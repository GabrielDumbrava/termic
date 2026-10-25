use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    ptr::null_mut,
    sync::atomic::{AtomicU32, Ordering},
};
use windows_sys::{
    core::GUID,
    Win32::{
        Devices::Display::*,
        Foundation::{CloseHandle, GetLastError, LocalFree, SetLastError, HANDLE, LUID},
        Security::{
            AdjustTokenPrivileges, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED,
            TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
        },
        System::{
            Power::*,
            Shutdown::LockWorkStation,
            Threading::{GetCurrentProcess, OpenProcessToken, REASON_CONTEXT, REASON_CONTEXT_0},
        },
        UI::WindowsAndMessaging::{GetSystemMetrics, SM_SYSTEMDOCKED},
    },
};

const BUTTONS: GUID = GUID::from_u128(0x4f971e89_eebd_4455_a8de_9e59040e7347);
const LID_ACTION: GUID = GUID::from_u128(0x5ca83367_6e45_459f_a27b_476b1d01c936);
const LID_STATE: GUID = GUID::from_u128(0xba3e0f4d_b817_4094_a2d1_d56379e6a0f3);
static CURRENT_LID: AtomicU32 = AtomicU32::new(2); // unknown until first notification

// A closed internal panel can disappear from the desktop's active paths.
// Count output technologies rather than monitor count, and skip on query error.
fn external_display() -> Option<bool> {
    unsafe {
        if GetSystemMetrics(SM_SYSTEMDOCKED) != 0 {
            return Some(true);
        }
        for _ in 0..3 {
            let (mut paths, mut modes) = (0, 0);
            if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths, &mut modes) != 0 {
                return None;
            }
            if paths > 1024 || modes > 4096 {
                return None;
            }
            let mut path_data: Vec<DISPLAYCONFIG_PATH_INFO> =
                vec![std::mem::zeroed(); paths as usize];
            let mut mode_data: Vec<DISPLAYCONFIG_MODE_INFO> =
                vec![std::mem::zeroed(); modes as usize];
            let code = QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut paths,
                path_data.as_mut_ptr(),
                &mut modes,
                mode_data.as_mut_ptr(),
                null_mut(),
            );
            if code == 122 {
                continue;
            } // topology changed, retry with fresh sizes
            if code != 0 {
                return None;
            }
            return Some(path_data[..paths as usize].iter().any(|path| {
                !matches!(
                    path.targetInfo.outputTechnology,
                    DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL
                        | DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS
                        | DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED
                        | DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED
                )
            }));
        }
        None
    }
}

