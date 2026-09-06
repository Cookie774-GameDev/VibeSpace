//! Installed application discovery and reversible native Workbench window hosting.
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
    #[serde(skip)]
    shell_id: Option<String>,
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
    embedding_error: Option<String>,
}
struct Record {
    operation_id: String,
    app_id: String,
    name: String,
    path: PathBuf,
    shell_id: Option<String>,
    #[cfg(windows)]
    embedded: Option<embedding::EmbeddedWindow>,
    z: i32,
    visible: bool,
    embedding_error: Option<String>,
}
#[cfg(windows)]
#[path = "native_app_embedding.rs"]
mod embedding;
static RECORDS: LazyLock<Mutex<HashMap<String, Record>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static REQUESTS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn release_all() {
    if let Ok(mut requests) = REQUESTS.lock() {
        requests.clear();
    }
    if let Ok(mut records) = RECORDS.lock() {
        records.clear();
    }
}

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
    pub fn focus_window(hwnd: isize) -> Result<(), String> {
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

    pub fn app_id(hwnd: isize) -> Option<String> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetApplicationUserModelId(
                process: *mut std::ffi::c_void,
                length: *mut u32,
                id: *mut u16,
            ) -> i32;
        }
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid));
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = vec![0u16; 512];
        let mut length = buffer.len() as u32;
        let result =
            unsafe { GetApplicationUserModelId(process.0, &mut length, buffer.as_mut_ptr()) };
        let _ = unsafe { CloseHandle(process) };
        (result == 0 && length > 0 && length as usize <= buffer.len())
            .then(|| String::from_utf16_lossy(&buffer[..length as usize - 1]))
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn windows() -> Vec<(isize, PathBuf)> {
        Vec::new()
    }
    pub fn focus_window(_: isize) -> Result<(), String> {
        Err("workbench_native_app_requires_windows".into())
    }
    pub fn app_id(_: isize) -> Option<String> {
        None
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledApp {
    name: String,
    app_id: String,
    path: Option<String>,
}

#[cfg(windows)]
fn installed_apps() -> Result<Vec<InstalledApp>, String> {
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    static CACHE: LazyLock<Mutex<Option<(Instant, Vec<InstalledApp>)>>> =
        LazyLock::new(|| Mutex::new(None));
    let mut cache = CACHE.lock().map_err(|_| "App catalog unavailable")?;
    if let Some((at, apps)) = &*cache {
        if at.elapsed() < Duration::from_secs(30) {
            return Ok(apps.clone());
        }
    }
    let executable =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows directory unavailable")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut child = Command::new(executable)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("native_app_catalog.ps1"),
        ])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not read Windows installed apps")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("App catalog output unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| "App catalog reader failed")?
        .map_err(|_| "App catalog read failed")?;
    if !success || bytes.len() > 8 * 1024 * 1024 {
        return Err("Windows app discovery failed. Reopen Apps to retry.".into());
    }
    let apps: Vec<InstalledApp> =
        serde_json::from_slice(&bytes).map_err(|_| "Windows app catalog was invalid")?;
    *cache = Some((Instant::now(), apps.clone()));
    Ok(apps)
}
#[cfg(not(windows))]
fn installed_apps() -> Result<Vec<InstalledApp>, String> {
    Ok(Vec::new())
}

fn stable_app_id(identity: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(identity.to_lowercase().as_bytes()));
    format!("app_{}", &digest[..20])
}

fn find_window(path: &Path, shell_id: Option<&str>) -> Option<isize> {
    platform::windows()
        .into_iter()
        .find_map(|(hwnd, candidate)| {
            ((!path.as_os_str().is_empty() && same_path(path, &candidate))
                || shell_id.is_some_and(|id| platform::app_id(hwnd).as_deref() == Some(id)))
            .then_some(hwnd)
        })
}

