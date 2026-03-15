use std::fs;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::sync::broadcast;

mod kds_server;

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
        .plugin(tauri_plugin_thermal_printer::init());

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_biometric::init());
    }

    builder
        .manage(KdsState {
            server_url: Mutex::new(None),
            tx,
            last_message: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
        use tauri::Manager;
        let window = app.get_webview_window("main").unwrap();

            #[cfg(desktop)]
            {
                // Force disable decorations (Fix for persistent title bar)
                let _ = window.set_decorations(false);
                // let _ = window.set_shadow(true);

                // Show window after configuration
                let _ = window.maximize();
                let _ = window.show();
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
            broadcast_kds_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
