//! Fail-closed native runtime-profile authority for VibeSpace.
//!
//! Parses `VIBESPACE_RUNTIME_PROFILE` from the process environment before any
//! branding initialization or Tauri Builder construction. Only two states are
//! valid:
//!
//! - **Absent** → ordinary production behavior.
//! - **Exact `monochrome-visual-test`** → minimal visual-test mode.
//!
//! Any other value (unknown, empty-but-present, non-Unicode) fails startup
//! before any side effects.

use std::ffi::OsString;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::utils::config::CapabilityEntry;

/// The environment variable name that selects the native runtime profile.
pub const RUNTIME_PROFILE_ENV: &str = "VIBESPACE_RUNTIME_PROFILE";

/// The exact accepted visual-test profile value.
pub const MONOCHROME_VISUAL_TEST: &str = "monochrome-visual-test";

/// Child-only session evidence supplied by the native harness.
pub const MONOCHROME_SESSION_NONCE_HASH_ENV: &str = "VIBESPACE_MONOCHROME_SESSION_NONCE_HASH";

/// The only capability identifier exposed by the visual-test query.
pub const MONOCHROME_CAPABILITY_IDENTIFIER: &str = "monochrome-test";

pub const DENIED_EFFECT_NOTIFICATION: &str = "notification";
pub const DENIED_EFFECT_PROCESS_RELAUNCH: &str = "processRelaunch";
pub const DENIED_EFFECT_UPDATER: &str = "updater";
pub const DENIED_EFFECT_SHELL_OPEN: &str = "shellOpen";
pub const DENIED_EFFECT_EXTERNAL_HTTP: &str = "externalHttp";
pub const DENIED_EFFECT_KEYCHAIN: &str = "keychain";
pub const DENIED_EFFECT_REGISTRY: &str = "registry";
pub const DENIED_EFFECT_LAUNCHER: &str = "launcher";
pub const DENIED_EFFECT_TRAY: &str = "tray";
pub const DENIED_EFFECT_SINGLE_INSTANCE: &str = "singleInstance";
pub const DENIED_EFFECT_GLOBAL_SHORTCUT: &str = "globalShortcut";
pub const DENIED_EFFECT_DEEP_LINK: &str = "deepLink";
pub const DENIED_EFFECT_AUTOSTART: &str = "autostart";

pub const DENIED_EFFECT_MANIFEST_HASH: &str =
    "24d75985399db9fb179ac64a10b982801fcb7681bf3f13a5a62d2340fa04850c";

const ORDINARY_APP_IDENTIFIER: &str = "ai.jarvis.desktop";
const MONOCHROME_APP_IDENTIFIER_PREFIX: &str = "ai.vibespace.monochrome.test";
const PRODUCTION_CAPABILITY_IDENTIFIERS: [&str; 7] = [
    "browser-chat-host",
    "cold-start-intro",
    "default",
    "pet-mini-panel",
    "pet-overlay",
    "taskbar-usage",
    "workbench-window",
];
static DENIED_EFFECT_REGISTRY_STATE: OnceLock<DeniedEffectRegistry> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
enum DeniedEffectKind {
    Notification,
    ProcessRelaunch,
    Updater,
    ShellOpen,
    ExternalHttp,
    Keychain,
    Registry,
    Launcher,
    Tray,
    SingleInstance,
    GlobalShortcut,
    DeepLink,
    Autostart,
}

impl DeniedEffectKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            DENIED_EFFECT_NOTIFICATION => Some(Self::Notification),
            DENIED_EFFECT_PROCESS_RELAUNCH => Some(Self::ProcessRelaunch),
            DENIED_EFFECT_UPDATER => Some(Self::Updater),
            DENIED_EFFECT_SHELL_OPEN => Some(Self::ShellOpen),
            DENIED_EFFECT_EXTERNAL_HTTP => Some(Self::ExternalHttp),
            DENIED_EFFECT_KEYCHAIN => Some(Self::Keychain),
            DENIED_EFFECT_REGISTRY => Some(Self::Registry),
            DENIED_EFFECT_LAUNCHER => Some(Self::Launcher),
            DENIED_EFFECT_TRAY => Some(Self::Tray),
            DENIED_EFFECT_SINGLE_INSTANCE => Some(Self::SingleInstance),
            DENIED_EFFECT_GLOBAL_SHORTCUT => Some(Self::GlobalShortcut),
            DENIED_EFFECT_DEEP_LINK => Some(Self::DeepLink),
            DENIED_EFFECT_AUTOSTART => Some(Self::Autostart),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeniedEffectAuthority {
    app_identifier: String,
    capability_identifier: String,
    session_nonce_hash: String,
}

impl DeniedEffectAuthority {
    fn from_context(context: &RuntimeStartupContext) -> Result<Self, String> {
        if context.profile != RuntimeProfile::MonochromeVisualTest {
            return Err("denied-effect registry requires visual-test authority".to_string());
        }
        let suffix = context
            .app_identifier
            .strip_prefix(MONOCHROME_APP_IDENTIFIER_PREFIX)
            .unwrap_or_default();
        if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("denied-effect registry application authority rejected".to_string());
        }
        let capability_identifier = context
            .capability_identifier
            .as_deref()
            .filter(|value| *value == MONOCHROME_CAPABILITY_IDENTIFIER)
            .ok_or_else(|| "denied-effect registry capability authority rejected".to_string())?;
        let session_nonce_hash = context
            .session_nonce_hash
            .as_deref()
            .filter(|value| is_lower_hex_64(value))
            .ok_or_else(|| "denied-effect registry nonce authority rejected".to_string())?;
        Ok(Self {
            app_identifier: context.app_identifier.clone(),
            capability_identifier: capability_identifier.to_string(),
            session_nonce_hash: session_nonce_hash.to_string(),
        })
    }
}

