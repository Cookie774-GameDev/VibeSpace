//! Metadata-only, bounded native context/model timeline. Never accepts output text or a log path.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

pub const ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION: u8 = 2;
pub const ACTIVITY_DIAGNOSTIC_MAX_BATCH_EVENTS: usize = 64;
pub const ACTIVITY_DIAGNOSTIC_FIELDS: &[&str] = &[
    "sequence", "operationId", "kind", "phase", "observedAt", "monotonicMs",
    "durationMs", "requestId", "chatId", "sessionId", "callId", "runId",
    "publicationRevision", "coalescedRevisions", "uiCommitMs", "nativeSequence",
    "nativeHandoffWallUs", "nativeHandoffMonotonicUs", "rendererReceivedAt",
    "rendererReceivedMonotonicMs", "provider", "model", "tool", "operation",
    "eventType", "resultCode", "runtimeGeneration", "nativeProcessId", "rendererSentAt",
    "rendererSentMonotonicMs", "clockRoundTripMs", "clockUncertaintyMs", "outcome", "completeness",
    "hasContinuation", "returnedItems", "returnedChars", "diagnosticTruncated",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDiagnosticCapabilities {
    schema_versions: [u8; 1],
    fields: &'static [&'static str],
    max_batch_events: usize,
}

static NATIVE_MONOTONIC_ORIGIN: OnceLock<Instant> = OnceLock::new();

pub fn native_monotonic_us() -> u64 {
    NATIVE_MONOTONIC_ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_micros()
        .min(u64::MAX as u128) as u64
}

pub fn native_wall_us() -> Result<u64, String> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_micros().min(u64::MAX as u128) as u64)
        .map_err(|_| "diagnostics_clock_unavailable".to_string())
}

