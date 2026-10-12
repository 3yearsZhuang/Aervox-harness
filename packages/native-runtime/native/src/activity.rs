use serde_json::{Value, json};
use std::time::{Duration, Instant, SystemTime};

pub struct Activity {
    observed: Option<(String, SystemTime)>,
    lease: Option<(Value, Instant, Duration, SystemTime)>,
    latest: Option<Value>,
    last_poll: Instant,
}
impl Default for Activity {
    fn default() -> Self {
        Self {
            observed: None,
            lease: None,
            latest: None,
            last_poll: Instant::now(),
        }
    }
}
impl Activity {
    pub fn poll(&mut self) {
        if self.lease.as_ref().is_none_or(|(_, start, ttl, wall)| {
            start.elapsed() >= *ttl || !wall.elapsed().is_ok_and(|d| d < *ttl)
        }) {
            self.revoke();
            return;
        }
        if self.last_poll.elapsed() < Duration::from_secs(1) {
            return;
        }
        self.last_poll = Instant::now();
        self.latest = if probe()["ready"] == true {
            capture().ok().map(|value| self.enrich(value))
        } else {
            None
        };
        if self.latest.is_none() {
            self.revoke();
        }
    }
    pub fn revoke(&mut self) {
        self.observed = None;
        self.lease = None;
        self.latest = None;
    }
    fn enrich(&mut self, mut value: Value) -> Value {
        let identity = format!("{}:{}", value["applicationId"], value["processId"]);
        if self
            .observed
            .as_ref()
            .is_none_or(|(old, _)| *old != identity)
        {
            self.observed = Some((identity, SystemTime::now()));
        }
        if let Some((_, start)) = self.observed.as_ref() {
            value["activeSinceMs"] = json!(
                start
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            );
            value["activeForMs"] = json!(start.elapsed().unwrap_or_default().as_millis() as u64);
        }
        value
    }
    pub fn handle(&mut self, method: &str, p: &Value) -> Result<Value, String> {
        match method {
            "activity.probe" => Ok(probe()),
            "activity.request" => {
                request_permission();
                Ok(probe())
            }
            "activity.revoke" => {
                self.revoke();
                Ok(json!({"stopped":true}))
            }
            "activity.lease" => {
                if self.lease.as_ref().is_some_and(|(l, _, _, _)| {
                    ["deviceId", "revisionId", "epoch"]
                        .iter()
                        .any(|k| l[*k] != p[*k])
                }) {
                    self.revoke();
                }
                for key in ["deviceId", "revisionId", "epoch"] {
                    if p[key]
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s.len() > 256)
                    {
                        return Err("activity_lease_invalid".into());
                    }
                }
                let ttl = p["ttlMs"]
                    .as_u64()
                    .filter(|n| *n > 0 && *n <= 15_000)
                    .ok_or("activity_lease_invalid")?;
                if p["source"].as_str() != Some("device.app_activity") {
                    return Err("activity_source_invalid".into());
                }
                if probe()["ready"] != true {
                    self.revoke();
                    return Err("activity_os_unavailable".into());
                }
                self.lease = Some((
                    p.clone(),
                    Instant::now(),
                    Duration::from_millis(ttl),
                    SystemTime::now(),
                ));
                self.latest = None;
                Ok(json!({"active":true}))
            }
            "activity.capture" => {
                let valid = self.lease.as_ref().is_some_and(|(l, start, ttl, wall)| {
                    start.elapsed() < *ttl
                        && wall.elapsed().is_ok_and(|d| d < *ttl)
                        && ["deviceId", "revisionId", "epoch"]
                            .iter()
                            .all(|k| l[*k] == p[*k])
                });
                if !valid {
                    self.revoke();
                    return Err("activity_lease_expired_or_mismatched".into());
                }
                // Re-probe for every read; neither an old handle nor a cached event grants access.
                if probe()["ready"] != true {
                    self.revoke();
                    return Err("activity_os_unavailable".into());
                }
                let value = self.enrich(capture()?);
                if probe()["ready"] != true {
                    self.revoke();
                    return Err("activity_os_revoked".into());
                }
                self.latest = Some(value.clone());
                Ok(json!({"records":[value]}))
            }
            _ => Err("activity_method_unknown".into()),
        }
    }
}
fn request_permission() {
    #[cfg(target_os = "macos")]
    unsafe {
        use std::ffi::c_void;
        #[link(name = "ApplicationServices", kind = "framework")]
        unsafe extern "C" {
            static kAXTrustedCheckOptionPrompt: *const c_void;
            fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        }
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            static kCFBooleanTrue: *const c_void;
            fn CFDictionaryCreate(
                allocator: *const c_void,
                keys: *const *const c_void,
                values: *const *const c_void,
                count: isize,
                key_callbacks: *const c_void,
                value_callbacks: *const c_void,
            ) -> *const c_void;
            fn CFRelease(value: *const c_void);
        }
        let key = kAXTrustedCheckOptionPrompt;
        let value = kCFBooleanTrue;
        let options = CFDictionaryCreate(
            std::ptr::null(),
            &key,
            &value,
            1,
            std::ptr::null(),
            std::ptr::null(),
        );
        if !options.is_null() {
            AXIsProcessTrustedWithOptions(options);
            CFRelease(options);
        }
    }
}
fn probe() -> Value {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        unsafe extern "C" {
            fn AXIsProcessTrusted() -> bool;
        }
        // Probe only: never open a permission dialog without an explicit host request.
        let granted = unsafe { AXIsProcessTrusted() };
        json!({"status":if granted {"granted"} else {"denied"}, "osStatus":if granted {"granted"} else {"denied"}, "ready":granted, "canRequest":true, "reason":if granted {"appkit_ready"} else {"accessibility_permission_denied"}})
    }
    #[cfg(target_os = "windows")]
    {
        match permission_ready() {
            Ok(_) => {
                json!({"status":"granted","osStatus":"granted","ready":true,"canRequest":false})
            }
            Err(e) => {
                json!({"status":"unavailable","osStatus":"unknown","ready":false,"canRequest":false,"reason":e})
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        match permission_ready() {
            Ok(_) => {
                json!({"status":"granted","osStatus":"granted","ready":true,"canRequest":false})
            }
            Err(e) => {
                json!({"status":"unavailable","osStatus":"unknown","ready":false,"canRequest":false,"reason":e})
            }
        }
    }
}
#[cfg(target_os = "windows")]
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
#[cfg(target_os = "linux")]
fn permission_ready() -> Result<(), String> {
    use x11rb::{
        connection::Connection,
        protocol::xproto::{AtomEnum, ConnectionExt},
    };
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Err("wayland_foreground_provider_unavailable".into());
    }
    let display = std::env::var("DISPLAY").map_err(|_| "x11_session_unavailable")?;
    if !display.starts_with(':') && !display.starts_with("unix:") {
        return Err("x11_remote_display_refused".into());
    }
    let (conn, screen) = x11rb::connect(None).map_err(|_| "x11_session_unavailable")?;
    let atom = conn
        .intern_atom(false, b"_NET_ACTIVE_WINDOW")
        .map_err(|_| "x11_atom_failed")?
        .reply()
        .map_err(|_| "x11_atom_failed")?
        .atom;
    let prop = conn
        .get_property(
            false,
            conn.setup().roots[screen].root,
            atom,
            AtomEnum::WINDOW,
            0,
            1,
        )
        .map_err(|_| "x11_property_failed")?
        .reply()
        .map_err(|_| "x11_property_failed")?;
    if prop
        .value32()
        .and_then(|mut p| p.next())
        .is_none_or(|p| p == 0)
    {
        return Err("x11_no_foreground".into());
    }
    Ok(())
}
fn capture() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSDate, NSRunLoop};
        objc2::rc::autoreleasepool(|_| {
            NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.001));
            let app = NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .ok_or("appkit_no_foreground")?;
            let pid = app.processIdentifier();
            if pid <= 0 {
                return Err("appkit_process_unavailable".into());
            }
            let bundle = app.bundleIdentifier().map(|s| s.to_string());
            Ok(
                json!({"applicationId":bundle.clone().unwrap_or_else(||format!("pid:{pid}")), "bundleId":bundle,"applicationName":app.localizedName().map(|s|s.to_string()),"processId":pid,"isFrontmost":true}),
            )
        })
    }
    #[cfg(target_os = "windows")]
    {
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
            Ok(
                json!({"applicationId":name,"applicationName":name,"processId":pid,"isFrontmost":true}),
            )
        }
    }
    #[cfg(target_os = "linux")]
    {
        use x11rb::{
            connection::Connection,
            protocol::xproto::{AtomEnum, ConnectionExt},
        };
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return Err("wayland_foreground_provider_unavailable".into());
        }
        let (conn, screen) = x11rb::connect(None).map_err(|_| "x11_session_unavailable")?;
        let root = conn.setup().roots[screen].root;
        let atom = |name: &[u8]| -> Result<u32, String> {
            Ok(conn
                .intern_atom(false, name)
                .map_err(|_| "x11_atom_failed")?
                .reply()
                .map_err(|_| "x11_atom_failed")?
                .atom)
        };
        let active = conn
            .get_property(
                false,
                root,
                atom(b"_NET_ACTIVE_WINDOW")?,
                AtomEnum::WINDOW,
                0,
                1,
            )
            .map_err(|_| "x11_property_failed")?
            .reply()
            .map_err(|_| "x11_property_failed")?;
        let window = active
            .value32()
            .and_then(|mut v| v.next())
            .filter(|w| *w != 0)
            .ok_or("x11_no_foreground")?;
        let p = conn
            .get_property(
                false,
                window,
                atom(b"_NET_WM_PID")?,
                AtomEnum::CARDINAL,
                0,
                1,
            )
            .map_err(|_| "x11_property_failed")?
            .reply()
            .map_err(|_| "x11_property_failed")?;
        let pid = p
            .value32()
            .and_then(|mut v| v.next())
            .filter(|p| *p > 0)
            .ok_or("x11_process_unavailable")?;
        let name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map_err(|_| "linux_process_access_denied")?;
        Ok(
            json!({"applicationId":name.trim(),"applicationName":name.trim(),"processId":pid,"isFrontmost":true}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_foreign_lease_cannot_capture() {
        let mut a = Activity::default();
        assert!(a.handle("activity.capture", &json!({})).is_err());
        a.lease = Some((
            json!({"deviceId":"a","revisionId":"r","epoch":"e"}),
            Instant::now(),
            Duration::from_secs(1),
            SystemTime::now(),
        ));
        assert!(
            a.handle(
                "activity.capture",
                &json!({"deviceId":"b","revisionId":"r","epoch":"e"})
            )
            .is_err()
        );
        assert!(a.lease.is_none());
    }
    #[test]
    fn expired_lease_discards_buffered_data() {
        let mut a = Activity::default();
        a.lease = Some((
            json!({}),
            Instant::now() - Duration::from_secs(1),
            Duration::from_millis(1),
            SystemTime::now(),
        ));
        a.latest = Some(json!({"applicationName":"old"}));
        a.poll();
        assert!(a.lease.is_none() && a.latest.is_none());
    }
}