#[derive(Debug)]
struct DeniedEffectRegistry {
    authority: DeniedEffectAuthority,
    counters: [AtomicU64; 13],
}

impl DeniedEffectRegistry {
    fn new(context: &RuntimeStartupContext) -> Result<Self, String> {
        Ok(Self {
            authority: DeniedEffectAuthority::from_context(context)?,
            counters: std::array::from_fn(|_| AtomicU64::new(0)),
        })
    }

    #[cfg(test)]
    fn record(&self, key: &str) -> Result<(), String> {
        let kind = DeniedEffectKind::parse(key)
            .ok_or_else(|| "denied-effect category rejected".to_string())?;
        self.record_kind(kind)
    }

    fn record_kind(&self, kind: DeniedEffectKind) -> Result<(), String> {
        increment_counter(&self.counters[kind as usize]).map(|_| ())
    }

    fn snapshot_for(
        &self,
        context: &RuntimeStartupContext,
    ) -> Result<DeniedEffectSnapshot, String> {
        let authority = DeniedEffectAuthority::from_context(context)?;
        if authority != self.authority {
            return Err("denied-effect registry authority mismatch".to_string());
        }
        let counters = DeniedEffectCounters::from_registry(self);
        Ok(DeniedEffectSnapshot {
            status: if counters.are_all_zero() {
                "PASS"
            } else {
                "FAIL"
            },
            manifest_hash: DENIED_EFFECT_MANIFEST_HASH,
            counters,
        })
    }
}

fn increment_counter(counter: &AtomicU64) -> Result<u64, String> {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
            current.checked_add(1)
        })
        .map(|previous| previous + 1)
        .map_err(|_| "denied-effect counter exhausted".to_string())
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeniedEffectCounters {
    pub notification: u64,
    pub process_relaunch: u64,
    pub updater: u64,
    pub shell_open: u64,
    pub external_http: u64,
    pub keychain: u64,
    pub registry: u64,
    pub launcher: u64,
    pub tray: u64,
    pub single_instance: u64,
    pub global_shortcut: u64,
    pub deep_link: u64,
    pub autostart: u64,
}

impl DeniedEffectCounters {
    fn from_registry(registry: &DeniedEffectRegistry) -> Self {
        let load = |kind: DeniedEffectKind| registry.counters[kind as usize].load(Ordering::SeqCst);
        Self {
            notification: load(DeniedEffectKind::Notification),
            process_relaunch: load(DeniedEffectKind::ProcessRelaunch),
            updater: load(DeniedEffectKind::Updater),
            shell_open: load(DeniedEffectKind::ShellOpen),
            external_http: load(DeniedEffectKind::ExternalHttp),
            keychain: load(DeniedEffectKind::Keychain),
            registry: load(DeniedEffectKind::Registry),
            launcher: load(DeniedEffectKind::Launcher),
            tray: load(DeniedEffectKind::Tray),
            single_instance: load(DeniedEffectKind::SingleInstance),
            global_shortcut: load(DeniedEffectKind::GlobalShortcut),
            deep_link: load(DeniedEffectKind::DeepLink),
            autostart: load(DeniedEffectKind::Autostart),
        }
    }

    fn are_all_zero(&self) -> bool {
        self.notification == 0
            && self.process_relaunch == 0
            && self.updater == 0
            && self.shell_open == 0
            && self.external_http == 0
            && self.keychain == 0
            && self.registry == 0
            && self.launcher == 0
            && self.tray == 0
            && self.single_instance == 0
            && self.global_shortcut == 0
            && self.deep_link == 0
            && self.autostart == 0
    }