pub fn activity_diagnostic_capabilities() -> ActivityDiagnosticCapabilities {
    ActivityDiagnosticCapabilities {
        schema_versions: [ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION],
        fields: ACTIVITY_DIAGNOSTIC_FIELDS,
        max_batch_events: ACTIVITY_DIAGNOSTIC_MAX_BATCH_EVENTS,
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityDiagnosticBatch {
    schema_version: u8,
    renderer_instance: String,
    dropped_total: u64,
    failed_batches: u64,
    events: Vec<Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReceipt {
    accepted: usize,
    path: String,
}
fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 || !value.as_bytes()[0].is_ascii_alphanumeric() {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._:/@-".contains(&byte))
        && ![
            "sk-",
            "ghp_",
            "gho_",
            "ghu_",
            "ghs_",
            "ghr_",
            "github_pat_",
            "aiza",
            "bearer",
        ]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}
fn validate_batch(batch: &ActivityDiagnosticBatch) -> Result<(), String> {
    if batch.schema_version != ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION
        || !valid_identifier(&batch.renderer_instance)
        || batch.events.is_empty()
        || batch.events.len() > ACTIVITY_DIAGNOSTIC_MAX_BATCH_EVENTS
    {
        return Err("diagnostics_invalid_batch".into());
    }
    for event in &batch.events {
        let object = event.as_object().ok_or("diagnostics_invalid_event")?;
        for key in [
            "sequence",
            "operationId",
            "kind",
            "phase",
            "observedAt",
            "monotonicMs",
            "outcome",
            "completeness",
        ] {
            if !object.contains_key(key) {
                return Err("diagnostics_missing_metadata".into());
            }
        }
        for (key, value) in object {
            let valid = match key.as_str() {
                "operationId" | "kind" | "phase" | "requestId" | "chatId" | "sessionId"
                | "runId" | "callId" | "provider" | "model" | "tool" | "operation"
                | "eventType" | "resultCode" | "runtimeGeneration" => value.as_str().is_some_and(valid_identifier),
                "sequence"
                | "returnedItems"
                | "returnedChars"
                | "publicationRevision"
                | "coalescedRevisions"
                | "nativeSequence"
                | "nativeHandoffWallUs"
                | "nativeHandoffMonotonicUs"
                | "nativeProcessId" => value
                    .as_u64()
                    .is_some_and(|number| number <= 9_007_199_254_740_991),
                "observedAt"
                | "monotonicMs"
                | "durationMs"
                | "uiCommitMs"
                | "rendererReceivedAt"
                | "rendererReceivedMonotonicMs"
                | "rendererSentAt"
                | "rendererSentMonotonicMs"
                | "clockRoundTripMs"
                | "clockUncertaintyMs" => value
                    .as_f64()
                    .is_some_and(|number| {
                        number.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&number)
                    }),
                "outcome" => value.as_str().is_some_and(|value| {
                    matches!(
                        value,
                        "running" | "success" | "failure" | "cancelled" | "timeout" | "unknown"
                    )
                }),
                "completeness" => value.as_str().is_some_and(|value| {
                    matches!(value, "complete" | "partial" | "truncated" | "unknown")
                }),
                "hasContinuation" | "diagnosticTruncated" => value.is_boolean(),
                _ => false,
            };
            if !valid {
                return Err("diagnostics_invalid_metadata".into());
            }
        }
    }
    Ok(())
}
fn reject_link(path: &Path, directory: bool) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            let mut linked = metadata.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                linked |= metadata.file_attributes() & 0x400 != 0;
            }
            if linked || (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
                return Err("diagnostics_unsafe_path".into());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("diagnostics_path_unavailable".into()),
    }
}
fn private_file(path: &Path, append: bool) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).append(append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "diagnostics_open_failed".into())
}
pub fn append_batch_at(
    directory: &Path,
    batch: ActivityDiagnosticBatch,
    limit: u64,
) -> Result<DiagnosticReceipt, String> {
    use std::io::Write;
    validate_batch(&batch)?;
    let accepted = batch.events.len();
    let native_received_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "diagnostics_clock_unavailable")?
        .as_millis() as u64;
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "nativeReceivedAt": native_received_at, "processId": std::process::id(), "batch": batch,
    }))
    .map_err(|_| "diagnostics_encode_failed")?;
    bytes.push(b'\n');
    if bytes.len() > 128 * 1024 || bytes.len() as u64 > limit {
        return Err("diagnostics_batch_too_large".into());
    }
    reject_link(directory, true)?;
    std::fs::create_dir_all(directory).map_err(|_| "diagnostics_directory_failed")?;
    reject_link(directory, true)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "diagnostics_permissions_failed")?;
    }
    let lock_path = directory.join("context-runtime.lock");
    reject_link(&lock_path, false)?;
    let lock_file = private_file(&lock_path, false)?;
    // Cross-process, non-blocking lock: another app instance cannot corrupt rotation.
    fs4::FileExt::try_lock_exclusive(&lock_file).map_err(|_| "diagnostics_writer_busy")?;
    let paths = [
        directory.join("context-runtime.jsonl"),
        directory.join("context-runtime.1.jsonl"),
        directory.join("context-runtime.2.jsonl"),
    ];
    for path in &paths {
        reject_link(path, false)?;
    }
    let size = match std::fs::metadata(&paths[0]) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return Err("diagnostics_metadata_failed".into()),
    };
    if size + bytes.len() as u64 > limit {
        if paths[2].exists() {
            std::fs::remove_file(&paths[2]).map_err(|_| "diagnostics_rotate_failed")?;
        }
        if paths[1].exists() {
            std::fs::rename(&paths[1], &paths[2]).map_err(|_| "diagnostics_rotate_failed")?;
        }
        if paths[0].exists() {
            std::fs::rename(&paths[0], &paths[1]).map_err(|_| "diagnostics_rotate_failed")?;
        }
    }
    let mut file = private_file(&paths[0], true)?;
    file.write_all(&bytes)
        .map_err(|_| "diagnostics_write_failed")?;
    file.sync_data().map_err(|_| "diagnostics_sync_failed")?;
    Ok(DiagnosticReceipt {
        accepted,
        path: paths[0].to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn batch() -> ActivityDiagnosticBatch {
        serde_json::from_value(json!({"schemaVersion":2,"rendererInstance":"test-renderer",
            "droppedTotal":0,"failedBatches":0,"events":[{"sequence":1,"operationId":"op:1",
            "kind":"semantic-tool","phase":"completed","observedAt":1700000000000u64,
            "monotonicMs":1.5,"outcome":"success","completeness":"unknown"}]}))
        .unwrap()
    }
    #[test]
    fn rejects_unknown_content_and_secret_shaped_identifiers() {
        let mut input = batch();
        input.events[0]["text"] = json!("private source text");
        assert!(validate_batch(&input).is_err());
        let mut input = batch();
        input.events[0]["model"] = json!("sk-proj-private");
        assert!(validate_batch(&input).is_err());
    }
    #[test]
    fn rejects_oversized_batches_and_invalid_numeric_metadata() {
        let mut input = batch();
        input.events = vec![input.events[0].clone(); 65];
        assert!(validate_batch(&input).is_err());
        let mut input = batch();
        input.events[0]["monotonicMs"] = json!(-1);
        assert!(validate_batch(&input).is_err());
        input.events[0]["monotonicMs"] = json!("not a number");
        assert!(validate_batch(&input).is_err());
    }
    #[test]
    fn accepts_renderer_run_and_commit_correlation_without_accepting_payloads() {
        let mut input = batch();
        input.events[0]["runId"] = json!("run-22");
        input.events[0]["requestId"] = json!("request-22");
        input.events[0]["chatId"] = json!("chat-22");
        input.events[0]["publicationRevision"] = json!(22);
        input.events[0]["uiCommitMs"] = json!(4.5);
        assert_eq!(validate_batch(&input), Ok(()));
        input.events[0]["runId"] = json!("sk-proj-not-an-id");
        assert!(validate_batch(&input).is_err());
    }
    #[test]
    fn accepts_real_preview_coalescing_metadata_without_weakening_unknown_field_rejection() {
        let mut input = batch();
        input.events[0]["kind"] = json!("ui.preview");
        input.events[0]["phase"] = json!("committed");
        input.events[0]["coalescedRevisions"] = json!(0);
        assert_eq!(validate_batch(&input), Ok(()));
        input.events[0]["coalescedRevisions"] = json!(2);
        assert_eq!(validate_batch(&input), Ok(()));
        for invalid in [json!(-1), json!(9_007_199_254_740_992u64), json!("2")] {
            input.events[0]["coalescedRevisions"] = invalid;
            assert!(validate_batch(&input).is_err());
        }
        input.events[0]["coalescedRevisions"] = json!(0);
        input.events[0]["rawOutput"] = json!("not permitted");
        assert!(validate_batch(&input).is_err());
    }
    #[test]
    fn canonical_fixture_is_accepted_by_the_actual_native_validator() {
        let fixture: ActivityDiagnosticBatch = serde_json::from_str(include_str!(
            "../../src/lib/diagnostics/activityDiagnosticContract.fixture.json"
        ))
        .expect("canonical diagnostic fixture");
        assert_eq!(validate_batch(&fixture), Ok(()));
        assert_eq!(fixture.schema_version, ACTIVITY_DIAGNOSTIC_SCHEMA_VERSION);
        assert_eq!(activity_diagnostic_capabilities().max_batch_events, 64);
    }

    #[test]
    fn accepts_only_the_versioned_metadata_schema() {
        assert!(validate_batch(&batch()).is_ok());
        let mut input = batch();
        input.schema_version = 1;
        assert!(validate_batch(&input).is_err());
        let mut input = batch();
        input.events[0]["completeness"] = json!("probably complete");
        assert!(validate_batch(&input).is_err());
    }
    #[test]
    fn writes_acknowledged_jsonl_and_rotates_with_a_bounded_disk_footprint() {
        let root = std::env::var_os("VIBESPACE_DIAGNOSTICS_TEST_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = root.join(format!(
            "activity-diagnostics-{}-{nonce}",
            std::process::id()
        ));
        for sequence in 1..=12 {
            let mut input = batch();
            input.events[0]["sequence"] = json!(sequence);
            let result = append_batch_at(&directory, input, 1200).unwrap();
            assert_eq!(result.accepted, 1);
            assert!(result.path.ends_with("context-runtime.jsonl"));
        }
        let files: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
            .collect();
        assert_eq!(files.len(), 3);
        for path in files {
            assert!(std::fs::metadata(&path).unwrap().len() <= 1200);
            for line in std::fs::read_to_string(path).unwrap().lines() {
                let value: Value = serde_json::from_str(line).unwrap();
                assert!(value["nativeReceivedAt"].is_number());
                assert!(value["processId"].is_number());
                assert_eq!(value["batch"]["schemaVersion"], 2);
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
