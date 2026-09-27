//! A Windows toast needs a Start Menu shortcut whose AppUserModelID matches the
//! sender. The app's historical identifier is also used by older Jarvis installs,
//! so notifications use a distinct VibeSpace identity without moving app data.

#[cfg(windows)]
const NOTIFICATION_APP_ID: &str = "ai.vibespace.notifications";

#[tauri::command]
pub async fn vibespace_notify(
    app: tauri::AppHandle,
    title: String,
    body: Option<String>,
    silent: bool,
    variant: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            register_windows_shortcut()?;
            let plain_notification = || {
                let mut notification = tauri_winrt_notification::Toast::new(NOTIFICATION_APP_ID)
                    .title(&title)
                    .text1(body.as_deref().unwrap_or_default());
                if silent {
                    notification = notification.sound(None);
                }
                notification
            };
            let mut notification = plain_notification();
            // Artwork must never prevent a task result from reaching Notification Center.
            let mut has_artwork = false;
            if let Ok((hero, icon)) = prepare_notification_artwork(
                variant.as_deref(),
                &title,
                body.as_deref().unwrap_or_default(),
            ) {
                notification = notification
                    .hero(&hero, "VibeSpace notification artwork")
                    .icon(
                        &icon,
                        tauri_winrt_notification::IconCrop::Square,
                        "VibeSpace logo",
                    );
                has_artwork = true;
            }
            match notification.show() {
                Ok(()) => Ok(()),
                Err(artwork_error) if has_artwork => plain_notification().show().map_err(|error| {
                    format!("branded toast failed: {artwork_error}; plain toast failed: {error}")
                }),
                Err(error) => Err(error.to_string()),
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = silent;
        let _ = variant;
        let mut notification = app.notification().builder().title(title);
        if let Some(body) = body {
            notification = notification.body(body);
        }
        notification.show().map_err(|error| error.to_string())
    }
}

