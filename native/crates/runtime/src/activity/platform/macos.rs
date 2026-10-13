use serde_json::{Value, json};

pub(crate) fn request_permission() {
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
pub(crate) fn probe() -> Value {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    // Probe only: never open a permission dialog without an explicit host request.
    let granted = unsafe { AXIsProcessTrusted() };
    json!({"status":if granted {"granted"} else {"denied"}, "osStatus":if granted {"granted"} else {"denied"}, "ready":granted, "canRequest":true, "reason":if granted {"appkit_ready"} else {"accessibility_permission_denied"}})
}
pub(crate) fn capture() -> Result<Value, String> {
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
