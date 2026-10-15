use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::broadcast;

mod kds_server;
mod kurdishtts_website_stt;
mod android_bluetooth_printer;
mod local_mode_sqlite;

const SINGLE_INSTANCE_PORT: u16 = 41931;

fn setup_single_instance(handle: tauri::AppHandle) -> bool {
    match TcpListener::bind(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
        Ok(listener) => {
            let _ = listener.set_nonblocking(true);
            thread::spawn(move || loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                        let mut buf = [0; 4096];
                        if let Ok(n) = stream.read(&mut buf) {
                            if n > 0 {
                                let msg = String::from_utf8_lossy(&buf[..n]).to_string();
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.emit("deep-link", msg);
                                }
                            }
                        }
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.set_focus();
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(100));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(500)),
                }
            });
            true
        }
        Err(_) => {
            if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
                let args: Vec<String> = std::env::args().collect();
                for arg in &args {
                    if let Some(route) = arg.strip_prefix("--open-route=") {
                        let _ = stream.write_all(route.as_bytes());
                        let _ = stream.flush();
                        break;
                    }
                }
                let _ = stream.shutdown(std::net::Shutdown::Write);
                let mut buf = [0; 1];
                let _ = stream.read(&mut buf);
            }
            false
        }
    }
}

pub struct KdsState {
    pub server_url: Mutex<Option<String>>,
    pub tx: broadcast::Sender<String>,
    pub last_message: Arc<Mutex<Option<String>>>,
}

#[tauri::command]
fn read_fcm_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(app_data) = app.path().app_data_dir() {
        candidates.push(app_data.join("fcm-token.txt"));
        // Android's getFilesDir() = <app_dir>/files/
        candidates.push(app_data.join("files").join("fcm-token.txt"));
        if let Some(parent) = app_data.parent() {
            candidates.push(parent.join("fcm-token.txt"));
            // Also check parent/files/ in case app_data_dir is nested differently
            candidates.push(parent.join("files").join("fcm-token.txt"));
        }
    }

    if let Ok(data_dir) = app.path().data_dir() {
        candidates.push(data_dir.join("fcm-token.txt"));
    }

    for path in &candidates {
        match fs::read_to_string(path) {
            Ok(contents) => {
                let token = contents.trim().to_string();
                if !token.is_empty() {
                    return Ok(Some(token));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => continue,
        }
    }

    Ok(None)
}

#[tauri::command]
async fn start_kds_stream(app: tauri::AppHandle, state: tauri::State<'_, KdsState>, port: u16) -> Result<String, String> {
    {
        let url_lock = state.server_url.lock().map_err(|e| e.to_string())?;
        if let Some(url) = &*url_lock {
            return Ok(url.clone());
        }
    } // lock dropped

    let url = kds_server::start_server(app, port, state.tx.clone(), state.last_message.clone()).await?;
    
    let mut url_lock = state.server_url.lock().map_err(|e| e.to_string())?;
    *url_lock = Some(url.clone());
    Ok(url)
}

#[tauri::command]
fn get_kds_stream_url(state: tauri::State<'_, KdsState>) -> Result<Option<String>, String> {
    let url_lock = state.server_url.lock().map_err(|e| e.to_string())?;
    Ok(url_lock.clone())
}

#[tauri::command]
fn broadcast_kds_update(state: tauri::State<'_, KdsState>, event: String, payload: serde_json::Value) -> Result<(), String> {
    let message = kds_server::KdsMessage { event, payload };
    let json = serde_json::to_string(&message).map_err(|e| e.to_string())?;
    // Cache the last message for new WebSocket clients
    if let Ok(mut cached) = state.last_message.lock() {
        *cached = Some(json.clone());
    }
    let _ = state.tx.send(json);
    Ok(())
}

#[tauri::command]
fn open_file_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Creates a desktop shortcut that opens the app and navigates directly to the given module route.
#[cfg(desktop)]
#[tauri::command]
fn create_desktop_shortcut(
    app: tauri::AppHandle,
    module_name: String,
    module_href: String,
) -> Result<(), String> {
    let desktop = app.path().desktop_dir().map_err(|e| e.to_string())?;
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;

    let sanitized_name: String = module_name
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace() || *c == '-' || *c == '_')
        .collect();
    let label = sanitized_name.trim();

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let shortcut_path = desktop.join(format!("Atlas - {}.lnk", label));
        let spath = shortcut_path.to_string_lossy().replace('\'', "''");
        let exe = exe_path.to_string_lossy().replace('\'', "''");
        let args = format!("--open-route={}", module_href);
        let wd = exe_path
            .parent()
            .map(|p| p.to_string_lossy().replace('\'', "''"))
            .unwrap_or_default();
        let desc = format!("Atlas - {}", module_name).replace('\'', "''");

        let ps = format!(
            "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');\
             $s.TargetPath='{}';\
             $s.Arguments='{}';\
             $s.WorkingDirectory='{}';\
             $s.Description='{}';\
             $s.Save()",
            spath, exe, args, wd, desc
        );

        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .output()
            .map_err(|e| format!("Failed to create shortcut: {}", e))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!("PowerShell error: {}", err));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let command_path = desktop.join(format!("Atlas - {}.command", label));
        let script = format!(
            "#!/bin/bash\nopen \"{}\" --args --open-route={}\n",
            exe_path.to_string_lossy(),
            module_href
        );
        fs::write(&command_path, script).map_err(|e| e.to_string())?;
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&command_path, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let desktop_path = desktop.join(format!("Atlas - {}.desktop", label));
        let desktop_entry = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=Atlas - {}\n\
             Exec={} --open-route={}\n\
             Terminal=false\n\
             Categories=Office;\n",
            module_name, exe_path.to_string_lossy(), module_href
        );
        fs::write(&desktop_path, desktop_entry).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
