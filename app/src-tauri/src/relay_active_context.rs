//! Native-owned snapshot of the current Workbench account/project/chat scope.
//!
//! This state is a lifecycle cache supplied by the main app window. It is not
//! authentication, a Relay credential, or authority to send messages or stop a
//! terminal. Consumers must establish those capabilities separately.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{State, WebviewWindow};

#[derive(Default)]
pub struct RelayActiveContextState(Mutex<ContextState>);

#[derive(Default)]
struct ContextState {
    generation: u64,
    owner_handle: Option<String>,
    last_revision: u64,
    context: Option<RelayActiveContext>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayActiveContext {
    pub account_id: String,
    pub workspace_id: Option<String>,
    pub project_id: String,
    pub chat_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayActiveContextUpdate {
    pub account_id: String,
    pub workspace_id: Option<String>,
    pub project_id: String,
    pub chat_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayActiveContextSnapshot {
    pub generation: u64,
    pub context: Option<RelayActiveContext>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayActiveContextOwner {
    pub owner_handle: String,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value == value.trim()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':' | b'@')
        })
}

fn checked_context(update: RelayActiveContextUpdate) -> Result<RelayActiveContext, String> {
    if !valid_id(&update.account_id)
        || !valid_id(&update.project_id)
        || !valid_id(&update.chat_id)
        || update
            .workspace_id
            .as_deref()
            .is_some_and(|id| !valid_id(id))
    {
        return Err("Relay active context is invalid.".into());
    }
    Ok(RelayActiveContext {
        account_id: update.account_id,
        workspace_id: update.workspace_id,
        project_id: update.project_id,
        chat_id: update.chat_id,
    })
}

fn snapshot(state: &ContextState) -> RelayActiveContextSnapshot {
    RelayActiveContextSnapshot {
        generation: state.generation,
        context: state.context.clone(),
    }
}

impl RelayActiveContextState {
    fn open(&self) -> Result<RelayActiveContextOwner, String> {
        let owner_handle = nanoid::nanoid!(32);
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Relay active context state is busy.")?;
        state.generation = state.generation.wrapping_add(1);
        state.owner_handle = Some(owner_handle.clone());
        state.last_revision = 0;
        state.context = None;
        Ok(RelayActiveContextOwner { owner_handle })
    }

    fn update(
        &self,
        owner_handle: &str,
        revision: u64,
        update: Option<RelayActiveContextUpdate>,
    ) -> Result<RelayActiveContextSnapshot, String> {
        let context = update.map(checked_context).transpose()?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Relay active context state is busy.")?;
        if state.owner_handle.as_deref() != Some(owner_handle) {
            return Err("Relay active context owner has expired.".into());
        }
        if revision == 0 || revision <= state.last_revision {
            return Err("Relay active context update is stale.".into());
        }
        state.last_revision = revision;
        if state.context != context {
            state.generation = state.generation.wrapping_add(1);
            state.context = context;
        }
        Ok(snapshot(&state))
    }

    fn close(&self, owner_handle: &str, revision: u64) -> Result<(), String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Relay active context state is busy.")?;
        if state.owner_handle.as_deref() != Some(owner_handle) {
            return Ok(());
        }
        if revision == 0 || revision <= state.last_revision {
            return Err("Relay active context close is stale.".into());
        }
        state.owner_handle = None;
        state.last_revision = revision;
        if state.context.take().is_some() {
            state.generation = state.generation.wrapping_add(1);
        }
        Ok(())
    }

    fn current(&self) -> Result<RelayActiveContextSnapshot, String> {
        let state = self
            .0
            .lock()
            .map_err(|_| "Relay active context state is busy.")?;
        Ok(snapshot(&state))
    }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Relay active context is available only from the main VibeSpace window.".into())
    }
}

#[tauri::command]
pub fn relay_active_context_open(
    state: State<'_, RelayActiveContextState>,
    window: WebviewWindow,
) -> Result<RelayActiveContextOwner, String> {
    require_main(&window)?;
    state.open()
}

#[tauri::command]
pub fn relay_active_context_update(
    state: State<'_, RelayActiveContextState>,
    window: WebviewWindow,
    owner_handle: String,
    revision: u64,
    context: Option<RelayActiveContextUpdate>,
) -> Result<RelayActiveContextSnapshot, String> {
    require_main(&window)?;
    state.update(&owner_handle, revision, context)
}

#[tauri::command]
pub fn relay_active_context_close(
    state: State<'_, RelayActiveContextState>,
    window: WebviewWindow,
    owner_handle: String,
    revision: u64,
) -> Result<(), String> {
    require_main(&window)?;
    state.close(&owner_handle, revision)
}

#[tauri::command]
pub fn relay_active_context_snapshot(
    state: State<'_, RelayActiveContextState>,
    window: WebviewWindow,
) -> Result<RelayActiveContextSnapshot, String> {
    require_main(&window)?;
    state.current()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(project_id: &str, chat_id: &str) -> RelayActiveContextUpdate {
        RelayActiveContextUpdate {
            account_id: "account-a".into(),
            workspace_id: Some("workspace-a".into()),
            project_id: project_id.into(),
            chat_id: chat_id.into(),
        }
    }

    #[test]
    fn owner_revision_and_scope_change_invalidate_old_app_context() {
        let state = RelayActiveContextState::default();
        let owner = state.open().unwrap().owner_handle;
        let first = state
            .update(&owner, 1, Some(update("project-a", "chat-a")))
            .unwrap();
        let second = state
            .update(&owner, 2, Some(update("project-b", "chat-b")))
            .unwrap();

        assert!(second.generation > first.generation);
        assert_eq!(second.context.unwrap().project_id, "project-b");
        assert!(state
            .update(&owner, 1, Some(update("project-a", "chat-a")))
            .is_err());
    }

    #[test]
    fn replacement_owner_revokes_previous_owner_and_close_clears_context() {
        let state = RelayActiveContextState::default();
        let previous = state.open().unwrap().owner_handle;
        state
            .update(&previous, 1, Some(update("project-a", "chat-a")))
            .unwrap();

        let current = state.open().unwrap().owner_handle;
        assert!(state
            .update(&previous, 2, Some(update("project-a", "chat-a")))
            .is_err());
        state
            .update(&current, 1, Some(update("project-b", "chat-b")))
            .unwrap();
        state.close(&current, 2).unwrap();

        assert_eq!(state.current().unwrap().context, None);
        assert!(state
            .update(&current, 3, Some(update("project-c", "chat-c")))
            .is_err());
    }

    #[test]
    fn invalid_scope_values_fail_without_mutating_current_context() {
        let state = RelayActiveContextState::default();
        let owner = state.open().unwrap().owner_handle;
        let before = state.current().unwrap();

        assert!(state
            .update(&owner, 1, Some(update("bad project", "chat-a")))
            .is_err());
        assert_eq!(state.current().unwrap(), before);
    }

    #[test]
    fn a_new_revision_can_clear_context_for_logout_or_missing_selection() {
        let state = RelayActiveContextState::default();
        let owner = state.open().unwrap().owner_handle;
        state
            .update(&owner, 1, Some(update("project-a", "chat-a")))
            .unwrap();

        let cleared = state.update(&owner, 2, None).unwrap();
        assert!(cleared.generation > 1);
        assert_eq!(cleared.context, None);
    }
}
