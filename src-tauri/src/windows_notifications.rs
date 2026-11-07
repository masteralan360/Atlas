use std::fs;
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};
use std::ptr;

use windows::core::{Interface, GUID, HSTRING, PWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::PropVariantClear;
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, IPersistFile,
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{IShellLinkW, SetCurrentProcessExplicitAppUserModelID, ShellLink};

const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

// This is the same AtlasClear mark used by the Tauri Windows application icon.
const ATLAS_CLEAR_ICON: &[u8] = include_bytes!("../icons/icon.ico");

fn app_icon_path() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "Windows local app data directory is unavailable".to_string())?;
    let icon_dir = local_app_data.join("Atlas");
    fs::create_dir_all(&icon_dir).map_err(|error| error.to_string())?;

    let icon_path = icon_dir.join("AtlasClear.ico");
    let needs_update = fs::read(&icon_path)
        .map(|contents| contents.as_slice() != ATLAS_CLEAR_ICON)
        .unwrap_or(true);
    if needs_update {
        fs::write(&icon_path, ATLAS_CLEAR_ICON).map_err(|error| error.to_string())?;
    }

    Ok(icon_path)
}

fn start_menu_programs_dir() -> Result<PathBuf, String> {
    let app_data = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "Windows user profile directory is unavailable".to_string())?;
    Ok(app_data
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs"))
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn create_notification_shortcut(
    app_id: &str,
    product_name: &str,
    executable_path: &Path,
) -> Result<(), String> {
    // Windows resolves a desktop toast's display name and app icon from this shortcut's AUMID.
    let start_menu = start_menu_programs_dir()?;
    fs::create_dir_all(&start_menu).map_err(|error| error.to_string())?;

    let icon_path = app_icon_path()?;
    let shortcut_path = start_menu.join(format!("{product_name}.lnk"));
    let executable = HSTRING::from(executable_path.to_string_lossy().as_ref());
    let working_directory = executable_path
        .parent()
        .map(|path| HSTRING::from(path.to_string_lossy().as_ref()))
        .unwrap_or_default();
    let icon = HSTRING::from(icon_path.to_string_lossy().as_ref());
    let description = HSTRING::from(product_name);
    let shortcut = HSTRING::from(shortcut_path.to_string_lossy().as_ref());

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| error.to_string())?;

        let result = (|| {
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|error| error.to_string())?;
            shell_link
                .SetPath(&executable)
                .map_err(|error| error.to_string())?;
            shell_link
                .SetWorkingDirectory(&working_directory)
                .map_err(|error| error.to_string())?;
            shell_link
                .SetDescription(&description)
                .map_err(|error| error.to_string())?;
            shell_link
                .SetIconLocation(&icon, 0)
                .map_err(|error| error.to_string())?;

            let app_id_wide = wide(app_id);
            let app_id_pointer =
                CoTaskMemAlloc(app_id_wide.len() * std::mem::size_of::<u16>()).cast::<u16>();
            if app_id_pointer.is_null() {
                return Err("Could not allocate the Atlas notification identity".to_string());
            }
            ptr::copy_nonoverlapping(app_id_wide.as_ptr(), app_id_pointer, app_id_wide.len());
            let mut app_id_property = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_LPWSTR,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 {
                            pwszVal: PWSTR::from_raw(app_id_pointer),
                        },
                    }),
                },
            };
            let property_store: IPropertyStore =
                shell_link.cast().map_err(|error| error.to_string())?;
            let set_value_result = property_store
                .SetValue(&PKEY_APP_USER_MODEL_ID, &app_id_property)
                .map_err(|error| error.to_string());
            let clear_value_result =
                PropVariantClear(&mut app_id_property).map_err(|error| error.to_string());
            set_value_result?;
            clear_value_result?;
            property_store.Commit().map_err(|error| error.to_string())?;

            let persist_file: IPersistFile =
                shell_link.cast().map_err(|error| error.to_string())?;
            persist_file
                .Save(&shortcut, true)
                .map_err(|error| error.to_string())
        })();

        CoUninitialize();
        result
    }
}

pub fn register_identity(app_id: &str, product_name: &str) -> Result<(), String> {
    let executable_path = std::env::current_exe().map_err(|error| error.to_string())?;
    let app_id = app_id.to_string();
    let shortcut_app_id = app_id.clone();
    let product_name = product_name.to_string();
    std::thread::spawn(move || {
        create_notification_shortcut(&shortcut_app_id, &product_name, &executable_path)
    })
    .join()
    .map_err(|_| "Could not register the Atlas notification identity".to_string())??;

    unsafe {
        SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub fn show_notification(app_id: &str, title: &str, body: &str) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification.app_id(app_id).summary(title).body(body);
    notification.show().map_err(|error| error.to_string())
}
