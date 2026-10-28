use std::path::Path;
use zbus::{
    blocking::{connection::Builder, Connection, Proxy},
    zvariant::{OwnedFd, OwnedObjectPath},
};

fn system() -> Result<Connection, String> {
    Builder::system()
        .map_err(|e| e.to_string())?
        .method_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}

pub fn elapsed_ms() -> u64 {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    #[cfg(target_os = "linux")]
    let clock = libc::CLOCK_BOOTTIME;
    #[cfg(not(target_os = "linux"))]
    let clock = libc::CLOCK_MONOTONIC;
    if unsafe { libc::clock_gettime(clock, &mut time) } == 0 {
        (time.tv_sec.max(0) as u64).saturating_mul(1000) + time.tv_nsec.max(0) as u64 / 1_000_000
    } else {
        0
    }
}
fn inhibit(what: &str) -> Result<(Connection, OwnedFd), String> {
    let connection = system()?;
    let fd: OwnedFd = {
        let proxy = Proxy::new(
            &connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .map_err(|e| e.to_string())?;
        proxy
            .call("Inhibit", &(what, "Termic", "Termic agent work", "block"))
            .map_err(|e| e.to_string())?
    };
    use std::os::fd::AsRawFd;
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
    if flags < 0
        || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok((connection, fd))
}
#[derive(Default)]
pub struct Backend {
    held: Option<(Connection, OwnedFd)>,
    // logind has no display inhibitor; blanking belongs to the desktop
    // session, which drops the inhibit when this connection closes.
    display: Option<Connection>,
}
impl Backend {
    pub fn check(&self) -> Result<(), String> {
        let Some((connection, _)) = &self.held else {
            return Ok(());
        };
        check_inhibitor(connection, "sleep")
    }
    pub fn set_awake(&mut self, on: bool) -> Result<(), String> {
        if on && self.held.is_none() {
            self.held = Some(inhibit("sleep")?);
        } else if !on {
            self.held.take();
        }
        Ok(())
    }
    pub fn set_display(&mut self, on: bool) -> Result<(), String> {
        if on && self.display.is_none() {
            let connection = Builder::session()
                .map_err(|e| e.to_string())?
                .method_timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(|e| e.to_string())?;
            Proxy::new(
                &connection,
                "org.freedesktop.ScreenSaver",
                "/org/freedesktop/ScreenSaver",
                "org.freedesktop.ScreenSaver",
            )
            .map_err(|e| e.to_string())?
            .call::<_, _, u32>("Inhibit", &("Termic", "Termic agent work"))
            .map_err(|e| e.to_string())?;
            self.display = Some(connection);
        } else if !on {
            self.display.take();
        }
        Ok(())
    }
}
pub fn lid_supported() -> bool {
    Path::new("/run/systemd/seats").is_dir()
}
pub fn permission() -> bool {
    true
} // logind/polkit returns the authoritative decision at acquisition.
pub fn limited() -> bool {
    true
} // Desktop lid handling needs per-session verification.
pub fn battery_low() -> bool {
    battery_low_at(Path::new("/sys/class/power_supply"))
}
fn battery_low_at(root: &Path) -> bool {
    std::fs::read_dir(root).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let path = entry.path();
            std::fs::read_to_string(path.join("type")).is_ok_and(|s| s.trim() == "Battery")
                && !std::fs::read_to_string(path.join("scope")).is_ok_and(|s| s.trim() == "Device")
                && std::fs::read_to_string(path.join("status"))
                    .is_ok_and(|s| s.trim() == "Discharging")
                && std::fs::read_to_string(path.join("capacity"))
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok())
                    .is_some_and(|n| n <= 10)
        })
    })
}
pub fn set_permission(_: bool) -> Result<(), String> {
    Ok(())
}
pub fn recover(_: &Path, _: bool) -> Result<(), String> {
    Ok(())
}
pub struct Lid {
    held: Option<(Connection, OwnedFd)>,
}
impl Lid {
    pub fn enable(_: &Path) -> Result<Self, String> {
        let held = inhibit("handle-lid-switch")?;
        // Lock only the calling desktop session. The guard remains alive while
        // locked; no idle/screensaver inhibitor is taken.
        let connection = system()?;
        let power = Proxy::new(
            &connection,
            "org.freedesktop.UPower",
            "/org/freedesktop/UPower",
            "org.freedesktop.UPower",
        )
        .map_err(|e| e.to_string())?;
        if !power
            .get_property::<bool>("LidIsPresent")
            .map_err(|e| e.to_string())?
        {
            return Err("No supported Linux lid sensor is available".into());
        }
        let manager = Proxy::new(
            &connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .map_err(|e| e.to_string())?;
        let session: OwnedObjectPath = manager
            .call("GetSession", &("auto",))
            .or_else(|_| manager.call("GetSessionByPID", &(std::process::id(),)))
            .map_err(|e| e.to_string())?;
        drop(manager);
        drop(power);
        std::thread::spawn(move || {
            let Ok(session) = Proxy::new(
                &connection,
                "org.freedesktop.login1",
                session.as_str(),
                "org.freedesktop.login1.Session",
            ) else {
                return;
            };
            let Ok(power) = Proxy::new(
                &connection,
                "org.freedesktop.UPower",
                "/org/freedesktop/UPower",
                "org.freedesktop.UPower",
            ) else {
                return;
            };
            // The property stream begins with its current value. Enabling a
            // session while already closed is not a new lid-close gesture.
            let mut was_closed = power.get_property::<bool>("LidIsClosed").unwrap_or(true);
            let mut changes = power.receive_property_changed::<bool>("LidIsClosed");
            for change in &mut changes {
                let Ok(closed) = change.get() else {
                    continue;
                };
                let newly_closed = closed && !was_closed;
                was_closed = closed;
                let docked = Proxy::new(
                    &connection,
                    "org.freedesktop.login1",
                    "/org/freedesktop/login1",
                    "org.freedesktop.login1.Manager",
                )
                .and_then(|p| p.get_property::<bool>("Docked"))
                .unwrap_or(true);
                if newly_closed && !docked {
                    let _: Result<(), _> = session.call("Lock", &());
                }
            }
        });
        Ok(Self { held: Some(held) })
    }
    pub fn check(&self) -> Result<(), String> {
        let Some((connection, _)) = &self.held else {
            return Err("Lid inhibitor was released".into());
        };
        check_inhibitor(connection, "handle-lid-switch")
    }
    pub fn restore(&mut self, _: &Path, _: bool) -> Result<(), String> {
        self.held.take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peripheral_batteries_do_not_stop_a_session() {
        let root = tempfile::tempdir().unwrap();
        let write = |name: &str, scope: &str, capacity: &str| {
            let battery = root.path().join(name);
            std::fs::create_dir_all(&battery).unwrap();
            for (key, value) in [
                ("type", "Battery"),
                ("scope", scope),
                ("status", "Discharging"),
                ("capacity", capacity),
            ] {
                std::fs::write(battery.join(key), value).unwrap();
            }
        };
        write("mouse", "Device", "2");
        write("BAT0", "System", "90");
        assert!(!battery_low_at(root.path()));
        std::fs::write(root.path().join("BAT0/capacity"), "10").unwrap();
        assert!(battery_low_at(root.path()));
    }
}
fn check_inhibitor(connection: &Connection, kind: &str) -> Result<(), String> {
    let proxy = Proxy::new(
        connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .map_err(|e| e.to_string())?;
    let inhibitors: Vec<(String, String, String, String, u32, u32)> = proxy
        .call("ListInhibitors", &())
        .map_err(|e| e.to_string())?;
    if inhibitors
        .iter()
        .any(|(what, _, _, _, _, pid)| what == kind && *pid == std::process::id())
    {
        Ok(())
    } else {
        Err("A Linux power inhibitor was lost".into())
    }
}
