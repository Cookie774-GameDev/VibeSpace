//! Native applications use an explicit launch/focus contract. Reparenting arbitrary
//! third-party windows with SetParent is not a supported embedding API: it can
//! break their DPI, input and window lifetime. Never claim those windows are embedded.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppDescriptor {
    id: String,
    name: String,
    path: Option<String>,
    process_name: Option<String>,
    running: bool,
    pinned: bool,
    launchable: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStatus {
    panel_id: String,
    operation_id: String,
    app_id: String,
    name: String,
    embedded: bool,
    running: bool,
    fallback: bool,
    owned: bool,
    error: Option<String>,
}
struct Record {
    operation_id: String,
    app_id: String,
    name: String,
    path: PathBuf,
}
static RECORDS: LazyLock<Mutex<HashMap<String, Record>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn ensure_main_caller(label: &str, window_label: &str) -> Result<(), String> {
    if label == "main" && window_label == "main" {
        Ok(())
    } else {
        Err("workbench_native_app_caller_not_authorized".into())
    }
}
pub fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        Err("workbench_native_app_identity_invalid".into())
    } else {
        Ok(())
    }
}
pub fn validate_bounds(bounds: &NativeBounds) -> Result<(), String> {
    if [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .any(|n| !n.is_finite())
        || bounds.width <= 0.0
        || bounds.height <= 0.0
    {
        Err("workbench_native_app_bounds_invalid".into())
    } else {
        Ok(())
    }
}
pub fn validate_executable_path(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if raw.len() > 2048
        || raw.chars().any(|c| c.is_control())
        || !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("exe"))
    {
        return Err("workbench_native_app_path_invalid".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "workbench_native_app_not_installed")?;
    if !canonical.is_file() {
        return Err("workbench_native_app_not_installed".into());
    }
    Ok(canonical)
}
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .eq_ignore_ascii_case(b.to_string_lossy().trim_start_matches(r"\\?\"))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM},
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::WindowsAndMessaging::{
                EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow,
                ShowWindow, SW_RESTORE,
            },
        },
    };
    pub fn windows() -> Vec<(isize, PathBuf)> {
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
            if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
                return true.into();
            }
            let mut pid = 0;
            unsafe {
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
            }
            if pid == std::process::id() {
                return true.into();
            }
            if let Ok(handle) =
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            {
                let mut buffer = vec![0u16; 32768];
                let mut len = buffer.len() as u32;
                let result = unsafe {
                    QueryFullProcessImageNameW(
                        handle,
                        PROCESS_NAME_WIN32,
                        PWSTR(buffer.as_mut_ptr()),
                        &mut len,
                    )
                };
                let _ = unsafe { CloseHandle(handle) };
                if result.is_ok() {
                    let path = PathBuf::from(String::from_utf16_lossy(&buffer[..len as usize]));
                    unsafe { &mut *(data.0 as *mut Vec<(isize, PathBuf)>) }
                        .push((hwnd.0 as isize, path));
                }
            }
            true.into()
        }
        let mut rows: Vec<(isize, PathBuf)> = Vec::new();
        let _ = unsafe {
            EnumWindows(
                Some(visit),
                LPARAM((&mut rows as *mut Vec<(isize, PathBuf)>) as isize),
            )
        };
        rows
    }
    pub fn focus(path: &Path) -> Result<(), String> {
        let (hwnd, _) = windows()
            .into_iter()
            .find(|(_, candidate)| same_path(candidate, path))
            .ok_or("workbench_native_app_window_closed")?;
        let hwnd = HWND(hwnd as *mut std::ffi::c_void);
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if unsafe { SetForegroundWindow(hwnd) }.as_bool() {
            Ok(())
        } else {
            Err("Windows did not grant focus. Select the app from the taskbar.".into())
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn windows() -> Vec<(isize, PathBuf)> {
        Vec::new()
    }
    pub fn focus(_: &Path) -> Result<(), String> {
        Err("workbench_native_app_requires_windows".into())
    }
}

fn catalog() -> Vec<NativeAppDescriptor> {
    let mut apps = Vec::new();
    for (_, path) in platform::windows() {
        if apps.iter().any(|a: &NativeAppDescriptor| {
            a.path
                .as_ref()
                .is_some_and(|p| same_path(Path::new(p), &path))
        }) {
            continue;
        }
        let file = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if file.eq_ignore_ascii_case("jarvis.exe")
            || file.eq_ignore_ascii_case("msedgewebview2.exe")
        {
            continue;
        }
        let chatgpt = file.eq_ignore_ascii_case("ChatGPT.exe");
        // Stable executable identity, never a PID which changes across reloads.
        let digest = format!(
            "{:x}",
            Sha256::digest(path.to_string_lossy().to_lowercase().as_bytes())
        );
        apps.push(NativeAppDescriptor {
            id: if chatgpt {
                "chatgpt".into()
            } else {
                format!("app_{}", &digest[..20])
            },
            name: if chatgpt {
                "ChatGPT".into()
            } else {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into()
            },
            path: Some(path.to_string_lossy().into()),
            process_name: Some(file),
            running: true,
            pinned: chatgpt,
            launchable: true,
        });
    }
    if !apps.iter().any(|a| a.id == "chatgpt") {
        let installed = std::env::var_os("ProgramFiles")
            .and_then(|root| std::fs::read_dir(PathBuf::from(root).join("WindowsApps")).ok())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("OpenAI.Codex_") || name.starts_with("OpenAI.ChatGPT_")
            })
            .map(|entry| entry.path().join("app").join("ChatGPT.exe"))
            .filter(|path| path.is_file())
            .max();
        apps.push(NativeAppDescriptor {
            id: "chatgpt".into(),
            name: "ChatGPT".into(),
            path: installed.as_ref().map(|p| p.to_string_lossy().into()),
            process_name: Some("ChatGPT.exe".into()),
            running: false,
            pinned: true,
            launchable: installed.is_some(),
        });
    }
    apps.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(a.name.cmp(&b.name)));
    apps
}
fn retire_record(records: &mut HashMap<String, Record>, panel_id: &str, operation_id: &str) {
    if records
        .get(panel_id)
        .is_some_and(|r| r.operation_id == operation_id)
    {
        records.remove(panel_id);
    }
}
fn status(panel_id: &str, record: &Record) -> NativeStatus {
    NativeStatus {
        panel_id: panel_id.into(),
        operation_id: record.operation_id.clone(),
        app_id: record.app_id.clone(),
        name: record.name.clone(),
        embedded: false,
        running: platform::windows()
            .iter()
            .any(|(_, p)| same_path(p, &record.path)),
        fallback: true,
        owned: false,
        error: None,
    }
}

