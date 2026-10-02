// STAGING ONLY: pure native policy for the independent, supervised Codex child.
// Authority must be constructed inside native code from the live parent state,
// never deserialized from a model/tool request or accepted from frontend booleans.
use std::path::{Path, PathBuf};
// CERTIFICATE_PINS_BEGIN
pub const PINNED_RUNTIME_SHA:&str="fcd5eafefb4ff4a607f244e099e0974f66e17966b6ffda6948de2ef3a7a79530";
pub const BINARY_CONFIG_CERTIFICATE_SHA:&str="77fab9f37813598bf35805e66730dccae940413312f9dfce9752f197b468b3f9";
pub const STANDARD_ARGV_SHA:&str="e79a80e474b4fd0e35c0b5860738d13254a5da9deb324101176ce1f8a91e1501";
pub const PRIORITY_ARGV_SHA:&str="cb6891db8f3c6a804236730bcbbabd21c24bc28cec978e13d3827bfae0ba3bc4";
// CERTIFICATE_PINS_END

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Authority {
    pub caller: String,
    pub owner: String,
    pub generation: String,
    pub executable_id: String,
    pub executable_sha256: String,
    pub version: String,
    pub route: String,
    pub profile_generation: String,
    pub config_generation: String,
    pub account_hash: String,
    pub capability_generation: String,
    pub authenticated_profile_verified: bool,
}

pub struct ChildRequest<'a> {
    pub caller: &'a str,
    pub owner: &'a str,
    pub generation: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub fast: bool,
    pub prompt_bytes: usize,
}

