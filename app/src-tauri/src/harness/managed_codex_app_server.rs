use crate::harness::managed_cli_manifest::{ManagedCliKind, ManagedCliRelease};
use crate::harness::managed_cli_runtime::{ManagedCliLaunch, ManagedCliReadiness};
use std::path::PathBuf;

/// Codex app-server v2 begins with a request followed by the initialized notification.
pub const CODEX_APP_SERVER_INITIALIZE: &str = "initialize";
pub const CODEX_APP_SERVER_INITIALIZED: &str = "initialized";

/// Raw reasoning text is private chain-of-thought and must never enter the Chat ledger.
/// Public progress may use `item/reasoning/summaryTextDelta` instead.
pub const CODEX_APP_SERVER_PRIVATE_REASONING_METHODS: &[&str] = &["item/reasoning/textDelta"];

/// Codex app-server messages can contain bounded public activity details, but a single
/// untrusted stdout frame must never grow the native process without limit.
pub const CODEX_APP_SERVER_MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const CODEX_APP_SERVER_MAX_FRAMES_PER_PUSH: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexAppServerFrameError {
    Poisoned,
    EmptyFrame,
    FrameTooLarge,
    TooManyFrames,
    InvalidJson,
    NonObject,
    IncompleteFrame,
}

#[derive(Debug, Default)]
pub struct CodexAppServerFrameDecoder {
    buffer: Vec<u8>,
    poisoned: bool,
}

impl CodexAppServerFrameDecoder {
    fn fail<T>(&mut self, error: CodexAppServerFrameError) -> Result<T, CodexAppServerFrameError> {
        self.buffer.clear();
        self.poisoned = true;
        Err(error)
    }

