use jarvis_lib::terminal_cli::{
    bash_terminal_prompt_integration, build_scoped_terminal_cli_request,
    build_terminal_cli_request, fish_terminal_prompt_integration,
    install_managed_terminal_shell_profile, merge_managed_terminal_shell_profile,
    parse_terminal_cli_args, powershell_terminal_prompt_integration, read_terminal_cli_wire_line,
    remove_managed_terminal_cli_aliases, remove_managed_terminal_shell_profile,
    render_terminal_cli_response, replace_managed_terminal_cli_aliases,
    replace_managed_terminal_cli_shim, run_terminal_cli, terminal_cli_request_error_code,
    terminal_cli_response_timeout, uninstall_managed_terminal_shell_profile,
    unix_terminal_cli_shim, validate_terminal_cli_request, windows_terminal_cli_shim,
    zsh_terminal_prompt_integration, TerminalCliConnectionLimiter, TerminalCliRequest,
    TerminalCliRequestScope, TerminalCliResponse,
};
use serde_json::json;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn parses_portable_commands_into_closed_authenticated_requests() {
    let invocation = parse_terminal_cli_args(&[
        "--endpoint".into(),
        "C:\\Users\\Test\\endpoint.json".into(),
        "--json".into(),
        "context".into(),
        "search".into(),
        "safe query".into(),
    ])
    .expect("parse invocation");
    assert_eq!(invocation.method, "context.search");
    assert_eq!(invocation.params, json!({ "query": "safe query" }));
    assert!(invocation.json);
    assert!(!invocation.color);

    let request = build_terminal_cli_request(&invocation, NONCE, "request-1")
        .expect("build authenticated request");
    assert_eq!(request.protocol_version, 1);
    assert_eq!(request.nonce, NONCE);
    assert_eq!(request.method, "context.search");
    assert!(validate_terminal_cli_request(&request, NONCE).is_ok());

    let mut forged = request;
    forged.nonce = "b".repeat(64);
    assert!(validate_terminal_cli_request(&forged, NONCE).is_err());
}

#[test]
fn parses_context_ask_from_the_dedicated_alias_and_context_family() {
    for args in [
        vec![
            "--endpoint".into(),
            "/tmp/vibespace-endpoint.json".into(),
            "ask".into(),
            "Which file owns model routing?".into(),
        ],
        vec![
            "--endpoint".into(),
            "/tmp/vibespace-endpoint.json".into(),
            "context".into(),
            "ask".into(),
            "Which file owns model routing?".into(),
        ],
    ] {
        let invocation = parse_terminal_cli_args(&args).expect("context ask");
        assert_eq!(invocation.method, "context.ask");
        assert_eq!(
            invocation.params,
            json!({ "question": "Which file owns model routing?" })
        );
    }
}

#[test]
fn allows_bounded_long_running_context_source_operations_without_delaying_normal_commands() {
    assert_eq!(
        terminal_cli_response_timeout("context.create"),
        std::time::Duration::from_secs(120)
    );
    assert_eq!(
        terminal_cli_response_timeout("context.refresh"),
        std::time::Duration::from_secs(120)
    );
    assert_eq!(
        terminal_cli_response_timeout("context.ask"),
        std::time::Duration::from_secs(120)
    );
    assert_eq!(
        terminal_cli_response_timeout("context.search"),
        std::time::Duration::from_secs(15)
    );
    assert_eq!(
        terminal_cli_response_timeout("status"),
        std::time::Duration::from_secs(15)
    );
}