fn catalog() -> Result<Vec<NativeAppDescriptor>, String> {
    let mut apps: Vec<NativeAppDescriptor> = installed_apps()?
        .into_iter()
        .filter(|app| {
            !app.name.trim().is_empty()
                && !app.app_id.is_empty()
                && !app.app_id.chars().any(char::is_control)
        })
        .map(|app| {
            let chatgpt = app.name.eq_ignore_ascii_case("ChatGPT");
            NativeAppDescriptor {
                id: if chatgpt {
                    "chatgpt".into()
                } else {
                    stable_app_id(&app.app_id)
                },
                name: app.name,
                path: app.path,
                process_name: None,
                running: false,
                pinned: chatgpt,
                launchable: true,
                shell_id: Some(app.app_id),
            }
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    apps.retain(|app| seen.insert(app.id.clone()));
    for (hwnd, path) in platform::windows() {
        let shell_id = platform::app_id(hwnd);
        if let Some(app) = apps.iter_mut().find(|a: &&mut NativeAppDescriptor| {
            a.path
                .as_ref()
                .is_some_and(|p| same_path(Path::new(p), &path))
                || shell_id
                    .as_ref()
                    .is_some_and(|id| a.shell_id.as_ref() == Some(id))
        }) {
            app.running = true;
            if app.path.is_none() {
                app.path = Some(path.to_string_lossy().into());
            }
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
            shell_id: None,
        });
    }
    apps.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(a.name.cmp(&b.name)));
    if let Ok(records) = RECORDS.lock() {
        for app in &mut apps {
            #[cfg(windows)]
            if records.values().any(|record| {
                record.app_id == app.id
                    && record
                        .embedded
                        .as_ref()
                        .is_some_and(|host| host.is_attached())
            }) {
                app.running = true;
            }
        }
    }
    Ok(apps)
}
fn hide_record(records: &mut HashMap<String, Record>, panel_id: &str, operation_id: &str) {
    if let Some(record) = records
        .get_mut(panel_id)
        .filter(|r| r.operation_id == operation_id)
    {
        record.visible = false;
        #[cfg(windows)]
        if let Some(host) = &record.embedded {
            host.hide();
        }
    }
}
fn status(panel_id: &str, record: &Record) -> NativeStatus {
    #[cfg(windows)]
    let embedded = record
        .embedded
        .as_ref()
        .is_some_and(|host| host.is_attached());
    #[cfg(not(windows))]
    let embedded = false;
    NativeStatus {
        panel_id: panel_id.into(),
        operation_id: record.operation_id.clone(),
        app_id: record.app_id.clone(),
        name: record.name.clone(),
        embedded,
        running: embedded || find_window(&record.path, record.shell_id.as_deref()).is_some(),
        fallback: !embedded,
        owned: false,
        error: None,
        embedding_error: record.embedding_error.clone(),
    }
}