    fn decode_buffer(&mut self) -> Result<Option<serde_json::Value>, CodexAppServerFrameError> {
        if self.buffer.last() == Some(&b'\r') {
            self.buffer.pop();
        }
        if self.buffer.is_empty() {
            return self.fail(CodexAppServerFrameError::EmptyFrame);
        }
        let value: serde_json::Value = match serde_json::from_slice(&self.buffer) {
            Ok(value) => value,
            Err(_) => return self.fail(CodexAppServerFrameError::InvalidJson),
        };
        self.buffer.clear();
        let Some(object) = value.as_object() else {
            return self.fail(CodexAppServerFrameError::NonObject);
        };
        let is_private_reasoning = object
            .get("method")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|method| CODEX_APP_SERVER_PRIVATE_REASONING_METHODS.contains(&method));
        Ok((!is_private_reasoning).then_some(value))
    }

    /// Accepts arbitrary stdout chunks and returns only complete safe JSON object frames.
    /// Any protocol error permanently poisons this decoder so callers cannot resume from an
    /// ambiguous byte boundary.
    pub fn push(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<serde_json::Value>, CodexAppServerFrameError> {
        if self.poisoned {
            return Err(CodexAppServerFrameError::Poisoned);
        }
        let mut frames = Vec::new();
        let mut frame_count = 0_usize;
        for &byte in bytes {
            if byte == b'\n' {
                frame_count += 1;
                if frame_count > CODEX_APP_SERVER_MAX_FRAMES_PER_PUSH {
                    return self.fail(CodexAppServerFrameError::TooManyFrames);
                }
                if let Some(frame) = self.decode_buffer()? {
                    frames.push(frame);
                }
                continue;
            }
            if self.buffer.len() == CODEX_APP_SERVER_MAX_FRAME_BYTES {
                return self.fail(CodexAppServerFrameError::FrameTooLarge);
            }
            self.buffer.push(byte);
        }
        Ok(frames)
    }

    /// JSONL requires every terminal frame to end with a newline. A partial frame at EOF is
    /// ambiguous and therefore fails closed rather than being guessed or repaired.
    pub fn finish(&mut self) -> Result<Vec<serde_json::Value>, CodexAppServerFrameError> {
        if self.poisoned {
            return Err(CodexAppServerFrameError::Poisoned);
        }
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }
        self.fail(CodexAppServerFrameError::IncompleteFrame)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerHandshake {
    pub initialize: Vec<u8>,
    pub initialized: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexAppServerHandshakeError {
    InvalidRequestId,
    InvalidClientVersion,
    Serialization,
}

fn json_line(value: &serde_json::Value) -> Result<Vec<u8>, CodexAppServerHandshakeError> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|_| CodexAppServerHandshakeError::Serialization)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Creates the schema-derived app-server initialize exchange. The private raw-reasoning
/// notification is suppressed at transport negotiation before a thread or turn can exist.
pub fn codex_app_server_handshake(
    request_id: u64,
    client_version: &str,
) -> Result<CodexAppServerHandshake, CodexAppServerHandshakeError> {
    if request_id == 0 {
        return Err(CodexAppServerHandshakeError::InvalidRequestId);
    }
    if client_version.is_empty()
        || client_version.len() > 64
        || !client_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return Err(CodexAppServerHandshakeError::InvalidClientVersion);
    }
    let initialize = serde_json::json!({
        "method": CODEX_APP_SERVER_INITIALIZE,
        "id": request_id,
        "params": {
            "clientInfo": {
                "name": "vibespace",
                "title": "VibeSpace",
                "version": client_version,
            },
            "capabilities": {
                // Required by turn/start collaborationMode (native Plan mode).
                "experimentalApi": true,
                "requestAttestation": false,
                "optOutNotificationMethods": CODEX_APP_SERVER_PRIVATE_REASONING_METHODS,
            },
        },
    });
    let initialized = serde_json::json!({ "method": CODEX_APP_SERVER_INITIALIZED });
    Ok(CodexAppServerHandshake {
        initialize: json_line(&initialize)?,
        initialized: json_line(&initialized)?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppServerStdio {
    Piped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedCodexAppServerLaunch {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub stdin: AppServerStdio,
    pub stdout: AppServerStdio,
    pub stderr: AppServerStdio,
    pub kill_on_drop: bool,
    /// Preserve the user's existing Codex authentication/config environment. Secrets and
    /// provider/model/prompt selections are intentionally absent from the command line.
    pub inherit_environment: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCodexAppServerLaunchError {
    WrongBackend,
    RuntimeNotReady,
    InvalidVerifiedLaunch,
}

/// Converts a checksum-verified managed Codex runtime into the one supported structured
/// transport. This function is deliberately a pure launch plan: process ownership, JSON-RPC,
/// permissions, and Chat projection remain with their existing authorities.
pub fn managed_codex_app_server_launch(
    release: &ManagedCliRelease,
    readiness: ManagedCliReadiness,
) -> Result<ManagedCodexAppServerLaunch, ManagedCodexAppServerLaunchError> {
    if release.kind != ManagedCliKind::Codex {
        return Err(ManagedCodexAppServerLaunchError::WrongBackend);
    }
    let ManagedCliReadiness::Ready {
        launch: ManagedCliLaunch {
            executable,
            arguments,
        },
    } = readiness
    else {
        return Err(ManagedCodexAppServerLaunchError::RuntimeNotReady);
    };

    let version_parent_matches = executable
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        == Some(release.version.as_str());
    if !executable.is_absolute()
        || !executable.ends_with(&release.entrypoint)
        || !version_parent_matches
        || !arguments.is_empty()
    {
        return Err(ManagedCodexAppServerLaunchError::InvalidVerifiedLaunch);
    }

    Ok(ManagedCodexAppServerLaunch {
        executable,
        arguments: vec!["--enable".to_string(), "default_mode_request_user_input".to_string(), "app-server".to_string(), "--stdio".to_string()],
        stdin: AppServerStdio::Piped,
        stdout: AppServerStdio::Piped,
        stderr: AppServerStdio::Piped,
        kill_on_drop: true,
        inherit_environment: true,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        codex_app_server_handshake, managed_codex_app_server_launch, AppServerStdio,
        CodexAppServerFrameDecoder, CodexAppServerFrameError, CODEX_APP_SERVER_INITIALIZE,
        CODEX_APP_SERVER_INITIALIZED, CODEX_APP_SERVER_MAX_FRAME_BYTES,
        CODEX_APP_SERVER_PRIVATE_REASONING_METHODS,
    };
    use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
    use crate::harness::managed_cli_runtime::{ManagedCliLaunch, ManagedCliReadiness};
    use std::path::PathBuf;

    fn codex_ready() -> (
        crate::harness::managed_cli_manifest::ManagedCliRelease,
        ManagedCliReadiness,
    ) {
        let release = embedded_managed_release(ManagedCliKind::Codex, "windows", "x86_64")
            .expect("embedded Codex release");
        let executable =
            PathBuf::from(r"C:\VibeSpace\managed\codex\versions\0.151.0").join(&release.entrypoint);
        let readiness = ManagedCliReadiness::Ready {
            launch: ManagedCliLaunch {
                executable,
                arguments: Vec::new(),
            },
        };
        (release, readiness)
    }

    #[test]
    fn codex_app_server_uses_verified_native_stdio_without_payload_arguments() {
        let (release, readiness) = codex_ready();
        let plan = managed_codex_app_server_launch(&release, readiness).expect("launch plan");

        assert!(plan.executable.is_absolute());
        assert!(plan.executable.ends_with(&release.entrypoint));
        assert_eq!(plan.arguments, ["--enable", "default_mode_request_user_input", "app-server", "--stdio"]);
        assert_eq!(plan.stdin, AppServerStdio::Piped);
        assert_eq!(plan.stdout, AppServerStdio::Piped);
        assert_eq!(plan.stderr, AppServerStdio::Piped);
        assert!(plan.kill_on_drop);
        assert!(plan.inherit_environment);
        assert!(plan.arguments.iter().all(|argument| {
            !argument.contains("key")
                && !argument.contains("token")
                && !argument.contains("model")
                && !argument.contains("provider")
                && !argument.contains("prompt")
        }));
        assert_eq!(CODEX_APP_SERVER_INITIALIZE, "initialize");
        assert_eq!(CODEX_APP_SERVER_INITIALIZED, "initialized");
        assert_eq!(
            CODEX_APP_SERVER_PRIVATE_REASONING_METHODS,
            &["item/reasoning/textDelta"]
        );
    }

    #[test]
    fn handshake_opts_out_private_reasoning_before_any_thread_or_turn() {
        let handshake = codex_app_server_handshake(1, "1.5.0").expect("handshake");
        assert!(handshake.initialize.ends_with(b"\n"));
        assert!(handshake.initialized.ends_with(b"\n"));
        let initialize: serde_json::Value =
            serde_json::from_slice(&handshake.initialize).expect("initialize JSON");
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(initialize["id"], 1);
        assert_eq!(initialize["params"]["clientInfo"]["name"], "vibespace");
        assert_eq!(initialize["params"]["clientInfo"]["title"], "VibeSpace");
        assert_eq!(initialize["params"]["clientInfo"]["version"], "1.5.0");
        assert_eq!(
            initialize["params"]["capabilities"]["experimentalApi"],
            true
        );
        assert_eq!(
            initialize["params"]["capabilities"]["requestAttestation"],
            false
        );
        assert_eq!(
            initialize["params"]["capabilities"]["optOutNotificationMethods"],
            serde_json::json!(["item/reasoning/textDelta"])
        );
        assert!(initialize.get("jsonrpc").is_none());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&handshake.initialized)
                .expect("initialized JSON"),
            serde_json::json!({ "method": "initialized" })
        );
    }

    #[test]
    fn handshake_rejects_invalid_request_identity_and_client_version() {
        assert!(codex_app_server_handshake(0, "1.5.0").is_err());
        for invalid in ["", "1.5.0 secret", "1.5.0\n{}", &"x".repeat(65)] {
            assert!(codex_app_server_handshake(1, invalid).is_err());
        }
    }

    #[test]
    fn app_server_rejects_unverified_or_wrong_backend_launches() {
        let (codex, ready) = codex_ready();
        for readiness in [
            ManagedCliReadiness::Missing,
            ManagedCliReadiness::Incomplete { reason: "fixture" },
            ManagedCliReadiness::ProbeRequired {
                launch: ManagedCliLaunch {
                    executable: PathBuf::from(r"C:\fixture\bun.exe"),
                    arguments: vec!["ready".to_string(), "--json".to_string()],
                },
                dependency_lock_sha256: "a".repeat(64),
            },
        ] {
            assert!(managed_codex_app_server_launch(&codex, readiness).is_err());
        }

        let opencodex = embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
            .expect("embedded OpenCodex release");
        assert!(managed_codex_app_server_launch(&opencodex, ready).is_err());
    }

    #[test]
    fn app_server_rejects_tampered_ready_launch_shapes() {
        let (release, _) = codex_ready();
        for launch in [
            ManagedCliLaunch {
                executable: PathBuf::from(&release.entrypoint),
                arguments: Vec::new(),
            },
            ManagedCliLaunch {
                executable: PathBuf::from(r"C:\VibeSpace\managed\codex\versions\0.151.0\other.exe"),
                arguments: Vec::new(),
            },
            ManagedCliLaunch {
                executable: PathBuf::from(r"C:\VibeSpace\managed\codex\versions\0.151.0")
                    .join(&release.entrypoint),
                arguments: vec!["exec".to_string(), "secret".to_string()],
            },
        ] {
            assert!(managed_codex_app_server_launch(
                &release,
                ManagedCliReadiness::Ready { launch }
            )
            .is_err());
        }
    }

    #[test]
    fn jsonl_decoder_streams_split_and_multiple_object_frames_in_order() {
        let mut decoder = CodexAppServerFrameDecoder::default();
        assert!(decoder.push(br#"{"method":"turn/sta"#).unwrap().is_empty());
        let frames = decoder
            .push(b"rted\",\"params\":{\"threadId\":\"thread_1\"}}\r\n{\"id\":2,\"result\":{}}\n")
            .unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["method"], "turn/started");
        assert_eq!(frames[0]["params"]["threadId"], "thread_1");
        assert_eq!(frames[1]["id"], 2);
        assert!(decoder.finish().unwrap().is_empty());
    }

    #[test]
    fn jsonl_decoder_suppresses_private_reasoning_before_projection() {
        let mut decoder = CodexAppServerFrameDecoder::default();
        let frames = decoder
            .push(
                br#"{"method":"item/reasoning/textDelta","params":{"delta":"private"}}
{"method":"item/reasoning/summaryTextDelta","params":{"delta":"public"}}
"#,
            )
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["method"], "item/reasoning/summaryTextDelta");
        assert!(!serde_json::to_string(&frames).unwrap().contains("private"));
    }

    #[test]
    fn jsonl_decoder_fails_closed_and_stays_poisoned_after_bad_frames() {
        for (frame, expected) in [
            (b"[]\n".as_slice(), CodexAppServerFrameError::NonObject),
            (
                b"not-json\n".as_slice(),
                CodexAppServerFrameError::InvalidJson,
            ),
            (b"\n".as_slice(), CodexAppServerFrameError::EmptyFrame),
        ] {
            let mut decoder = CodexAppServerFrameDecoder::default();
            assert_eq!(decoder.push(frame), Err(expected));
            assert_eq!(
                decoder.push(b"{\"id\":1}\n"),
                Err(CodexAppServerFrameError::Poisoned)
            );
        }
    }

    #[test]
    fn jsonl_decoder_rejects_oversized_and_incomplete_terminal_frames() {
        let mut oversized = CodexAppServerFrameDecoder::default();
        assert_eq!(
            oversized.push(&vec![b'x'; CODEX_APP_SERVER_MAX_FRAME_BYTES + 1]),
            Err(CodexAppServerFrameError::FrameTooLarge)
        );

        let mut incomplete = CodexAppServerFrameDecoder::default();
        assert!(incomplete.push(b"{\"id\":1}").unwrap().is_empty());
        assert_eq!(
            incomplete.finish(),
            Err(CodexAppServerFrameError::IncompleteFrame)
        );
        assert_eq!(incomplete.finish(), Err(CodexAppServerFrameError::Poisoned));

        let mut many = CodexAppServerFrameDecoder::default();
        assert_eq!(
            many.push(b"{}\n".repeat(1_025).as_slice()),
            Err(CodexAppServerFrameError::TooManyFrames)
        );
    }
}
