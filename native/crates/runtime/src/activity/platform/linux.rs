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
pub(crate) fn capture() -> Result<Value, String> {
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
