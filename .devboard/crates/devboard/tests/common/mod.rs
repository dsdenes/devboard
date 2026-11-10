//! Helpers shared by the integration tests.

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