#[test]
fn supports_alias_commands_and_rejects_ambiguous_or_executable_input() {
    let status = parse_terminal_cli_args(&[
        "--endpoint".into(),
        "/tmp/vibespace-endpoint.json".into(),
        "status".into(),
    ])
    .expect("status");
    assert_eq!(status.method, "status");

    let once = parse_terminal_cli_args(&[
        "--endpoint".into(),
        "/tmp/vibespace-endpoint.json".into(),
        "context".into(),
        "attach".into(),
        "entity-1".into(),
        "--once".into(),
    ])
    .expect("one-turn context");
    assert_eq!(once.method, "context.attach");
    assert_eq!(
        once.params,
        json!({ "entity": "entity-1", "mode": "one_turn" })
    );

    for args in [
        vec![
            "--endpoint".into(),
            "/tmp/e.json".into(),
            "context".into(),
            "search".into(),
        ],
        vec![
            "--endpoint".into(),
            "/tmp/e.json".into(),
            "status".into(),
            "&&".into(),
            "whoami".into(),
        ],
        vec![
            "--endpoint".into(),
            "/tmp/e.json".into(),
            "filesystem".into(),
            "delete".into(),
        ],
        vec![
            "--endpoint".into(),
            "/tmp/e.json".into(),
            "--endpoint".into(),
            "/tmp/alternate.json".into(),
            "status".into(),
        ],
    ] {
        assert!(parse_terminal_cli_args(&args).is_err());
    }
}

#[test]
fn validates_closed_method_specific_request_schemas() {
    let valid = TerminalCliRequest {
        protocol_version: 1,
        request_id: "request-closed".into(),
        nonce: NONCE.into(),
        terminal_session_id: None,
        pane_id: None,
        project_id: None,
        run_identity: None,
        method: "context.attach".into(),
        params: json!({ "entity": "entity-1", "mode": "one_turn" }),
    };
    assert!(validate_terminal_cli_request(&valid, NONCE).is_ok());

    for params in [
        json!({ "entity": "entity-1", "mode": "one_turn", "execute": true }),
        json!({ "entity": "entity-1", "mode": "arbitrary" }),
        json!({ "entity": "entity-1" }),
        json!({ "entity": 42, "mode": "persistent" }),
    ] {
        let malformed = TerminalCliRequest {
            params,
            ..valid.clone()
        };
        assert!(validate_terminal_cli_request(&malformed, NONCE).is_err());
    }

    let malformed_create = TerminalCliRequest {
        protocol_version: 1,
        request_id: "request-create".into(),
        nonce: NONCE.into(),
        terminal_session_id: None,
        pane_id: None,
        project_id: None,
        run_identity: None,
        method: "context.create".into(),
        params: json!({ "sourceKind": "folder", "source": "/safe", "ref": "main" }),
    };
    assert!(validate_terminal_cli_request(&malformed_create, NONCE).is_err());
}

#[test]
fn distinguishes_authenticated_version_errors_from_authentication_and_schema_errors() {
    let request = TerminalCliRequest {
        protocol_version: 2,
        request_id: "request-version".into(),
        nonce: NONCE.into(),
        terminal_session_id: None,
        pane_id: None,
        project_id: None,
        run_identity: None,
        method: "status".into(),
        params: json!({}),
    };
    assert_eq!(
        terminal_cli_request_error_code(&request, NONCE),
        Some("unsupported_version")
    );

    let forged = TerminalCliRequest {
        nonce: "b".repeat(64),
        ..request.clone()
    };
    assert_eq!(
        terminal_cli_request_error_code(&forged, NONCE),
        Some("authentication_failed")
    );

    let malformed = TerminalCliRequest {
        protocol_version: 1,
        method: "status".into(),
        params: json!({ "unexpected": true }),
        ..request
    };
    assert_eq!(
        terminal_cli_request_error_code(&malformed, NONCE),
        Some("invalid_request")
    );
}

#[test]
fn carries_bounded_terminal_scope_without_exposing_it_in_command_params() {
    let invocation = parse_terminal_cli_args(&[
        "--endpoint".into(),
        "/tmp/vibespace-endpoint.json".into(),
        "context".into(),
        "current".into(),
    ])
    .expect("context current");
    let request = build_scoped_terminal_cli_request(
        &invocation,
        NONCE,
        "request-scoped",
        TerminalCliRequestScope {
            terminal_session_id: Some("tty-session-1".into()),
            pane_id: Some("pane-1".into()),
            project_id: Some("project-1".into()),
            run_identity: Some("ctxrun_exact-1".into()),
            process_instance_id: None,
        },
    )
    .expect("scoped request");
    assert_eq!(
        request.terminal_session_id.as_deref(),
        Some("tty-session-1")
    );
    assert_eq!(request.pane_id.as_deref(), Some("pane-1"));
    assert_eq!(request.project_id.as_deref(), Some("project-1"));
    assert_eq!(request.run_identity.as_deref(), Some("ctxrun_exact-1"));
    assert_eq!(request.params, json!({}));
    assert!(validate_terminal_cli_request(&request, NONCE).is_ok());

    let malformed = TerminalCliRequest {
        terminal_session_id: Some("bad scope\n".into()),
        ..request
    };
    assert_eq!(
        terminal_cli_request_error_code(&malformed, NONCE),
        Some("invalid_request")
    );
}