    #[cfg(test)]
    fn total(&self) -> u64 {
        [
            self.notification,
            self.process_relaunch,
            self.updater,
            self.shell_open,
            self.external_http,
            self.keychain,
            self.registry,
            self.launcher,
            self.tray,
            self.single_instance,
            self.global_shortcut,
            self.deep_link,
            self.autostart,
        ]
        .into_iter()
        .try_fold(0_u64, u64::checked_add)
        .expect("test counter total must remain representable")
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeniedEffectSnapshot {
    pub status: &'static str,
    pub manifest_hash: &'static str,
    pub counters: DeniedEffectCounters,
}

// ---------------------------------------------------------------------------
// Profile enum
// ---------------------------------------------------------------------------

/// Parsed native runtime profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeProfile {
    /// Environment variable absent → ordinary production behavior.
    Ordinary,
    /// Exact `monochrome-visual-test` → minimal visual-test mode.
    MonochromeVisualTest,
}

/// Fully validated startup authority resolved before Tauri builder setup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStartupContext {
    pub profile: RuntimeProfile,
    pub app_identifier: String,
    pub capability_identifier: Option<String>,
    pub session_nonce_hash: Option<String>,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Parse the runtime profile from an optional `OsString`.
///
/// - `None` (absent) → `Ok(RuntimeProfile::Ordinary)`
/// - `Some("monochrome-visual-test")` → `Ok(RuntimeProfile::MonochromeVisualTest)`
/// - `Some("")` → `Err` (empty but present)
/// - `Some(unknown)` → `Err`
/// - `Some(non-Unicode)` → `Err`
pub fn parse_runtime_profile(raw: Option<OsString>) -> Result<RuntimeProfile, String> {
    match raw {
        None => Ok(RuntimeProfile::Ordinary),
        Some(val) => {
            let s = val
                .to_str()
                .ok_or_else(|| "non-Unicode VIBESPACE_RUNTIME_PROFILE value".to_string())?;
            match s {
                MONOCHROME_VISUAL_TEST => Ok(RuntimeProfile::MonochromeVisualTest),
                "" => Err("empty VIBESPACE_RUNTIME_PROFILE is not valid".to_string()),
                _ => Err("unknown VIBESPACE_RUNTIME_PROFILE value".to_string()),
            }
        }
    }
}

/// Convenience: read from the actual process environment and parse.
pub fn resolve_from_env() -> Result<RuntimeProfile, String> {
    parse_runtime_profile(std::env::var_os(RUNTIME_PROFILE_ENV))
}

/// Resolve the profile and its paired child-only evidence.
///
/// The nonce is meaningful only for the exact visual-test profile. Ordinary
/// mode deliberately discards it so an auxiliary environment variable cannot
/// enable test behavior or leak test evidence into production.
pub fn resolve_startup_context(
    raw_profile: Option<OsString>,
    raw_nonce_hash: Option<OsString>,
    app_identifier: &str,
    capabilities: &[CapabilityEntry],
) -> Result<RuntimeStartupContext, String> {
    let profile = parse_runtime_profile(raw_profile)?;
    let capability_identifier = match profile {
        RuntimeProfile::Ordinary => {
            let valid_identifier = app_identifier == ORDINARY_APP_IDENTIFIER;
            let mut observed_capabilities = capabilities
                .iter()
                .map(|entry| match entry {
                    CapabilityEntry::Reference(identifier) => Some(identifier.as_str()),
                    CapabilityEntry::Inlined(_) => None,
                })
                .collect::<Option<Vec<_>>>();
            if let Some(observed) = observed_capabilities.as_mut() {
                observed.sort_unstable();
            }
            let valid_capabilities = observed_capabilities.as_deref()
                == Some(PRODUCTION_CAPABILITY_IDENTIFIERS.as_slice());
            if !valid_identifier {
                return Err("ordinary application identifier policy is invalid".to_string());
            }
            if !valid_capabilities {
                return Err("ordinary capability policy is invalid".to_string());
            }
            None
        }
        RuntimeProfile::MonochromeVisualTest => {
            let suffix = app_identifier
                .strip_prefix(MONOCHROME_APP_IDENTIFIER_PREFIX)
                .unwrap_or_default();
            if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("visual-test application identifier policy is invalid".to_string());
            }
            match capabilities {
                [CapabilityEntry::Reference(identifier)]
                    if identifier == MONOCHROME_CAPABILITY_IDENTIFIER =>
                {
                    Some(identifier.clone())
                }
                _ => return Err("visual-test capability policy is invalid".to_string()),
            }
        }
    };
    let session_nonce_hash = match profile {
        RuntimeProfile::Ordinary => None,
        RuntimeProfile::MonochromeVisualTest => {
            let raw = raw_nonce_hash.ok_or_else(|| {
                format!(
                    "{MONOCHROME_SESSION_NONCE_HASH_ENV} is required in {MONOCHROME_VISUAL_TEST} mode"
                )
            })?;
            let value = raw
                .to_str()
                .ok_or_else(|| format!("{MONOCHROME_SESSION_NONCE_HASH_ENV} must be Unicode"))?;
            let valid = value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
            if !valid {
                return Err(format!(
                    "{MONOCHROME_SESSION_NONCE_HASH_ENV} must be exactly 64 lowercase hexadecimal characters"
                ));
            }
            Some(value.to_string())
        }
    };

    Ok(RuntimeStartupContext {
        profile,
        app_identifier: app_identifier.to_string(),
        capability_identifier,
        session_nonce_hash,
    })
}

/// Read and validate all native startup authority from the process environment.
pub fn resolve_startup_context_from_env(
    app_identifier: &str,
    capabilities: &[CapabilityEntry],
) -> Result<RuntimeStartupContext, String> {
    resolve_startup_context(
        std::env::var_os(RUNTIME_PROFILE_ENV),
        std::env::var_os(MONOCHROME_SESSION_NONCE_HASH_ENV),
        app_identifier,
        capabilities,
    )
}

/// Initialize the immutable per-process denied-effect registry for the exact
/// accepted visual-test authority. Repeated initialization for the same
/// authority preserves counters; any different authority fails closed.
pub fn initialize_denied_effect_registry(context: &RuntimeStartupContext) -> Result<(), String> {
    initialize_denied_effect_registry_in(&DENIED_EFFECT_REGISTRY_STATE, context)
}

fn initialize_denied_effect_registry_in(
    slot: &OnceLock<DeniedEffectRegistry>,
    context: &RuntimeStartupContext,
) -> Result<(), String> {
    let candidate = DeniedEffectRegistry::new(context)?;
    match slot.set(candidate) {
        Ok(()) => Ok(()),
        Err(candidate) => {
            let existing = slot
                .get()
                .ok_or_else(|| "denied-effect registry initialization failed".to_string())?;
            if existing.authority == candidate.authority {
                Ok(())
            } else {
                Err("denied-effect registry authority already bound".to_string())
            }
        }
    }
}

#[cfg(test)]
pub(crate) static RUNTIME_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Crate-wide test guard for the two runtime-profile environment variables.
///
/// The guard snapshots both prior `OsString` values, serializes all cooperating
/// tests, and restores the snapshot from `Drop`, including during unwinding.
#[cfg(test)]
pub(crate) struct TestRuntimeEnvironment {
    _lock: std::sync::MutexGuard<'static, ()>,
    previous_profile: Option<OsString>,
    previous_nonce_hash: Option<OsString>,
    restoration_observer: Option<Box<dyn FnOnce()>>,
}

#[cfg(test)]
fn set_test_environment_value(name: &str, value: Option<&OsString>) {
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}

