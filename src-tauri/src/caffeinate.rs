//! App-wide power policy. Work arrives from native PTYs, never a webview cache.
//! The worker parks on a channel; its bounded minute tick reconciles wall-clock
//! changes, resume and the closed-lid helper's heartbeat without busy polling.
mod guard;
mod platform;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager as _};

pub(crate) fn configure_window(window: &tauri::WebviewWindow) {
    // A new window keeps its own policy unless a session is already on.
    if caffeinate_status().is_ok_and(|s| s.mode != Mode::Off || s.active) {
        window_background_policy(window, true);
    }
}
fn window_background_policy(window: &tauri::WebviewWindow, enabled: bool) {
    #[cfg(target_os = "macos")]
    if crate::darwin_major_version().is_some_and(|version| version >= 23) {
        let label = window.label().to_owned();
        let _ = window.with_webview(move |webview| unsafe {
            use objc2::{msg_send, runtime::AnyObject};
            let view = webview.inner().cast::<AnyObject>();
            let config: *mut AnyObject = msg_send![view, configuration];
            let preferences: *mut AnyObject = msg_send![config, preferences];
            // Only an enabled caffeinate session keeps hidden queues alive.
            let current: isize = msg_send![preferences, inactiveSchedulingPolicy];
            if let Some(policy) = SCHEDULING.lock().next(&label, enabled, current) {
                let _: () = msg_send![preferences, setInactiveSchedulingPolicy: policy];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, enabled);
}
/// WKInactiveSchedulingPolicy: Suspend=0, Throttle=1, None=2.
#[cfg(any(target_os = "macos", test))]
const THROTTLE: isize = 1;
/// Each window's policy from before the session changed it, so ending the
/// session puts back what was there instead of assuming WebKit's default.
#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct SchedulingMemo(std::collections::BTreeMap<String, isize>);
#[cfg(any(target_os = "macos", test))]
impl SchedulingMemo {
    /// The value to write to `label`'s window, given its current one.
    fn next(&mut self, label: &str, enabled: bool, current: isize) -> Option<isize> {
        if enabled {
            self.0.entry(label.to_owned()).or_insert(current);
            (current != THROTTLE).then_some(THROTTLE)
        } else {
            self.0.remove(label).filter(|prior| *prior != current)
        }
    }
}
#[cfg(target_os = "macos")]
static SCHEDULING: Mutex<SchedulingMemo> =
    Mutex::new(SchedulingMemo(std::collections::BTreeMap::new()));

/// A revoked macOS permission leaves the override set until the user approves
/// an interactive restore.
#[cfg(any(target_os = "macos", feature = "e2e"))]
const RESTORE_NEEDS_APPROVAL: &str = "Closed-lid permission was removed, so normal sleep was not restored automatically. Choose Restore normal sleep and approve the administrator request.";

const MAX_SESSION_MS: u64 = 24 * 60 * 60 * 1000;
const SETTLE_GRACE_MS: u64 = 120_000;
const ATTENTION_GRACE_MS: u64 = 300_000;
const UNKNOWN_LIMIT_MS: u64 = 1_200_000;
const INTERRUPT_QUIET_MS: u64 = 15_000;

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Off,
    Duration,
    Until,
    Agents,
    /// Until turned off. Like a timed session, it does not survive relaunch.
    Indefinite,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub mode: Mode,
    #[serde(default)]
    pub duration_minutes: Option<f64>,
    #[serde(default)]
    pub until_ms: Option<u64>,
    #[serde(default)]
    pub closed_lid: bool,
    #[serde(default)]
    pub display: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    pub mode: Mode,
    pub active: bool,
    pub closed_lid: bool,
    pub display: bool,
    pub lid_active: bool,
    pub lid_supported: bool,
    pub lid_permission: bool,
    pub deadline_ms: Option<u64>,
    pub duration_minutes: Option<f64>,
    pub working: usize,
    pub waiting: usize,
    pub unknown: usize,
    pub recovery_pending: bool,
    pub limited: bool,
    pub error: Option<String>,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq)]
enum Work {
    Idle,
    Working,
    Delegated,
    Detached,
    Attention,
    Unknown,
}
struct Agent {
    work: Work,
    since: u64,
    hooks: bool,
    output_at: Arc<AtomicU64>,
    interrupt_at: Option<u64>,
}

struct Policy {
    request: Request,
    deadline: Option<u64>,
    // Duration must not be extended by setting the wall clock back.
    elapsed_deadline: Option<u64>,
    agents: HashMap<String, Agent>,
    release_at: Option<u64>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            request: Request::default(),
            deadline: None,
            elapsed_deadline: None,
            agents: HashMap::new(),
            release_at: None,
        }
    }
}