#[test]
fn rejects_context_ask_without_a_bounded_question_or_valid_run_identity() {
    let invocation = parse_terminal_cli_args(&[
        "--endpoint".into(),
        "/tmp/vibespace-endpoint.json".into(),
        "ask".into(),
        "Where is the provider selected?".into(),
    ])
    .expect("context ask");
    let request = build_scoped_terminal_cli_request(
        &invocation,
        NONCE,
        "request-ask",
        TerminalCliRequestScope {
            terminal_session_id: Some("tty-session-1".into()),
            pane_id: Some("pane-1".into()),
            project_id: Some("project-1".into()),
            run_identity: Some("ctxrun_exact-1".into()),
            process_instance_id: None,
        },
    )
    .expect("scoped ask");
    assert!(validate_terminal_cli_request(&request, NONCE).is_ok());

    let malformed_question = TerminalCliRequest {
        params: json!({ "question": "" }),
        ..request.clone()
    };
    assert!(validate_terminal_cli_request(&malformed_question, NONCE).is_err());

    let missing_identity = TerminalCliRequest {
        run_identity: None,
        ..request.clone()
    };
    assert!(validate_terminal_cli_request(&missing_identity, NONCE).is_err());

    let forged_identity = TerminalCliRequest {
        run_identity: Some("bad identity".into()),
        ..request
    };
    assert!(validate_terminal_cli_request(&forged_identity, NONCE).is_err());
}

#[test]
fn reports_an_incompatible_endpoint_as_an_unsupported_protocol() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let endpoint = std::env::temp_dir().join(format!(
        "vibespace-terminal-cli-endpoint-{}-{suffix}.json",
        std::process::id()
    ));
    fs::write(
        &endpoint,
        serde_json::to_vec(&json!({
            "protocolVersion": 2,
            "address": "127.0.0.1:1",
            "keyringService": "ai.jarvis.desktop",
            "keyringAccount": "terminal-cli-nonce"
        }))
        .expect("endpoint JSON"),
    )
    .expect("endpoint file");

    let exit_code = run_terminal_cli(&[
        "--endpoint".into(),
        endpoint.to_string_lossy().into_owned(),
        "status".into(),
    ]);
    assert_eq!(exit_code, 2);
    fs::remove_file(endpoint).expect("remove temporary endpoint");
}

#[test]
fn bounds_parallel_connection_workers_and_releases_capacity() {
    let limiter = TerminalCliConnectionLimiter::new(2);
    let first = limiter.try_acquire().expect("first permit");
    let second = limiter.try_acquire().expect("second permit");
    assert!(limiter.try_acquire().is_none());
    drop(first);
    assert!(limiter.try_acquire().is_some());
    drop(second);
}

#[test]
fn renders_safe_text_and_json_without_control_characters() {
    let response = TerminalCliResponse {
        request_id: "request-1".into(),
        ok: false,
        code: "app_not_running".into(),
        message: "VibeSpace is not running.".into(),
        data: None,
    };
    assert_eq!(
        render_terminal_cli_response(&response, false, false).expect("text"),
        "VibeSpace is not running."
    );
    let json_output = render_terminal_cli_response(&response, true, false).expect("json");
    assert!(json_output.contains("\"code\":\"app_not_running\""));

    let mut unsafe_response = response;
    unsafe_response.message = "unsafe\u{001b}[31m".into();
    assert!(render_terminal_cli_response(&unsafe_response, false, true).is_err());
    unsafe_response.message = "unsafe\u{009b}31m".into();
    assert!(render_terminal_cli_response(&unsafe_response, false, true).is_err());
}