#[cfg(test)]
pub(crate) fn test_runtime_environment(
    profile: Option<OsString>,
    nonce_hash: Option<OsString>,
) -> TestRuntimeEnvironment {
    let lock = RUNTIME_ENV_MUTEX
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous_profile = std::env::var_os(RUNTIME_PROFILE_ENV);
    let previous_nonce_hash = std::env::var_os(MONOCHROME_SESSION_NONCE_HASH_ENV);
    set_test_environment_value(RUNTIME_PROFILE_ENV, profile.as_ref());
    set_test_environment_value(MONOCHROME_SESSION_NONCE_HASH_ENV, nonce_hash.as_ref());
    TestRuntimeEnvironment {
        _lock: lock,
        previous_profile,
        previous_nonce_hash,
        restoration_observer: None,
    }
}

#[cfg(test)]
impl TestRuntimeEnvironment {
    fn observe_restoration(&mut self, observer: impl FnOnce() + 'static) {
        self.restoration_observer = Some(Box::new(observer));
    }
}

#[cfg(test)]
impl Drop for TestRuntimeEnvironment {
    fn drop(&mut self) {
        set_test_environment_value(RUNTIME_PROFILE_ENV, self.previous_profile.as_ref());
        set_test_environment_value(
            MONOCHROME_SESSION_NONCE_HASH_ENV,
            self.previous_nonce_hash.as_ref(),
        );
        if let Some(observer) = self.restoration_observer.take() {
            observer();
        }
    }
}

// ---------------------------------------------------------------------------
// Privileged-effect guard (consumed by task 115)
// ---------------------------------------------------------------------------

/// Fail-closed guard for privileged effects.
///
/// - In an ordinary process with no visual registry: `Ok(())`.
/// - If environment tampering claims ordinary mode after visual initialization:
///   `Err` (the process remains fail closed).
/// - In visual-test mode: always `Err` before effect construction (fail closed).
/// - On invalid/unresolved profile: `Err` (fail closed).
///
/// Task 115 calls this before constructing any privileged effect.
pub fn ensure_privileged_effect_allowed(
    category: &'static str,
    effect: &'static str,
) -> Result<(), String> {
    let profile = resolve_from_env();
    let nonce_hash = std::env::var_os(MONOCHROME_SESSION_NONCE_HASH_ENV)
        .and_then(|value| value.into_string().ok());
    ensure_privileged_effect_allowed_with(
        profile,
        nonce_hash.as_deref(),
        category,
        effect,
        DENIED_EFFECT_REGISTRY_STATE.get(),
    )
}