impl Policy {
    fn input(&mut self, id: &str, bytes: &[u8], now: u64) {
        let Some(agent) = self.agents.get_mut(id) else {
            return;
        };
        let cancel = bytes == [3] || bytes == [27];
        let submit = bytes.iter().any(|b| matches!(b, b'\r' | b'\n'));
        if cancel && matches!(agent.work, Work::Working | Work::Unknown) {
            // Escape alone is not evidence that an agent stopped. In
            // particular, the first Escape in opencode keeps streaming.
            agent.interrupt_at = Some(now);
        } else if !agent.hooks && submit {
            agent.work = Work::Unknown;
            agent.since = now;
        }
    }
    fn configure(&mut self, request: Request, now: u64) -> Result<(), String> {
        let length = match request.mode {
            Mode::Duration => {
                let minutes = request.duration_minutes.ok_or("Enter a duration")?;
                if !minutes.is_finite() || minutes <= 0.0 || minutes > 1440.0 {
                    return Err("Duration must be greater than zero and at most 24 hours".into());
                }
                Some((minutes * 60_000.0).ceil() as u64)
            }
            Mode::Until => {
                let end = request.until_ms.ok_or("Choose an end time")?;
                if end <= now || end - now > MAX_SESSION_MS {
                    return Err("Choose a future time within the next 24 hours".into());
                }
                Some(end - now)
            }
            _ => None,
        };
        self.elapsed_deadline = if request.mode == Mode::Duration {
            length.map(|ms| platform::elapsed_ms().saturating_add(ms))
        } else {
            None
        };
        self.deadline = length.map(|ms| now.saturating_add(ms));
        self.request = request;
        self.release_at = None;
        Ok(())
    }

    fn counts(&self, now: u64) -> (usize, usize, usize) {
        let mut counts = (0, 0, 0);
        for agent in self.agents.values() {
            match agent.work {
                Work::Working | Work::Delegated => counts.0 += 1,
                Work::Detached if now.saturating_sub(agent.since) < ATTENTION_GRACE_MS => {
                    counts.0 += 1
                }
                Work::Attention if now.saturating_sub(agent.since) < ATTENTION_GRACE_MS => {
                    counts.1 += 1
                }
                Work::Unknown if now.saturating_sub(agent.since) < UNKNOWN_LIMIT_MS => {
                    counts.2 += 1
                }
                _ => {}
            }
        }
        counts
    }

    fn wanted(&mut self, now: u64, elapsed: u64) -> bool {
        for agent in self.agents.values_mut() {
            if let Some(interrupted) = agent.interrupt_at {
                let quiet_since = interrupted.max(agent.output_at.load(Ordering::Relaxed));
                if elapsed.saturating_sub(quiet_since) >= INTERRUPT_QUIET_MS {
                    agent.interrupt_at = None;
                    if matches!(agent.work, Work::Working | Work::Unknown) {
                        agent.work = Work::Idle;
                        agent.since = elapsed;
                        self.release_at = Some(elapsed.saturating_add(SETTLE_GRACE_MS));
                    }
                }
            }
        }
        if (self.request.mode == Mode::Until && self.deadline.is_some_and(|end| end <= now))
            || self.elapsed_deadline.is_some_and(|end| end <= elapsed)
        {
            let _ = self.configure(Request::default(), now);
        }
        match self.request.mode {
            Mode::Off => false,
            Mode::Duration | Mode::Until | Mode::Indefinite => true,
            Mode::Agents => {
                let (working, waiting, unknown) = self.counts(elapsed);
                if working > 0 {
                    self.release_at = Some(elapsed.saturating_add(SETTLE_GRACE_MS));
                    true
                } else if waiting + unknown > 0 {
                    true
                } else {
                    self.release_at.is_some_and(|end| end > elapsed)
                }
            }
        }
    }

    fn guard_deadline(&self) -> guard::Deadline {
        guard::Deadline {
            wall: if self.request.mode == Mode::Until {
                self.deadline
            } else {
                None
            },
            elapsed: self.elapsed_deadline,
        }
    }

