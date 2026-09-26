//! Typed Tauri command boundary. Operational commands remain inaccessible until the native
//! supervisor reports both feature and packaged-payload readiness for the requested project.

use super::client::{
    AppendBlockInput, Block, BlockSummary, ClientError, Notebook, RuntimeStatus, RuntimeVersion,
    SiyuanClient,
};
use super::manifest::{SIYUAN_UPSTREAM_COMMIT, SIYUAN_UPSTREAM_TAG};
use super::supervisor::{SiyuanRuntimeState, SupervisorError};
use serde::{Deserialize, Serialize};
use tauri::State;

static READ_WORKERS: async_lock::Semaphore = async_lock::Semaphore::new(4);

async fn run_read<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = READ_WORKERS.acquire().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanNotebooksResponse {
    notebooks: Vec<Notebook>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanNotebookResponse {
    notebook: Notebook,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSearchResponse {
    blocks: Vec<BlockSummary>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanBlockResponse {
    block: Block,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanBlockRelationIdsResponse {
    block_ids: Vec<String>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanDocumentResponse {
    id: String,
}

#[derive(Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiyuanAppendBlockRequest {
    parent_id: String,
    markdown: String,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanBatchAppendBlocksResponse {
    ids: Vec<String>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanMutationResponse {
    applied: bool,
}

fn public_error(error: SupervisorError) -> String {
    error.public_code().to_owned()
}

fn client_error(error: ClientError) -> String {
    error.to_string()
}

#[tauri::command]
pub fn siyuan_status(state: State<'_, SiyuanRuntimeState>) -> Result<RuntimeStatus, String> {
    state.status().map_err(public_error)
}

#[tauri::command]
pub async fn siyuan_start(
    project_id: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<RuntimeStatus, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.start(&project_id).map_err(public_error))
        .await
        .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_stop(
    project_id: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<RuntimeStatus, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.stop_project(&project_id).map_err(public_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub fn siyuan_version() -> RuntimeVersion {
    RuntimeVersion {
        version: SIYUAN_UPSTREAM_TAG.trim_start_matches('v').to_owned(),
        commit: SIYUAN_UPSTREAM_COMMIT.to_owned(),
    }
}

#[tauri::command]
pub async fn siyuan_list_notebooks(
    project_id: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanNotebooksResponse, String> {
    let runtime = state.inner().clone();
    run_read(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .list_notebooks()
            .map(|notebooks| SiyuanNotebooksResponse { notebooks })
            .map_err(client_error)
    })
    .await
}

#[tauri::command]
pub async fn siyuan_create_notebook(
    project_id: String,
    name: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanNotebookResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .create_notebook(&name)
            .map(|notebook| SiyuanNotebookResponse { notebook })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_search_blocks(
    project_id: String,
    query: String,
    limit: u16,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanSearchResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .search_blocks(&query, limit)
            .map(|blocks| SiyuanSearchResponse { blocks })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_get_block(
    project_id: String,
    id: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanBlockResponse, String> {
    let runtime = state.inner().clone();
    run_read(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .get_block(&id)
            .map(|block| SiyuanBlockResponse { block })
            .map_err(client_error)
    })
    .await
}

#[tauri::command]
pub async fn siyuan_list_inbound_backlinks(
    project_id: String,
    id: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanBlockRelationIdsResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .list_inbound_backlinks(&id)
            .map(|block_ids| SiyuanBlockRelationIdsResponse { block_ids })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_create_document(
    project_id: String,
    notebook_id: String,
    path: String,
    markdown: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanDocumentResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .create_document(&notebook_id, &path, &markdown)
            .map(|id| SiyuanDocumentResponse { id })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_create_document_under_parent(
    project_id: String,
    notebook_id: String,
    map_root_id: String,
    parent_id: String,
    staging_path: String,
    markdown: String,
    marker: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanDocumentResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .create_document_under_parent(
                &notebook_id,
                &map_root_id,
                &parent_id,
                &staging_path,
                &markdown,
                &marker,
            )
            .map(|id| SiyuanDocumentResponse { id })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_batch_append_blocks(
    project_id: String,
    notebook_id: String,
    map_root_id: String,
    blocks: Vec<SiyuanAppendBlockRequest>,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanBatchAppendBlocksResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        let blocks = blocks
            .into_iter()
            .map(|block| AppendBlockInput {
                parent_id: block.parent_id,
                markdown: block.markdown,
            })
            .collect::<Vec<_>>();
        SiyuanClient::new(true, transport)
            .batch_append_blocks(&notebook_id, &map_root_id, &blocks)
            .map(|ids| SiyuanBatchAppendBlocksResponse { ids })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_update_block(
    project_id: String,
    map_root_id: String,
    id: String,
    expected_markdown: String,
    markdown: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanMutationResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .update_block(&map_root_id, &id, &expected_markdown, &markdown)
            .map(|_| SiyuanMutationResponse { applied: true })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_delete_block(
    project_id: String,
    map_root_id: String,
    id: String,
    expected_markdown: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanMutationResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .delete_block(&map_root_id, &id, &expected_markdown)
            .map(|_| SiyuanMutationResponse { applied: true })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_create_daily_note(
    project_id: String,
    notebook_id: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanDocumentResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .create_daily_note(&notebook_id)
            .map(|id| SiyuanDocumentResponse { id })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[tauri::command]
pub async fn siyuan_create_snapshot(
    project_id: String,
    memo: String,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanMutationResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let transport = runtime
            .runtime_transport(&project_id)
            .map_err(public_error)?;
        SiyuanClient::new(true, transport)
            .create_snapshot(&memo)
            .map(|_| SiyuanMutationResponse { applied: true })
            .map_err(client_error)
    })
    .await
    .map_err(|_| "siyuan_state_unavailable".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_worker_leaves_the_calling_thread_and_preserves_results() {
        let caller = std::thread::current().id();
        tauri::async_runtime::block_on(async {
            assert_ne!(
                caller,
                run_read(|| Ok(std::thread::current().id())).await.unwrap()
            );
            assert_eq!(
                run_read(|| Ok(vec!["one", "two"])).await.unwrap(),
                vec!["one", "two"]
            );
            assert_eq!(
                run_read(|| Err::<(), _>("original error".to_owned())).await,
                Err("original error".to_owned())
            );
        });
    }

    #[test]
    fn search_command_offloads_blocking_http_transport() {
        let source = include_str!("commands.rs");
        let command = source
            .split("pub async fn siyuan_search_blocks")
            .nth(1)
            .and_then(|remainder| remainder.split("pub async fn siyuan_get_block").next())
            .expect("search command must remain async");

        assert!(
            command.contains("tauri::async_runtime::spawn_blocking"),
            "blocking SiYuan HTTP search must not run on the Tauri command thread"
        );
        assert!(command.contains("runtime_transport(&project_id)"));
        assert!(command.contains("search_blocks(&query, limit)"));
    }

    #[test]
    fn relation_commands_offload_blocking_http_transport() {
        let source = include_str!("commands.rs");
        let command = source
            .split("pub async fn siyuan_list_inbound_backlinks")
            .nth(1)
            .and_then(|remainder| {
                remainder
                    .split("pub async fn siyuan_create_document")
                    .next()
            })
            .expect("backlink command must remain async");
        assert!(command.contains("tauri::async_runtime::spawn_blocking"));
        assert!(command.contains("runtime_transport(&project_id)"));
        assert!(command.contains("list_inbound_backlinks(&id)"));
    }

    #[test]
    fn batch_append_command_is_closed_ordered_and_offloads_blocking_http() {
        let source = include_str!("commands.rs");
        let command = source
            .split("pub async fn siyuan_batch_append_blocks")
            .nth(1)
            .and_then(|remainder| remainder.split("pub async fn siyuan_update_block").next())
            .expect("batch append command must remain async and bounded");
        assert!(command.contains("tauri::async_runtime::spawn_blocking"));
        assert!(command.contains("runtime_transport(&project_id)"));
        assert!(command.contains("map_root_id: String"));
        assert!(command.contains("batch_append_blocks(&notebook_id, &map_root_id, &blocks)"));
        assert!(command.contains("SiyuanBatchAppendBlocksResponse { ids }"));

        let update = source
            .split("pub async fn siyuan_update_block")
            .nth(1)
            .and_then(|remainder| remainder.split("pub async fn siyuan_delete_block").next())
            .expect("update command must remain map-root bound");
        assert!(update.contains("map_root_id: String"));
        assert!(update.contains("update_block(&map_root_id, &id, &expected_markdown, &markdown)"));
        let delete = source
            .split("pub async fn siyuan_delete_block")
            .nth(1)
            .and_then(|remainder| {
                remainder
                    .split("pub async fn siyuan_create_daily_note")
                    .next()
            })
            .expect("delete command must remain map-root bound");
        assert!(delete.contains("map_root_id: String"));
        assert!(delete.contains("delete_block(&map_root_id, &id, &expected_markdown)"));

        let first: SiyuanAppendBlockRequest = serde_json::from_value(serde_json::json!({
            "parentId": "parent-1",
            "markdown": "# First",
        }))
        .unwrap();
        let second: SiyuanAppendBlockRequest = serde_json::from_value(serde_json::json!({
            "parentId": "parent-2",
            "markdown": "# Second",
        }))
        .unwrap();
        assert_eq!(first.parent_id, "parent-1");
        assert_eq!(second.parent_id, "parent-2");
        assert!(
            serde_json::from_value::<SiyuanAppendBlockRequest>(serde_json::json!({
                "parentId": "parent-1",
                "markdown": "# First",
                "endpoint": "/api/query/sql",
            }))
            .is_err()
        );

        let response = SiyuanBatchAppendBlocksResponse {
            ids: vec!["child-1".to_owned(), "child-2".to_owned()],
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({ "ids": ["child-1", "child-2"] })
        );
    }

    #[test]
    fn exact_parent_document_create_is_closed_and_offloads_blocking_http() {
        let source = include_str!("commands.rs");
        let command = source
            .split("pub async fn siyuan_create_document_under_parent")
            .nth(1)
            .and_then(|remainder| {
                remainder
                    .split("pub async fn siyuan_batch_append_blocks")
                    .next()
            })
            .expect("exact-parent create command is registered");
        assert!(command.contains("tauri::async_runtime::spawn_blocking"));
        assert!(command.contains("runtime_transport(&project_id)"));
        assert!(command.contains("map_root_id: String"));
        assert!(command.contains("parent_id: String"));
        assert!(command.contains("create_document_under_parent("));
    }

    #[test]
    fn version_is_pinned_metadata_without_runtime_or_token_material() {
        let version = siyuan_version();
        assert_eq!(version.version, "3.8.1");
        assert_eq!(version.commit, SIYUAN_UPSTREAM_COMMIT);
        let serialized = serde_json::to_string(&version).unwrap();
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("127.0.0.1"));
    }

    #[test]
    fn public_errors_are_stable_redacted_codes() {
        for error in [
            SupervisorError::FeatureDisabled,
            SupervisorError::PayloadUnavailable,
            SupervisorError::RuntimeNotReady,
            SupervisorError::ProjectUnauthorized,
            SupervisorError::WorkspaceUnavailable,
            SupervisorError::ResourceUnavailable,
            SupervisorError::StateUnavailable,
            SupervisorError::LifecycleInvalid,
            SupervisorError::ProcessUnavailable,
            SupervisorError::StartupTimeout,
        ] {
            let rendered = public_error(error);
            assert!(rendered.starts_with("siyuan_"));
            assert!(!rendered.contains("token"));
            assert!(!rendered.contains("http"));
            assert!(!rendered.contains('\\'));
        }
    }
}
