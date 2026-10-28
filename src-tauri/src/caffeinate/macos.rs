//! Native idle assertion; optional, independently authorized pmset lid override.
//! Written from OS contracts, not copied from the Vorssaint implementation.
use serde::{Deserialize, Serialize};
use std::{
    ffi::{c_void, CString},
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
};
type Ref = *const c_void;
#[repr(C)]
struct Timebase {
    numer: u32,
    denom: u32,
}
extern "C" {
    fn mach_continuous_time() -> u64;
    fn mach_timebase_info(info: *mut Timebase) -> i32;
}
pub fn elapsed_ms() -> u64 {
    static SCALE: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    let (numer, denom) = *SCALE.get_or_init(|| {
        let mut info = Timebase { numer: 1, denom: 1 };
        unsafe {
            mach_timebase_info(&mut info);
        }
        (info.numer, info.denom.max(1))
    });
    ((unsafe { mach_continuous_time() } as u128 * u128::from(numer))
        / u128::from(denom)
        / 1_000_000) as u64
}
#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(kind: Ref, level: u32, reason: Ref, id: *mut u32) -> i32;
    fn IOPMAssertionRelease(id: u32) -> i32;
    fn IOServiceMatching(name: *const i8) -> *mut c_void;
    fn IOServiceGetMatchingService(port: u32, matching: *mut c_void) -> u32;
    fn IOObjectRelease(object: u32) -> i32;
    fn IORegistryEntryCreateCFProperty(entry: u32, key: Ref, allocator: Ref, options: u32) -> Ref;
    fn IONotificationPortCreate(port: u32) -> *mut c_void;
    fn IONotificationPortGetRunLoopSource(port: *mut c_void) -> Ref;
    fn IOServiceAddInterestNotification(
        port: *mut c_void,
        service: u32,
        interest: *const i8,
        callback: extern "C" fn(*mut c_void, u32, u32, *mut c_void),
        context: *mut c_void,
        notification: *mut u32,
    ) -> i32;
    fn IOPMFindPowerManagement(port: u32) -> u32;
    fn IOPMSleepSystem(connection: u32) -> i32;
    fn IOServiceClose(connection: u32) -> i32;
    fn IOPSCopyPowerSourcesInfo() -> Ref;
    fn IOPSCopyPowerSourcesList(blob: Ref) -> Ref;
    fn IOPSGetPowerSourceDescription(blob: Ref, source: Ref) -> Ref;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(allocator: Ref, value: *const i8, encoding: u32) -> Ref;
    fn CFRelease(value: Ref);
    fn CFBooleanGetValue(value: Ref) -> bool;
    fn CFArrayGetCount(value: Ref) -> isize;
    fn CFArrayGetValueAtIndex(value: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFNumberGetValue(value: Ref, kind: isize, number: *mut c_void) -> bool;
    fn CFEqual(a: Ref, b: Ref) -> bool;
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(loop_ref: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRun();
    static kCFRunLoopDefaultMode: Ref;
}
fn string(value: &str) -> Ref {
    let value = CString::new(value).expect("constant CF string");
    unsafe { CFStringCreateWithCString(std::ptr::null(), value.as_ptr(), 0x08000100) }
}
fn create_assertion(kind: &str) -> Result<u32, String> {
    let kind = string(kind);
    let reason = string("Termic agent work");
    let mut id = 0;
    let result = unsafe { IOPMAssertionCreateWithName(kind, 255, reason, &mut id) };
    unsafe {
        CFRelease(kind);
        CFRelease(reason);
    }
    if result != 0 {
        return Err(format!("macOS could not prevent idle sleep ({result})"));
    }
    Ok(id)
}
fn release_assertion(slot: &mut Option<u32>) -> Result<(), String> {
    if let Some(id) = *slot {
        let result = unsafe { IOPMAssertionRelease(id) };
        if result != 0 {
            return Err(format!(
                "macOS could not release sleep assertion ({result})"
            ));
        }
        *slot = None;
    }
    Ok(())
}
#[derive(Default)]
pub struct Backend {
    assertion: Option<u32>,
    display: Option<u32>,
}
impl Backend {
    pub fn check(&self) -> Result<(), String> {
        Ok(())
    }
    pub fn set_awake(&mut self, on: bool) -> Result<(), String> {
        if on && self.assertion.is_none() {
            self.assertion = Some(create_assertion("PreventUserIdleSystemSleep")?);
        } else if !on {
            release_assertion(&mut self.assertion)?;
        }
        Ok(())
    }
    pub fn set_display(&mut self, on: bool) -> Result<(), String> {
        if on && self.display.is_none() {
            self.display = Some(create_assertion("PreventUserIdleDisplaySleep")?);
        } else if !on {
            release_assertion(&mut self.display)?;
        }
        Ok(())
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.set_display(false);
        let _ = self.set_awake(false);
    }
}

const RULE: &str = "/etc/sudoers.d/termic-caffeinate";
pub fn lid_supported() -> bool {
    lid_closed().is_some()
}
pub fn permission() -> bool {
    Path::new(RULE).is_file()
}
pub fn limited() -> bool {
    false
}
pub fn battery_low() -> bool {
    unsafe {
        let blob = IOPSCopyPowerSourcesInfo();
        if blob.is_null() {
            return false;
        }
        let list = IOPSCopyPowerSourcesList(blob);
        if list.is_null() {
            CFRelease(blob);
            return false;
        }
        let state = string("Power Source State");
        let battery = string("Battery Power");
        let current = string("Current Capacity");
        let maximum = string("Max Capacity");
        let mut low = false;
        for index in 0..CFArrayGetCount(list) {
            let description =
                IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(list, index));
            if description.is_null() {
                continue;
            }
            let source_state = CFDictionaryGetValue(description, state);
            if source_state.is_null() || !CFEqual(source_state, battery) {
                continue;
            }
            let c = CFDictionaryGetValue(description, current);
            let m = CFDictionaryGetValue(description, maximum);
            let mut capacity: i32 = 0;
            let mut total: i32 = 0;
            if !c.is_null()
                && !m.is_null()
                && CFNumberGetValue(c, 3, (&mut capacity as *mut i32).cast())
                && CFNumberGetValue(m, 3, (&mut total as *mut i32).cast())
                && total > 0
                && capacity >= 0
                && i64::from(capacity) * 100 <= i64::from(total) * 10
            {
                low = true;
            }
        }
        for value in [state, battery, current, maximum, list, blob] {
            CFRelease(value);
        }
        low
    }
}
pub fn set_permission(install: bool) -> Result<(), String> {
    let command = if install {
        let uid = unsafe { libc::getuid() };
        // Fixed command/arguments only, granted to the uid, not to an app path.
        format!("umask 077; mkdir -p /etc/sudoers.d && printf '%s\\n' '#{uid} ALL=(root) NOPASSWD: /usr/bin/pmset disablesleep 1, /usr/bin/pmset disablesleep 0' > {RULE}.tmp && chmod 0440 {RULE}.tmp && /usr/sbin/visudo -c -f {RULE}.tmp && mv {RULE}.tmp {RULE}")
    } else {
        format!("rm -f {RULE}")
    };
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("do shell script \"{escaped}\" with administrator privileges with prompt \"Termic needs permission to manage closed-lid sleep.\"");
    let result = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(
            "Closed-lid permission was not changed. Allow the administrator request to continue."
                .into(),
        );
    }
    Ok(())
}
fn disabled() -> Result<bool, String> {
    let output = Command::new("/usr/bin/pmset")
        .arg("-g")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cannot read macOS sleep setting".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let mut words = line.split_whitespace();
        if words.next() == Some("SleepDisabled") {
            return match words.next() {
                Some("1") => Ok(true),
                Some("0") => Ok(false),
                _ => Err("Unknown macOS sleep setting".into()),
            };
        }
    }
    // pmset omits the optional property on Macs where it has never been set.
    Ok(false)
}
fn write_disabled(on: bool) -> Result<(), String> {
    let result = Command::new("/usr/bin/sudo")
        .args([
            "-n",
            "/usr/bin/pmset",
            "disablesleep",
            if on { "1" } else { "0" },
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(if !on && !permission() {
            super::super::RESTORE_NEEDS_APPROVAL.into()
        } else {
            "Could not change macOS closed-lid sleep. Check closed-lid permission.".into()
        });
    }
    if disabled()? != on {
        return Err("macOS did not apply the closed-lid setting".into());
    }
    Ok(())
}
/// The fallback when the sudoers rule is gone: the user's own approval.
fn restore_as_administrator() -> Result<(), String> {
    let result = Command::new("/usr/bin/osascript")
        .args(["-e", "do shell script \"/usr/bin/pmset disablesleep 0\" with administrator privileges with prompt \"Termic needs administrator approval to restore normal sleep.\""])
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(
            "Normal sleep was not restored. Approve the administrator request, or run sudo pmset disablesleep 0 in Terminal."
                .into(),
        );
    }
    if disabled()? {
        return Err("macOS did not apply the closed-lid setting".into());
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    prior_disabled: bool,
}
pub struct Lid {
    owned: bool,
}
impl Lid {
    pub fn enable(path: &Path) -> Result<Self, String> {
        if disabled()? {
            return Err(
                "Sleep is already disabled by another app. Stop its closed-lid mode first.".into(),
            );
        }
        super::super::guard::save(
            path,
            &Journal {
                version: 1,
                prior_disabled: false,
            },
        )?;
        if let Err(error) = write_disabled(true) {
            let _ = recover(path, false);
            return Err(error);
        }
        // This observer is confined to the guard, whose exit releases it.
        std::thread::spawn(watch_lid);
        Ok(Self { owned: true })
    }
    pub fn restore(&mut self, path: &Path, resleep: bool) -> Result<(), String> {
        if self.owned {
            restore(path, resleep, false)?;
            self.owned = false;
        }
        Ok(())
    }
    pub fn check(&self) -> Result<(), String> {
        if disabled()? {
            Ok(())
        } else {
            Err("macOS sleep settings changed outside Termic".into())
        }
    }
}
pub fn recover(path: &Path, interactive: bool) -> Result<(), String> {
    restore(path, true, interactive)
}
fn restore(path: &Path, resleep: bool, interactive: bool) -> Result<(), String> {
    let journal: Journal = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if journal.version != 1 || journal.prior_disabled {
        return Err("Unrecognized closed-lid recovery record".into());
    }
    if disabled()? {
        match write_disabled(false) {
            Ok(()) => {}
            Err(_) if interactive => restore_as_administrator()?,
            Err(error) => return Err(error),
        }
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    // Re-evaluate a lid that closed while the global override was held.
    // AppleClamshellCausesSleep is false in supported docked configurations.
    if resleep
        && lid_closed() == Some(true)
        && property("AppleClamshellCausesSleep") == Some(true)
        && !other_sleep_blockers()
    {
        let connection = unsafe { IOPMFindPowerManagement(0) };
        if connection != 0 {
            unsafe {
                IOPMSleepSystem(connection);
                IOServiceClose(connection);
            }
        }
    }
    Ok(())
}
fn other_sleep_blockers() -> bool {
    let Ok(output) = Command::new("/usr/bin/pmset")
        .args(["-g", "assertions"])
        .output()
    else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    prevents_lid_sleep(&String::from_utf8_lossy(&output.stdout))
}
fn prevents_lid_sleep(assertions: &str) -> bool {
    assertions.lines().any(|line| {
        let mut fields = line.split_whitespace();
        matches!(fields.next(), Some("PreventSystemSleep"))
            && fields
                .next()
                .is_some_and(|n| n.parse::<u32>().unwrap_or(1) > 0)
    })
}
fn root() -> u32 {
    unsafe { IOServiceGetMatchingService(0, IOServiceMatching(c"IOPMrootDomain".as_ptr())) }
}
fn property(key: &str) -> Option<bool> {
    let service = root();
    if service == 0 {
        return None;
    }
    let key = string(key);
    let value = unsafe { IORegistryEntryCreateCFProperty(service, key, std::ptr::null(), 0) };
    unsafe {
        CFRelease(key);
        IOObjectRelease(service);
    }
    if value.is_null() {
        None
    } else {
        let result = unsafe { CFBooleanGetValue(value) };
        unsafe {
            CFRelease(value);
        }
        Some(result)
    }
}
fn lid_closed() -> Option<bool> {
    property("AppleClamshellState")
}
static WAS_CLOSED: AtomicBool = AtomicBool::new(false);
extern "C" fn changed(_: *mut c_void, _: u32, _: u32, _: *mut c_void) {
    let closed = lid_closed().unwrap_or(false);
    if closed
        && !WAS_CLOSED.swap(closed, Ordering::Relaxed)
        && property("AppleClamshellCausesSleep") == Some(true)
    {
        // Real display sleep. Password timing remains the user's lock setting.
        let _ = Command::new("/usr/bin/pmset")
            .arg("displaysleepnow")
            .output();
    } else if !closed {
        WAS_CLOSED.store(false, Ordering::Relaxed);
    }
}
fn watch_lid() {
    WAS_CLOSED.store(lid_closed().unwrap_or(true), Ordering::Relaxed);
    let service = root();
    if service == 0 {
        return;
    }
    unsafe {
        let port = IONotificationPortCreate(0);
        if port.is_null() {
            IOObjectRelease(service);
            return;
        }
        let mut notification = 0;
        if IOServiceAddInterestNotification(
            port,
            service,
            c"IOGeneralInterest".as_ptr(),
            changed,
            std::ptr::null_mut(),
            &mut notification,
        ) == 0
        {
            CFRunLoopAddSource(
                CFRunLoopGetCurrent(),
                IONotificationPortGetRunLoopSource(port),
                kCFRunLoopDefaultMode,
            );
            CFRunLoopRun();
        }
        IOObjectRelease(service);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_assertions_do_not_override_restored_lid_sleep() {
        assert!(!prevents_lid_sleep(
            "PreventUserIdleSystemSleep 1\nExternalMedia 1\nPreventSystemSleep 0"
        ));
        assert!(prevents_lid_sleep(
            "PreventSystemSleep 1\nPreventUserIdleSystemSleep 0"
        ));
    }
}
