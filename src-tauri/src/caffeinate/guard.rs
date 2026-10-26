//! A bounded, local child, not a service. EOF on its dedicated pipe restores
//! global lid settings even when the desktop crashes. A lease handles hangs,
//! and logout/shutdown signals restore before the OS ends the process.
use super::{now_ms, platform};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

pub(super) struct LeaseLock(File);
impl LeaseLock {
    pub(super) fn acquire(path: &Path) -> Result<Self, String> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let file = options
            .open(path.with_extension("lock"))
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("Another closed-lid session is still restoring sleep".into());
            }
        }
        Ok(Self(file))
    }
}
impl Drop for LeaseLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

pub(super) fn save<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        {
            fs::rename(&tmp, path).map_err(|e| e.to_string())
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let source: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
            let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                    source.as_ptr(),
                    target.as_ptr(),
                    9,
                )
            } == 0
            {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

/// `interactive` may ask the user to approve the restore (a revoked macOS
/// permission leaves no other way to write the setting back).
pub(super) fn recover(path: &Path, interactive: bool) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let _lock = LeaseLock::acquire(path)?;
    platform::recover(path, interactive)
}

#[derive(Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct Deadline {
    pub wall: Option<u64>,
    pub elapsed: Option<u64>,
}
impl Deadline {
    fn remaining(self, wall: u64, elapsed: u64) -> Duration {
        let wall = self.wall.map(|end| end.saturating_sub(wall));
        let elapsed = self.elapsed.map(|end| end.saturating_sub(elapsed));
        Duration::from_millis(wall.into_iter().chain(elapsed).min().unwrap_or(60_000))
    }
}

pub(super) struct Client {
    child: Option<Child>,
    input: Option<ChildStdin>,
    replies: mpsc::Receiver<Result<(), String>>,
    last_heartbeat: Option<Instant>,
    deadline: Deadline,
}
impl Client {
    pub(super) fn start(path: &Path, deadline: Deadline) -> Result<Self, String> {
        {
            let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
            command
                .arg("--termic-caffeinate-guard")
                .arg(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn().map_err(|e| e.to_string())?;
            let input = child.stdin.take().ok_or("Cannot open power guard input")?;
            let output = child
                .stdout
                .take()
                .ok_or("Cannot open power guard output")?;
            let (tx, replies) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(output).lines() {
                    let result = line
                        .map_err(|e| e.to_string())
                        .and_then(|s| {
                            serde_json::from_str::<Result<(), String>>(&s)
                                .map_err(|e| e.to_string())
                        })
                        .and_then(|x| x);
                    if tx.send(result).is_err() {
                        break;
                    }
                }
            });
            let mut client = Self {
                child: Some(child),
                input: Some(input),
                replies,
                last_heartbeat: None,
                deadline,
            };
            client.heartbeat(deadline)?;
            client
                .replies
                .recv_timeout(Duration::from_secs(20))
                .map_err(|e| format!("Power guard did not start: {e}"))??;
            Ok(client)
        }
    }
    /// Close the pipe and return the guard's own restoration result, so a
    /// failed restore reaches the status instead of being dropped.
    pub(super) fn stop(mut self) -> Result<(), String> {
        self.input.take();
        let result = self
            .replies
            .recv_timeout(Duration::from_secs(8))
            .unwrap_or_else(|_| {
                Err("Closed-lid control did not confirm that normal sleep was restored".into())
            });
        self.reap();
        result
    }
    /// Termic is quitting, so the user is at the machine or the OS is ending
    /// the session: restore, but never request sleep. Drop closes the pipe and
    /// waits for the restore.
    pub(super) fn quit(mut self) {
        if let Some(input) = &mut self.input {
            let _ = writeln!(input, "quit").and_then(|_| input.flush());
        }
    }
    fn reap(&mut self) {
        if let Some(mut child) = self.child.take() {
            // Reap off-thread if restoration is slow; never kill a restore.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    pub(super) fn heartbeat(&mut self, deadline: Deadline) -> Result<(), String> {
        if self.deadline == deadline
            && self
                .last_heartbeat
                .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
        {
            return Ok(());
        }
        if let Some(child) = &mut self.child {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("Closed-lid control ended; normal sleep is being restored".into());
            }
        }
        if let Some(input) = &mut self.input {
            writeln!(
                input,
                "{}",
                serde_json::to_string(&deadline).map_err(|e| e.to_string())?
            )
            .and_then(|_| input.flush())
            .map_err(|e| e.to_string())?;
        }
        self.last_heartbeat = Some(Instant::now());
        self.deadline = deadline;
        Ok(())
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        // Only the guard owns the setting. Do not race it with a second write.
        self.input.take();
        if self.child.is_some() {
            let _ = self.replies.recv_timeout(Duration::from_secs(8));
        }
        self.reap();
    }
}

/// What the guard loop hears. The parent closing the pipe is an ordinary stop;
/// the OS ending the session, or Termic quitting, must restore without
/// forcing a sleep.
enum Input {
    Deadline(Deadline),
    Closed,
    Terminate,
}

/// Logout and shutdown signal the guard rather than closing its pipe. Block
/// the signals before any thread exists and take them on one thread, so none
/// can kill the process before it restores. Children get a clean mask from
/// `Command`.
#[cfg(unix)]
fn watch_session_end(tx: mpsc::Sender<Input>) {
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
            libc::sigaddset(&mut set, signal);
        }
        if libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
            return;
        }
    }
    std::thread::spawn(move || {
        let mut signal = 0;
        if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
            let _ = tx.send(Input::Terminate);
        }
    });
}
#[cfg(windows)]
fn watch_session_end(tx: mpsc::Sender<Input>) {
    session_end::watch(tx);
}

