use super::Spec;
use std::process::{Child, Command, Stdio};

pub(super) struct Owned {
    pub(super) role: String,
    pub(super) child: Child,
    pub(super) pid: u32,
    job: windows_sys::Win32::Foundation::HANDLE,
}
impl Owned {
    pub(super) fn spawn(spec: &Spec) -> Result<Self, String> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        let mut child = Command::new(&spec.executable)
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .envs(&spec.env)
            .env("AERVOX_NATIVE_SUPERVISOR_MANAGED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()
            .map_err(|_| "supervisor_spawn_failed")?;
        let job = match attach_job(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let pid = child.id();
        Ok(Self {
            role: spec.role.clone(),
            child,
            pid,
            job,
        })
    }
    pub(super) fn stop(&mut self) {
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