#[test]
fn renders_a_bounded_context_answer_for_plain_terminal_output() {
    let response = TerminalCliResponse {
        request_id: "request-context".into(),
        ok: true,
        code: "ok".into(),
        message: "Context answer ready.".into(),
        data: Some(json!({
            "answer": "The provider is preserved by the registered model selection.",
            "receipt": { "route": "focused" }
        })),
    };
    assert_eq!(
        render_terminal_cli_response(&response, false, false).expect("plain answer"),
        "The provider is preserved by the registered model selection."
    );
}

#[test]
fn accepts_bounded_list_responses_larger_than_request_parameter_arrays() {
    let methods = (0..33)
        .map(|index| format!("method-{index}"))
        .collect::<Vec<_>>();
    let response = TerminalCliResponse {
        request_id: "request-help".into(),
        ok: true,
        code: "ok".into(),
        message: "Available commands.".into(),
        data: Some(json!({ "methods": methods })),
    };
    let rendered = render_terminal_cli_response(&response, true, false).expect("bounded help list");
    assert!(rendered.contains("method-32"));

    let oversized = TerminalCliResponse {
        data: Some(json!({ "value": "x".repeat(65_536) })),
        ..response
    };
    assert!(render_terminal_cli_response(&oversized, true, false).is_err());
}

#[test]
fn creates_marked_reversible_shims_without_interpolating_shell_input() {
    let windows = windows_terminal_cli_shim(
        Path::new(r"C:\Program Files\VibeSpace\jarvis.exe"),
        Path::new(r"C:\Users\Test\AppData\Local\VibeSpace\endpoint.json"),
    )
    .expect("windows shim");
    assert!(windows.starts_with("@echo off\r\n:: VIBESPACE_CLI_MANAGED_V1\r\n"));
    assert!(windows.contains("\"C:\\Program Files\\VibeSpace\\jarvis.exe\""));
    assert!(windows.contains("--vibespace-cli --endpoint"));
    assert!(windows.ends_with(" %*\r\n"));

    let windows_special = windows_terminal_cli_shim(
        Path::new(r"C:\Users\%USERNAME%!\VibeSpace\jarvis.exe"),
        Path::new(r"C:\Users\%USERNAME%!\VibeSpace\endpoint.json"),
    )
    .expect("windows shim with literal expansion characters");
    assert!(windows_special.contains("setlocal DisableDelayedExpansion\r\n"));
    assert!(windows_special.contains(r"C:\Users\%%USERNAME%%!\VibeSpace\jarvis.exe"));

    let unix = unix_terminal_cli_shim(
        Path::new("/Applications/VibeSpace.app/Contents/MacOS/jarvis"),
        Path::new("/Users/test/Library/Application Support/VibeSpace/endpoint.json"),
    )
    .expect("unix shim");
    assert!(unix.starts_with("#!/usr/bin/env sh\n# VIBESPACE_CLI_MANAGED_V1\n"));
    assert!(unix.contains("exec '/Applications/VibeSpace.app/Contents/MacOS/jarvis'"));
    assert!(unix.ends_with(" \"$@\"\n"));
}

#[test]
fn builds_static_secret_free_prompt_protocol_integrations_for_supported_shells() {
    let integrations = [
        ("powershell", powershell_terminal_prompt_integration()),
        ("bash", bash_terminal_prompt_integration()),
        ("zsh", zsh_terminal_prompt_integration()),
        ("fish", fish_terminal_prompt_integration()),
    ];

    for (shell, integration) in integrations {
        assert!(
            integration.contains("]133;A") && integration.contains("]133;B"),
            "{shell} must emit bounded OSC 133 prompt markers"
        );
        assert!(!integration.to_ascii_lowercase().contains("nonce"));
        assert!(!integration.to_ascii_lowercase().contains("token"));
        assert!(!integration.to_ascii_lowercase().contains("endpoint"));
    }
    let powershell = powershell_terminal_prompt_integration();
    assert!(powershell.contains("function global:prompt"));
    assert!(
        powershell.find("]133;A").expect("PowerShell prompt start")
            < powershell
                .find("${vibespacePrompt}")
                .expect("PowerShell prompt body")
    );
    assert!(
        powershell
            .find("${vibespacePrompt}")
            .expect("PowerShell prompt body")
            < powershell.find("]133;B").expect("PowerShell prompt end")
    );
    assert!(bash_terminal_prompt_integration().contains("PS1="));
    assert!(zsh_terminal_prompt_integration().contains("PROMPT="));
    assert!(fish_terminal_prompt_integration().contains("function fish_prompt"));
}

