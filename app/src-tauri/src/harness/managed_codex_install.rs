use crate::cli_bridge::CliBridgeState;
use crate::harness::managed_cli_manifest::{embedded_managed_release, ManagedCliKind};
use crate::harness::managed_cli_runtime::{inspect_managed_runtime, ManagedCliReadiness};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_NAME: &str = "vibespace://managed-codex-install-state";
const RUNTIME_DETECTION_TIMEOUT: Duration = Duration::from_secs(30);

type DetectionResult = Result<ManagedCodexRuntimeDetection, String>;

struct DetectionFlight {
    result: tokio::sync::watch::Receiver<Option<DetectionResult>>,
}

// Several renderer windows can ask for readiness at startup. Share one
// in-progress verification and its result across all windows. The verifier
// remains the authority for every result; no cached readiness is used for CLI
// execution or executable registration.
static RUNTIME_DETECTION_FLIGHT: OnceLock<Mutex<Option<Arc<DetectionFlight>>>> = OnceLock::new();

#[derive(Default)]
pub struct ManagedCodexInstallState {
    active: Mutex<Option<Arc<AtomicBool>>>,
}

struct InstallLease<'a> {
    state: &'a ManagedCodexInstallState,
    cancellation: Arc<AtomicBool>,
}

impl ManagedCodexInstallState {
    fn begin(&self) -> Result<InstallLease<'_>, &'static str> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Managed Codex installer state is unavailable.")?;
        if active.is_some() {
            return Err("Managed Codex installation is already running.");
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        *active = Some(cancellation.clone());
        Ok(InstallLease {
            state: self,
            cancellation,
        })
    }

    fn cancel(&self) -> Result<bool, &'static str> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Managed Codex installer state is unavailable.")?;
        if let Some(cancellation) = active.as_ref() {
            cancellation.store(true, Ordering::Release);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

impl Drop for InstallLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.active.lock() {
            if active
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, &self.cancellation))
            {
                *active = None;
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ManagedCodexRuntimeDetection {
    Missing,
    Incomplete {
        reason: &'static str,
    },
    Ready {
        codex_version: String,
        open_codex_version: String,
        executable_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum InstallComponent {
    Codex,
    OpenCodex,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum InstallEvent {
    Connecting {
        component: InstallComponent,
    },
    Installing {
        component: InstallComponent,
        progress: f64,
    },
    Ready {
        codex_version: String,
        open_codex_version: String,
        executable_id: String,
    },
    Failed {
        recoverable: bool,
        message: &'static str,
    },
}

fn managed_base(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "VibeSpace managed runtime storage is unavailable.".to_string())?;
    crate::harness::managed_codex_storage::storage_root(&app_data)
        .map(|root| root.join("managed-runtime"))
}

fn inspect_and_register(
    managed_base: &Path,
    cli: &CliBridgeState,
) -> Result<ManagedCodexRuntimeDetection, String> {
    let codex_release = embedded_managed_release(ManagedCliKind::Codex, "windows", "x86_64")
        .map_err(|_| "Managed Codex release authority is unavailable.".to_string())?;
    let opencodex_release =
        embedded_managed_release(ManagedCliKind::OpenCodex, "windows", "x86_64")
            .map_err(|_| "Managed OpenCodex release authority is unavailable.".to_string())?;
    let codex = inspect_managed_runtime(&managed_base.join("codex"), &codex_release);
    let opencodex = inspect_managed_runtime(&managed_base.join("opencodex"), &opencodex_release);
    let codex_launch = match codex {
        ManagedCliReadiness::Ready { launch } => launch,
        ManagedCliReadiness::Missing => return Ok(ManagedCodexRuntimeDetection::Missing),
        ManagedCliReadiness::Incomplete { reason } => {
            return Ok(ManagedCodexRuntimeDetection::Incomplete { reason })
        }
        ManagedCliReadiness::ProbeRequired { .. } => {
            return Ok(ManagedCodexRuntimeDetection::Incomplete {
                reason: "Managed Codex requires unsupported probing.",
            })
        }
    };
    match opencodex {
        ManagedCliReadiness::ProbeRequired { .. } | ManagedCliReadiness::Ready { .. } => {}
        ManagedCliReadiness::Missing => return Ok(ManagedCodexRuntimeDetection::Missing),
        ManagedCliReadiness::Incomplete { reason } => {
            return Ok(ManagedCodexRuntimeDetection::Incomplete { reason })
        }
    }
    let canonical = std::fs::canonicalize(codex_launch.executable)
        .map_err(|_| "Verified managed Codex executable is unavailable.".to_string())?;
    let executable = cli.register_trusted_executable(canonical, Some("codex".to_string()))?;
    Ok(ManagedCodexRuntimeDetection::Ready {
        codex_version: codex_release.version,
        open_codex_version: opencodex_release.version,
        executable_id: executable.executable_id,
    })
}

fn emit(app: &AppHandle, event: InstallEvent) {
    let _ = app.emit(EVENT_NAME, event);
}

fn clear_detection_flight(flight: &Arc<DetectionFlight>) {
    if let Ok(mut active) = RUNTIME_DETECTION_FLIGHT
        .get_or_init(|| Mutex::new(None))
        .lock()
    {
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            *active = None;
        }
    }
}

struct DetectionFlightCleanup(Arc<DetectionFlight>);

impl Drop for DetectionFlightCleanup {
    fn drop(&mut self) {
        clear_detection_flight(&self.0);
    }
}

fn start_or_join_detection(app: AppHandle) -> Result<Arc<DetectionFlight>, String> {
    let flights = RUNTIME_DETECTION_FLIGHT.get_or_init(|| Mutex::new(None));
    let mut active = flights
        .lock()
        .map_err(|_| "Managed Codex detection state is unavailable.".to_string())?;
    if let Some(flight) = active.as_ref() {
        return Ok(flight.clone());
    }

    let (sender, receiver) = tokio::sync::watch::channel(None);
    let flight = Arc::new(DetectionFlight { result: receiver });
    *active = Some(flight.clone());
    drop(active);

    let worker_app = app;
    let worker_flight = flight.clone();
    let _worker = tauri::async_runtime::spawn_blocking(move || {
        let _cleanup = DetectionFlightCleanup(worker_flight);
        let result: DetectionResult =
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let cli = worker_app.state::<CliBridgeState>();
                inspect_and_register(&managed_base(&worker_app)?, &cli)
            })) {
                Ok(result) => result,
                Err(_) => Err("Managed Codex detection worker panicked.".to_string()),
            };
        if let Ok(ManagedCodexRuntimeDetection::Ready {
            codex_version,
            open_codex_version,
            executable_id,
        }) = &result
        {
            emit(
                &worker_app,
                InstallEvent::Ready {
                    codex_version: codex_version.clone(),
                    open_codex_version: open_codex_version.clone(),
                    executable_id: executable_id.clone(),
                },
            );
        }
        let _ = sender.send(Some(result));
    });
    Ok(flight)
}

