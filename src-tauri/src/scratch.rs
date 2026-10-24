//! Scratch disks and recovery files.
//!
//! The editor pages old history to scratch files when images outgrow the
//! memory the user allows (see src/core/scratch.ts). Up to four folders can be
//! chosen in Preferences; each gets a "Classic Image Editor Scratch" folder
//! with one sub-folder per running editor, locked while it runs, so folders
//! left behind by a crash are recognised and removed at the next start.
//! Recovery copies of changed images go to "Recovery" in the first scratch
//! disk; the copies of an editor that crashed are offered when it starts again.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const ROOT: &str = "Classic Image Editor Scratch";
const RECOVERY: &str = "Recovery";
/// Space left free on a scratch disk for the rest of the system.
const MARGIN: u64 = 512 * 1024 * 1024;

struct State {
    session: String,
    /// The chosen folders (or the system's temporary folder).
    roots: Vec<PathBuf>,
    /// Lock files held open while the editor runs, one per folder used.
    locks: HashMap<PathBuf, File>,
    /// Scratch file name -> where it is.
    packs: HashMap<String, PathBuf>,
    /// Every recovery folder this editor has written to (the first scratch disk can change).
    recovery_dirs: Vec<PathBuf>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = g.get_or_insert_with(|| {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        State { session: format!("s{}-{}", std::process::id(), t), roots: vec![std::env::temp_dir()], locks: HashMap::new(), packs: HashMap::new(), recovery_dirs: Vec::new() }
    });
    f(st)
}

#[derive(serde::Serialize)]
pub struct DiskInfo {
    path: String,
    free: u64,
    total: u64,
    ok: bool,
    error: Option<String>,
}

fn disk_info(p: &Path) -> DiskInfo {
    let path = p.to_string_lossy().into_owned();
    if !p.is_dir() {
        return DiskInfo { path, free: 0, total: 0, ok: false, error: Some("the folder does not exist".into()) };
    }
    match (fs4::available_space(p), fs4::total_space(p)) {
        (Ok(free), Ok(total)) => DiskInfo { path, free, total, ok: true, error: None },
        (Err(e), _) | (_, Err(e)) => DiskInfo { path, free: 0, total: 0, ok: false, error: Some(e.to_string()) },
    }
}

/// This editor's folder on a scratch disk, created (and locked) on first use.
fn session_dir(st: &mut State, root: &Path) -> Result<PathBuf, String> {
    let dir = root.join(ROOT).join(&st.session);
    if !st.locks.contains_key(&dir) {
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not use the scratch folder {}: {e}", root.display()))?;
        let f = File::create(dir.join("lock")).map_err(|e| e.to_string())?;
        f.try_lock().map_err(|e| format!("could not lock the scratch folder: {e:?}"))?;
        st.locks.insert(dir.clone(), f);
    }
    Ok(dir)
}

/// Is another editor using this session folder? (Its lock file is held.)
fn in_use(dir: &Path) -> bool {
    match File::open(dir.join("lock")) {
        Ok(f) => match f.try_lock() {
            Ok(()) => {
                let _ = f.unlock();
                false
            }
            Err(_) => true,
        },
        Err(_) => false,
    }
}