    fn signal(&mut self, id: &str, body: &str, now: u64) {
        let Some(agent) = self.agents.get_mut(id) else {
            return;
        };
        if let Some(usage) = body.strip_prefix("usage ") {
            // Match the existing UI's exhausted-window decision. A usage
            // reading alone does not prove execution hooks are installed.
            let exhausted = usage.split_whitespace().take(2).any(|raw| {
                let mut parts = raw.split('.');
                let whole = parts.next().unwrap_or("");
                let decimal = parts.next();
                let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
                digits(whole)
                    && decimal.is_none_or(digits)
                    && parts.next().is_none()
                    && raw
                        .parse::<f64>()
                        .is_ok_and(|n| n.is_finite() && n >= 100.0)
            });
            if exhausted {
                agent.work = Work::Idle;
                agent.since = now;
            }
            return;
        }
        let work = if body == "agent working" {
            Work::Working
        } else if body == "agent done" || body == "agent ready for input" {
            Work::Idle
        } else if body.starts_with("agent needs your permission")
            || body.starts_with("agent needs your input")
        {
            Work::Attention
        } else if body.starts_with("agent delegated: ") {
            if !body
                .split_whitespace()
                .nth(2)
                .and_then(|n| n.parse::<u16>().ok())
                .is_some_and(|count| (1..=999).contains(&count))
            {
                return;
            }
            // A usage-window wait cannot make progress until the quota resets.
            match body.split_whitespace().nth(3) {
                Some("usage_limit") => Work::Idle,
                Some("shell") => Work::Detached,
                Some(
                    "subagent" | "workflow" | "teammate" | "cloud_session" | "mcp_task" | "work",
                ) => Work::Delegated,
                _ => return,
            }
        } else {
            return;
        };
        // An attention prompt does not get a fresh grace on every repaint.
        if agent.work != work {
            agent.since = now;
        }
        if matches!(agent.work, Work::Working | Work::Delegated)
            && !matches!(work, Work::Working | Work::Delegated)
        {
            self.release_at = Some(now.saturating_add(SETTLE_GRACE_MS));
        }
        agent.interrupt_at = None;
        agent.work = work;
        agent.hooks = true;
    }
}

/// Streaming OSC decoder with bounded storage. Handles BEL and ST terminators,
/// split frames, multiple messages, and ordinary output without buffering it.
#[derive(Default)]
pub(crate) struct Decoder {
    frame: Vec<u8>,
    escape: bool,
    osc: bool,
}
impl Decoder {
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            if self.osc {
                if b == 7 || (self.escape && b == b'\\') {
                    if self.escape {
                        self.frame.pop();
                    }
                    if let Some(body) = self.frame.strip_prefix(b"777;notify;termic;") {
                        if let Ok(body) = std::str::from_utf8(body) {
                            if body.starts_with("agent ") || body.starts_with("usage ") {
                                out.push(body.to_owned());
                            }
                        }
                    }
                    self.frame.clear();
                    self.osc = false;
                    self.escape = false;
                } else if self.frame.len() < 4096 {
                    self.frame.push(b);
                    self.escape = b == 27;
                } else {
                    self.frame.clear();
                    self.osc = false;
                    self.escape = false;
                }
            } else if self.escape && b == b']' {
                self.osc = true;
                self.escape = false;
            } else {
                self.escape = b == 27;
            }
        }
        out
    }
}

enum Message {
    Register(String, Arc<AtomicU64>),
    Signal(String, String),
    Input(String, Vec<u8>),
    Exit(String),
    Configure(Request, mpsc::Sender<Result<Status, String>>),
    Permission(bool, mpsc::Sender<Result<Status, String>>),
    PermissionDone(
        bool,
        Result<(), String>,
        mpsc::Sender<Result<Status, String>>,
    ),
    Recover(mpsc::Sender<Result<Status, String>>),
    RecoverDone(Result<(), String>, mpsc::Sender<Result<Status, String>>),
    Shutdown(mpsc::Sender<()>),
}
struct Manager {
    tx: mpsc::Sender<Message>,
    status: Arc<Mutex<Status>>,
}
static MANAGER: OnceLock<Manager> = OnceLock::new();

