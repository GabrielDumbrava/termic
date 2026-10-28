#[cfg(all(target_os = "macos", not(feature = "e2e")))]
#[path = "macos.rs"]
mod native;
#[cfg(all(windows, not(feature = "e2e")))]
#[path = "windows.rs"]
mod native;
#[cfg(all(target_os = "linux", not(feature = "e2e")))]
#[path = "linux.rs"]
mod native;
#[cfg(any(
    feature = "e2e",
    not(any(target_os = "macos", windows, target_os = "linux"))
))]
mod native {
    use std::{
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
    };
    static PERMISSION: AtomicBool = AtomicBool::new(true);
    #[derive(Default)]
    pub struct Backend;
    impl Backend {
        pub fn check(&self) -> Result<(), String> {
            Ok(())
        }
        pub fn set_awake(&mut self, on: bool) -> Result<(), String> {
            if on && !cfg!(feature = "e2e") {
                return Err("Sleep prevention is unavailable on this OS".into());
            }
            if cfg!(feature = "e2e")
                && on
                && crate::global_dir().is_ok_and(|p| p.join("e2e-caffeinate-fail").exists())
            {
                Err("Simulated power adapter failure".into())
            } else {
                Ok(())
            }
        }
        pub fn set_display(&mut self, _on: bool) -> Result<(), String> {
            Ok(())
        }
    }
    pub fn lid_supported() -> bool {
        cfg!(feature = "e2e")
    }
    pub fn permission() -> bool {
        PERMISSION.load(Ordering::Relaxed)
    }
    pub fn set_permission(value: bool) -> Result<(), String> {
        #[cfg(all(feature = "e2e", unix))]
        {
            use std::os::unix::fs::FileTypeExt;
            let gate = crate::global_dir()
                .map_err(|e| e.to_string())?
                .join("e2e-caffeinate-permission-gate");
            if std::fs::metadata(&gate).is_ok_and(|m| m.file_type().is_fifo()) {
                // A written e2e case holds this pipe open to model a pending
                // administrator prompt, without touching real OS permission.
                std::fs::read(gate).map_err(|e| e.to_string())?;
            }
        }
        PERMISSION.store(value, Ordering::Relaxed);
        Ok(())
    }
    pub fn limited() -> bool {
        false
    }
    pub fn battery_low() -> bool {
        false
    }
    pub fn elapsed_ms() -> u64 {
        // A shared origin is essential for parent/guard deadline tests.
        // Production adapters use the OS suspend-aware monotonic clock.
        super::super::now_ms()
    }
    pub fn recover(path: &Path, interactive: bool) -> Result<(), String> {
        if cfg!(feature = "e2e") && path.exists() {
            // A written e2e case models a revoked macOS permission: only the
            // interactive restore (the administrator prompt) can clear it.
            let revoked = path.with_extension("needs-approval");
            if revoked.exists() {
                if !interactive {
                    return Err(super::super::RESTORE_NEEDS_APPROVAL.into());
                }
                std::fs::remove_file(revoked).map_err(|e| e.to_string())?;
            }
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub struct Lid;
    impl Lid {
        pub fn enable(path: &Path) -> Result<Self, String> {
            if cfg!(feature = "e2e") {
                super::super::guard::save(path, &"fake lid override")?;
            }
            Ok(Self)
        }
        pub fn check(&self) -> Result<(), String> {
            Ok(())
        }
        pub fn restore(&mut self, path: &Path, _resleep: bool) -> Result<(), String> {
            recover(path, false)
        }
    }
}
pub(super) use native::*;