fn ensure_privileged_effect_allowed_with(
    profile: Result<RuntimeProfile, String>,
    observed_nonce_hash: Option<&str>,
    category: &'static str,
    effect: &'static str,
    registry: Option<&DeniedEffectRegistry>,
) -> Result<(), String> {
    let kind = DeniedEffectKind::parse(category)
        .ok_or_else(|| format!("privileged effect '{effect}' denied: category rejected"))?;
    let profile = profile.map_err(|error| {
        format!("privileged effect '{effect}' denied: profile resolution failed: {error}")
    })?;
    match profile {
        RuntimeProfile::Ordinary if registry.is_none() => Ok(()),
        RuntimeProfile::Ordinary => Err(format!(
            "privileged effect '{effect}' denied: visual registry authority mismatch"
        )),
        RuntimeProfile::MonochromeVisualTest => {
            let registry = registry.ok_or_else(|| {
                format!(
                    "privileged effect '{effect}' denied in monochrome-visual-test mode: registry unavailable"
                )
            })?;
            if observed_nonce_hash != Some(registry.authority.session_nonce_hash.as_str()) {
                return Err(format!(
                    "privileged effect '{effect}' denied in monochrome-visual-test mode: registry authority mismatch"
                ));
            }
            registry.record_kind(kind).map_err(|_| {
                format!(
                    "privileged effect '{effect}' denied in monochrome-visual-test mode: counter unavailable"
                )
            })?;
            Err(format!(
                "privileged effect '{effect}' denied in monochrome-visual-test mode"
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Query evidence (for runtime_profile_query command)
// ---------------------------------------------------------------------------

/// Non-secret evidence returned by the `runtime_profile_query` command.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProfileEvidence {
    /// The exact resolved profile string.
    pub profile: String,
    /// The identifier from the running Tauri AppHandle configuration.
    pub app_identifier: String,
    /// Test capability identity; absent in ordinary mode.
    pub capability_identifier: Option<String>,
    /// Harness-provided session nonce hash; absent in ordinary mode.
    pub session_nonce_hash: Option<String>,
    /// Authority-bound denied-attempt snapshot; omitted outside visual mode.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied_effects: Option<DeniedEffectSnapshot>,
}

/// Build the evidence struct for the current process state.
pub fn build_evidence(context: &RuntimeStartupContext) -> Result<RuntimeProfileEvidence, String> {
    build_evidence_with_registry(context, DENIED_EFFECT_REGISTRY_STATE.get())
}

fn build_evidence_with_registry(
    context: &RuntimeStartupContext,
    registry: Option<&DeniedEffectRegistry>,
) -> Result<RuntimeProfileEvidence, String> {
    let profile = match context.profile {
        RuntimeProfile::Ordinary => "ordinary",
        RuntimeProfile::MonochromeVisualTest => MONOCHROME_VISUAL_TEST,
    };
    let is_visual_test = context.profile == RuntimeProfile::MonochromeVisualTest;
    let denied_effects = if is_visual_test {
        Some(
            registry
                .ok_or_else(|| "denied-effect registry unavailable".to_string())?
                .snapshot_for(context)?,
        )
    } else {
        None
    };

    Ok(RuntimeProfileEvidence {
        profile: profile.to_string(),
        app_identifier: context.app_identifier.clone(),
        capability_identifier: if is_visual_test {
            context.capability_identifier.clone()
        } else {
            None
        },
        session_nonce_hash: if is_visual_test {
            context.session_nonce_hash.clone()
        } else {
            None
        },
        denied_effects,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::utils::config::CapabilityEntry;

    fn capability_references(identifiers: &[&str]) -> Vec<CapabilityEntry> {
        identifiers
            .iter()
            .map(|identifier| CapabilityEntry::Reference((*identifier).to_string()))
            .collect()
    }

    fn ordinary_capabilities() -> Vec<CapabilityEntry> {
        capability_references(&[
            "browser-chat-host",
            "cold-start-intro",
            "default",
            "pet-mini-panel",
            "pet-overlay",
            "taskbar-usage",
            "workbench-window",
        ])
    }

    fn visual_test_capabilities() -> Vec<CapabilityEntry> {
        capability_references(&[MONOCHROME_CAPABILITY_IDENTIFIER])
    }

    fn visual_test_context() -> RuntimeStartupContext {
        resolve_startup_context(
            Some(OsString::from(MONOCHROME_VISUAL_TEST)),
            Some(OsString::from("a".repeat(64))),
            "ai.vibespace.monochrome.testabc123",
            &visual_test_capabilities(),
        )
        .expect("valid visual-test authority")
    }

    // -- Parsing: absent → ordinary --

    #[test]
    fn parse_absent_returns_ordinary() {
        let result = parse_runtime_profile(None);
        assert_eq!(result, Ok(RuntimeProfile::Ordinary));
    }

    // -- Parsing: exact value → visual test --

    #[test]
    fn parse_exact_monochrome_visual_test_returns_test_mode() {
        let result = parse_runtime_profile(Some(OsString::from("monochrome-visual-test")));
        assert_eq!(result, Ok(RuntimeProfile::MonochromeVisualTest));
    }

    #[test]
    fn parser_rejects_near_miss_profile_values() {
        for value in [
            " monochrome-visual-test",
            "monochrome-visual-test ",
            "MONOCHROME-VISUAL-TEST",
            "prefix-monochrome-visual-test",
            "monochrome-visual-test-suffix",
            " ",
        ] {
            assert!(
                parse_runtime_profile(Some(OsString::from(value))).is_err(),
                "{value:?} must not select visual-test mode"
            );
        }
    }

    // -- Parsing: unknown value → error --

    #[test]
    fn parse_unknown_value_fails() {
        let result = parse_runtime_profile(Some(OsString::from("something-else")));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown"));
    }

    #[test]
    fn invalid_profile_errors_are_bounded_and_never_echo_raw_content() {
        let marker = "marker-secret\r\n\u{1b}[31m";
        let error = parse_runtime_profile(Some(OsString::from(marker))).unwrap_err();

        assert!(!error.contains("marker-secret"));
        assert!(!error.contains('\r'));
        assert!(!error.contains('\n'));
        assert!(!error.contains('\u{1b}'));
        assert!(error.contains(RUNTIME_PROFILE_ENV));
    }

    // -- Parsing: empty but present → error --

    #[test]
    fn parse_empty_present_fails() {
        let result = parse_runtime_profile(Some(OsString::from("")));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    // -- Parsing: non-Unicode → error --

    #[test]
    fn parse_non_unicode_fails() {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let bad = OsString::from_vec(vec![0xFF, 0xFE, 0x00]);
            let result = parse_runtime_profile(Some(bad));
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("non-Unicode"));
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            // 0xD800 is an unpaired surrogate → invalid UTF-8 when converted
            let bad = OsString::from_wide(&[0xD800, 0x0041]);
            let result = parse_runtime_profile(Some(bad));
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("non-Unicode"));
        }
    }

    #[test]
    fn test_environment_guard_restores_both_variables_after_panic() {
        let (restoration_tx, restoration_rx) = mpsc::channel();

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut environment = test_runtime_environment(
                Some(OsString::from("temporary-profile")),
                Some(OsString::from("temporary-nonce")),
            );
            let expected_profile = environment.previous_profile.clone();
            let expected_nonce = environment.previous_nonce_hash.clone();
            environment.observe_restoration(move || {
                restoration_tx
                    .send((
                        std::env::var_os(RUNTIME_PROFILE_ENV) == expected_profile,
                        std::env::var_os(MONOCHROME_SESSION_NONCE_HASH_ENV) == expected_nonce,
                    ))
                    .expect("report restoration while the environment lock is held");
            });
            assert_eq!(
                std::env::var_os(RUNTIME_PROFILE_ENV),
                Some(OsString::from("temporary-profile"))
            );
            panic!("exercise panic-safe restoration");
        }));

        assert!(panic.is_err());
        assert_eq!(
            restoration_rx
                .recv()
                .expect("Drop observer must report restoration"),
            (true, true)
        );
    }

    #[test]
    fn test_environment_guard_serializes_parallel_callers() {
        let (first_ready_tx, first_ready_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first = std::thread::spawn(move || {
            let _environment = test_runtime_environment(Some(OsString::from("first")), None);
            first_ready_tx.send(()).expect("signal first acquisition");
            release_first_rx.recv().expect("release first guard");
        });
        first_ready_rx.recv().expect("wait for first acquisition");

        let (second_ready_tx, second_ready_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let _environment = test_runtime_environment(Some(OsString::from("second")), None);
            second_ready_tx.send(()).expect("signal second acquisition");
        });

        assert!(
            second_ready_rx
                .recv_timeout(Duration::from_millis(50))
                .is_err(),
            "the second caller must wait for the crate-wide environment lock"
        );
        release_first_tx.send(()).expect("release first caller");
        second_ready_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second caller acquires after release");
        first.join().expect("first caller");
        second.join().expect("second caller");
    }

    // -- Guard: ordinary allows --

    #[test]
    fn guard_allows_in_ordinary_mode() {
        let _environment = test_runtime_environment(None, None);
        let result = ensure_privileged_effect_allowed(DENIED_EFFECT_NOTIFICATION, "test_effect");
        assert!(result.is_ok());
    }

    // -- Guard: visual test denies --

    #[test]
    fn guard_denies_in_visual_test_mode() {
        let _environment =
            test_runtime_environment(Some(OsString::from(MONOCHROME_VISUAL_TEST)), None);
        let result = ensure_privileged_effect_allowed(DENIED_EFFECT_NOTIFICATION, "test_effect");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("denied"));
    }

    // -- Guard: invalid profile fails closed --

    #[test]
    fn guard_fails_closed_on_invalid_profile() {
        let _environment = test_runtime_environment(Some(OsString::from("garbage")), None);
        let result = ensure_privileged_effect_allowed(DENIED_EFFECT_NOTIFICATION, "test_effect");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("denied"));
    }

    #[test]
    fn guard_errors_never_echo_invalid_profile_content() {
        let _environment =
            test_runtime_environment(Some(OsString::from("marker-secret\r\n\u{1b}[31m")), None);

        let error = ensure_privileged_effect_allowed(DENIED_EFFECT_NOTIFICATION, "test_effect")
            .unwrap_err();

        assert!(!error.contains("marker-secret"));
        assert!(!error.contains('\r'));
        assert!(!error.contains('\n'));
        assert!(!error.contains('\u{1b}'));
    }

    #[test]
    fn visual_test_startup_requires_a_strict_lowercase_sha256_nonce_hash() {
        let valid_hash = "0123456789abcdef".repeat(4);
        let context = resolve_startup_context(
            Some(OsString::from(MONOCHROME_VISUAL_TEST)),
            Some(OsString::from(&valid_hash)),
            "ai.vibespace.monochrome.test0a1b2c3d",
            &visual_test_capabilities(),
        )
        .expect("exact test profile and lowercase SHA-256 hash must resolve");

        assert_eq!(context.profile, RuntimeProfile::MonochromeVisualTest);
        assert_eq!(
            context.capability_identifier.as_deref(),
            Some(MONOCHROME_CAPABILITY_IDENTIFIER)
        );
        assert_eq!(
            context.session_nonce_hash.as_deref(),
            Some(valid_hash.as_str())
        );

        for invalid in [
            None,
            Some(String::new()),
            Some("0123456789abcdef".repeat(3)),
            Some("0123456789abcdef".repeat(4).to_uppercase()),
            Some(format!("{}g", "0".repeat(63))),
            Some(format!("{} ", "0".repeat(64))),
        ] {
            let result = resolve_startup_context(
                Some(OsString::from(MONOCHROME_VISUAL_TEST)),
                invalid.as_ref().map(OsString::from),
                "ai.vibespace.monochrome.test0a1b2c3d",
                &visual_test_capabilities(),
            );
            assert!(result.is_err(), "invalid nonce hash must fail: {invalid:?}");
        }
    }

    #[test]
    fn visual_test_startup_rejects_a_non_unicode_nonce_hash() {
        #[cfg(unix)]
        let invalid = {
            use std::os::unix::ffi::OsStringExt;
            OsString::from_vec(vec![0xff; 64])
        };
        #[cfg(windows)]
        let invalid = {
            use std::os::windows::ffi::OsStringExt;
            OsString::from_wide(&[0xd800; 64])
        };

        let result = resolve_startup_context(
            Some(OsString::from(MONOCHROME_VISUAL_TEST)),
            Some(invalid),
            "ai.vibespace.monochrome.test0a1b2c3d",
            &visual_test_capabilities(),
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("must be Unicode"));
    }

    #[test]
    fn ordinary_startup_never_exposes_test_nonce_state() {
        let context = resolve_startup_context(
            None,
            Some(OsString::from("0123456789abcdef".repeat(4))),
            "ai.jarvis.desktop",
            &ordinary_capabilities(),
        )
        .expect("an auxiliary test signal must not change ordinary mode");

        assert_eq!(context.profile, RuntimeProfile::Ordinary);
        assert_eq!(context.app_identifier, "ai.jarvis.desktop");
        assert_eq!(context.capability_identifier, None);
        assert_eq!(context.session_nonce_hash, None);
    }

    #[test]
    fn ordinary_startup_accepts_a_reordered_complete_reference_set() {
        let capabilities = capability_references(&[
            "workbench-window",
            "browser-chat-host",
            "default",
            "pet-overlay",
            "taskbar-usage",
            "pet-mini-panel",
            "cold-start-intro",
        ]);

        let context = resolve_startup_context(None, None, "ai.jarvis.desktop", &capabilities)
            .expect("production capability equality must be independent of input order");

        assert_eq!(context.profile, RuntimeProfile::Ordinary);
        assert_eq!(context.capability_identifier, None);
    }

    #[test]
    fn visual_test_startup_observes_exact_context_identity_and_capability() {
        let context = resolve_startup_context(
            Some(OsString::from(MONOCHROME_VISUAL_TEST)),
            Some(OsString::from("a".repeat(64))),
            "ai.vibespace.monochrome.testABC123",
            &visual_test_capabilities(),
        )
        .expect("exact observed test policy must resolve");

        assert_eq!(context.app_identifier, "ai.vibespace.monochrome.testABC123");
        assert_eq!(
            context.capability_identifier.as_deref(),
            Some(MONOCHROME_CAPABILITY_IDENTIFIER)
        );
    }

    #[test]
    fn visual_test_startup_rejects_capability_policy_drift() {
        let inline: CapabilityEntry = serde_json::from_value(serde_json::json!({
            "identifier": "monochrome-test",
            "windows": ["monochrome-test"],
            "permissions": ["core:default"]
        }))
        .expect("inline capability fixture");
        let cases = [
            Vec::new(),
            capability_references(&[""]),
            capability_references(&["default"]),
            capability_references(&["monochrome-test", "default"]),
            vec![inline],
        ];

        for capabilities in cases {
            let error = resolve_startup_context(
                Some(OsString::from(MONOCHROME_VISUAL_TEST)),
                Some(OsString::from("a".repeat(64))),
                "ai.vibespace.monochrome.test1",
                &capabilities,
            )
            .unwrap_err();
            assert!(error.contains("capability policy"));
            assert!(!error.contains("default"));
        }
    }

    #[test]
    fn ordinary_startup_rejects_capability_policy_drift() {
        let inline: CapabilityEntry = serde_json::from_value(serde_json::json!({
            "identifier": "default",
            "windows": ["main"],
            "permissions": ["core:default"]
        }))
        .expect("inline capability fixture");
        for capabilities in [
            Vec::new(),
            capability_references(&["monochrome-test"]),
            capability_references(&["default", "pet-overlay"]),
            capability_references(&["default", "pet-mini-panel", "pet-overlay", "pet-overlay"]),
            capability_references(&[
                "default",
                "pet-mini-panel",
                "pet-overlay",
                "workbench-window",
                "unexpected",
            ]),
            vec![inline],
        ] {
            let error = resolve_startup_context(None, None, "ai.jarvis.desktop", &capabilities)
                .unwrap_err();
            assert!(error.contains("capability policy"));
            assert!(!error.contains("monochrome-test"));
        }
    }

    #[test]
    fn visual_test_startup_rejects_invalid_app_identifiers_without_echoing_them() {
        for identifier in [
            "ai.vibespace.monochrome.test",
            "ai.vibespace.monochrome.test-not-hex",
            "ai.jarvis.desktop",
            "marker-secret\r\n\u{1b}[31m",
        ] {
            let error = resolve_startup_context(
                Some(OsString::from(MONOCHROME_VISUAL_TEST)),
                Some(OsString::from("a".repeat(64))),
                identifier,
                &visual_test_capabilities(),
            )
            .unwrap_err();
            assert!(error.contains("application identifier"));
            assert!(!error.contains(identifier));
            assert!(!error.contains('\r'));
            assert!(!error.contains('\n'));
            assert!(!error.contains('\u{1b}'));
        }
    }

    // -- Evidence: structure and non-secret fields --

    #[test]
    fn evidence_contains_expected_fields() {
        let context = RuntimeStartupContext {
            profile: RuntimeProfile::Ordinary,
            app_identifier: "ai.jarvis.desktop".to_string(),
            capability_identifier: None,
            session_nonce_hash: None,
        };
        let evidence = build_evidence(&context).expect("ordinary evidence");
        assert_eq!(evidence.profile, "ordinary");
        assert_eq!(evidence.app_identifier, "ai.jarvis.desktop");
        assert_eq!(evidence.capability_identifier, None);
        assert_eq!(evidence.session_nonce_hash, None);

        let json = serde_json::to_value(evidence).expect("evidence must serialize");
        assert_eq!(
            json.as_object().expect("evidence must be an object").len(),
            4
        );
        assert!(json.get("appIdentifier").is_some());
        assert!(json.get("capabilityIdentifier").is_some());
        assert!(json.get("sessionNonceHash").is_some());
        assert!(json.get("app_identifier").is_none());
    }

    #[test]
    fn evidence_visual_test_profile_string() {
        let context = visual_test_context();
        let registry = DeniedEffectRegistry::new(&context).expect("visual registry");
        let evidence =
            build_evidence_with_registry(&context, Some(&registry)).expect("visual evidence");
        assert_eq!(evidence.profile, "monochrome-visual-test");
        assert_eq!(
            evidence.app_identifier,
            "ai.vibespace.monochrome.testabc123"
        );
        assert_eq!(
            evidence.capability_identifier.as_deref(),
            Some("monochrome-test")
        );
        assert_eq!(
            evidence.session_nonce_hash.as_deref(),
            context.session_nonce_hash.as_deref()
        );
        assert_eq!(
            evidence
                .denied_effects
                .as_ref()
                .expect("visual counters")
                .status,
            "PASS"
        );
    }

    #[test]
    fn denied_effect_registry_snapshot_has_exact_manifest_and_canonical_key_order() {
        let context = visual_test_context();
        let registry = DeniedEffectRegistry::new(&context).expect("visual registry");
        let snapshot = registry
            .snapshot_for(&context)
            .expect("authority-bound snapshot");

        assert_eq!(
            serde_json::to_string(&snapshot).expect("serialize snapshot"),
            concat!(
                "{\"status\":\"PASS\",",
                "\"manifestHash\":\"24d75985399db9fb179ac64a10b982801fcb7681bf3f13a5a62d2340fa04850c\",",
                "\"counters\":{",
                "\"notification\":0,",
                "\"processRelaunch\":0,",
                "\"updater\":0,",
                "\"shellOpen\":0,",
                "\"externalHttp\":0,",
                "\"keychain\":0,",
                "\"registry\":0,",
                "\"launcher\":0,",
                "\"tray\":0,",
                "\"singleInstance\":0,",
                "\"globalShortcut\":0,",
                "\"deepLink\":0,",
                "\"autostart\":0",
                "}}"
            )
        );
    }

    #[test]
    fn registry_initialization_is_visual_only_authority_bound_and_never_resets() {
        let slot = OnceLock::new();
        let ordinary =
            resolve_startup_context(None, None, "ai.jarvis.desktop", &ordinary_capabilities())
                .expect("ordinary context");
        assert!(initialize_denied_effect_registry_in(&slot, &ordinary).is_err());
        assert!(slot.get().is_none());

        let context = visual_test_context();
        initialize_denied_effect_registry_in(&slot, &context).expect("first initialization");
        slot.get()
            .expect("initialized registry")
            .record("tray")
            .expect("record attempt");
        initialize_denied_effect_registry_in(&slot, &context)
            .expect("same authority remains idempotent");
        assert_eq!(
            slot.get()
                .expect("registry")
                .snapshot_for(&context)
                .expect("snapshot")
                .counters
                .tray,
            1,
            "same-authority initialization must never reset counters"
        );

        let mut different = context.clone();
        different.session_nonce_hash = Some("b".repeat(64));
        assert!(initialize_denied_effect_registry_in(&slot, &different).is_err());
        assert_eq!(
            slot.get()
                .expect("registry")
                .snapshot_for(&context)
                .expect("original authority remains bound")
                .counters
                .tray,
            1
        );
    }

    #[test]
    fn real_guard_boundary_records_only_valid_visual_denials() {
        let context = visual_test_context();
        let nonce_hash = context.session_nonce_hash.as_deref();
        let registry = DeniedEffectRegistry::new(&context).expect("visual registry");

        assert!(ensure_privileged_effect_allowed_with(
            Ok(RuntimeProfile::Ordinary),
            None,
            "notification",
            "test-notification",
            None,
        )
        .is_ok());
        assert!(ensure_privileged_effect_allowed_with(
            Ok(RuntimeProfile::Ordinary),
            None,
            "notification",
            "test-notification",
            Some(&registry),
        )
        .is_err());
        assert!(ensure_privileged_effect_allowed_with(
            Ok(RuntimeProfile::Ordinary),
            None,
            "unknown",
            "test-unknown",
            Some(&registry),
        )
        .is_err());
        assert!(ensure_privileged_effect_allowed_with(
            Err("unknown profile".to_string()),
            None,
            "notification",
            "test-notification",
            Some(&registry),
        )
        .is_err());
        assert!(ensure_privileged_effect_allowed_with(
            Ok(RuntimeProfile::MonochromeVisualTest),
            nonce_hash,
            "notification",
            "test-notification",
            Some(&registry),
        )
        .is_err());

        let snapshot = registry.snapshot_for(&context).expect("snapshot");
        assert_eq!(snapshot.status, "FAIL");
        assert_eq!(snapshot.counters.notification, 1);
        assert_eq!(snapshot.counters.total(), 1);
    }

    #[test]
    fn all_canonical_denied_effect_keys_increment_their_exact_counter() {
        let context = visual_test_context();
        let registry = DeniedEffectRegistry::new(&context).expect("visual registry");
        for key in [
            "notification",
            "processRelaunch",
            "updater",
            "shellOpen",
            "externalHttp",
            "keychain",
            "registry",
            "launcher",
            "tray",
            "singleInstance",
            "globalShortcut",
            "deepLink",
            "autostart",
        ] {
            registry.record(key).expect("canonical key");
        }
        assert!(registry.record("unknown").is_err());

        let snapshot = registry.snapshot_for(&context).expect("snapshot");
        assert_eq!(snapshot.counters.total(), 13);
        assert_eq!(
            serde_json::to_value(snapshot.counters).expect("serialize counters"),
            serde_json::json!({
                "notification": 1,
                "processRelaunch": 1,
                "updater": 1,
                "shellOpen": 1,
                "externalHttp": 1,
                "keychain": 1,
                "registry": 1,
                "launcher": 1,
                "tray": 1,
                "singleInstance": 1,
                "globalShortcut": 1,
                "deepLink": 1,
                "autostart": 1
            })
        );
    }

    #[test]
    fn denied_effect_registry_is_monotonic_under_concurrency_and_rejects_overflow() {
        let context = visual_test_context();
        let registry =
            std::sync::Arc::new(DeniedEffectRegistry::new(&context).expect("visual registry"));
        let workers = (0..8)
            .map(|_| {
                let registry = std::sync::Arc::clone(&registry);
                std::thread::spawn(move || {
                    for _ in 0..1_000 {
                        registry.record("externalHttp").expect("bounded increment");
                    }
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().expect("counter worker");
        }
        assert_eq!(
            registry
                .snapshot_for(&context)
                .expect("snapshot")
                .counters
                .external_http,
            8_000
        );

        let exhausted = std::sync::atomic::AtomicU64::new(u64::MAX);
        assert!(increment_counter(&exhausted).is_err());
        assert_eq!(
            exhausted.load(std::sync::atomic::Ordering::SeqCst),
            u64::MAX
        );
    }

    #[test]
    fn snapshot_and_query_are_authority_bound_and_ordinary_query_discloses_no_counters() {
        let context = visual_test_context();
        let registry = DeniedEffectRegistry::new(&context).expect("visual registry");
        let mut different = context.clone();
        different.session_nonce_hash = Some("b".repeat(64));
        assert!(registry.snapshot_for(&different).is_err());

        let ordinary =
            resolve_startup_context(None, None, "ai.jarvis.desktop", &ordinary_capabilities())
                .expect("ordinary context");
        assert!(DeniedEffectRegistry::new(&ordinary).is_err());
        let ordinary_evidence =
            build_evidence_with_registry(&ordinary, Some(&registry)).expect("ordinary evidence");
        assert!(ordinary_evidence.denied_effects.is_none());
        assert!(
            serde_json::to_value(ordinary_evidence)
                .expect("serialize ordinary evidence")
                .get("deniedEffects")
                .is_none(),
            "ordinary query must not disclose or claim visual counters"
        );
    }
}
