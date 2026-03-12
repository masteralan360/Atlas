use std::fs;
use tauri::Manager;

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
fn debug_fcm_paths(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut results: Vec<String> = Vec::new();

    if let Ok(app_data) = app.path().app_data_dir() {
        let p = app_data.join("fcm-token.txt");
        results.push(format!("app_data_dir: {} (exists={})", p.display(), p.exists()));

        let p_files = app_data.join("files").join("fcm-token.txt");
        results.push(format!("app_data_dir/files: {} (exists={})", p_files.display(), p_files.exists()));

        if let Some(parent) = app_data.parent() {
            let p2 = parent.join("fcm-token.txt");
            results.push(format!("parent_of_app_data: {} (exists={})", p2.display(), p2.exists()));

            let p2_files = parent.join("files").join("fcm-token.txt");
            results.push(format!("parent/files: {} (exists={})", p2_files.display(), p2_files.exists()));

            if let Ok(entries) = fs::read_dir(parent) {
                let files: Vec<String> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| format!("  -> {}", e.file_name().to_string_lossy()))
                    .collect();
                results.push(format!("files in parent ({}): [{}]", parent.display(), files.join(", ")));
            }
        }
    } else {
        results.push("app_data_dir: ERROR resolving".to_string());
    }

    if let Ok(data_dir) = app.path().data_dir() {
        let p = data_dir.join("fcm-token.txt");
        let exists = p.exists();
        results.push(format!("data_dir: {} (exists={})", p.display(), exists));
    }

    Ok(results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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

    builder.setup(|app| {
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
        .invoke_handler(tauri::generate_handler![read_fcm_token, debug_fcm_paths])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
