use keyring::{Entry, Error};

const SERVICE: &str = "ai.jarvis.desktop";
const ACCOUNT_PREFIX: &str = "llm-api-key";

fn account_for(provider: &str) -> Result<String, String> {
    let clean = provider.trim().to_ascii_lowercase();
    if clean.is_empty() {
        return Err("provider is required".to_string());
    }
    if !clean
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("provider contains invalid characters".to_string());
    }
    Ok(format!("{ACCOUNT_PREFIX}:{clean}"))
}

fn entry_for(provider: &str) -> Result<Entry, String> {
    let account = account_for(provider)?;
    Entry::new(SERVICE, &account).map_err(|err| format!("credential store unavailable: {err}"))
}

#[tauri::command]
pub fn credential_set(provider: String, key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return credential_delete(provider);
    }
    let entry = entry_for(&provider)?;
    entry
        .set_password(trimmed)
        .map_err(|err| format!("credential save failed: {err}"))
}

#[tauri::command]
pub fn credential_get(provider: String) -> Result<Option<String>, String> {
    let entry = entry_for(&provider)?;
    match entry.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("credential read failed: {err}")),
    }
}

#[tauri::command]
pub fn credential_delete(provider: String) -> Result<(), String> {
    let entry = entry_for(&provider)?;
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("credential delete failed: {err}")),
    }
}