#[test]
fn managed_shell_profile_round_trip_preserves_user_content_exactly() {
    for original in [
        None,
        Some("export USER_SETTING=1"),
        Some("# user profile\nexport USER_SETTING=1\n"),
        Some("# user profile\r\n$env:USER_SETTING = '1'\r\n"),
    ] {
        let installed = merge_managed_terminal_shell_profile(
            original,
            powershell_terminal_prompt_integration(),
        )
        .expect("install managed shell block");
        assert!(installed.contains("VIBESPACE_SHELL_INTEGRATION_V1"));
        assert_eq!(
            remove_managed_terminal_shell_profile(&installed)
                .expect("remove managed shell block")
                .as_deref(),
            original
        );

        let reinstalled = merge_managed_terminal_shell_profile(
            Some(&installed),
            bash_terminal_prompt_integration(),
        )
        .expect("replace managed shell block");
        assert_eq!(
            reinstalled
                .matches("VIBESPACE_SHELL_INTEGRATION_V1")
                .count(),
            2
        );
        assert!(reinstalled.contains("PS1="));
        assert_eq!(
            remove_managed_terminal_shell_profile(&reinstalled)
                .expect("remove replaced block")
                .as_deref(),
            original
        );
    }
}

#[test]
fn managed_shell_profile_rejects_ambiguous_or_damaged_markers() {
    let damaged = "# >>> VIBESPACE_SHELL_INTEGRATION_V1 prior_exists=1 prior_eol=1 >>>\nuser";
    assert!(merge_managed_terminal_shell_profile(
        Some(damaged),
        bash_terminal_prompt_integration()
    )
    .is_err());
    assert!(remove_managed_terminal_shell_profile(damaged).is_err());

    let duplicated = format!(
        "{}\n{}\n{}\n{}",
        "# >>> VIBESPACE_SHELL_INTEGRATION_V1 prior_exists=1 prior_eol=1 >>>",
        "# <<< VIBESPACE_SHELL_INTEGRATION_V1 <<<",
        "# >>> VIBESPACE_SHELL_INTEGRATION_V1 prior_exists=1 prior_eol=1 >>>",
        "# <<< VIBESPACE_SHELL_INTEGRATION_V1 <<<"
    );
    assert!(merge_managed_terminal_shell_profile(
        Some(&duplicated),
        zsh_terminal_prompt_integration()
    )
    .is_err());
}

#[test]
fn atomically_installs_and_removes_only_the_managed_shell_profile_block() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "vibespace-terminal-shell-profile-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary shell profile directory");
    let profile = root.join("profile.ps1");
    let original = "# user-owned profile\n$env:USER_SETTING = 'preserve exactly'";
    fs::write(&profile, original).expect("write user profile");

    install_managed_terminal_shell_profile(&profile, powershell_terminal_prompt_integration())
        .expect("install shell integration");
    let installed = fs::read_to_string(&profile).expect("read installed profile");
    assert!(installed.starts_with(original));
    assert!(installed.contains("VIBESPACE_SHELL_INTEGRATION_V1"));
    assert!(installed.contains("]133;B"));

    uninstall_managed_terminal_shell_profile(&profile).expect("remove shell integration");
    assert_eq!(
        fs::read_to_string(&profile).expect("read restored profile"),
        original
    );

    let new_profile = root.join("new-profile.ps1");
    install_managed_terminal_shell_profile(&new_profile, powershell_terminal_prompt_integration())
        .expect("create managed-only profile");
    uninstall_managed_terminal_shell_profile(&new_profile).expect("remove managed-only profile");
    assert!(!new_profile.exists());

    fs::remove_dir_all(root).expect("remove temporary shell profile directory");
}

