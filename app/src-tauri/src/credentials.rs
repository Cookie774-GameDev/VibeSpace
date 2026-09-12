use keyring::{Entry, Error};

const SERVICE: &str = "ai.jarvis.desktop";
const ACCOUNT_PREFIX: &str = "llm-api-key";
const MAX_HARNESS_CREDENTIAL_BYTES: usize = 32 * 1024;

pub(crate) const HARNESS_API_KEY_PROVIDERS: [&str; 17] = [
    "anthropic",
    "openai",
    "google",
    "xai",
    "openrouter",
    "groq",
    "deepseek",
    "mistral",
    "together",
    "qwen",
    "cohere",
    "perplexity",
    "fireworks",
    "replicate",
    "hyperbolic",
    "novita",
    "lambda",
];

/// Stable named-profile identifiers for each privileged credential-store effect.
/// These match the frozen MC0B side-effect inventory row ids so the guard and the
/// injected effect seam speak the same effect vocabulary as the manifest oracle.
pub(crate) const EFFECT_KEYRING_ENTRY: &str = "credentials-22-keyring-entry";
pub(crate) const EFFECT_KEYRING_SET: &str = "credentials-33-keyring-set";
pub(crate) const EFFECT_KEYRING_READ: &str = "credentials-40-keyring-read";
pub(crate) const EFFECT_KEYRING_DELETE: &str = "credentials-51-keyring-delete";

// ---------------------------------------------------------------------------
// Named-profile privileged-effect guard (defense-in-depth).
//
// The guard runs before any credential-manager access. In production it consumes
// task 114's exact crate-visible interface
// `crate::runtime_profile::ensure_privileged_effect_allowed(category, effect) -> Result<(), String>`.
// Ordinary mode returns `Ok`; the `monochrome-visual-test` profile returns a stable
// named-profile denial; unknown/non-empty profile values fail closed. The reference
// is compiled only in non-test builds because the runtime_profile module is provided
// by a sibling task; unit tests inject an equivalent guard through the test hook below.
// ---------------------------------------------------------------------------

#[cfg(not(test))]
fn ensure_effect_allowed(effect: &'static str) -> Result<(), String> {
    crate::runtime_profile::ensure_privileged_effect_allowed(
        crate::runtime_profile::DENIED_EFFECT_KEYCHAIN,
        effect,
    )
}

