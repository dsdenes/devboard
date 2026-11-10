//! Helpers shared by the integration tests.

// Each test binary compiles this module for the helpers it uses and leaves the
// rest behind.
#![allow(dead_code)]

/// A loopback port that refuses every connection until the test opens it.
///
/// A port released with `drop(TcpListener)` can be claimed by any other test
/// that asks the kernel for an ephemeral port, and a connection aimed at the
/// "closed" port then reaches that unrelated listener. A socket that is bound
/// but never listens refuses every connection and holds the port exclusively,
/// so a refused-connection test stays true while the whole suite runs in
/// parallel. `listen` turns the same socket into the accepting listener, with
/// no window in which another process could take the port.
#[cfg(target_os = "linux")]
pub struct ReservedPort {
    fd: std::os::unix::io::RawFd,
    port: u16,
}

#[cfg(target_os = "linux")]
impl ReservedPort {
    pub fn bind() -> Self {
        use std::net::Ipv4Addr;
        unsafe {
            let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
            assert!(fd >= 0, "a socket");
            let address = libc::sockaddr_in {
                sin_family: libc::AF_INET as libc::sa_family_t,
                sin_port: 0,
                sin_addr: libc::in_addr {
                    s_addr: u32::from(Ipv4Addr::LOCALHOST).to_be(),
                },
                sin_zero: [0; 8],
            };
            let bound = libc::bind(
                fd,
                &address as *const libc::sockaddr_in as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
            );
            assert_eq!(bound, 0, "bind");
            let mut named: libc::sockaddr_in = std::mem::zeroed();
            let mut length = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
            let read = libc::getsockname(
                fd,
                &mut named as *mut libc::sockaddr_in as *mut libc::sockaddr,
                &mut length,
            );
            assert_eq!(read, 0, "getsockname");
            Self {
                fd,
                port: u16::from_be(named.sin_port),
            }
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Starts listening on the reserved port, returning the accept socket.
    pub fn listen(self) -> std::net::TcpListener {
        assert_eq!(unsafe { libc::listen(self.fd, 128) }, 0, "listen");
        let fd = self.fd;
        std::mem::forget(self);
        use std::os::unix::io::FromRawFd;
        unsafe { std::net::TcpListener::from_raw_fd(fd) }
    }
}

#[cfg(target_os = "linux")]
impl Drop for ReservedPort {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

/// Counts the reads of every file under one directory tree, so a test can
/// prove how many times the dashboard opened a state file. `IN_ACCESS` fires
/// on a read and never on a write, so the dashboard's own writes are not
/// counted.
#[cfg(target_os = "linux")]
pub struct AccessCounter {
    fd: std::os::unix::io::RawFd,
    directories: std::collections::HashMap<i32, std::path::PathBuf>,
}

#[cfg(target_os = "linux")]
impl AccessCounter {
    /// Watches one directory and every directory below it.
    pub fn watch(root: &std::path::Path) -> Self {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        assert!(fd >= 0, "inotify init");
        let mut counter = Self {
            fd,
            directories: std::collections::HashMap::new(),
        };
        let mut stack = vec![(root.to_path_buf(), 0usize)];
        while let Some((directory, depth)) = stack.pop() {
            let raw = CString::new(directory.as_os_str().as_bytes()).expect("a watched path");
            let wd = unsafe { libc::inotify_add_watch(fd, raw.as_ptr(), libc::IN_ACCESS) };
            assert!(wd >= 0, "inotify watch");
            counter.directories.insert(wd, directory.clone());
            if depth >= 6 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    stack.push((entry.path(), depth + 1));
                }
            }
        }
        counter
    }

    /// Every path read since the previous call, with its read count.
    pub fn take(&self) -> std::collections::HashMap<std::path::PathBuf, u64> {
        use std::os::unix::ffi::OsStrExt;
        let mut counts = std::collections::HashMap::new();
        let mut buffer = [0u8; 16384];
        loop {
            let read = unsafe {
                libc::read(
                    self.fd,
                    buffer.as_mut_ptr().cast::<libc::c_void>(),
                    buffer.len(),
                )
            };
            if read <= 0 {
                break;
            }
            let mut offset = 0usize;
            let read = read as usize;
            while offset + std::mem::size_of::<libc::inotify_event>() <= read {
                let event = unsafe {
                    std::ptr::read_unaligned(
                        buffer.as_ptr().add(offset).cast::<libc::inotify_event>(),
                    )
                };
                let name_start = offset + std::mem::size_of::<libc::inotify_event>();
                let name_end = name_start + event.len as usize;
                if name_end <= read && event.len > 0 && (event.mask & libc::IN_ACCESS) != 0 {
                    let raw = &buffer[name_start..name_end];
                    let name = std::ffi::OsStr::from_bytes(
                        &raw[..raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len())],
                    )
                    .to_string_lossy()
                    .into_owned();
                    if let Some(directory) = self.directories.get(&event.wd) {
                        let path = directory.join(name);
                        // A directory read is not a state-file read.
                        if path.is_file() {
                            *counts.entry(path).or_insert(0u64) += 1;
                        }
                    }
                }
                offset = name_end;
            }
        }
        counts
    }
}

#[cfg(target_os = "linux")]
impl Drop for AccessCounter {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}
