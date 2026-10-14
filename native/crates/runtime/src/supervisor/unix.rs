use super::{Spec, digest};
use std::{
    io::{Read, Write},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub(super) struct Owned {
    guarded: bool,
    pub(super) role: String,
    pub(super) child: Child,
    pub(super) pid: u32,
}
impl Owned {
    pub(super) fn spawn(spec: &Spec) -> Result<Self, String> {
        use std::os::unix::process::CommandExt;
        let encoded = serde_json::to_vec(spec).map_err(|_| "supervisor_guard_invalid")?;
        let mut child =
            Command::new(std::env::current_exe().map_err(|_| "supervisor_guard_unavailable")?)
                .arg("guard")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .map_err(|_| "supervisor_spawn_failed")?;
        if child.stdin.as_mut().is_none_or(|s| {
            s.write_all(&encoded)
                .and_then(|_| s.write_all(b"\n"))
                .is_err()
        }) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("supervisor_guard_failed".into());
        }
        let pid = child.id();
        Ok(Self {
            guarded: true,
            role: spec.role.clone(),
            child,
            pid,
        })
    }
    pub(super) fn stop(&mut self) {
        // A private process group is created at spawn; never enumerate or kill foreign PIDs.
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGTERM);
        }
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(if self.guarded { 1200 } else { 500 }) {
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
// A small guardian owns each Unix child group and a private parent pipe. The
// kernel closes the pipe even after SIGKILL, so descendants are not orphaned
// when the supervisor cannot run its Drop implementation.
pub fn run_guard() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    static STOP: AtomicBool = AtomicBool::new(false);
    extern "C" fn terminate(_: i32) {
        STOP.store(true, Ordering::Release);
    }
    unsafe {
        libc::signal(libc::SIGTERM, terminate as *const () as usize);
        libc::signal(libc::SIGINT, terminate as *const () as usize);
    }
    let mut first = String::new();
    std::io::stdin()
        .read_line(&mut first)
        .map_err(|_| "supervisor_guard_declaration_invalid")?;
    if first.len() > 65536 {
        return Err("supervisor_guard_declaration_invalid".into());
    }
    let spec: Spec =
        serde_json::from_str(&first).map_err(|_| "supervisor_guard_declaration_invalid")?;
    if digest(&spec.executable)? != spec.sha256 {
        return Err("supervisor_digest_mismatch".into());
    }
    let alive = Arc::new(AtomicBool::new(true));
    let watcher = Arc::clone(&alive);
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16];
        while std::io::stdin().read(&mut buffer).is_ok_and(|n| n > 0) {}
        watcher.store(false, Ordering::Release);
    });
    let child = Command::new(&spec.executable)
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(&spec.env)
        .env("AERVOX_NATIVE_SUPERVISOR_MANAGED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| "supervisor_spawn_failed")?;
    let pid = child.id();
    let mut owned = Owned {
        guarded: false,
        role: spec.role,
        child,
        pid,
    };
    let mut status = None;
    while alive.load(Ordering::Acquire) && !STOP.load(Ordering::Acquire) {
        status = owned
            .child
            .try_wait()
            .map_err(|_| "supervisor_wait_failed")?;
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    owned.stop();
    if status.is_some_and(|s| !s.success()) {
        return Err("supervisor_child_failed".into());
    }
    Ok(())
}
