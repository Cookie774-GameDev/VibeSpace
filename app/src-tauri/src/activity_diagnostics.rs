//! The main application may append only the bounded, metadata-only diagnostic schema.
use crate::activity_diagnostics_store::{
    append_batch_at, ActivityDiagnosticBatch, DiagnosticReceipt,
};
use tauri::Manager;

const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

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