fn suspend_for_restored_lid(action: u32) -> Result<(), String> {
    if CURRENT_LID.load(Ordering::Relaxed) != 0
        || external_display() != Some(false)
        || !matches!(action, 1 | 2)
    {
        return Ok(());
    }
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let result = (|| {
            let mut luid = LUID::default();
            let name: Vec<u16> = "SeShutdownPrivilege\0".encode_utf16().collect();
            if LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut desired = TOKEN_PRIVILEGES::default();
            desired.PrivilegeCount = 1;
            desired.Privileges[0].Luid = luid;
            desired.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;
            let mut prior = TOKEN_PRIVILEGES::default();
            let mut length = 0;
            SetLastError(0);
            if AdjustTokenPrivileges(
                token,
                0,
                &desired,
                std::mem::size_of::<TOKEN_PRIVILEGES>() as u32,
                &mut prior,
                &mut length,
            ) == 0
                || GetLastError() != 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let slept = SetSuspendState(action == 2, false, false);
            let error = std::io::Error::last_os_error().to_string();
            AdjustTokenPrivileges(token, 0, &prior, 0, null_mut(), null_mut());
            if slept {
                Ok(())
            } else {
                Err(format!(
                    "Normal lid policy was restored, but Windows could not enter sleep: {error}"
                ))
            }
        })();
        CloseHandle(token);
        result
    }
}
fn checked(code: u32) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("Windows power setting failed ({code})"))
    }
}
#[derive(Default)]
pub struct Backend {
    request: Option<HANDLE>,
}
impl Backend {
    pub fn check(&self) -> Result<(), String> {
        Ok(())
    }
    pub fn set_awake(&mut self, on: bool) -> Result<(), String> {
        unsafe {
            if on && self.request.is_none() {
                let mut reason: Vec<u16> = "Termic\0".encode_utf16().collect();
                let context = REASON_CONTEXT {
                    Version: 0,
                    Flags: 1,
                    Reason: REASON_CONTEXT_0 {
                        SimpleReasonString: reason.as_mut_ptr(),
                    },
                };
                let handle = PowerCreateRequest(&context);
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                if PowerSetRequest(handle, PowerRequestSystemRequired) == 0 {
                    let error = std::io::Error::last_os_error().to_string();
                    CloseHandle(handle);
                    return Err(error);
                }
                self.request = Some(handle);
            } else if !on {
                if let Some(handle) = self.request {
                    if PowerClearRequest(handle, PowerRequestSystemRequired) == 0 {
                        return Err(std::io::Error::last_os_error().to_string());
                    }
                    CloseHandle(handle);
                    self.request = None;
                }
            }
        }
        Ok(())
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        let _ = self.set_awake(false);
    }
}
fn capabilities() -> SYSTEM_POWER_CAPABILITIES {
    let mut value = SYSTEM_POWER_CAPABILITIES::default();
    unsafe {
        GetPwrCapabilities(&mut value);
    }
    value
}
pub fn lid_supported() -> bool {
    capabilities().LidPresent
}
pub fn limited() -> bool {
    capabilities().AoAc
}
pub fn battery_low() -> bool {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe {
        GetSystemPowerStatus(&mut status) != 0
            && status.ACLineStatus == 0
            && status.BatteryLifePercent <= 10
    }
}
pub fn elapsed_ms() -> u64 {
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() }
}
pub fn permission() -> bool {
    unsafe {
        PowerSettingAccessCheck(ACCESS_AC_POWER_SETTING_INDEX, &LID_ACTION) == 0
            && PowerSettingAccessCheck(ACCESS_DC_POWER_SETTING_INDEX, &LID_ACTION) == 0
    }
}
pub fn set_permission(_: bool) -> Result<(), String> {
    Err("Windows power settings are controlled by your account or organization".into())
}
fn scheme() -> Result<GUID, String> {
    unsafe {
        let mut value = null_mut();
        checked(PowerGetActiveScheme(null_mut(), &mut value))?;
        if value.is_null() {
            return Err("Windows returned no active power plan".into());
        }
        let result = *value;
        LocalFree(value.cast());
        Ok(result)
    }
}
fn read(guid: &GUID, ac: bool) -> Result<u32, String> {
    let mut value = 0;
    unsafe {
        checked(if ac {
            PowerReadACValueIndex(null_mut(), guid, &BUTTONS, &LID_ACTION, &mut value)
        } else {
            PowerReadDCValueIndex(null_mut(), guid, &BUTTONS, &LID_ACTION, &mut value)
        })?;
    }
    Ok(value)
}
fn write(guid: &GUID, ac: bool, value: u32) -> Result<(), String> {
    unsafe {
        checked(if ac {
            PowerWriteACValueIndex(null_mut(), guid, &BUTTONS, &LID_ACTION, value)
        } else {
            PowerWriteDCValueIndex(null_mut(), guid, &BUTTONS, &LID_ACTION, value)
        })
    }
}
fn same(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
    ac: u32,
    dc: u32,
}
impl Journal {
    fn guid(&self) -> GUID {
        GUID {
            data1: self.data1,
            data2: self.data2,
            data3: self.data3,
            data4: self.data4,
        }
    }
}
pub struct Lid {
    guid: GUID,
    notification: *mut std::ffi::c_void,
    _subscribe: Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>,
}
impl Lid {
    pub fn enable(path: &Path) -> Result<Self, String> {
        if !permission() {
            return Err("Your Windows account cannot change the lid-close action".into());
        }
        let guid = scheme()?;
        let record = Journal {
            version: 1,
            data1: guid.data1,
            data2: guid.data2,
            data3: guid.data3,
            data4: guid.data4,
            ac: read(&guid, true)?,
            dc: read(&guid, false)?,
        };
        if record.ac > 3 || record.dc > 3 {
            return Err("Unknown Windows lid-close policy".into());
        }
        super::super::guard::save(path, &record)?;
        let result = (|| {
            write(&guid, true, 0)?;
            write(&guid, false, 0)?;
            if !same(&scheme()?, &guid) {
                return Err("The active power plan changed during setup".into());
            }
            unsafe {
                checked(PowerSetActiveScheme(null_mut(), &guid))?;
            }
            if read(&guid, true)? != 0 || read(&guid, false)? != 0 {
                return Err("Windows did not apply the lid-close policy".into());
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = recover(path);
            return Err(error);
        }
        let mut notification = null_mut();
        let subscribe = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(lid_changed),
            Context: null_mut(),
        });
        let result = unsafe {
            PowerSettingRegisterNotification(
                &LID_STATE,
                2,
                (&*subscribe as *const DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS)
                    .cast_mut()
                    .cast(),
                &mut notification,
            )
        };
        if result != 0 {
            let _ = recover(path);
            return Err(format!("Cannot monitor lid closure ({result})"));
        }
        Ok(Self {
            guid,
            notification,
            _subscribe: subscribe,
        })
    }
    pub fn check(&self) -> Result<(), String> {
        if !same(&scheme()?, &self.guid)
            || read(&self.guid, true)? != 0
            || read(&self.guid, false)? != 0
        {
            Err("The power plan changed outside Termic. Closed-lid mode has stopped.".into())
        } else {
            Ok(())
        }
    }
    pub fn restore(&mut self, path: &Path) -> Result<(), String> {
        unsafe {
            PowerSettingUnregisterNotification(self.notification as isize);
        }
        self.notification = null_mut();
        recover(path)
    }
}
unsafe extern "system" fn lid_changed(
    _: *const std::ffi::c_void,
    _: u32,
    setting: *const std::ffi::c_void,
) -> u32 {
    if !setting.is_null() {
        let value = &*setting.cast::<POWERBROADCAST_SETTING>();
        if same(&value.PowerSetting, &LID_STATE) && value.DataLength >= 4 {
            let state = std::ptr::read_unaligned(value.Data.as_ptr().cast::<u32>());
            let before = CURRENT_LID.swap(state, Ordering::Relaxed);
            if state == 0 && before == 1 && external_display() == Some(false) {
                LockWorkStation();
            }
        }
    }
    0
}
pub fn recover(path: &Path) -> Result<(), String> {
    let record: Journal = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if record.version != 1 || record.ac > 3 || record.dc > 3 {
        return Err("Unrecognized Windows lid recovery record".into());
    }
    let guid = record.guid();
    // Preserve independent user/app edits. Never activate an old plan.
    for (ac, original) in [(true, record.ac), (false, record.dc)] {
        if read(&guid, ac)? == 0 {
            write(&guid, ac, original)?;
        }
    }
    let current = same(&scheme()?, &guid);
    if current {
        unsafe {
            checked(PowerSetActiveScheme(null_mut(), &guid))?;
        }
    }
    if current {
        let mut power = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut power) } != 0 && power.ACLineStatus <= 1 {
            // Re-read after restoration, preserving any independent user edits.
            suspend_for_restored_lid(read(&guid, power.ACLineStatus == 1)?)?;
        }
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