fn create_desktop_shortcut(
    _app: tauri::AppHandle,
    _module_name: String,
    _module_href: String,
) -> Result<(), String> {
    Err("Desktop shortcuts are not supported on mobile devices.".into())
}

/// Check if a file or directory exists at the given path.
/// Used to validate USB destination on startup.
#[tauri::command]
fn check_path_exists(path: String) -> Result<bool, String> {
    Ok(PathBuf::from(&path).exists())
}

/// Get the size of a file in bytes.
/// Used to verify USB copy completion by comparing source vs dest size.
#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !meta.is_file() {
        return Err("Path is not a file".into());
    }
    Ok(meta.len())
}

/// Copy the local database file to a USB destination.
/// This is strictly one-way: source is always within AppData, dest is the USB path.
/// The dest path is never read — only written to.
#[tauri::command]
fn backup_db_to_usb(app: tauri::AppHandle, db_filename: String, dest_path: String) -> Result<u64, String> {
    let app_data = app.path().app_data_dir().map_err(|e| format!("Failed to get AppData dir: {}", e))?;

    // Resolve source: AppData / db_filename
    let source = app_data.join(&db_filename);

    // Validate source is within AppData (prevent path traversal)
    if !source.starts_with(&app_data) {
        return Err("Invalid source path: must be within AppData directory".into());
    }

    // Validate source file exists
    if !source.exists() {
        return Err(format!("Source database not found at {:?}", source));
    }
    if !source.is_file() {
        return Err("Source path is not a file".into());
    }

    // Create destination parent directory if needed
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create destination directory: {}", e))?;
    }

    // Copy file — one-way, never read from dest
    let copied = fs::copy(&source, &dest).map_err(|e| format!("Failed to copy database to USB: {}", e))?;

    Ok(copied)
}

#[tauri::command]
async fn list_android_bluetooth_thermal_printers(
    app: tauri::AppHandle,
) -> Result<Vec<android_bluetooth_printer::BluetoothPrinterInfo>, String> {
    android_bluetooth_printer::list_printers(app).await
}

#[tauri::command]
async fn print_android_bluetooth_thermal_printer(
    app: tauri::AppHandle,
    address: String,
    payload: Vec<u8>,
) -> Result<(), String> {
    android_bluetooth_printer::print(app, address, payload).await
}

#[tauri::command]
async fn test_android_bluetooth_thermal_printer(
    app: tauri::AppHandle,
    address: String,
) -> Result<(), String> {
    android_bluetooth_printer::test(app, address).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (tx, _rx) = broadcast::channel(100);

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(android_bluetooth_printer::init())
        .plugin(tauri_plugin_thermal_printer::init());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_biometric::init());
        builder = builder.plugin(tauri_plugin_opener::init());
    }

    let app = builder
        .manage(KdsState {
            server_url: Mutex::new(None),
            tx,
            last_message: Arc::new(Mutex::new(None)),
        })
        .manage(local_mode_sqlite::LocalModeSqliteTransactionState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            if !setup_single_instance(handle) {
                std::process::exit(0);
            }

            let window = app.get_webview_window("main").unwrap();

            #[cfg(desktop)]
            {
                let _ = window.set_decorations(false);

                let _ = window.maximize();
                let _ = window.show();

                let args: Vec<String> = std::env::args().collect();
                for arg in &args {
                    if let Some(route) = arg.strip_prefix("--open-route=") {
                        let _ = window.emit("deep-link", route.to_string());
                        break;
                    }
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_fcm_token,
            start_kds_stream,
            get_kds_stream_url,
            broadcast_kds_update,
            open_file_path,
            check_path_exists,
            get_file_size,
            backup_db_to_usb,
            create_desktop_shortcut,
            list_android_bluetooth_thermal_printers,
            print_android_bluetooth_thermal_printer,
            test_android_bluetooth_thermal_printer,
            local_mode_sqlite::begin_local_mode_sqlite_transaction,
            local_mode_sqlite::execute_local_mode_sqlite_transaction,
            local_mode_sqlite::select_local_mode_sqlite_transaction,
            local_mode_sqlite::commit_local_mode_sqlite_transaction,
            local_mode_sqlite::rollback_local_mode_sqlite_transaction,
            kurdishtts_website_stt::atlas_assistant_kurdishtts_website_status,
            kurdishtts_website_stt::atlas_assistant_transcribe_kurdishtts_website
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Resumed = event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }
    });
}
