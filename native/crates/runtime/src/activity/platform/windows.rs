use serde_json::{Value, json};

pub(crate) fn request_permission() {}
pub(crate) fn probe() -> Value {
    match permission_ready() {
        Ok(_) => {
            json!({"status":"granted","osStatus":"granted","ready":true,"canRequest":false})
        }
        Err(e) => {
            json!({"status":"unavailable","osStatus":"unknown","ready":false,"canRequest":false,"reason":e})
        }
    }
}
fn permission_ready() -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return Err("windows_no_foreground".into());
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err("windows_process_access_denied".into());
        }
        CloseHandle(handle);
        Ok(())
    }
}
pub(crate) fn capture() -> Result<Value, String> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
        },
        UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId},
    };
    // No window title, command line, elevation or protected-process bypass.
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return Err("windows_no_foreground".into());
        }
        let mut pid = 0;
        GetWindowThreadProcessId(window, &mut pid);
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Err("windows_process_access_denied".into());
        }
        let mut name = vec![0u16; 32768];
        let mut length = name.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, name.as_mut_ptr(), &mut length);
        CloseHandle(handle);
        if ok == 0 {
            return Err("windows_process_access_denied".into());
        }
        let path = String::from_utf16_lossy(&name[..length as usize]);
        let name = path.rsplit('\\').next().unwrap_or("unknown");
        Ok(json!({"applicationId":name,"applicationName":name,"processId":pid,"isFrontmost":true}))
    }
}
