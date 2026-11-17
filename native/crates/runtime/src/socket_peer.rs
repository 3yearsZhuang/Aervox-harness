//! Host-only inspection of inherited FD 3. No database protocol, credentials,
//! new connection or path lookup is accepted as a substitute for that peer.
use serde::Serialize;

#[derive(Serialize)]
pub struct Peer {
    pid: u32,
    #[serde(rename = "parentPid")]
    parent_pid: u32,
    uid: u32,
    executable: String,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn inspect(fd: libc::c_int) -> Result<Peer, String> {
    use std::mem::{size_of, zeroed};
    // SAFETY: each buffer is sized for its OS socket API and remains alive for
    // the call. The child owns an inherited descriptor; no I/O or flag changes
    // are performed on the parent's shared socket description.
    let mut address: libc::sockaddr_storage = unsafe { zeroed() };
    let mut length = size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    if unsafe {
        libc::getpeername(
            fd,
            &mut address as *mut _ as *mut libc::sockaddr,
            &mut length,
        )
    } != 0
        || address.ss_family as libc::c_int != libc::AF_UNIX
    {
        return Err("socket_peer_requires_connected_unix_socket".into());
    }
    let mut kind: libc::c_int = 0;
    length = size_of::<libc::c_int>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            &mut kind as *mut _ as *mut libc::c_void,
            &mut length,
        )
    } != 0
        || length as usize != size_of::<libc::c_int>()
        || kind != libc::SOCK_STREAM
    {
        return Err("socket_peer_requires_stream".into());
    }
    let (pid, uid) = credentials(fd)?;
    if pid <= 0 {
        return Err("socket_peer_pid_unavailable".into());
    }
    let executable = executable(pid)?;
    Ok(Peer {
        pid: pid as u32,
        parent_pid: parent_pid(pid)?,
        uid,
        executable,
    })
}

#[cfg(target_os = "linux")]
fn credentials(fd: libc::c_int) -> Result<(libc::pid_t, libc::uid_t), String> {
    let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut peer as *mut _ as *mut libc::c_void,
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::ucred>()
    {
        return Err("socket_peer_credentials_unavailable".into());
    }
    Ok((peer.pid, peer.uid))
}

#[cfg(target_os = "macos")]
fn credentials(fd: libc::c_int) -> Result<(libc::pid_t, libc::uid_t), String> {
    let mut pid: libc::pid_t = 0;
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            &mut pid as *mut _ as *mut libc::c_void,
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of::<libc::pid_t>()
        || unsafe { libc::getpeereid(fd, &mut uid, &mut gid) } != 0
    {
        return Err("socket_peer_credentials_unavailable".into());
    }
    Ok((pid, uid))
}

#[cfg(target_os = "linux")]
fn parent_pid(pid: libc::pid_t) -> Result<u32, String> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))
        .map_err(|_| "socket_peer_process_unavailable")?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("PPid:"))
        .and_then(|value| value.trim().parse().ok())
        .ok_or("socket_peer_parent_unavailable".into())
}

#[cfg(target_os = "macos")]
fn parent_pid(pid: libc::pid_t) -> Result<u32, String> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    if unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size as libc::c_int,
        )
    } != size as libc::c_int
        || info.pbi_pid != pid as u32
    {
        return Err("socket_peer_parent_unavailable".into());
    }
    Ok(info.pbi_ppid)
}

#[cfg(target_os = "linux")]
fn executable(pid: libc::pid_t) -> Result<String, String> {
    let path = std::fs::read_link(format!("/proc/{pid}/exe"))
        .map_err(|_| "socket_peer_process_unavailable")?;
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or("socket_peer_executable_unavailable".into())
}

#[cfg(target_os = "macos")]
fn executable(pid: libc::pid_t) -> Result<String, String> {
    let mut buffer = [0_u8; 4096];
    if unsafe {
        libc::proc_pidpath(
            pid,
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as u32,
        )
    } <= 0
    {
        return Err("socket_peer_process_unavailable".into());
    }
    let path = std::ffi::CStr::from_bytes_until_nul(&buffer)
        .map_err(|_| "socket_peer_executable_unavailable")?
        .to_str()
        .map_err(|_| "socket_peer_executable_unavailable")?;
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or("socket_peer_executable_unavailable".into())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn inspect(_fd: i32) -> Result<Peer, String> {
    Err("socket_peer_platform_unsupported".into())
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    use super::inspect;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    #[test]
    fn observes_the_current_connected_peer_without_consuming_the_stream() {
        let (mut first, mut second) = std::os::unix::net::UnixStream::pair().unwrap();
        second.write_all(b"remain").unwrap();
        let peer = inspect(first.as_raw_fd()).unwrap();
        assert_eq!(peer.pid, std::process::id());
        assert_eq!(peer.uid, unsafe { libc::getuid() });
        assert!(!peer.executable.is_empty());
        let mut bytes = [0; 6];
        first.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"remain");
    }
    #[test]
    fn rejects_files_and_internet_sockets() {
        let file = std::fs::File::open("/dev/null").unwrap();
        assert!(inspect(file.as_raw_fd()).is_err());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        assert!(inspect(client.as_raw_fd()).is_err());
    }
}