pub(crate) fn register(id: &str) -> Arc<AtomicU64> {
    let output = Arc::new(AtomicU64::new(platform::elapsed_ms()));
    send(Message::Register(id.into(), output.clone()));
    output
}
pub(crate) fn activity(output: &AtomicU64) {
    output.store(platform::elapsed_ms(), Ordering::Relaxed);
}
pub(crate) fn output(id: &str, bodies: Vec<String>) {
    for body in bodies {
        send(Message::Signal(id.into(), body));
    }
}
pub(crate) fn input(id: &str, bytes: &[u8]) {
    // Avoid allocation and wakeups on ordinary typed characters.
    if bytes == [3] || bytes == [27] || bytes.iter().any(|b| matches!(b, b'\r' | b'\n')) {
        send(Message::Input(id.into(), bytes.to_vec()));
    }
}
pub(crate) fn exited(id: &str) {
    send(Message::Exit(id.into()));
}
fn send(message: Message) {
    if let Some(manager) = MANAGER.get() {
        let _ = manager.tx.send(message);
    }
}

pub(crate) fn start(app: tauri::AppHandle) {
    let (tx, rx) = mpsc::channel();
    let status = Status {
        mode: Mode::Off,
        active: false,
        closed_lid: false,
        display: false,
        lid_active: false,
        lid_supported: platform::lid_supported(),
        lid_permission: platform::permission(),
        deadline_ms: None,
        duration_minutes: None,
        working: 0,
        waiting: 0,
        unknown: 0,
        recovery_pending: false,
        limited: platform::limited(),
        error: None,
        revision: 0,
    };
    let shared = Arc::new(Mutex::new(status.clone()));
    if MANAGER
        .set(Manager {
            tx,
            status: shared.clone(),
        })
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || worker(app, rx, shared, status));
}