#[cfg(test)]
type TestGuard = dyn Fn(&'static str) -> Result<(), String>;

#[cfg(test)]
std::thread_local! {
    static TEST_GUARD: std::cell::RefCell<Option<Box<TestGuard>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn ensure_effect_allowed(effect: &'static str) -> Result<(), String> {
    TEST_GUARD.with(|slot| match &*slot.borrow() {
        Some(guard) => guard(effect),
        // Fail closed: with no profile mode installed, deny every privileged effect.
        None => Err(format!(
            "privileged effect '{effect}' denied by named-profile guard (fail closed)"
        )),
    })
}

#[cfg(test)]
pub(crate) fn install_test_guard<F>(guard: F)
where
    F: Fn(&'static str) -> Result<(), String> + 'static,
{
    TEST_GUARD.with(|slot| *slot.borrow_mut() = Some(Box::new(guard)));
}

#[cfg(test)]
pub(crate) fn clear_test_guard() {
    TEST_GUARD.with(|slot| *slot.borrow_mut() = None);
}

// ---------------------------------------------------------------------------
// Injectable credential-store effect seam.
//
// Production routes through the real OS credential manager (behavior unchanged).
// Tests inject a counting in-memory store so ordinary-mode behavior is proven
// without touching the host keychain, and denied modes leave every counter at zero.
// ---------------------------------------------------------------------------

trait CredentialStoreSink {
    fn set_password(&self, service: &str, account: &str, password: &str) -> Result<(), String>;
    fn get_password(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn delete_credential(&self, service: &str, account: &str) -> Result<(), String>;
}

#[cfg_attr(test, allow(dead_code))]
struct RealCredentialStore;

impl CredentialStoreSink for RealCredentialStore {
    fn set_password(&self, service: &str, account: &str, password: &str) -> Result<(), String> {
        let entry = Entry::new(service, account)
            .map_err(|err| format!("credential store unavailable: {err}"))?;
        entry
            .set_password(password)
            .map_err(|err| format!("credential save failed: {err}"))
    }

    fn get_password(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(service, account)
            .map_err(|err| format!("credential store unavailable: {err}"))?;
        match entry.get_password() {
            Ok(value) if value.trim().is_empty() => Ok(None),
            Ok(value) => Ok(Some(value)),
            Err(Error::NoEntry) => Ok(None),
            Err(err) => Err(format!("credential read failed: {err}")),
        }
    }

    fn delete_credential(&self, service: &str, account: &str) -> Result<(), String> {
        let entry = Entry::new(service, account)
            .map_err(|err| format!("credential store unavailable: {err}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("credential delete failed: {err}")),
        }
    }
}

#[cfg(not(test))]
fn sink() -> &'static dyn CredentialStoreSink {
    &RealCredentialStore
}

#[cfg(test)]
#[derive(Default)]
struct CountingCredentialStore {
    store: std::cell::RefCell<std::collections::HashMap<String, String>>,
    counters: std::cell::RefCell<std::collections::HashMap<&'static str, usize>>,
}

#[cfg(test)]
impl CountingCredentialStore {
    fn bump(&self, effect: &'static str) {
        *self.counters.borrow_mut().entry(effect).or_insert(0) += 1;
    }

    fn count(&self, effect: &'static str) -> usize {
        self.counters.borrow().get(effect).copied().unwrap_or(0)
    }

    fn total(&self) -> usize {
        self.counters.borrow().values().sum()
    }

    fn key(&self, service: &str, account: &str) -> String {
        format!("{service}/{account}")
    }
}

#[cfg(test)]
impl CredentialStoreSink for CountingCredentialStore {
    fn set_password(&self, service: &str, account: &str, password: &str) -> Result<(), String> {
        self.bump(EFFECT_KEYRING_ENTRY);
        self.bump(EFFECT_KEYRING_SET);
        self.store
            .borrow_mut()
            .insert(self.key(service, account), password.to_string());
        Ok(())
    }

    fn get_password(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        self.bump(EFFECT_KEYRING_ENTRY);
        self.bump(EFFECT_KEYRING_READ);
        let value = self
            .store
            .borrow()
            .get(&self.key(service, account))
            .cloned();
        match value {
            Some(value) if value.trim().is_empty() => Ok(None),
            Some(value) => Ok(Some(value)),
            None => Ok(None),
        }
    }

    fn delete_credential(&self, service: &str, account: &str) -> Result<(), String> {
        self.bump(EFFECT_KEYRING_ENTRY);
        self.bump(EFFECT_KEYRING_DELETE);
        self.store.borrow_mut().remove(&self.key(service, account));
        Ok(())
    }
}

#[cfg(test)]
std::thread_local! {
    static TEST_SINK: std::cell::RefCell<Option<std::rc::Rc<CountingCredentialStore>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn sink() -> std::rc::Rc<CountingCredentialStore> {
    TEST_SINK
        .with(|slot| slot.borrow().clone())
        .expect("test credential sink not installed")
}

#[cfg(test)]
fn install_counting_sink() -> std::rc::Rc<CountingCredentialStore> {
    let sink = std::rc::Rc::new(CountingCredentialStore::default());
    TEST_SINK.with(|slot| *slot.borrow_mut() = Some(sink.clone()));
    sink
}

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

#[tauri::command]
pub fn credential_set(provider: String, key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return credential_delete(provider);
    }
    ensure_effect_allowed(EFFECT_KEYRING_ENTRY)?;
    ensure_effect_allowed(EFFECT_KEYRING_SET)?;
    let account = account_for(&provider)?;
    sink().set_password(SERVICE, &account, trimmed)
}

#[tauri::command]
pub fn credential_get(provider: String) -> Result<Option<String>, String> {
    ensure_effect_allowed(EFFECT_KEYRING_ENTRY)?;
    ensure_effect_allowed(EFFECT_KEYRING_READ)?;
    let account = account_for(&provider)?;
    sink().get_password(SERVICE, &account)
}

#[tauri::command]
pub fn credential_delete(provider: String) -> Result<(), String> {
    ensure_effect_allowed(EFFECT_KEYRING_ENTRY)?;
    ensure_effect_allowed(EFFECT_KEYRING_DELETE)?;
    let account = account_for(&provider)?;
    sink().delete_credential(SERVICE, &account)
}

pub(crate) fn harness_api_keys() -> Result<Vec<(String, String)>, String> {
    let mut keys = Vec::new();
    for provider in HARNESS_API_KEY_PROVIDERS {
        ensure_effect_allowed(EFFECT_KEYRING_ENTRY)?;
        ensure_effect_allowed(EFFECT_KEYRING_READ)?;
        let account = account_for(provider)?;
        let Some(value) = sink().get_password(SERVICE, &account)? else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.len() > MAX_HARNESS_CREDENTIAL_BYTES {
            return Err("credential is too large for the OpenCode child environment".to_string());
        }
        keys.push((provider.to_string(), value.to_string()));
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VISUAL_TEST_PROFILE: &str = "monochrome-visual-test";

    fn ordinary_guard() -> impl Fn(&'static str) -> Result<(), String> {
        |_effect| Ok(())
    }

    fn visual_test_guard() -> impl Fn(&'static str) -> Result<(), String> {
        |effect| {
            if effect == EFFECT_KEYRING_ENTRY {
                Ok(())
            } else {
                Err(format!(
                    "privileged effect '{effect}' is disabled by the {VISUAL_TEST_PROFILE} runtime profile"
                ))
            }
        }
    }

    #[test]
    fn ordinary_mode_set_then_get_preserves_behavior_and_invokes_seam() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();

        assert_eq!(
            credential_set("OpenAI".into(), "  sk-test  ".into()),
            Ok(())
        );
        assert_eq!(
            credential_get("openai".into()),
            Ok(Some("sk-test".to_string()))
        );

        assert_eq!(sink.count(EFFECT_KEYRING_SET), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_READ), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_ENTRY), 2);
        assert_eq!(sink.count(EFFECT_KEYRING_DELETE), 0);
    }

    #[test]
    fn ordinary_mode_delete_removes_and_invokes_seam() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();

        assert_eq!(credential_set("openai".into(), "sk-test".into()), Ok(()));
        assert_eq!(credential_delete("openai".into()), Ok(()));
        assert_eq!(credential_get("openai".into()), Ok(None));

        assert_eq!(sink.count(EFFECT_KEYRING_DELETE), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_SET), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_READ), 1);
    }

    #[test]
    fn harness_snapshot_tracks_add_update_and_delete_without_logging_values() {
        install_test_guard(ordinary_guard());
        let _sink = install_counting_sink();

        assert_eq!(
            credential_set("openai".into(), "first-secret".into()),
            Ok(())
        );
        let first = harness_api_keys().unwrap();
        assert!(first
            .iter()
            .any(|(provider, key)| { provider == "openai" && key == "first-secret" }));

        assert_eq!(
            credential_set("openai".into(), "second-secret".into()),
            Ok(())
        );
        let second = harness_api_keys().unwrap();
        assert!(second
            .iter()
            .any(|(provider, key)| { provider == "openai" && key == "second-secret" }));
        assert!(!second.iter().any(|(_, key)| key == "first-secret"));

        assert_eq!(credential_delete("openai".into()), Ok(()));
        assert!(!harness_api_keys()
            .unwrap()
            .iter()
            .any(|(provider, _)| provider == "openai"));
    }

    #[test]
    fn ordinary_mode_empty_key_delegates_to_delete_seam() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();

        assert_eq!(credential_set("openai".into(), "   ".into()), Ok(()));

        assert_eq!(sink.count(EFFECT_KEYRING_DELETE), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_SET), 0);
    }

    #[test]
    fn visual_test_mode_denies_set_before_any_effect() {
        install_test_guard(visual_test_guard());
        let sink = install_counting_sink();

        let message = credential_set("openai".into(), "sk-test".into())
            .expect_err("visual-test mode must deny credential set");
        assert!(
            message.contains(VISUAL_TEST_PROFILE),
            "stable named-profile denial: {message}"
        );
        assert!(message.contains(EFFECT_KEYRING_SET));
        assert_eq!(
            sink.total(),
            0,
            "denial must precede every credential effect"
        );
    }

    #[test]
    fn keyring_entry_denial_precedes_set_adapter() {
        install_test_guard(|effect| {
            if effect == EFFECT_KEYRING_ENTRY {
                Err(format!("privileged effect '{effect}' denied"))
            } else {
                Ok(())
            }
        });
        let sink = install_counting_sink();

        let message = credential_set("openai".into(), "sk-test".into())
            .expect_err("entry boundary denial must stop credential set");

        assert!(message.contains(EFFECT_KEYRING_ENTRY));
        assert_eq!(
            sink.total(),
            0,
            "entry denial must precede the credential adapter"
        );
    }

    #[test]
    fn visual_test_mode_denies_get_before_any_effect() {
        install_test_guard(visual_test_guard());
        let sink = install_counting_sink();

        let message =
            credential_get("openai".into()).expect_err("visual-test mode must deny credential get");
        assert!(message.contains(VISUAL_TEST_PROFILE));
        assert!(message.contains(EFFECT_KEYRING_READ));
        assert_eq!(sink.total(), 0);
    }

    #[test]
    fn visual_test_mode_denies_delete_before_any_effect() {
        install_test_guard(visual_test_guard());
        let sink = install_counting_sink();

        let message = credential_delete("openai".into())
            .expect_err("visual-test mode must deny credential delete");
        assert!(message.contains(VISUAL_TEST_PROFILE));
        assert!(message.contains(EFFECT_KEYRING_DELETE));
        assert_eq!(sink.total(), 0);
    }

    #[test]
    fn unknown_profile_value_fails_closed_before_effects() {
        // No guard installed mirrors an unknown/unresolved profile: fail closed.
        clear_test_guard();
        let sink = install_counting_sink();

        let message = credential_set("openai".into(), "sk-test".into())
            .expect_err("unknown profile must fail closed");
        assert!(message.contains("fail closed"));
        assert_eq!(sink.total(), 0);
    }

    #[test]
    fn guard_precedes_keyring_entry_construction() {
        install_test_guard(visual_test_guard());
        let sink = install_counting_sink();

        assert!(credential_get("openai".into()).is_err());
        assert_eq!(
            sink.count(EFFECT_KEYRING_ENTRY),
            0,
            "guard must run before keyring Entry construction"
        );
    }

    #[test]
    fn account_validation_still_rejects_invalid_provider_in_ordinary_mode() {
        install_test_guard(ordinary_guard());
        let sink = install_counting_sink();

        assert!(credential_get("bad provider!".into()).is_err());
        assert_eq!(
            sink.total(),
            0,
            "invalid provider must not reach the effect seam"
        );
    }

    // -----------------------------------------------------------------
    // End-to-end integration through the real task-114 named-profile guard.
    //
    // These delegate the injectable hook to the actual crate-visible
    // `crate::runtime_profile::ensure_privileged_effect_allowed` so the whole
    // command -> guard -> effect-seam path is proven against the production
    // contract. The profile is selected via `VIBESPACE_RUNTIME_PROFILE`; the
    // manipulation is serialized and always reset so parallel tests stay isolated.
    // -----------------------------------------------------------------

    fn with_profile<F: FnOnce()>(value: Option<&str>, f: F) {
        let _environment = crate::runtime_profile::test_runtime_environment(
            value.map(std::ffi::OsString::from),
            None,
        );
        f();
    }

    fn real_guard() -> impl Fn(&'static str) -> Result<(), String> {
        |effect| {
            crate::runtime_profile::ensure_privileged_effect_allowed(
                crate::runtime_profile::DENIED_EFFECT_KEYCHAIN,
                effect,
            )
        }
    }

    #[test]
    fn real_guard_ordinary_mode_preserves_behavior_end_to_end() {
        install_test_guard(real_guard());
        let sink = install_counting_sink();
        with_profile(None, || {
            assert_eq!(credential_set("openai".into(), "sk-real".into()), Ok(()));
            assert_eq!(
                credential_get("openai".into()),
                Ok(Some("sk-real".to_string()))
            );
        });
        assert_eq!(sink.count(EFFECT_KEYRING_SET), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_READ), 1);
        assert_eq!(sink.count(EFFECT_KEYRING_ENTRY), 2);
    }

    #[test]
    fn real_guard_visual_test_mode_denies_before_effects_end_to_end() {
        install_test_guard(real_guard());
        let sink = install_counting_sink();
        with_profile(Some(crate::runtime_profile::MONOCHROME_VISUAL_TEST), || {
            let message = credential_set("openai".into(), "sk".into())
                .expect_err("visual-test profile must deny credential set");
            assert!(
                message.contains("monochrome-visual-test"),
                "stable named-profile denial: {message}"
            );
        });
        assert_eq!(sink.total(), 0, "real guard must deny before any effect");
    }

    #[test]
    fn real_guard_unknown_profile_fails_closed_end_to_end() {
        install_test_guard(real_guard());
        let sink = install_counting_sink();
        with_profile(Some("not-a-real-profile"), || {
            let message =
                credential_get("openai".into()).expect_err("unknown profile must fail closed");
            assert!(
                message.contains("profile resolution failed") || message.contains("denied"),
                "fail-closed denial: {message}"
            );
        });
        assert_eq!(
            sink.total(),
            0,
            "unknown profile must fail closed before effects"
        );
    }
}
