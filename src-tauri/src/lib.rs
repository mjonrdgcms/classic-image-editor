//! Native side of the editor.
//!
//! The backend stays thin: it hosts the webview, exposes the dialog and
//! file-system plugins the UI uses to open and save images, and keeps the
//! AI model files (people detection, face landmarks) in the app's data
//! folder. Models are fetched once, from a fixed list of pinned addresses, with the
//! system's curl (built into Windows 10 and later), so the editor itself
//! carries no HTTP stack.

mod scratch;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "name": env!("CARGO_PKG_NAME"),
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// Files passed on the command line (double-clicking a .cie file, "Open with").
#[tauri::command]
fn launch_files() -> Vec<String> {
    let mut files: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with('-') && std::path::Path::new(a).is_file()).collect();
    // Files macOS handed over (double-click in Finder) before the window was ready.
    files.extend(OPENED.lock().unwrap_or_else(|e| e.into_inner()).drain(..));
    files
}

/// Files the system asked us to open (macOS sends them as an event, not as arguments).
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Picture and project extensions the editor reads and writes outside its own folders.
const USER_EXTS: &[&str] = &["cie", "png", "jpg", "jpeg", "gif", "bmp", "webp", "avif", "zip"];

fn user_ext_ok(p: &std::path::Path) -> bool {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    USER_EXTS.contains(&ext.as_str())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Save a picture or project where the user chose (Save to a file opened from
/// anywhere). The body is the raw file; the path comes in a header. Writes a
/// temporary file first so a failed save never leaves half a file behind.
#[tauri::command]
fn write_user_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("missing path")?;
    let path = percent_decode(path);
    let p = std::path::Path::new(&path);
    if !user_ext_ok(p) {
        return Err("only pictures and Classic Image Editor files can be saved there".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let tmp = p.with_extension(format!("{}.saving", p.extension().and_then(|e| e.to_str()).unwrap_or("tmp")));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Read a picture or project the user chose earlier (Open Recent, a file the
/// app was launched with). Only image and .cie files, wherever they are.
#[tauri::command]
fn read_user_file(path: String) -> Result<tauri::ipc::Response, String> {
    let p = std::path::Path::new(&path);
    if !user_ext_ok(p) {
        return Err("that is not a picture or Classic Image Editor file".into());
    }
    std::fs::read(p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// The only files the editor fetches, and where from (pinned versions).
const MODELS: &[(&str, &str)] = &[
    ("vision_wasm_internal.js", "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm/vision_wasm_internal.js"),
    ("vision_wasm_internal.wasm", "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm/vision_wasm_internal.wasm"),
    (
        "selfie_multiclass_256x256.tflite",
        "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
    ),
    ("face_landmarker.task", "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"),
];

/// Downloads in progress: model name -> (temporary file, cancel flag).
static ACTIVE: Mutex<Option<HashMap<String, (PathBuf, Arc<AtomicBool>)>>> = Mutex::new(None);

fn with_active<T>(f: impl FnOnce(&mut HashMap<String, (PathBuf, Arc<AtomicBool>)>) -> T) -> T {
    let mut g = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

/// Where model files live: <local app data>/models.
fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Only the known model files can be named.
fn checked(name: &str) -> Result<&'static str, String> {
    MODELS.iter().find(|(n, _)| *n == name).map(|(n, _)| *n).ok_or_else(|| format!("unknown model file {name:?}"))
}

/// Sizes of the finished files (0 if missing) and of downloads in progress.
#[tauri::command]
fn model_status(app: tauri::AppHandle, names: Vec<String>) -> Result<serde_json::Value, String> {
    let d = models_dir(&app)?;
    let mut out = Vec::new();
    for n in &names {
        let n = checked(n)?;
        let size = std::fs::metadata(d.join(n)).map(|m| m.len()).unwrap_or(0);
        let part = with_active(|a| a.get(n).map(|(p, _)| p.clone()))
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);
        out.push(serde_json::json!({ "name": n, "size": size, "part": part }));
    }
    Ok(serde_json::json!({ "dir": d.to_string_lossy(), "files": out }))
}

/// Download one model with the system curl (built into Windows 10 and later)
/// into a temporary file, then move it into place. One download per file at a
/// time; model_cancel stops it.
#[tauri::command]
async fn model_download(app: tauri::AppHandle, name: String) -> Result<u64, String> {
    let name = checked(&name)?;
    let url = MODELS.iter().find(|(n, _)| *n == name).map(|(_, u)| *u).unwrap_or_default();
    let d = models_dir(&app)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_nanos()).unwrap_or(0);
    let part = d.join(format!("{name}.{stamp}.part"));
    let cancel = Arc::new(AtomicBool::new(false));
    let busy = with_active(|a| {
        if a.contains_key(name) {
            true
        } else {
            a.insert(name.to_string(), (part.clone(), cancel.clone()));
            false
        }
    });
    if busy {
        return Err("this file is already downloading".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let dest = d.join(name);
        let mut cmd = std::process::Command::new("curl");
        cmd.args(["-L", "--fail", "--silent", "--show-error", "--globoff", "--proto", "=https", "--proto-redir", "=https"])
            .args(["--retry", "3", "--connect-timeout", "20", "--max-filesize", "67108864", "-o"])
            .arg(&part)
            .arg(url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start curl: {e}"))?;
        let status = loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&part);
                return Err("Stopped".to_string());
            }
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(e) => return Err(e.to_string()),
            }
        };
        if !status.success() {
            let mut msg = String::new();
            if let Some(mut e) = child.stderr.take() {
                use std::io::Read;
                let _ = e.read_to_string(&mut msg);
            }
            let _ = std::fs::remove_file(&part);
            let msg = msg.trim().to_string();
            return Err(if msg.is_empty() { "the download failed".to_string() } else { msg });
        }
        let _ = std::fs::remove_file(&dest);
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
        Ok(std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string());
    with_active(|a| a.remove(name));
    result?
}

/// Stop a download started by model_download.
#[tauri::command]
fn model_cancel(name: String) -> Result<(), String> {
    let name = checked(&name)?;
    with_active(|a| {
        if let Some((_, c)) = a.get(name) {
            c.store(true, Ordering::Relaxed);
        }
    });
    Ok(())
}

/// The bytes of a downloaded model (sent raw, not as JSON).
#[tauri::command]
fn model_read(app: tauri::AppHandle, name: String) -> Result<tauri::ipc::Response, String> {
    let p = models_dir(&app)?.join(checked(&name)?);
    let bytes = std::fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Store a model the user picked by hand (offline machines). The body is the raw file; the name comes in a header.
#[tauri::command]
fn model_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let name = request.headers().get("x-model-name").and_then(|v| v.to_str().ok()).ok_or("missing model name")?;
    let name = checked(name)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let p = models_dir(&app)?.join(name);
    std::fs::write(&p, bytes).map_err(|e| e.to_string())
}

/// Delete downloaded models (Help > AI Models > Remove).
#[tauri::command]
fn model_remove(app: tauri::AppHandle, names: Vec<String>) -> Result<(), String> {
    let d = models_dir(&app)?;
    for n in &names {
        let _ = std::fs::remove_file(d.join(checked(n)?));
    }
    Ok(())
}

/// The page is running and will answer close requests (until then, closing just closes).
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);
/// The page answered the last close request (it shows its own "unsaved changes" question).
static CLOSE_ACKED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn frontend_ready() {
    FRONTEND_READY.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn close_ack() {
    CLOSE_ACKED.store(true, Ordering::SeqCst);
}

/// Quit for real (the page has checked for unsaved changes).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    scratch::scratch_shutdown();
    app.exit(0);
}

/// Closing the window (or Cmd+Q on a Mac) asks the page first, so unsaved images
/// aren't lost. If the page doesn't answer within a few seconds (it hung), the
/// editor closes anyway.
fn request_close(app: &tauri::AppHandle) -> bool {
    use tauri::Emitter;
    if !FRONTEND_READY.load(Ordering::SeqCst) {
        return false;
    }
    CLOSE_ACKED.store(false, Ordering::SeqCst);
    let _ = app.emit("close-requested", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if !CLOSE_ACKED.load(Ordering::SeqCst) {
            scratch::scratch_shutdown();
            handle.exit(0);
        }
    });
    true
}

/// Linux: WebKitGTK's DMA-BUF renderer shows a blank window with NVIDIA's driver; use the older path there.
fn linux_webkit_workarounds() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() && std::path::Path::new("/proc/driver/nvidia").exists() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// macOS menu bar: the application menu and an Edit menu for typing in fields.
/// Undo, Select All and the rest stay with the editor's own shortcuts, so the
/// menu doesn't swallow Cmd+Z, Cmd+A, Cmd+H (Extras) or Cmd+M (Curves).
#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let about = AboutMetadata { version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        "Classic Image Editor",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Classic Image Editor"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "hide", "Hide Classic Image Editor", true, None::<&str>)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit Classic Image Editor", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[&PredefinedMenuItem::cut(app, None)?, &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    linux_webkit_workarounds();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu).on_menu_event(|app, event| match event.id().as_ref() {
        "quit" => {
            if !request_close(app) {
                scratch::scratch_shutdown();
                app.exit(0);
            }
        }
        "hide" => {
            let _ = app.hide();
        }
        _ => {}
    });
    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if request_close(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            launch_files,
            read_user_file,
            write_user_file,
            model_status,
            model_download,
            model_cancel,
            model_read,
            model_write,
            model_remove,
            scratch::scratch_configure,
            scratch::scratch_disk_info,
            scratch::scratch_default_dir,
            scratch::scratch_write,
            scratch::scratch_read,
            scratch::scratch_remove,
            scratch::system_memory,
            scratch::recovery_save,
            scratch::recovery_forget,
            scratch::recovery_list,
            scratch::recovery_read,
            scratch::recovery_discard,
            frontend_ready,
            close_ack,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while running the editor")
        .run(|_app, _event| {
            // A normal exit leaves no scratch files (or recovery copies) behind.
            if let tauri::RunEvent::Exit = &_event {
                scratch::scratch_shutdown();
            }
            // macOS opens documents with an event rather than command-line arguments.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                use tauri::Emitter;
                let paths: Vec<String> = urls.iter().filter_map(|u| u.to_file_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
                OPENED.lock().unwrap_or_else(|e| e.into_inner()).extend(paths.iter().cloned());
                let _ = _app.emit("open-files", ());
            }
        });
}