async fn await_detection(
    mut receiver: tokio::sync::watch::Receiver<Option<DetectionResult>>,
) -> DetectionResult {
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        receiver.changed().await.map_err(|_| {
            "Managed Codex detection worker ended before reporting readiness.".to_string()
        })?;
    }
}

#[tauri::command]
pub async fn managed_codex_runtime_detect(
    app: AppHandle,
) -> Result<ManagedCodexRuntimeDetection, String> {
    let flight = start_or_join_detection(app)?;
    tokio::time::timeout(
        RUNTIME_DETECTION_TIMEOUT,
        await_detection(flight.result.clone()),
    )
    .await
    .map_err(|_| {
        "Managed Codex detection timed out; runtime verification is still required.".to_string()
    })?
}

#[tauri::command]
pub async fn managed_codex_runtime_install(
    app: AppHandle,
    install_state: State<'_, ManagedCodexInstallState>,
    cli: State<'_, CliBridgeState>,
) -> Result<ManagedCodexRuntimeDetection, String> {
    let lease = install_state.begin().map_err(str::to_string)?;
    let cancellation = lease.cancellation.clone();
    let base = managed_base(&app)?;
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        emit(
            &worker_app,
            InstallEvent::Connecting {
                component: InstallComponent::Codex,
            },
        );
        crate::harness::managed_codex_materializer::download_and_install_embedded_codex(
            &base,
            &cancellation,
            |progress| {
                emit(
                    &worker_app,
                    InstallEvent::Installing {
                        component: InstallComponent::Codex,
                        progress: progress.clamp(0.0, 1.0),
                    },
                )
            },
        )
        .map_err(|failure| failure.message)?;
        emit(
            &worker_app,
            InstallEvent::Connecting {
                component: InstallComponent::OpenCodex,
            },
        );
        crate::harness::managed_opencodex_materializer::download_and_install_embedded_opencodex(
            &base,
            &cancellation,
            |progress| {
                emit(
                    &worker_app,
                    InstallEvent::Installing {
                        component: InstallComponent::OpenCodex,
                        progress: progress.clamp(0.0, 1.0),
                    },
                )
            },
        )
        .map_err(|failure| failure.message)?;
        Ok::<(), &'static str>(())
    })
    .await
    .map_err(|_| "Managed Codex installer worker failed.".to_string())?;
    drop(lease);
    if let Err(message) = result {
        emit(
            &app,
            InstallEvent::Failed {
                recoverable: true,
                message,
            },
        );
        return Err(message.to_string());
    }
    let detection = inspect_and_register(&managed_base(&app)?, &cli)?;
    let ManagedCodexRuntimeDetection::Ready {
        codex_version,
        open_codex_version,
        executable_id,
    } = &detection
    else {
        let message = "Installed Codex tools did not pass managed runtime verification.";
        emit(
            &app,
            InstallEvent::Failed {
                recoverable: true,
                message,
            },
        );
        return Err(message.to_string());
    };
    emit(
        &app,
        InstallEvent::Ready {
            codex_version: codex_version.clone(),
            open_codex_version: open_codex_version.clone(),
            executable_id: executable_id.clone(),
        },
    );
    Ok(detection)
}

