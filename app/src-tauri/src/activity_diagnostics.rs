//! The main application may append only the bounded, metadata-only diagnostic schema.
use crate::activity_diagnostics_store::{
    activity_diagnostic_capabilities, append_batch_at, native_monotonic_us, native_wall_us,
    ActivityDiagnosticBatch, ActivityDiagnosticCapabilities, DiagnosticReceipt,
};
use serde::Serialize;
use tauri::Manager;

const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDiagnosticClockSample {
    process_id: u32,
    wall_us: u64,
    monotonic_us: u64,
}

#[tauri::command]
pub fn activity_diagnostics_clock_sample(
    window: tauri::Webview,
) -> Result<ActivityDiagnosticClockSample, String> {
    crate::native_app_surface::ensure_main_caller(window.label(), window.window().label())?;
    Ok(ActivityDiagnosticClockSample {
        process_id: std::process::id(),
        wall_us: native_wall_us()?,
        monotonic_us: native_monotonic_us(),
    })
}

#[tauri::command]
pub fn activity_diagnostics_capabilities(
    window: tauri::Webview,
) -> Result<ActivityDiagnosticCapabilities, String> {
    crate::native_app_surface::ensure_main_caller(window.label(), window.window().label())?;
    Ok(activity_diagnostic_capabilities())
}

#[tauri::command]
pub async fn activity_diagnostics_append(
    window: tauri::Webview,
    batch: ActivityDiagnosticBatch,
) -> Result<DiagnosticReceipt, String> {
    crate::native_app_surface::ensure_main_caller(window.label(), window.window().label())?;
    let directory = window
        .app_handle()
        .path()
        .app_log_dir()
        .map_err(|_| "diagnostics_directory_unavailable")?
        .join("diagnostics");
    tauri::async_runtime::spawn_blocking(move || append_batch_at(&directory, batch, MAX_LOG_BYTES))
        .await
        .map_err(|_| "diagnostics_writer_unavailable".to_string())?
}
