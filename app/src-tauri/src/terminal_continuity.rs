//! Claude's SessionStart hook records identity, never conversation text.
//! Records belong to one account/project/pane and are atomically replaced.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const LIMIT: u64 = 65_536;
const HOOK_FLAG: &str = "--vibespace-claude-session-hook";

#[derive(Deserialize, Serialize)]
struct Binding {
    version: u8,
    account_id: String,
    project_id: String,
    pane_id: String,
    cwd: PathBuf,
    nonce: String,
    session_id: Option<String>,
    transcript: Option<PathBuf>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreparedClaude {
    pub state: String,
    pub startup_command: Option<String>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn read_binding(path: &Path) -> Result<Binding, String> {
    let file = fs::File::open(path).map_err(|_| "continuity record unavailable")?;
    if file
        .metadata()
        .map_err(|_| "continuity metadata unavailable")?
        .len()
        > LIMIT
    {
        return Err("continuity record too large".into());
    }
    serde_json::from_reader(file.take(LIMIT)).map_err(|_| "continuity record invalid".into())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", nanoid::nanoid!(12)));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "continuity write unavailable")?;
        serde_json::to_writer(&mut file, value).map_err(|_| "continuity encoding failed")?;
        file.flush()
            .and_then(|_| file.sync_all())
            .map_err(|_| "continuity flush failed")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "continuity replace failed")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn quote(value: &str, powershell: bool) -> String {
    format!(
        "'{}'",
        value.replace('\'', if powershell { "''" } else { "'\\''" })
    )
}

// Claude executes command hooks through its shell, including Git Bash on Windows.
fn hook_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .replace('\\', "/")
}

#[allow(clippy::too_many_arguments)]
pub fn prepare(
    root: &Path,
    executable: &Path,
    account: &str,
    project: &str,
    pane: &str,
    cwd: &Path,
    restore: bool,
    powershell: bool,
) -> Result<PreparedClaude, String> {
    if [account, project, pane]
        .iter()
        .any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
    {
        return Err("continuity scope invalid".into());
    }
    let cwd = fs::canonicalize(cwd).map_err(|_| "continuity directory unavailable")?;
    if !cwd.is_dir() {
        return Err("continuity directory invalid".into());
    }
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(account, project, pane)).unwrap())
    );
    let record_path = root.join(format!("{key}.json"));
    let mut binding = if restore {
        let previous = read_binding(&record_path).ok().filter(|record| {
            record.version == 1
                && record.account_id == account
                && record.project_id == project
                && record.pane_id == pane
                && record.cwd == cwd
                && record.session_id.as_deref().map(valid_id).unwrap_or(false)
                && record
                    .transcript
                    .as_ref()
                    .map(|path| path.is_file())
                    .unwrap_or(false)
        });
        match previous {
            Some(binding) => binding,
            None => {
                return Ok(PreparedClaude {
                    state: "unavailable".into(),
                    startup_command: None,
                })
            }
        }
    } else {
        Binding {
            version: 1,
            account_id: account.into(),
            project_id: project.into(),
            pane_id: pane.into(),
            cwd,
            nonce: String::new(),
            session_id: None,
            transcript: None,
        }
    };
    // An older process cannot overwrite the binding after a restart/reassignment.
    binding.nonce = nanoid::nanoid!(32);
    fs::create_dir_all(root).map_err(|_| "continuity directory write unavailable")?;
    write_json(&record_path, &binding)?;
    // A session-local plugin adds our hook without overriding the user's hooks/settings.
    let plugin_path = root.join(format!("{key}.plugin"));
    fs::create_dir_all(plugin_path.join(".claude-plugin"))
        .and_then(|_| fs::create_dir_all(plugin_path.join("hooks")))
        .map_err(|_| "continuity plugin directory unavailable")?;
    write_json(
        &plugin_path.join(".claude-plugin/plugin.json"),
        &serde_json::json!({
            "name": "vibespace-terminal-continuity", "version": "1.0.0"
        }),
    )?;
    let hook = format!(
        "{} {HOOK_FLAG} {} {}",
        quote(&hook_path(executable), false),
        quote(&hook_path(&record_path), false),
        quote(&binding.nonce, false)
    );
    write_json(
        &plugin_path.join("hooks/hooks.json"),
        &serde_json::json!({"hooks": {"SessionStart": [{"hooks": [
            {"type": "command", "command": hook, "timeout": 5}
        ]}]}}),
    )?;
    let resume = binding
        .session_id
        .as_ref()
        .map(|id| format!(" --resume {id}"))
        .unwrap_or_default();
    Ok(PreparedClaude {
        state: if restore { "resume" } else { "new" }.into(),
        startup_command: Some(format!(
            "claude{resume} --plugin-dir {}",
            quote(&hook_path(&plugin_path), powershell)
        )),
    })
}