#[tauri::command]
pub async fn workbench_native_app_list(
    window: tauri::Webview,
) -> Result<Vec<NativeAppDescriptor>, String> {
    ensure_main_caller(window.label(), window.window().label())?;
    tauri::async_runtime::spawn_blocking(catalog)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn workbench_native_app_surface_open(
    window: tauri::Webview,
    panel_id: String,
    operation_id: String,
    app_id: String,
    path: Option<String>,
    bounds: NativeBounds,
    launch: Option<bool>,
    scale_factor: Option<f64>,
    z_index: Option<i32>,
) -> Result<NativeStatus, String> {
    ensure_main_caller(window.label(), window.window().label())?;
    validate_id(&panel_id)?;
    validate_id(&operation_id)?;
    validate_id(&app_id)?;
    validate_bounds(&bounds)?;
    let scale = scale_factor.unwrap_or(1.0);
    if !scale.is_finite() || scale <= 0.0 || scale > 16.0 {
        return Err("workbench_native_app_scale_invalid".into());
    }
    #[cfg(windows)]
    let parent = window.window().hwnd().map_err(|e| e.to_string())?.0 as isize;
    REQUESTS
        .lock()
        .map_err(|_| "Native app state unavailable")?
        .insert(panel_id.clone(), operation_id.clone());
    tauri::async_runtime::spawn_blocking(move || {
        // Avoid re-enumerating the installed catalog during every drag/resize.
        {
            let requests = REQUESTS
                .lock()
                .map_err(|_| "Native app state unavailable")?;
            if requests.get(&panel_id) != Some(&operation_id) {
                return Err("workbench_native_app_operation_stale".into());
            }
            let mut records = RECORDS.lock().map_err(|_| "Native app state unavailable")?;
            if let Some(record) = records.get_mut(&panel_id).filter(|r| {
                r.app_id == app_id
                    && path
                        .as_ref()
                        .is_none_or(|path| same_path(Path::new(path), &r.path))
            }) {
                record.operation_id = operation_id.clone();
                record.visible = true;
                record.z = z_index.unwrap_or(0);
                #[cfg(windows)]
                if let Some(host) = record.embedded.as_ref().filter(|host| host.is_attached()) {
                    host.resize(&bounds, scale)?;
                    let result = status(&panel_id, record);
                    raise_surfaces(&records);
                    return Ok(result);
                }
            }
        }
        let detected = if app_id == "custom" && path.is_some() {
            None
        } else {
            catalog()?.into_iter().find(|a| a.id == app_id)
        };
        let shell_id = detected.as_ref().and_then(|app| app.shell_id.clone());
        let current_path = match &detected {
            Some(app) => app.path.clone(),
            None => path,
        };
        let path = match current_path {
            Some(path) => validate_executable_path(&path)?,
            None if shell_id.is_some() => PathBuf::new(),
            None => return Err("workbench_native_app_not_installed".into()),
        };
        let name = detected.map(|a| a.name).unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        });
        let mut record = Record {
            operation_id,
            app_id,
            name,
            path,
            shell_id,
            #[cfg(windows)]
            embedded: None,
            z: z_index.unwrap_or(0),
            visible: true,
            embedding_error: None,
        };
        let mut hwnd = find_window(&record.path, record.shell_id.as_deref());
        #[cfg(windows)]
        if RECORDS
            .lock()
            .map_err(|_| "Native app state unavailable")?
            .iter()
            .any(|(id, existing)| {
                id != &panel_id
                    && (existing.app_id == record.app_id
                        || (!record.path.as_os_str().is_empty()
                            && same_path(&existing.path, &record.path)))
                    && existing
                        .embedded
                        .as_ref()
                        .is_some_and(|host| host.is_attached())
            })
        {
            return Err("This app is already open in another Workbench panel.".into());
        }
        if hwnd.is_none() && launch == Some(true) {
            launch_app(&record)?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while std::time::Instant::now() < deadline {
                if !request_current(&panel_id, &record.operation_id) {
                    return Err("workbench_native_app_operation_stale".into());
                }
                hwnd = find_window(&record.path, record.shell_id.as_deref());
                if hwnd.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        let requests = REQUESTS
            .lock()
            .map_err(|_| "Native app state unavailable")?;
        if requests.get(&panel_id) != Some(&record.operation_id) {
            return Err("workbench_native_app_operation_stale".into());
        }
        let mut records = RECORDS.lock().map_err(|_| "Native app state unavailable")?;
        // Retire our previous lease before attempting to attach a replacement window.
        records.remove(&panel_id);
        #[cfg(windows)]
        if let Some(hwnd) = hwnd {
            match embedding::EmbeddedWindow::attach(hwnd, parent).and_then(|host| {
                host.resize(&bounds, scale)?;
                Ok(host)
            }) {
                Ok(host) => record.embedded = Some(host),
                Err(error) => record.embedding_error = Some(error),
            }
        }
        let result = status(&panel_id, &record);
        records.insert(panel_id, record);
        raise_surfaces(&records);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn request_current(panel_id: &str, operation_id: &str) -> bool {
    REQUESTS
        .lock()
        .is_ok_and(|requests| requests.get(panel_id).is_some_and(|id| id == operation_id))
}

fn raise_surfaces(records: &HashMap<String, Record>) {
    #[cfg(windows)]
    {
        let mut ordered: Vec<_> = records.values().filter(|r| r.visible).collect();
        ordered.sort_by_key(|r| r.z);
        for record in ordered {
            if let Some(host) = &record.embedded {
                host.raise();
            }
        }
    }
}

fn launch_app(record: &Record) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(app_id) = &record.shell_id {
        // Only OS-enumerated IDs reach this branch; no renderer-provided shell command.
        use std::os::windows::process::CommandExt;
        let explorer =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows directory unavailable")?)
                .join("explorer.exe");
        std::process::Command::new(explorer)
            .arg(format!("shell:AppsFolder\\{app_id}"))
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|_| "workbench_native_app_launch_failed")?;
        return Ok(());
    }
    let path = validate_executable_path(&record.path.to_string_lossy())?;
    std::process::Command::new(path)
        .spawn()
        .map_err(|_| "workbench_native_app_launch_failed")?;
    // Single-instance launchers often exit before their actual UI appears. Never kill them.
    Ok(())
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
        let hwnd = find_window(&record.path, record.shell_id.as_deref())
            .ok_or("workbench_native_app_window_closed")?;
        platform::focus_window(hwnd)
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
        let records = RECORDS
            .lock()
            .map_err(|_| "workbench_native_app_state_unavailable")?;
        let record = records
            .get(&panel_id)
            .filter(|r| r.operation_id == operation_id)
            .ok_or("workbench_native_app_operation_stale")?;
        launch_app(record)
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
    let mut requests = REQUESTS
        .lock()
        .map_err(|_| "Native app state unavailable")?;
    if requests
        .get(&panel_id)
        .is_some_and(|id| id == &operation_id)
    {
        requests.remove(&panel_id);
    }
    let mut records = RECORDS
        .lock()
        .map_err(|_| "workbench_native_app_state_unavailable")?;
    hide_record(&mut records, &panel_id, &operation_id);
    Ok(())
}
#[tauri::command]
pub fn workbench_native_app_surface_detach(
    window: tauri::Webview,
    panel_id: String,
) -> Result<(), String> {
    ensure_main_caller(window.label(), window.window().label())?;
    let mut requests = REQUESTS
        .lock()
        .map_err(|_| "Native app state unavailable")?;
    requests.remove(&panel_id);
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
    fn stale_hide_cannot_hide_a_restored_panel_and_current_hide_preserves_its_lease() {
        let mut records = HashMap::new();
        records.insert(
            "panel".into(),
            Record {
                operation_id: "new".into(),
                app_id: "app".into(),
                name: "App".into(),
                path: PathBuf::from("missing.exe"),
                shell_id: None,
                #[cfg(windows)]
                embedded: None,
                z: 0,
                visible: true,
                embedding_error: None,
            },
        );
        hide_record(&mut records, "panel", "old");
        assert_eq!(records.len(), 1);
        assert!(records["panel"].visible);
        let observed = status("panel", records.get("panel").unwrap());
        assert!(!observed.embedded && !observed.running && !observed.owned && observed.fallback);
        hide_record(&mut records, "panel", "new");
        assert!(!records["panel"].visible);
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
        let apps = catalog().unwrap();
        for installed in installed_apps().unwrap() {
            assert!(apps
                .iter()
                .any(|app| app.shell_id.as_deref() == Some(&installed.app_id)));
        }
        for app in apps.iter().filter(|a| a.running) {
            assert!(app.launchable);
            assert!(app.path.as_ref().is_some_and(|p| Path::new(p).is_file()));
        }
    }
}
