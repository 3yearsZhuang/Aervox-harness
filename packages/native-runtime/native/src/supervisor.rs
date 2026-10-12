use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    protocol: u8,
    version: String,
    data_dir: PathBuf,
    processes: Vec<Spec>,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spec {
    role: String,
    executable: PathBuf,
    sha256: String,
    args: Vec<String>,
    cwd: PathBuf,
    #[serde(default)]
    env: BTreeMap<String, String>,
    ready: Option<Ready>,
    #[serde(default = "startup_ms")]
    startup_ms: u64,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    port: u16,
    path: String,
    token_env: Option<String>,
}
fn startup_ms() -> u64 {
    10_000
}
struct Owned {
    #[cfg(unix)]
    guarded: bool,
    role: String,
    child: Child,
    pid: u32,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}
pub struct Supervisor {
    manifest: Manifest,
    _lock: File,
    children: Vec<Owned>,
    failures: BTreeMap<String, String>,
}
fn digest(path: &PathBuf) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "supervisor_executable_missing")?;
    if file
        .metadata()
        .map_err(|_| "supervisor_executable_missing")?
        .len()
        > 512 * 1024 * 1024
    {
        return Err("supervisor_executable_limit".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| "supervisor_executable_read_failed")?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
impl Supervisor {
    pub fn open(path: &str) -> Result<Self, String> {
        let file = File::open(path).map_err(|_| "supervisor_manifest_missing")?;
        if file
            .metadata()
            .map_err(|_| "supervisor_manifest_invalid")?
            .len()
            > 65536
        {
            return Err("supervisor_manifest_limit".into());
        }
        let manifest: Manifest =
            serde_json::from_reader(file).map_err(|_| "supervisor_manifest_invalid")?;
        if manifest.protocol != 1
            || manifest.version.is_empty()
            || manifest.version.len() > 128
            || !manifest.data_dir.is_absolute()
            || manifest.processes.is_empty()
            || manifest.processes.len() > 8
        {
            return Err("supervisor_manifest_invalid".into());
        }
        let mut roles = HashSet::new();
        for spec in &manifest.processes {
            if !["api", "worker", "model"].contains(&spec.role.as_str())
                || !roles.insert(&spec.role)
                || !spec.executable.is_absolute()
                || !spec.cwd.is_absolute()
                || spec.sha256.len() != 64
                || spec.args.len() > 64
                || spec.args.iter().any(|a| a.len() > 8192)
                || spec.env.len() > 32
                || spec
                    .env
                    .iter()
                    .any(|(k, v)| k.len() > 128 || v.len() > 8192)
                || spec.startup_ms == 0
                || spec.startup_ms > 30_000
                || spec.ready.as_ref().is_some_and(|r| {
                    r.port == 0
                        || !r.path.starts_with('/')
                        || r.path.len() > 128
                        || r.path.contains(['\r', '\n'])
                })
            {
                return Err("supervisor_manifest_invalid".into());
            }
        }
        let existed = manifest.data_dir.exists();
        std::fs::create_dir_all(&manifest.data_dir)
            .map_err(|_| "supervisor_data_directory_unavailable")?;
        #[cfg(unix)]
        if !existed {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&manifest.data_dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "supervisor_data_directory_unavailable")?;
        }
        #[cfg(windows)]
        let _ = existed;
        let lock_path = manifest.data_dir.join("native-supervisor.lock");
        if std::fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("supervisor_lock_symlink".into());
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options
            .open(lock_path)
            .map_err(|_| "supervisor_lock_unavailable")?;
        lock.try_lock_exclusive()
            .map_err(|_| "supervisor_already_owned")?;
        Ok(Self {
            manifest,
            _lock: lock,
            children: Vec::new(),
            failures: BTreeMap::new(),
        })
    }
    pub fn reap(&mut self) {
        let mut i = 0;
        while i < self.children.len() {
            if self.children[i].child.try_wait().ok().flatten().is_some() {
                let mut owned = self.children.remove(i);
                owned.stop();
                self.failures
                    .insert(owned.role.clone(), "process_exited".into());
            } else {
                i += 1;
            }
        }
    }
    fn start(&mut self) -> Result<(), String> {
        self.reap();
        if !self.children.is_empty() {
            return Err("supervisor_already_started".into());
        }
        self.failures.clear();
        // Preflight every executable and port before starting the first child.
        for spec in &self.manifest.processes {
            if digest(&spec.executable)? != spec.sha256 {
                return Err("supervisor_digest_mismatch".into());
            }
            if !spec.cwd.is_dir() {
                return Err("supervisor_cwd_missing".into());
            }
            if spec.ready.as_ref().is_some_and(|r| {
                TcpStream::connect_timeout(
                    &SocketAddr::from(([127, 0, 0, 1], r.port)),
                    Duration::from_millis(100),
                )
                .is_ok()
            }) {
                return Err("supervisor_port_occupied".into());
            }
        }
        for mut spec in self.manifest.processes.clone() {
            spec.env.insert(
                "AERVOX_EXTERNAL_MODEL_OWNER".into(),
                if self.manifest.processes.iter().any(|p| p.role == "model") {
                    "1"
                } else {
                    "0"
                }
                .into(),
            );
            #[cfg(windows)]
            let mut command = Command::new(&spec.executable);
            #[cfg(unix)]
            let mut command =
                Command::new(std::env::current_exe().map_err(|_| "supervisor_guard_unavailable")?);
            #[cfg(windows)]
            command
                .args(&spec.args)
                .current_dir(&spec.cwd)
                .envs(&spec.env)
                .env("AERVOX_NATIVE_SUPERVISOR_MANAGED", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command
                    .arg("guard")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
                command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
            }
            let child = match command.spawn() {
                Ok(c) => c,
                Err(_) => {
                    self.stop();
                    return Err("supervisor_spawn_failed".into());
                }
            };
            #[cfg(unix)]
            let mut child = child;
            #[cfg(unix)]
            {
                let encoded = serde_json::to_vec(&spec).map_err(|_| "supervisor_guard_invalid")?;
                if child.stdin.as_mut().is_none_or(|s| {
                    s.write_all(&encoded)
                        .and_then(|_| s.write_all(b"\n"))
                        .is_err()
                }) {
                    let _ = child.kill();
                    let _ = child.wait();
                    self.stop();
                    return Err("supervisor_guard_failed".into());
                }
            }
            let pid = child.id();
            #[cfg(windows)]
            let job = match attach_job(&child) {
                Ok(job) => job,
                Err(e) => {
                    let mut c = child;
                    let _ = c.kill();
                    let _ = c.wait();
                    self.stop();
                    return Err(e);
                }
            };
            self.children.push(Owned {
                #[cfg(unix)]
                guarded: true,
                role: spec.role.clone(),
                child,
                pid,
                #[cfg(windows)]
                job,
            });
            let begin = Instant::now();
            loop {
                if !crate::INPUT_OPEN.load(std::sync::atomic::Ordering::Acquire) {
                    self.stop();
                    return Err("supervisor_owner_disconnected".into());
                }
                if self
                    .children
                    .last_mut()
                    .unwrap()
                    .child
                    .try_wait()
                    .map_err(|_| "supervisor_wait_failed")?
                    .is_some()
                {
                    self.stop();
                    return Err("supervisor_startup_exit".into());
                }
                if spec
                    .ready
                    .as_ref()
                    .is_none_or(|ready| http_ready(ready, &spec.env))
                {
                    break;
                }
                if begin.elapsed() >= Duration::from_millis(spec.startup_ms) {
                    self.stop();
                    return Err("supervisor_readiness_timeout".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Ok(())
    }
    fn stop(&mut self) {
        for child in self.children.iter_mut().rev() {
            child.stop();
        }
        self.children.clear();
    }
    pub fn handle(&mut self, method: &str, _p: &Value) -> Result<Value, String> {
        match method {
            "supervisor.start" => self.start()?,
            "supervisor.stop" => self.stop(),
            "supervisor.status" => self.reap(),
            _ => return Err("supervisor_method_unknown".into()),
        }
        Ok(
            json!({"version":self.manifest.version,"processes":self.children.iter().map(|c|json!({"role":c.role,"pid":c.pid,"state":"ready"})).collect::<Vec<_>>(),"failures":self.failures}),
        )
    }
}

// A small guardian owns each Unix child group and a private parent pipe. The
// kernel closes the pipe even after SIGKILL, so descendants are not orphaned
// when the supervisor cannot run its Drop implementation.
#[cfg(unix)]
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
impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}
impl Owned {
    fn stop(&mut self) {
        #[cfg(unix)]
        {
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
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle, System::JobObjects::TerminateJobObject,
            };
            TerminateJobObject(self.job, 1);
            CloseHandle(self.job);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn http_ready(r: &Ready, env: &BTreeMap<String, String>) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], r.port)),
        Duration::from_millis(100),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(100)));
    let authorization = match r.token_env.as_ref() {
        Some(key) => match env.get(key) {
            Some(value) if !value.is_empty() && !value.contains(['\r', '\n', '\0']) => {
                format!("Authorization: Bearer {value}\r\n")
            }
            _ => return false,
        },
        None => String::new(),
    };
    if write!(
        stream,
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\n{authorization}Connection: close\r\n\r\n",
        r.path
    )
    .is_err()
    {
        return false;
    }
    let mut buffer = [0u8; 256];
    let Ok(n) = stream.read(&mut buffer) else {
        return false;
    };
    buffer[..n].starts_with(b"HTTP/1.1 200 ") || buffer[..n].starts_with(b"HTTP/1.0 200 ")
}
#[cfg(windows)]
fn attach_job(child: &Child) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
    };
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtResumeProcess(handle: windows_sys::Win32::Foundation::HANDLE) -> i32;
    }
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("supervisor_job_failed".into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
            || NtResumeProcess(child.as_raw_handle()) < 0
        {
            CloseHandle(job);
            return Err("supervisor_job_failed".into());
        }
        Ok(job)
    }
}