/// Logoff and shutdown end a windowless process without closing its pipe. A
/// hidden top-level window receives WM_ENDSESSION, and its procedure waits
/// for the restore before letting the session end.
#[cfg(windows)]
mod session_end {
    use super::Input;
    use std::{
        sync::{mpsc, Condvar, Mutex, OnceLock},
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, MSG,
            WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW,
        },
    };
    static SENDER: OnceLock<mpsc::Sender<Input>> = OnceLock::new();
    static RESTORED: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

    pub(super) fn watch(tx: mpsc::Sender<Input>) {
        if SENDER.set(tx).is_err() {
            return;
        }
        std::thread::spawn(|| unsafe {
            let class: Vec<u16> = "TermicCaffeinateGuard\0".encode_utf16().collect();
            let instance = GetModuleHandleW(std::ptr::null());
            let mut definition: WNDCLASSW = std::mem::zeroed();
            definition.lpfnWndProc = Some(procedure);
            definition.hInstance = instance;
            definition.lpszClassName = class.as_ptr();
            if RegisterClassW(&definition) == 0 {
                return;
            }
            // Never shown, but top-level: message-only windows miss the
            // session-end broadcast.
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if window.is_null() {
                return;
            }
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                DispatchMessageW(&message);
            }
        });
    }
    pub(super) fn restored() {
        *RESTORED.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        RESTORED.1.notify_all();
    }
    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_QUERYENDSESSION => 1,
            WM_ENDSESSION => {
                if wparam != 0 {
                    if let Some(tx) = SENDER.get() {
                        let _ = tx.send(Input::Terminate);
                    }
                    let done = RESTORED.0.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = RESTORED
                        .1
                        .wait_timeout_while(done, Duration::from_secs(5), |done| !*done);
                }
                0
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}

fn ack(result: &Result<(), String>) {
    if let Ok(line) = serde_json::to_string(result) {
        println!("{line}");
        let _ = std::io::stdout().flush();
    }
}
pub(super) fn run_if_requested() -> bool {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--termic-caffeinate-guard")) {
        return false;
    }
    let Some(path) = args.next().map(PathBuf::from) else {
        return true;
    };
    let (tx, rx) = mpsc::channel();
    // First, before any other thread starts (see `watch_session_end`).
    watch_session_end(tx.clone());
    let result = (|| -> Result<(), String> {
        let _lock = LeaseLock::acquire(&path)?;
        if path.exists() {
            platform::recover(&path, false)?;
        }
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = stdin.lock();
            loop {
                // The sole writer is our parent. Still bound malformed input.
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line.trim() == "quit" => {
                        let _ = tx.send(Input::Terminate);
                        break;
                    }
                    Ok(_) if line.len() <= 128 => {
                        match serde_json::from_str::<Deadline>(line.trim()) {
                            Ok(value) => {
                                if tx.send(Input::Deadline(value)).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    _ => break,
                }
            }
            // The session-end watcher holds a sender too, so say so explicitly.
            let _ = tx.send(Input::Closed);
        });
        let mut deadline = match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Input::Deadline(deadline)) => deadline,
            Ok(_) => return Err("The closed-lid session ended before it started".into()),
            Err(error) => return Err(error.to_string()),
        };
        if deadline
            .remaining(now_ms(), platform::elapsed_ms())
            .is_zero()
        {
            return Err("The closed-lid session already expired".into());
        }
        let mut lid = platform::Lid::enable(&path)?;
        ack(&Ok(()));
        let mut lease = Instant::now() + Duration::from_secs(180);
        let mut battery_check = None::<Instant>;
        let mut resleep = true;
        loop {
            let deadline_remaining = deadline.remaining(now_ms(), platform::elapsed_ms());
            if deadline_remaining.is_zero() {
                break;
            }
            if lid.check().is_err() {
                break;
            }
            if battery_check.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
                battery_check = Some(Instant::now());
                if platform::battery_low() {
                    break;
                }
            }
            let remaining = lease.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let remaining = remaining.min(deadline_remaining);
            match rx.recv_timeout(remaining.min(Duration::from_secs(60))) {
                Ok(Input::Deadline(next)) => {
                    deadline = next;
                    lease = Instant::now() + Duration::from_secs(180);
                }
                Ok(Input::Terminate) => {
                    // Never request sleep while the OS is logging out or
                    // shutting down.
                    resleep = false;
                    break;
                }
                Ok(Input::Closed) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        lid.restore(&path, resleep)
    })();
    #[cfg(windows)]
    session_end::restored();
    ack(&result);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elapsed_deadline_ignores_wall_clock_jumps_and_wall_deadline_tracks_them() {
        let duration = Deadline {
            elapsed: Some(10_000),
            wall: None,
        };
        assert_eq!(duration.remaining(u64::MAX, 9_000), Duration::from_secs(1));
        assert!(duration.remaining(0, 10_000).is_zero());
        let until = Deadline {
            wall: Some(10_000),
            elapsed: None,
        };
        assert!(until.remaining(11_000, 0).is_zero());
        assert_eq!(until.remaining(9_000, u64::MAX), Duration::from_secs(1));
    }
    #[test]
    fn journal_is_atomic_and_a_second_guard_cannot_take_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lid.json");
        let lock = LeaseLock::acquire(&path).unwrap();
        assert!(LeaseLock::acquire(&path).is_err());
        save(&path, &vec![1, 2, 3]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1,2,3]");
        save(&path, &vec![4]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[4]");
        drop(lock);
        assert!(LeaseLock::acquire(&path).is_ok());
    }
}