#[tauri::command]
pub fn managed_codex_runtime_install_cancel(
    state: State<'_, ManagedCodexInstallState>,
) -> Result<bool, String> {
    state.cancel().map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        await_detection, DetectionFlight, DetectionFlightCleanup, DetectionResult,
        InstallComponent, InstallEvent, ManagedCodexInstallState, ManagedCodexRuntimeDetection,
        RUNTIME_DETECTION_FLIGHT,
    };
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn managed_detection_yields_the_ipc_handler_while_probing() {
        let source = include_str!("managed_codex_install.rs");
        let tests_start = source.find("#[cfg(test)]").expect("tests are bounded");
        let production = &source[..tests_start];
        let detect_start = production
            .find("pub async fn managed_codex_runtime_detect")
            .or_else(|| production.find("pub fn managed_codex_runtime_detect"))
            .expect("managed detection command exists");
        let install_start = production
            .find("pub async fn managed_codex_runtime_install")
            .expect("managed install command exists");
        let command = &production[detect_start..install_start];

        assert!(command.contains("pub async fn managed_codex_runtime_detect"));
        assert!(command.contains("start_or_join_detection"));
        assert!(command.contains("RUNTIME_DETECTION_TIMEOUT"));
        assert!(production.contains("tauri::async_runtime::spawn_blocking"));
        assert!(production.contains("tokio::sync::watch"));
        assert!(production.contains("Arc::ptr_eq"));
        assert!(production.contains("catch_unwind"));
        assert!(production.contains("InstallEvent::Ready"));
    }

    #[test]
    fn detection_waiters_share_completion_and_late_completion_survives_timeout() {
        let (sender, receiver) = tokio::sync::watch::channel(None::<DetectionResult>);
        let second_receiver = receiver.clone();
        let timed_out = tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_millis(1), await_detection(receiver)).await
        });
        assert!(
            timed_out.is_err(),
            "waiter should time out while work is pending"
        );

        sender
            .send(Some(Ok(ManagedCodexRuntimeDetection::Missing)))
            .expect("late worker completion should reach the shared result");
        let first = tauri::async_runtime::block_on(await_detection(second_receiver))
            .expect("shared result");
        assert_eq!(first, ManagedCodexRuntimeDetection::Missing);
    }

    #[test]
    fn detection_cleanup_releases_failed_flight_for_a_fresh_retry() {
        let (sender, receiver) = tokio::sync::watch::channel(None::<DetectionResult>);
        let flight = Arc::new(DetectionFlight { result: receiver });
        let receiver_for_failure = flight.result.clone();
        {
            let mut active = RUNTIME_DETECTION_FLIGHT
                .get_or_init(|| std::sync::Mutex::new(None))
                .lock()
                .expect("detection state");
            assert!(active.is_none(), "test flight must start empty");
            *active = Some(flight.clone());
        }
        drop(DetectionFlightCleanup(flight));
        assert!(RUNTIME_DETECTION_FLIGHT
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .expect("detection state")
            .is_none());
        drop(sender);
        let failed = tauri::async_runtime::block_on(await_detection(receiver_for_failure));
        assert!(failed.is_err());
    }

    #[test]
    fn install_state_is_single_flight_and_cancellable() {
        let state = ManagedCodexInstallState::default();
        let lease = state.begin().expect("first install");
        assert_eq!(
            state.begin().err(),
            Some("Managed Codex installation is already running.")
        );
        assert_eq!(state.cancel(), Ok(true));
        assert!(lease.cancellation.load(Ordering::Acquire));
        drop(lease);
        assert_eq!(state.cancel(), Ok(false));
        assert!(state.begin().is_ok());
    }

    #[test]
    fn renderer_contract_is_camel_case_and_contains_no_paths() {
        let ready = serde_json::to_value(ManagedCodexRuntimeDetection::Ready {
            codex_version: "0.151.0".to_string(),
            open_codex_version: "5.0.0".to_string(),
            executable_id: "cli-executable-test".to_string(),
        })
        .expect("serialize readiness");
        assert_eq!(ready["status"], "ready");
        assert_eq!(ready["codexVersion"], "0.151.0");
        assert_eq!(ready["openCodexVersion"], "5.0.0");
        assert_eq!(ready["executableId"], "cli-executable-test");
        assert!(ready.get("executablePath").is_none());

        let connecting = serde_json::to_value(InstallEvent::Connecting {
            component: InstallComponent::Codex,
        })
        .expect("serialize connection state");
        assert_eq!(connecting["kind"], "connecting");
        assert_eq!(connecting["component"], "codex");

        let progress = serde_json::to_value(InstallEvent::Installing {
            component: InstallComponent::OpenCodex,
            progress: 0.5,
        })
        .expect("serialize progress");
        assert_eq!(progress["component"], "opencodex");
        assert_eq!(progress["progress"], 0.5);
    }
}