pub const STRIP_ENV: &[&str] = &[
    "OPENAI_API_KEY", "OPENAI_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
    "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT_ID",
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT",
    "VIBESPACE_CODEX_CONTEXT_TOKEN",
];
pub const ALLOW_ENV: &[&str] = &[
    "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "CODEX_HOME",
    "USERNAME", "USERDOMAIN", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
];

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn authorize(parent: &Authority, child_proof: &Authority, request: &ChildRequest<'_>) -> Result<Vec<String>, &'static str> {
    if parent != child_proof || !parent.authenticated_profile_verified {
        return Err("rlm_child_authority_unverified");
    }
    if !matches!(request.caller, "main" | "workbench-main")
        || parent.caller != request.caller || parent.owner != request.owner
        || parent.generation != request.generation || parent.generation.is_empty()
        || parent.route != "official:openai-codex"
        || !parent.executable_id.starts_with("cli-executable-")
        || parent.executable_sha256 != PINNED_RUNTIME_SHA || parent.version != "codex-cli 0.159.2"
        || !digest(&parent.account_hash) || parent.profile_generation.is_empty()
        || parent.config_generation != BINARY_CONFIG_CERTIFICATE_SHA
        || parent.capability_generation != BINARY_CONFIG_CERTIFICATE_SHA
    { return Err("rlm_parent_binding_invalid"); }
    // Initial admission is restricted to the actual proven model/effort contract.
    if request.model != "gpt-6-luna" || request.effort != "low" {
        return Err("rlm_exact_child_identity_unavailable");
    }
    if request.prompt_bytes == 0 || request.prompt_bytes > 128_000 {
        return Err("rlm_child_input_budget_exceeded");
    }
    let mut args: Vec<String> = [
        "exec", "--ignore-user-config", "--ephemeral", "--json",
        "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-6-luna",
    ].into_iter().map(str::to_string).collect();
    for config in [
        "model_provider=\"openai\"", "forced_login_method=\"chatgpt\"",
        "approval_policy=\"never\"", "model_reasoning_effort=\"low\"",
        "web_search=\"disabled\"", "project_doc_max_bytes=0", "mcp_servers={}",
        "model_providers.openai.request_max_retries=0", "model_providers.openai.stream_max_retries=0",
    ] { args.extend(["-c".into(), config.into()]); }
    if request.fast { args.extend(["-c".into(), "service_tier=\"priority\"".into()]); }
    for feature in [
        "shell_tool", "unified_exec", "apps", "multi_agent", "multi_agent_v2",
        "image_generation", "view_image", "skill_search", "workspace_dependencies",
        "remote_plugin", "hooks", "memories", "code_mode_host", "code_mode",
        "default_mode_request_user_input",
    ] { args.extend(["-c".into(), format!("features.{feature}=false")]); }
    args.push("-".into());
    Ok(args)
}

// The native caller must use create_dir (exclusive creation), not create_dir_all,
// with its own unpredictable nonce, then canonicalize and verify the empty dir.
// Never accept a frontend-provided path or reuse a prior run's working directory.
pub fn private_cwd(storage_root: &Path, nonce: &str) -> Result<PathBuf, &'static str> {
    if nonce.len() < 20 || nonce.len() > 64
        || !nonce.bytes().all(|b| b.is_ascii_alphanumeric())
    { return Err("rlm_child_directory_identity_invalid"); }
    Ok(storage_root.join("codex-rlm").join(nonce))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn authority() -> Authority { Authority {
        caller: "main".into(), owner: "synthetic-chat".into(), generation: "parent-generation".into(),
        executable_id: "cli-executable-0000000000000004".into(), executable_sha256: PINNED_RUNTIME_SHA.into(),
        version: "codex-cli 0.159.2".into(), route: "official:openai-codex".into(),
        profile_generation: "inherited-native-profile".into(), config_generation: BINARY_CONFIG_CERTIFICATE_SHA.into(),
        account_hash: "b".repeat(64), capability_generation: BINARY_CONFIG_CERTIFICATE_SHA.into(),
        authenticated_profile_verified: true,
    } }
    fn request() -> ChildRequest<'static> { ChildRequest {
        caller: "main", owner: "synthetic-chat", generation: "parent-generation",
        model: "gpt-6-luna", effort: "low", fast: false, prompt_bytes: 100,
    } }
    #[test] fn exact_fixed_args() { let p=authority(); let a=authorize(&p,&p,&request()).unwrap();
        assert_eq!(a[0],"exec"); assert_eq!(a.last().unwrap(),"-");
        for expected in ["--ignore-user-config","forced_login_method=\"chatgpt\"","features.apps=false","features.remote_plugin=false","features.shell_tool=false","project_doc_max_bytes=0"] { assert!(a.iter().any(|v| v==expected)); }
    }
    #[test] fn fast_priority() { let p=authority(); let mut r=request(); r.fast=true;
        assert!(authorize(&p,&p,&r).unwrap().contains(&"service_tier=\"priority\"".into())); }
    #[test] fn no_standard_tier_override() { let p=authority(); assert!(!authorize(&p,&p,&request()).unwrap().iter().any(|a| a.starts_with("service_tier"))); }
    #[test] fn binary_controls_not_auth_authority() { let mut p=authority();p.authenticated_profile_verified=false;assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn same_unique_account_required() { let p=authority();let mut c=p.clone();c.account_hash="c".repeat(64);assert!(authorize(&p,&c,&request()).is_err()); }
    #[test] fn missing_unique_account_rejected() { let mut p=authority();p.account_hash.clear();assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn changed_profile_rejected() { let p=authority();let mut c=p.clone();c.profile_generation="other".into();assert!(authorize(&p,&c,&request()).is_err()); }
    #[test] fn changed_runtime_rejected() { let p=authority();let mut c=p.clone();c.executable_sha256="c".repeat(64);assert!(authorize(&p,&c,&request()).is_err()); }
    #[test] fn legacy_runtime_rejected() { let mut p=authority();p.version="codex-cli 0.151.0".into();assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn unrelated_caller_rejected() { let p=authority();let mut r=request();r.caller="dictation";assert!(authorize(&p,&p,&r).is_err()); }
    #[test] fn unrelated_owner_rejected() { let p=authority();let mut r=request();r.owner="other-chat";assert!(authorize(&p,&p,&r).is_err()); }
    #[test] fn stale_generation_rejected() { let p=authority();let mut r=request();r.generation="old";assert!(authorize(&p,&p,&r).is_err()); }
    #[test] fn no_provider_fallback() { let mut p=authority();p.route="translation:openrouter".into();assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn no_model_fallback() { let p=authority();let mut r=request();r.model="other";assert!(authorize(&p,&p,&r).is_err()); }
    #[test] fn no_effort_fallback() { let p=authority();let mut r=request();r.effort="high";assert!(authorize(&p,&p,&r).is_err()); }
    #[test] fn input_bound() { let p=authority();let mut r=request();r.prompt_bytes=128001;assert!(authorize(&p,&p,&r).is_err()); }
    #[test] fn native_directory_no_traversal() { for n in ["../../other", "..\\other", "C:\\other", "a"] { assert!(private_cwd(Path::new("C:/task"),n).is_err()); } assert_eq!(private_cwd(Path::new("C:/task"),&"a".repeat(24)).unwrap(),Path::new("C:/task").join("codex-rlm").join("a".repeat(24))); }
    #[test] fn provider_env_strip_never_discards_auth_home() { assert!(STRIP_ENV.contains(&"OPENAI_API_KEY"));assert!(STRIP_ENV.contains(&"OPENAI_BASE_URL"));assert!(!STRIP_ENV.contains(&"CODEX_HOME"));assert!(!STRIP_ENV.contains(&"USERPROFILE")); }
    #[test] fn binary_pin_rejects_other_same_version_runtime() { let mut p=authority();p.executable_sha256="a".repeat(64);assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn changed_config_certificate_rejected() { let mut p=authority();p.config_generation="unproven".into();assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn changed_capability_certificate_rejected() { let mut p=authority();p.capability_generation="unproven".into();assert!(authorize(&p,&p,&request()).is_err()); }
    #[test] fn environment_allowlist_excludes_provider_and_config_overrides() { for name in STRIP_ENV {assert!(!ALLOW_ENV.contains(name));}assert!(ALLOW_ENV.contains(&"CODEX_HOME"));assert!(!ALLOW_ENV.contains(&"CODEX_CONFIG")); }
}