#[cfg(windows)]
fn prepare_notification_artwork(
    variant: Option<&str>,
    title: &str,
    body: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    use sha2::{Digest, Sha256};
    use std::{env, fs, path::Path, sync::Mutex, time::SystemTime};

    static ARTWORK_LOCK: Mutex<()> = Mutex::new(());
    let _guard = ARTWORK_LOCK.lock().map_err(|error| error.to_string())?;

    fn ensure_asset(path: &Path, bytes: &[u8]) -> Result<(), String> {
        if fs::read(path).ok().as_deref() != Some(bytes) {
            fs::write(path, bytes).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    let artwork_dir = env::var_os("APPDATA")
        .ok_or("APPDATA is unavailable")
        .map(std::path::PathBuf::from)?
        .join("VibeSpace/Notifications");
    fs::create_dir_all(&artwork_dir).map_err(|error| error.to_string())?;
    let (hero_name, hero_bytes) = match variant {
        Some("task_completed") => (
            "notification-task-complete.png",
            include_bytes!("../icons/notification-task-complete.png").as_slice(),
        ),
        Some("task_attention") => (
            "notification-task-attention.png",
            include_bytes!("../icons/notification-task-attention.png").as_slice(),
        ),
        Some("task_failed") => (
            "notification-task-failed.png",
            include_bytes!("../icons/notification-task-failed.png").as_slice(),
        ),
        Some("task_stopped") => (
            "notification-task-stopped.png",
            include_bytes!("../icons/notification-task-stopped.png").as_slice(),
        ),
        Some("context_map_completed") => (
            "notification-context-map.png",
            include_bytes!("../icons/notification-context-map.png").as_slice(),
        ),
        Some("credential_expired") => (
            "notification-credential-expired.png",
            include_bytes!("../icons/notification-credential-expired.png").as_slice(),
        ),
        _ => (
            "notification-hero.png",
            include_bytes!("../icons/notification-hero.png").as_slice(),
        ),
    };
    let static_hero = artwork_dir.join(hero_name);
    let icon = artwork_dir.join("notification-icon.png");
    ensure_asset(&icon, include_bytes!("../icons/icon.png"))?;
    let hero = (|| -> Result<std::path::PathBuf, String> {
        let mut digest = Sha256::new();
        digest.update(hero_bytes);
        digest.update(title.as_bytes());
        digest.update(body.as_bytes());
        let hash = digest.finalize();
        let name = hash[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let live_dir = artwork_dir.join("live");
        fs::create_dir_all(&live_dir).map_err(|error| error.to_string())?;
        let path = live_dir.join(format!("notification-live-{name}.png"));
        if !path.is_file() {
            let windows = env::var_os("WINDIR").ok_or("WINDIR is unavailable")?;
            let fonts = std::path::PathBuf::from(windows).join("Fonts");
            let regular = fs::read(fonts.join("segoeui.ttf")).map_err(|error| error.to_string())?;
            let bold = fs::read(fonts.join("segoeuib.ttf")).map_err(|error| error.to_string())?;
            let rendered =
                crate::notification_hero::render(hero_bytes, title, body, &regular, &bold)?;
            fs::write(&path, rendered).map_err(|error| error.to_string())?;
            // Keep a bounded local cache while preserving recent Notification Center images.
            let mut old = fs::read_dir(&live_dir)
                .map_err(|error| error.to_string())?
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("notification-live-")
                })
                .filter_map(|entry| {
                    let modified = entry
                        .metadata()
                        .ok()?
                        .modified()
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    Some((modified, entry.path()))
                })
                .collect::<Vec<_>>();
            old.sort_by_key(|(modified, _)| *modified);
            let excess = old.len().saturating_sub(128);
            for (_, expired) in old.into_iter().take(excess) {
                let _ = fs::remove_file(expired);
            }
        }
        Ok(path)
    })();
    let hero = match hero {
        Ok(path) => path,
        Err(_) => {
            ensure_asset(&static_hero, hero_bytes)?;
            static_hero
        }
    };
    Ok((hero, icon))
}

#[cfg(windows)]
fn register_windows_shortcut() -> Result<(), String> {
    use std::{env, fs, os::windows::ffi::OsStrExt, path::Path, sync::Mutex};
    use windows::{
        core::{Interface, PCWSTR, PWSTR},
        Win32::{
            Foundation::PROPERTYKEY,
            System::{
                Com::StructuredStorage::PROPVARIANT,
                Com::{
                    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoUninitialize, IPersistFile,
                    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
                },
                Variant::VT_LPWSTR,
            },
            UI::Shell::{IShellLinkW, PropertiesSystem::IPropertyStore, ShellLink},
        },
    };

    fn wide(value: &Path) -> Vec<u16> {
        value.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    static READY: Mutex<bool> = Mutex::new(false);
    let mut ready = READY.lock().map_err(|error| error.to_string())?;
    if *ready {
        return Ok(());
    }

    let exe = env::current_exe().map_err(|error| error.to_string())?;
    let programs = env::var_os("APPDATA")
        .ok_or("APPDATA is unavailable")
        .map(std::path::PathBuf::from)?
        .join("Microsoft/Windows/Start Menu/Programs/VibeSpace Notifications");
    fs::create_dir_all(&programs).map_err(|error| error.to_string())?;
    let shortcut_path = programs.join("VibeSpace.lnk");
    let exe_wide = wide(&exe);
    let path_wide = wide(&shortcut_path);
    let app_id_wide: Vec<u16> = NOTIFICATION_APP_ID.encode_utf16().chain(Some(0)).collect();

    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|error| error.to_string())?;
        struct ComGuard;
        impl Drop for ComGuard {
            fn drop(&mut self) {
                unsafe { CoUninitialize() }
            }
        }
        let _guard = ComGuard;

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        link.SetPath(PCWSTR(exe_wide.as_ptr()))
            .map_err(|error| error.to_string())?;
        link.SetIconLocation(PCWSTR(exe_wide.as_ptr()), 0)
            .map_err(|error| error.to_string())?;
        link.SetDescription(windows::core::w!("VibeSpace"))
            .map_err(|error| error.to_string())?;

        let store: IPropertyStore = link.cast().map_err(|error| error.to_string())?;
        let key = PROPERTYKEY {
            fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid: 5,
        };
        // PROPVARIANT owns VT_LPWSTR and frees it with CoTaskMemFree on drop.
        // Copy the Rust string into COM memory before passing it to SetValue.
        let app_id_ptr = CoTaskMemAlloc(app_id_wide.len() * std::mem::size_of::<u16>()) as *mut u16;
        if app_id_ptr.is_null() {
            return Err("unable to allocate the Windows notification identity".into());
        }
        std::ptr::copy_nonoverlapping(app_id_wide.as_ptr(), app_id_ptr, app_id_wide.len());
        let mut value = PROPVARIANT::default();
        let inner = &mut *value.Anonymous.Anonymous;
        inner.vt = VT_LPWSTR;
        inner.Anonymous.pwszVal = PWSTR(app_id_ptr);
        store
            .SetValue(&key, &value)
            .map_err(|error| error.to_string())?;
        store.Commit().map_err(|error| error.to_string())?;

        let persist: IPersistFile = link.cast().map_err(|error| error.to_string())?;
        persist
            .Save(PCWSTR(path_wide.as_ptr()), true)
            .map_err(|error| error.to_string())?;
    }
    *ready = true;
    Ok(())
}
