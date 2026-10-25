//! A bounded, local child, not a service. EOF on its dedicated pipe restores
//! global lid settings even when the desktop crashes. A lease handles hangs.
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

pub(super) fn recover(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let _lock = LeaseLock::acquire(path)?;
    platform::recover(path)
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
        if let Some(mut child) = self.child.take() {
            // Reap off-thread if restoration is slow; never kill a restore.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
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
    let result = (|| -> Result<(), String> {
        let _lock = LeaseLock::acquire(&path)?;
        if path.exists() {
            platform::recover(&path)?;
        }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = stdin.lock();
            loop {
                // The sole writer is our parent. Still bound malformed input.
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if line.len() <= 128 => {
                        match serde_json::from_str::<Deadline>(line.trim()) {
                            Ok(value) => {
                                if tx.send(value).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    _ => break,
                }
            }
        });
        let mut deadline = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())?;
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
                Ok(next) => {
                    deadline = next;
                    lease = Instant::now() + Duration::from_secs(180);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        lid.restore(&path)
    })();
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