/// Remove folders left by editors that are no longer running (not their recovery files).
fn clean(root: &Path, own: &str) {
    let Ok(rd) = std::fs::read_dir(root.join(ROOT)) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == RECOVERY || name == own || !e.path().is_dir() {
            continue;
        }
        if !in_use(&e.path()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Use these folders as scratch disks, in order (empty: the system's temporary folder).
/// Returns each one's free space. Files already written stay where they are.
#[tauri::command(async)]
pub fn scratch_configure(dirs: Vec<String>) -> Result<Vec<DiskInfo>, String> {
    with_state(|st| {
        let roots: Vec<PathBuf> = if dirs.is_empty() { vec![std::env::temp_dir()] } else { dirs.iter().map(PathBuf::from).collect() };
        let mut infos: Vec<DiskInfo> = roots.iter().map(|r| disk_info(r)).collect();
        let own = st.session.clone();
        // Keep the folders that can really be used (exist, writable, lockable), in order.
        let mut usable = Vec::new();
        for (r, info) in roots.iter().zip(infos.iter_mut()) {
            if !info.ok {
                continue;
            }
            clean(r, &own);
            match session_dir(st, r) {
                Ok(_) => usable.push(r.clone()),
                Err(e) => {
                    info.ok = false;
                    info.error = Some(e);
                }
            }
        }
        if usable.is_empty() {
            let tmp = std::env::temp_dir();
            clean(&tmp, &own);
            session_dir(st, &tmp)?;
            usable.push(tmp);
        }
        st.roots = usable;
        Ok(infos)
    })
}

/// Free and total space of folders (Preferences shows them).
#[tauri::command]
pub fn scratch_disk_info(dirs: Vec<String>) -> Vec<DiskInfo> {
    let dirs: Vec<PathBuf> = if dirs.is_empty() { vec![std::env::temp_dir()] } else { dirs.iter().map(PathBuf::from).collect() };
    dirs.iter().map(|d| disk_info(d)).collect()
}

/// The system's temporary folder (the default scratch disk).
#[tauri::command]
pub fn scratch_default_dir() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("bad scratch file name".into());
    }
    Ok(())
}

/// Write a scratch file (raw body; name in the x-name header) to the first scratch disk with room.
/// Runs off the main thread, and writes without holding the state lock.
#[tauri::command(async)]
pub fn scratch_write(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).ok_or("missing name")?.to_string();
    valid_name(&name)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let roots = with_state(|st| st.roots.clone());
    let mut last_err = String::from("no scratch disk has enough free space");
    for root in roots {
        let free = fs4::available_space(&root).unwrap_or(0);
        if free < bytes.len() as u64 + MARGIN {
            continue;
        }
        let dir = match with_state(|st| session_dir(st, &root)) {
            Ok(d) => d,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        let path = dir.join(format!("{name}.scratch"));
        match std::fs::write(&path, bytes) {
            Ok(()) => {
                with_state(|st| st.packs.insert(name.clone(), path));
                return Ok(());
            }
            Err(e) => {
                let _ = std::fs::remove_file(&path);
                last_err = e.to_string();
            }
        }
    }
    Err(last_err)
}

/// Largest single read (the editor reads at most one scratch file's worth at a time).
const MAX_READ: u64 = 1 << 30;

/// Read part of a scratch file.
#[tauri::command(async)]
pub fn scratch_read(name: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    valid_name(&name)?;
    if length > MAX_READ {
        return Err("read too large".into());
    }
    let path = with_state(|st| st.packs.get(&name).cloned()).ok_or_else(|| format!("scratch file {name} is missing"))?;
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command(async)]
pub fn scratch_remove(names: Vec<String>) {
    let paths: Vec<PathBuf> = with_state(|st| names.iter().filter_map(|n| st.packs.remove(n)).collect());
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}

/// Delete this editor's scratch folders (on a normal exit). Recovery files go too:
/// everything was either saved or deliberately discarded.
pub fn scratch_shutdown() {
    with_state(|st| {
        for (dir, f) in st.locks.drain() {
            let _ = f.unlock();
            drop(f);
            let _ = std::fs::remove_dir_all(&dir);
        }
        for dir in st.recovery_dirs.drain(..) {
            let _ = std::fs::remove_dir_all(dir);
        }
        st.packs.clear();
    });
}

/// Installed memory in bytes (0 if unknown).
#[tauri::command]
pub fn system_memory() -> u64 {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
            return m.ullTotalPhys;
        }
        0
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("MemTotal:") {
                let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().unwrap_or(0);
                return kb * 1024;
            }
        }
        0
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0)
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

// ---------------------------------------------------------------- recovery

fn recovery_dir(st: &State) -> PathBuf {
    st.roots[0].join(ROOT).join(RECOVERY).join(&st.session)
}