fn record_session(path: &Path, nonce: &str, input: &[u8]) -> Result<(), String> {
    if input.len() as u64 > LIMIT || path.extension().and_then(|s| s.to_str()) != Some("json") {
        return Err("continuity hook input invalid".into());
    }
    let mut binding = read_binding(path)?;
    if binding.version != 1 || nonce.len() != 32 || binding.nonce != nonce {
        return Err("continuity hook identity expired".into());
    }
    let event: serde_json::Value =
        serde_json::from_slice(input).map_err(|_| "continuity hook input invalid")?;
    let session = event["session_id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("continuity session invalid")?;
    let cwd = event["cwd"]
        .as_str()
        .ok_or("continuity hook directory missing")?;
    let transcript = event["transcript_path"]
        .as_str()
        .filter(|path| path.len() <= 4096)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("continuity transcript invalid")?;
    if event["hook_event_name"] != "SessionStart"
        || fs::canonicalize(cwd).ok().as_ref() != Some(&binding.cwd)
    {
        return Err("continuity hook scope mismatch".into());
    }
    binding.session_id = Some(session.into());
    binding.transcript = Some(transcript);
    write_json(path, &binding)
}

/// Fast internal subprocess path: no Tauri window, network, or global settings.
pub fn run_hook(arguments: &[String]) -> i32 {
    if arguments.len() != 2 {
        return 1;
    }
    let mut input = Vec::new();
    if std::io::stdin()
        .take(LIMIT + 1)
        .read_to_end(&mut input)
        .is_err()
    {
        return 1;
    }
    if record_session(Path::new(&arguments[0]), &arguments[1], &input).is_ok() {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "019bc371-82cf-7d82-ad0b-96d026aaca73";
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("vibespace-continuity-{}", nanoid::nanoid!(12)));
            fs::create_dir_all(root.join("project")).unwrap();
            Self { root }
        }
        fn prepare(&self, restore: bool, account: &str, pane: &str) -> PreparedClaude {
            prepare(
                &self.root.join("records"),
                &self.root.join("VibeSpace.exe"),
                account,
                "project-a",
                pane,
                &self.root.join("project"),
                restore,
                cfg!(windows),
            )
            .unwrap()
        }
        fn record(&self) -> PathBuf {
            fs::read_dir(self.root.join("records"))
                .unwrap()
                .flatten()
                .map(|f| f.path())
                .find(|p| {
                    p.to_string_lossy().ends_with(".json")
                        && !p.to_string_lossy().ends_with(".settings.json")
                })
                .unwrap()
        }
        fn event(&self, id: &str) -> Vec<u8> {
            let transcript = self.root.join("conversation.jsonl");
            fs::write(&transcript, "synthetic").unwrap();
            serde_json::to_vec(&serde_json::json!({"hook_event_name":"SessionStart", "session_id":id,
                "cwd":self.root.join("project"), "transcript_path":transcript, "prompt":"NEVER_PERSIST_THIS"})).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn resumes_exact_provider_identity_after_a_cold_restart_without_copying_text() {
        let f = Fixture::new();
        assert_eq!(f.prepare(false, "account-a", "pane-a").state, "new");
        let path = f.record();
        record_session(
            &path,
            &read_binding(&path).unwrap().nonce,
            &f.event(SESSION),
        )
        .unwrap();
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("NEVER_PERSIST_THIS"));
        let result = f.prepare(true, "account-a", "pane-a");
        assert_eq!(result.state, "resume");
        assert!(result
            .startup_command
            .unwrap()
            .contains(&format!("--resume {SESSION}")));
        assert_eq!(
            f.prepare(true, "other-account", "pane-a").state,
            "unavailable"
        );
        assert_eq!(
            f.prepare(true, "account-a", "other-pane").state,
            "unavailable"
        );
    }
    #[test]
    fn capture_is_a_session_local_plugin_without_replacing_user_settings() {
        let f = Fixture::new();
        let settings = f.root.join("project/.claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let original = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo existing"}]}]}}"#;
        fs::write(&settings, original).unwrap();
        let command = f
            .prepare(false, "account-a", "pane-a")
            .startup_command
            .unwrap();
        assert!(command.contains(" --plugin-dir "));
        assert!(!command.contains("--settings"));
        assert_eq!(fs::read_to_string(settings).unwrap(), original);
        let plugin = fs::read_dir(f.root.join("records"))
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.is_dir())
            .unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(plugin.join(".claude-plugin/plugin.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "vibespace-terminal-continuity");
        let hooks: serde_json::Value =
            serde_json::from_slice(&fs::read(plugin.join("hooks/hooks.json")).unwrap()).unwrap();
        let hook = &hooks["hooks"]["SessionStart"][0]["hooks"][0];
        assert_eq!(hook["type"], "command");
        assert!(hook["command"].as_str().unwrap().contains(HOOK_FLAG));
        assert_eq!(hook["timeout"], 5);
    }
    #[test]
    fn unknown_or_deleted_conversation_never_falls_back_to_latest_or_new() {
        let f = Fixture::new();
        assert_eq!(f.prepare(true, "account-a", "pane-a").state, "unavailable");
        f.prepare(false, "account-a", "pane-a");
        let path = f.record();
        record_session(
            &path,
            &read_binding(&path).unwrap().nonce,
            &f.event(SESSION),
        )
        .unwrap();
        fs::remove_file(f.root.join("conversation.jsonl")).unwrap();
        assert_eq!(f.prepare(true, "account-a", "pane-a").state, "unavailable");
    }
    #[test]
    fn rejects_injection_wrong_directory_and_stale_hook_writes() {
        let f = Fixture::new();
        f.prepare(false, "account-a", "pane-a");
        let path = f.record();
        let nonce = read_binding(&path).unwrap().nonce;
        assert!(record_session(&path, &nonce, &f.event("latest; calc")).is_err());
        let mut wrong: serde_json::Value = serde_json::from_slice(&f.event(SESSION)).unwrap();
        wrong["cwd"] = serde_json::json!(f.root);
        assert!(record_session(&path, &nonce, &serde_json::to_vec(&wrong).unwrap()).is_err());
        f.prepare(false, "account-a", "pane-a");
        assert!(record_session(&path, &nonce, &f.event(SESSION)).is_err());
    }
    #[test]
    fn observes_session_switches_and_quotes_paths_for_each_shell() {
        let f = Fixture::new();
        f.prepare(false, "account-a", "pane-a");
        let path = f.record();
        let nonce = read_binding(&path).unwrap().nonce;
        record_session(&path, &nonce, &f.event(SESSION)).unwrap();
        let next = "119bc371-82cf-7d82-ad0b-96d026aaca73";
        record_session(&path, &nonce, &f.event(next)).unwrap();
        assert!(f
            .prepare(true, "account-a", "pane-a")
            .startup_command
            .unwrap()
            .contains(next));
        assert_eq!(quote("it's $safe", true), "'it''s $safe'");
        assert_eq!(quote("it's $safe", false), "'it'\\''s $safe'");
    }
}