fn worker(
    app: tauri::AppHandle,
    rx: mpsc::Receiver<Message>,
    shared: Arc<Mutex<Status>>,
    mut status: Status,
) {
    let mut policy = Policy::default();
    let mut backend = platform::Backend::default();
    let mut lid: Option<guard::Client> = None;
    let mut pending = Vec::<mpsc::Sender<Result<Status, String>>>::new();
    let mut permission_pending = false;
    let mut recovering = false;
    let journal = crate::global_dir().map(|dir| dir.join("caffeinate-lid.json"));
    let preference = crate::global_dir().map(|dir| dir.join("caffeinate-policy.json"));
    if let Ok(path) = &preference {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(request) = serde_json::from_slice::<Request>(&bytes) {
                if request.mode == Mode::Agents {
                    let _ = policy.configure(request, now_ms());
                }
            }
        }
    }
    if let Ok(path) = &journal {
        if let Err(error) = guard::recover(path, false) {
            status.error = Some(error);
        }
    }
    let mut battery_check = Instant::now();
    let mut first_battery_check = true;
    let mut queues_enabled = false;
    let mut retry_at = 0;
    let mut display_held = false;
    loop {
        let now = now_ms();
        if first_battery_check || battery_check.elapsed() >= Duration::from_secs(60) {
            first_battery_check = false;
            battery_check = Instant::now();
            status.lid_permission = platform::permission();
            if lid.is_some() && !status.lid_permission {
                // Restoring needs that permission. Stop now, while someone is
                // more likely to be here to approve the fallback.
                status.error = Some(
                    lid.take()
                        .map_or(Ok(()), guard::Client::stop)
                        .err()
                        .unwrap_or_else(|| "Closed-lid permission was removed".into()),
                );
                policy.request.closed_lid = false;
            }
            if status.active {
                if let Err(error) = backend.check() {
                    let _ = backend.set_awake(false);
                    status.active = false;
                    status.error = Some(error);
                }
            }
            if policy.request.mode != Mode::Off && platform::battery_low() {
                let _ = policy.configure(Request::default(), now);
                if let Ok(path) = &preference {
                    let _ = guard::save(path, &Request::default());
                }
                status.error =
                    Some("Caffeinate stopped because the battery is at or below 10%".into());
            }
        }
        let elapsed = platform::elapsed_ms();
        let desired = policy.wanted(now, elapsed);
        if desired != status.active && (!desired || elapsed >= retry_at) {
            match backend.set_awake(desired) {
                Ok(()) => {
                    status.active = desired;
                    if desired {
                        status.error = None;
                    }
                }
                Err(error) => {
                    status.error = Some(error);
                    // An unavailable service must not cause synchronous OS
                    // retries for every hook frame in a busy terminal.
                    retry_at = elapsed.saturating_add(60_000);
                }
            }
        }
        let want_display = status.active && policy.request.display;
        if want_display != display_held {
            match backend.set_display(want_display) {
                Ok(()) => display_held = want_display,
                Err(error) => {
                    status.error = Some(error);
                    // Drop the request rather than retry on every hook frame.
                    policy.request.display = false;
                }
            }
        }
        let want_lid =
            status.active && policy.request.closed_lid && !permission_pending && !recovering;
        if !want_lid {
            if let Some(Err(error)) = lid.take().map(guard::Client::stop) {
                status.error = Some(error);
            }
        } else if lid.is_none() {
            let result = journal
                .as_ref()
                .map_err(|e| e.to_string())
                .and_then(|path| guard::Client::start(path, policy.guard_deadline()));
            match result {
                Ok(client) => {
                    lid = Some(client);
                    status.error = None;
                }
                Err(error) => {
                    status.error = Some(error);
                    policy.request.closed_lid = false;
                }
            }
        }
        if let Some(client) = &mut lid {
            if let Err(error) = client.heartbeat(policy.guard_deadline()) {
                // The guard's own restore result says more than "it ended".
                let restored = lid.take().map_or(Ok(()), guard::Client::stop);
                status.error = Some(restored.err().unwrap_or(error));
                policy.request.closed_lid = false;
            }
        }
        status.mode = policy.request.mode.clone();
        status.duration_minutes = if policy.request.mode == Mode::Duration {
            policy.request.duration_minutes
        } else {
            None
        };
        status.closed_lid = policy.request.closed_lid;
        status.display = policy.request.display;
        let display_deadline = policy
            .elapsed_deadline
            .map(|end| now.saturating_add(end.saturating_sub(elapsed)))
            .or(policy.deadline);
        // Avoid broadcasting sub-millisecond sampling jitter on every hook.
        if status
            .deadline_ms
            .zip(display_deadline)
            .is_none_or(|(old, new)| old.abs_diff(new) >= 1_000)
        {
            status.deadline_ms = display_deadline;
        }
        status.lid_active = lid.is_some();
        (status.working, status.waiting, status.unknown) = policy.counts(elapsed);
        status.recovery_pending = journal.as_ref().is_ok_and(|path| path.exists()) && lid.is_none();
        let enable_queues = status.mode != Mode::Off || status.active;
        if enable_queues != queues_enabled {
            queues_enabled = enable_queues;
            for (_, window) in app.webview_windows() {
                window_background_policy(&window, enable_queues);
            }
        }
        if *shared.lock() != status {
            status.revision = status.revision.saturating_add(1);
            *shared.lock() = status.clone();
            let _ = app.emit("caffeinate://status", &status);
        }
        for reply in pending.drain(..) {
            let _ = reply.send(Ok(status.clone()));
        }
        let timeout = policy
            .guard_deadline()
            .wall
            .map(|end| end.saturating_sub(now))
            .or_else(|| {
                policy
                    .elapsed_deadline
                    .map(|end| end.saturating_sub(elapsed))
            })
            .map(|ms| Duration::from_millis(ms.max(1)))
            .unwrap_or(Duration::from_secs(60))
            .min(Duration::from_secs(
                if policy.agents.values().any(|a| a.interrupt_at.is_some()) {
                    1
                } else {
                    60
                },
            ));
        match rx.recv_timeout(timeout) {
            Ok(Message::Register(id, output_at)) => {
                policy.agents.insert(
                    id,
                    Agent {
                        work: Work::Idle,
                        since: platform::elapsed_ms(),
                        hooks: false,
                        output_at,
                        interrupt_at: None,
                    },
                );
            }
            Ok(Message::Exit(id)) => {
                if policy
                    .agents
                    .remove(&id)
                    .is_some_and(|a| matches!(a.work, Work::Working | Work::Delegated))
                {
                    policy.release_at =
                        Some(platform::elapsed_ms().saturating_add(SETTLE_GRACE_MS));
                }
            }
            Ok(Message::Signal(id, body)) => policy.signal(&id, &body, platform::elapsed_ms()),
            Ok(Message::Input(id, bytes)) => {
                policy.input(&id, &bytes, platform::elapsed_ms());
            }
            Ok(Message::Configure(mut request, reply)) => {
                if request.mode == Mode::Off {
                    request.closed_lid = false;
                    request.display = false;
                }
                // Validate before stopping the current session.
                let mut candidate = Policy::default();
                let result = candidate
                    .configure(request.clone(), now_ms())
                    .and_then(|_| {
                        if request.closed_lid && !status.lid_supported {
                            return Err("Closed-lid control is unavailable on this system".into());
                        }
                        if request.closed_lid && permission_pending {
                            return Err("Closed-lid permission is being changed".into());
                        }
                        if request.closed_lid && recovering {
                            return Err("Normal sleep is still being restored".into());
                        }
                        if request.closed_lid && !platform::permission() {
                            return Err("Set up closed-lid permission first".into());
                        }
                        if request.mode != Mode::Off && platform::battery_low() {
                            return Err(
                                "Charge the battery above 10% before starting caffeinate".into()
                            );
                        }
                        let mut persistence_error = None;
                        if let Ok(path) = &preference {
                            let saved = if request.mode == Mode::Agents {
                                request.clone()
                            } else {
                                Request::default()
                            };
                            let result = guard::save(path, &saved);
                            if request.mode == Mode::Off {
                                persistence_error = result.err();
                            } else {
                                result?;
                            }
                        }
                        policy.configure(request, now_ms())?;
                        retry_at = 0;
                        status.error = persistence_error;
                        Ok(())
                    });
                // Process the transition before returning the command result.
                match result {
                    Ok(()) => pending.push(reply),
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(Message::Permission(install, reply)) => {
                if lid.is_some()
                    || (!install && status.recovery_pending)
                    || permission_pending
                    || recovering
                {
                    let _ = reply.send(Err(
                        "Stop closed-lid mode and restore sleep before changing permission".into(),
                    ));
                    continue;
                }
                permission_pending = true;
                // Authorization can wait on the user for minutes. Keep the
                // policy channel responsive to deadlines, Stop and battery.
                std::thread::spawn(move || {
                    let result = platform::set_permission(install);
                    send(Message::PermissionDone(install, result, reply));
                });
            }
            Ok(Message::PermissionDone(install, result, reply)) => {
                permission_pending = false;
                if result.is_ok() && !install {
                    policy.request.closed_lid = false;
                    if policy.request.mode == Mode::Agents {
                        if let Ok(path) = &preference {
                            let _ = guard::save(path, &policy.request);
                        }
                    }
                }
                status.lid_permission = platform::permission();
                match result {
                    Ok(()) => pending.push(reply),
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(Message::Recover(reply)) => {
                if lid.is_some() || permission_pending || recovering {
                    let _ = reply.send(Err("Stop closed-lid mode before restoring sleep".into()));
                    continue;
                }
                let path = match &journal {
                    Ok(path) => path.clone(),
                    Err(error) => {
                        let _ = reply.send(Err(error.to_string()));
                        continue;
                    }
                };
                recovering = true;
                // A revoked permission falls back to an administrator prompt,
                // which can wait on the user for minutes.
                std::thread::spawn(move || {
                    send(Message::RecoverDone(guard::recover(&path, true), reply));
                });
            }
            Ok(Message::RecoverDone(result, reply)) => {
                recovering = false;
                match result {
                    Ok(()) => {
                        status.error = None;
                        pending.push(reply);
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(Message::Shutdown(reply)) => {
                let _ = backend.set_awake(false);
                // Logout and restart quit Termic first; never sleep mid-restart.
                if let Some(client) = lid.take() {
                    client.quit();
                }
                let _ = reply.send(());
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[tauri::command]
pub(crate) fn caffeinate_status() -> Result<Status, String> {
    MANAGER
        .get()
        .map(|m| m.status.lock().clone())
        .ok_or("Power manager is starting".into())
}
#[tauri::command]
pub(crate) async fn caffeinate_set(request: Request) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        MANAGER
            .get()
            .ok_or("Power manager is starting")?
            .tx
            .send(Message::Configure(request, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn caffeinate_permission(install: bool) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        MANAGER
            .get()
            .ok_or("Power manager is starting")?
            .tx
            .send(Message::Permission(install, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(600))
            .map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn caffeinate_recover() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        MANAGER
            .get()
            .ok_or("Power manager is starting")?
            .tx
            .send(Message::Recover(tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(600))
            .map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
pub(crate) fn shutdown() {
    let (tx, rx) = mpsc::channel();
    send(Message::Shutdown(tx));
    let _ = rx.recv_timeout(Duration::from_secs(10));
}
pub(crate) fn run_guard_if_requested() -> bool {
    guard::run_if_requested()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_policy_is_untouched_without_a_session_and_restored_after() {
        let mut memo = SchedulingMemo::default();
        // Off: a window's policy is never written.
        assert_eq!(memo.next("main", false, 0), None);
        // On: throttle, remembering what was there; a repeat keeps the first.
        assert_eq!(memo.next("main", true, 2), Some(THROTTLE));
        assert_eq!(memo.next("main", true, THROTTLE), None);
        assert_eq!(memo.next("main", false, THROTTLE), Some(2));
        assert_eq!(memo.next("main", false, 2), None);
        // Already throttled by someone else: nothing to change or undo.
        assert_eq!(memo.next("other", true, THROTTLE), None);
        assert_eq!(memo.next("other", false, THROTTLE), None);
    }
    fn agent(policy: &mut Policy, id: &str) {
        policy.agents.insert(
            id.into(),
            Agent {
                work: Work::Idle,
                since: 0,
                hooks: false,
                output_at: Arc::new(AtomicU64::new(0)),
                interrupt_at: None,
            },
        );
    }
    #[test]
    fn fragmented_osc_and_both_terminators() {
        let mut decoder = Decoder::default();
        let bytes =
            b"noise\x1b]777;notify;termic;agent working\x07\x1b]777;notify;termic;agent done\x1b\\";
        for split in 0..bytes.len() {
            decoder = Decoder::default();
            let mut messages = decoder.feed(&bytes[..split]);
            messages.extend(decoder.feed(&bytes[split..]));
            assert_eq!(messages, ["agent working", "agent done"]);
        }
        assert!(decoder
            .feed(b"\x1b]777;notify;other;agent working\x07")
            .is_empty());
    }
    #[test]
    fn oversized_frames_are_bounded() {
        let mut decoder = Decoder::default();
        decoder.feed(&[b"\x1b]777;notify;termic;".as_slice(), &vec![b'x'; 50_000]].concat());
        assert!(decoder.frame.len() <= 4096);
        assert_eq!(
            decoder.feed(b"\x1b]777;notify;termic;agent done\x07"),
            ["agent done"]
        );
    }
    #[test]
    fn multiple_profiles_delegation_and_release_grace() {
        let mut policy = Policy::default();
        policy
            .configure(
                Request {
                    mode: Mode::Agents,
                    ..Request::default()
                },
                0,
            )
            .unwrap();
        agent(&mut policy, "profile-a/pty");
        agent(&mut policy, "profile-b/pty");
        policy.signal("profile-a/pty", "agent working", 1);
        assert!(policy.wanted(1, 1));
        policy.signal("profile-b/pty", "agent done", 2);
        assert!(policy.wanted(2, 2));
        policy.signal("profile-a/pty", "agent delegated: 1 subagent task1", 3);
        assert!(policy.wanted(2_000_000, 2_000_000)); // real delegated work has no spinner ceiling
        policy.signal("profile-a/pty", "agent done", 2_000_001);
        assert!(policy.wanted(2_000_002, 2_000_002));
        assert!(!policy.wanted(2_000_002 + SETTLE_GRACE_MS, 2_000_002 + SETTLE_GRACE_MS));
    }
    #[test]
    fn invalid_replacement_preserves_running_session_and_expiry() {
        let mut policy = Policy::default();
        policy
            .configure(
                Request {
                    mode: Mode::Duration,
                    duration_minutes: Some(2.0),
                    ..Request::default()
                },
                10,
            )
            .unwrap();
        assert!(policy
            .configure(
                Request {
                    mode: Mode::Until,
                    until_ms: Some(5),
                    ..Request::default()
                },
                20
            )
            .is_err());
        assert!(policy.wanted(100, 100));
        let elapsed_end = policy.elapsed_deadline.unwrap();
        assert!(policy.wanted(u64::MAX, elapsed_end - 1));
        assert!(!policy.wanted(10, elapsed_end));
        assert_eq!(policy.request.mode, Mode::Off);
    }
    #[test]
    fn indefinite_holds_without_a_deadline_until_turned_off() {
        let mut policy = Policy::default();
        policy
            .configure(
                Request {
                    mode: Mode::Indefinite,
                    display: true,
                    ..Request::default()
                },
                10,
            )
            .unwrap();
        assert_eq!((policy.deadline, policy.elapsed_deadline), (None, None));
        assert!(policy.wanted(u64::MAX, u64::MAX));
        let guard = policy.guard_deadline();
        assert_eq!((guard.wall, guard.elapsed), (None, None));
        policy.configure(Request::default(), 20).unwrap();
        assert!(!policy.wanted(30, 30));
        // An older policy file without `display` still loads.
        let old: Request = serde_json::from_str(r#"{"mode":"agents","closed_lid":false}"#).unwrap();
        assert!(!old.display);
    }
    #[test]
    fn hookless_and_attention_have_finite_grace() {
        let mut policy = Policy::default();
        agent(&mut policy, "a");
        let a = policy.agents.get_mut("a").unwrap();
        a.work = Work::Unknown;
        assert_eq!(policy.counts(UNKNOWN_LIMIT_MS), (0, 0, 0));
        policy.signal("a", "agent needs your permission: Bash", 1);
        policy.signal("a", "agent needs your permission: Bash", 50);
        assert_eq!(policy.counts(ATTENTION_GRACE_MS + 1), (0, 0, 0));
    }
    #[test]
    fn arrows_and_bracketed_paste_do_not_interrupt_real_agent_work() {
        let mut policy = Policy::default();
        agent(&mut policy, "a");
        policy.signal("a", "agent working", 1);
        for input in [b"\x1b[A".as_slice(), b"\x1b[200~hello\nworld\x1b[201~"] {
            policy.input("a", input, 2);
            assert_eq!(policy.counts(2), (1, 0, 0));
        }
        policy.input("a", &[3], 3);
        assert_eq!(policy.counts(3), (1, 0, 0));
        policy.agents["a"]
            .output_at
            .store(10_000, Ordering::Relaxed);
        policy.wanted(20_000, 20_000);
        assert_eq!(policy.counts(20_000), (1, 0, 0));
        policy.wanted(25_000, 25_000);
        assert_eq!(policy.counts(25_000), (0, 0, 0));
        policy.signal("a", "agent delegated: 1 subagent task", 30_000);
        policy.input("a", &[27], 30_001);
        policy.wanted(100_000, 100_000);
        assert_eq!(policy.counts(100_000), (1, 0, 0));
    }
    #[test]
    fn detached_shell_cannot_hold_forever_and_unknown_labels_are_ignored() {
        let mut policy = Policy::default();
        agent(&mut policy, "a");
        policy.signal("a", "agent delegated: 1 shell job", 0);
        assert_eq!(policy.counts(1), (1, 0, 0));
        assert_eq!(policy.counts(ATTENTION_GRACE_MS), (0, 0, 0));
        policy.signal("a", "agent delegated: 1 invented job", 1);
        assert_eq!(policy.agents["a"].work, Work::Detached);
        policy.signal("a", "agent delegated: 0 subagent -", 2);
        assert_eq!(policy.agents["a"].work, Work::Detached);
    }
    #[test]
    fn quota_wait_releases_after_settling_and_actual_work_rearms() {
        let mut policy = Policy::default();
        policy.request.mode = Mode::Agents;
        agent(&mut policy, "a");
        policy.signal("a", "agent working", 1);
        assert!(policy.wanted(1, 1));
        let mut decoder = Decoder::default();
        for body in decoder.feed(b"\x1b]777;notify;termic;usage 100 40 - -\x07") {
            policy.signal("a", &body, 2);
        }
        assert_eq!(policy.counts(2), (0, 0, 0));
        assert!(!policy.wanted(SETTLE_GRACE_MS + 1, SETTLE_GRACE_MS + 1));
        policy.signal("a", "agent working", SETTLE_GRACE_MS + 2);
        assert!(policy.wanted(SETTLE_GRACE_MS + 2, SETTLE_GRACE_MS + 2));
        agent(&mut policy, "hookless");
        policy.signal("hookless", "usage - 100 - -", 1);
        policy.input("hookless", b"resume\r", 2);
        assert_eq!(policy.agents["hookless"].work, Work::Unknown);
    }
}