#[test]
fn reads_one_bounded_wire_message_without_waiting_for_eof() {
    let mut input = Cursor::new(b"{\"requestId\":\"one\"}\nignored".to_vec());
    assert_eq!(
        read_terminal_cli_wire_line(&mut input, 64).expect("bounded line"),
        "{\"requestId\":\"one\"}"
    );

    let mut oversized = Cursor::new(format!("{}\n", "x".repeat(65)).into_bytes());
    assert!(read_terminal_cli_wire_line(&mut oversized, 64).is_err());
}

#[test]
fn replaces_only_managed_cli_shims_without_losing_reinstall_updates() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "vibespace-terminal-cli-contract-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary CLI directory");

    let managed = root.join("vs.cmd");
    fs::write(
        &managed,
        "@echo off\r\n:: VIBESPACE_CLI_MANAGED_V1\r\nold\r\n",
    )
    .expect("old managed shim");
    let replacement = "@echo off\r\n:: VIBESPACE_CLI_MANAGED_V1\r\nnew\r\n";
    replace_managed_terminal_cli_shim(&managed, replacement).expect("replace managed shim");
    assert_eq!(
        fs::read_to_string(&managed).expect("new managed shim"),
        replacement
    );

    let user_owned = root.join("vibespace.cmd");
    fs::write(&user_owned, "@echo off\r\necho user-owned\r\n").expect("user shim");
    assert!(replace_managed_terminal_cli_shim(&user_owned, replacement).is_err());
    assert_eq!(
        fs::read_to_string(&user_owned).expect("preserved user shim"),
        "@echo off\r\necho user-owned\r\n"
    );

    let marker_substring = root.join("substring.cmd");
    fs::write(
        &marker_substring,
        "@echo off\r\necho VIBESPACE_CLI_MANAGED_V1 is documentation\r\n",
    )
    .expect("user shim containing marker text");
    assert!(replace_managed_terminal_cli_shim(&marker_substring, replacement).is_err());
    assert_eq!(
        fs::read_to_string(&marker_substring).expect("preserved marker-substring shim"),
        "@echo off\r\necho VIBESPACE_CLI_MANAGED_V1 is documentation\r\n"
    );

    fs::remove_dir_all(root).expect("remove task-owned temporary CLI directory");
}

#[test]
fn rolls_back_both_aliases_when_a_cli_install_cannot_complete() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "vibespace-terminal-cli-rollback-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary CLI directory");
    let first = root.join("vibespace.cmd");
    let old = "@echo off\r\n:: VIBESPACE_CLI_MANAGED_V1\r\nold\r\n";
    let replacement = "@echo off\r\n:: VIBESPACE_CLI_MANAGED_V1\r\nnew\r\n";
    fs::write(&first, old).expect("old first alias");
    let second = root.join("missing-parent").join("vs.cmd");

    assert!(replace_managed_terminal_cli_aliases(&[first.clone(), second], replacement).is_err());
    assert_eq!(
        fs::read_to_string(&first).expect("rolled-back first alias"),
        old
    );
    fs::remove_dir_all(root).expect("remove task-owned temporary CLI directory");
}

#[test]
fn removes_both_managed_aliases_without_touching_user_owned_files() {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "vibespace-terminal-cli-uninstall-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("temporary CLI directory");
    let first = root.join("vibespace.cmd");
    let second = root.join("vs.cmd");
    let managed = "@echo off\r\n:: VIBESPACE_CLI_MANAGED_V1\r\n";
    fs::write(&first, managed).expect("first managed alias");
    fs::write(&second, managed).expect("second managed alias");

    remove_managed_terminal_cli_aliases(&[first.clone(), second.clone()])
        .expect("remove both aliases");
    assert!(!first.exists());
    assert!(!second.exists());

    fs::write(&first, managed).expect("managed alias");
    fs::write(&second, "@echo off\r\necho user-owned\r\n").expect("user-owned alias");
    assert!(remove_managed_terminal_cli_aliases(&[first.clone(), second.clone()]).is_err());
    assert!(first.exists());
    assert_eq!(
        fs::read_to_string(&second).expect("preserved user-owned alias"),
        "@echo off\r\necho user-owned\r\n"
    );
    fs::remove_dir_all(root).expect("remove task-owned temporary CLI directory");
}