#[tauri::command]
pub async fn workbench_native_app_list(
    window: tauri::Webview,
) -> Result<Vec<NativeAppDescriptor>, String> {
    ensure_main_caller(window.label(), window.window().label())?;
    tauri::async_runtime::spawn_blocking(catalog)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn workbench_native_app_surface_open(
    window: tauri::Webview,
    panel_id: String,
    operation_id: String,
    app_id: String,
    path: Option<String>,
    bounds: NativeBounds,
) -> Result<NativeStatus, String> {
    ensure_main_caller(window.label(), window.window().label())?;
    validate_id(&panel_id)?;
    validate_id(&operation_id)?;
    validate_id(&app_id)?;
    validate_bounds(&bounds)?;
    tauri::async_runtime::spawn_blocking(move || {
        let detected = catalog().into_iter().find(|a| a.id == app_id);
        let raw_path = path
            .or_else(|| detected.as_ref().and_then(|a| a.path.clone()))
            .ok_or("workbench_native_app_not_installed")?;
        let path = validate_executable_path(&raw_path)?;
        // Preparing/restoring a panel never launches or steals a third-party window.
        let name = detected.map(|a| a.name).unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        });
        let record = Record {
            operation_id,
            app_id,
            name,
            path,
        };
        let result = status(&panel_id, &record);
        RECORDS
            .lock()
            .map_err(|_| "workbench_native_app_state_unavailable")?
            .insert(panel_id, record);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn workbench_native_app_surface_status(
    window: tauri::Webview,
    panel_id: String,
    operation_id: String,
) -> Result<NativeStatus, String> {
    ensure_main_caller(window.label(), window.window().label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let records = RECORDS
            .lock()
            .map_err(|_| "workbench_native_app_state_unavailable")?;
        let record = records
            .get(&panel_id)
            .filter(|r| r.operation_id == operation_id)
            .ok_or("workbench_native_app_operation_stale")?;
        Ok(status(&panel_id, record))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn workbench_native_app_surface_focus(
    window: tauri::Webview,
    panel_id: String,
    operation_id: String,
) -> Result<(), String> {
    ensure_main_caller(window.label(), window.window().label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let records = RECORDS
            .lock()
            .map_err(|_| "workbench_native_app_state_unavailable")?;
        let record = records
            .get(&panel_id)
            .filter(|r| r.operation_id == operation_id)
            .ok_or("workbench_native_app_operation_stale")?;
        platform::focus(&record.path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn workbench_native_app_surface_launch(
    window: tauri::Webview,
    panel_id: String,
    operation_id: String,
) -> Result<(), String> {
    ensure_main_caller(window.label(), window.window().label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = {
            let records = RECORDS
                .lock()
                .map_err(|_| "workbench_native_app_state_unavailable")?;
            records
                .get(&panel_id)
                .filter(|r| r.operation_id == operation_id)
                .ok_or("workbench_native_app_operation_stale")?
                .path
                .clone()
        };
        if platform::windows().iter().any(|(_, p)| same_path(p, &path)) {
            return platform::focus(&path);
        }
        let path = validate_executable_path(&path.to_string_lossy())?;
        // Explicit user action, no shell/arguments and no background launch on restore.
        let mut child = std::process::Command::new(&path)
            .spawn()
            .map_err(|_| "workbench_native_app_launch_failed")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if platform::windows().iter().any(|(_, p)| same_path(p, &path)) {
                // Visible external app is now user-controlled; panel never owns its lifetime.
                return platform::focus(&path);
            }
            if child
                .try_wait()
                .map_err(|_| "workbench_native_app_launch_failed")?
                .is_some()
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Retire only our failed, windowless child. Never kill an existing application.
        let _ = child.kill();
        let _ = child.wait();
        Err("workbench_native_app_window_unavailable".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn workbench_native_app_surface_hide(
    window: tauri::Webview,
    panel_id: String,
    operation_id: String,
) -> Result<(), String> {
    ensure_main_caller(window.label(), window.window().label())?;
    let mut records = RECORDS
        .lock()
        .map_err(|_| "workbench_native_app_state_unavailable")?;
    retire_record(&mut records, &panel_id, &operation_id);
    Ok(())
}
#[tauri::command]
pub fn workbench_native_app_surface_detach(
    window: tauri::Webview,
    panel_id: String,
) -> Result<(), String> {
    ensure_main_caller(window.label(), window.window().label())?;
    RECORDS
        .lock()
        .map_err(|_| "workbench_native_app_state_unavailable")?
        .remove(&panel_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_cleanup_cannot_retire_a_restored_panel_and_cleanup_releases_records() {
        let mut records = HashMap::new();
        records.insert(
            "panel".into(),
            Record {
                operation_id: "new".into(),
                app_id: "app".into(),
                name: "App".into(),
                path: PathBuf::from("missing.exe"),
            },
        );
        retire_record(&mut records, "panel", "old");
        assert_eq!(records.len(), 1);
        let observed = status("panel", records.get("panel").unwrap());
        assert!(!observed.embedded && !observed.running && !observed.owned && observed.fallback);
        retire_record(&mut records, "panel", "new");
        assert!(records.is_empty());
    }
    #[test]
    fn rejects_untrusted_callers_and_invalid_geometry() {
        assert!(ensure_main_caller("main", "main").is_ok());
        for label in ["browser", "preview-surface", "pet-overlay", ""] {
            assert!(ensure_main_caller(label, "main").is_err());
        }
        assert!(ensure_main_caller("main", "foreign-window").is_err());
        assert!(ensure_main_caller("workbench-browser-1", "main").is_err());
        for id in ["", "../panel", "panel\n", "panel/1"] {
            assert!(validate_id(id).is_err());
        }
        assert!(validate_bounds(&NativeBounds {
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.
        })
        .is_ok());
        for width in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(validate_bounds(&NativeBounds {
                x: 0.,
                y: 0.,
                width,
                height: 1.
            })
            .is_err());
        }
    }
    #[test]
    fn rejects_non_executable_and_missing_paths() {
        for path in [
            "app.exe",
            "https://host/app.exe",
            "C:\\missing-m201\\app.exe",
            "C:\\Windows\\win.ini",
            "C:\\x.exe\n",
        ] {
            assert!(validate_executable_path(path).is_err());
        }
    }
    #[test]
    fn catalog_reports_real_availability_without_claiming_embedding() {
        let apps = catalog();
        assert!(apps.iter().any(|a| a.id == "chatgpt"));
        for app in apps.iter().filter(|a| a.running) {
            assert!(app.launchable);
            assert!(app.path.as_ref().is_some_and(|p| Path::new(p).is_file()));
        }
    }
}