/// Save (or replace) the recovery copy of an open image: raw .cie bytes, the key
/// (which image) and its name in headers.
#[tauri::command(async)]
pub fn recovery_save(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let key = request.headers().get("x-key").and_then(|v| v.to_str().ok()).ok_or("missing key")?.to_string();
    valid_name(&key)?;
    let name = request.headers().get("x-doc-name").and_then(|v| v.to_str().ok()).map(crate::percent_decode).unwrap_or_default();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let (dir, older) = with_state(|st| {
        let d = recovery_dir(st);
        if !st.recovery_dirs.contains(&d) {
            st.recovery_dirs.push(d.clone());
        }
        (d.clone(), st.recovery_dirs.iter().filter(|x| **x != d).cloned().collect::<Vec<_>>())
    });
    // A copy in a previous first scratch disk is out of date now.
    for o in older {
        let _ = std::fs::remove_file(o.join(format!("{key}.cie")));
        let _ = std::fs::remove_file(o.join(format!("{key}.name")));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{key}.saving"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("{key}.cie"))).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{key}.name")), name).map_err(|e| e.to_string())
}

/// Drop an image's recovery copy (it was saved or closed).
#[tauri::command(async)]
pub fn recovery_forget(key: String) -> Result<(), String> {
    valid_name(&key)?;
    let dirs = with_state(|st| st.recovery_dirs.clone());
    for dir in dirs {
        let _ = std::fs::remove_file(dir.join(format!("{key}.cie")));
        let _ = std::fs::remove_file(dir.join(format!("{key}.name")));
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct Recovered {
    path: String,
    name: String,
    modified: u64,
    size: u64,
}

fn alive(roots: &[PathBuf], session: &str) -> bool {
    roots.iter().any(|r| in_use(&r.join(ROOT).join(session)))
}

/// Where recovery copies can be: the scratch disks and the system's temporary folder.
fn known_roots(st: &State) -> Vec<PathBuf> {
    let mut r = st.roots.clone();
    let tmp = std::env::temp_dir();
    if !r.contains(&tmp) {
        r.push(tmp);
    }
    r
}

/// Recovery copies left by editors that did not close normally.
#[tauri::command(async)]
pub fn recovery_list() -> Vec<Recovered> {
    let (roots, own) = with_state(|st| (known_roots(st), st.session.clone()));
    let mut out = Vec::new();
    for root in &roots {
        let Ok(sessions) = std::fs::read_dir(root.join(ROOT).join(RECOVERY)) else { continue };
        for s in sessions.flatten() {
            let session = s.file_name().to_string_lossy().into_owned();
            if session == own || alive(&roots, &session) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(s.path()) else { continue };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("cie") {
                    continue;
                }
                let meta = f.metadata().ok();
                let modified = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
                let name = std::fs::read_to_string(p.with_extension("name")).unwrap_or_else(|_| "Untitled".into());
                out.push(Recovered { path: p.to_string_lossy().into_owned(), name, modified, size: meta.map(|m| m.len()).unwrap_or(0) });
            }
        }
    }
    out
}

/// A .cie file directly inside <known root>/<ROOT>/Recovery/<session>/ (nothing else can be read or deleted).
fn is_recovery_file(p: &Path) -> bool {
    if p.extension().and_then(|e| e.to_str()) != Some("cie") || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let Some(recovery) = p.parent().and_then(|s| s.parent()) else { return false };
    let roots = with_state(|st| known_roots(st));
    roots.iter().any(|r| r.join(ROOT).join(RECOVERY) == recovery)
}

#[tauri::command(async)]
pub fn recovery_read(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(&path);
    if !is_recovery_file(&p) {
        return Err("not a recovery file".into());
    }
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Delete recovery copies (recovered or declined); empty session folders go too.
#[tauri::command(async)]
pub fn recovery_discard(paths: Vec<String>) {
    for path in paths {
        let p = PathBuf::from(&path);
        if !is_recovery_file(&p) {
            continue;
        }
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(p.with_extension("name"));
        if let Some(dir) = p.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }
}
