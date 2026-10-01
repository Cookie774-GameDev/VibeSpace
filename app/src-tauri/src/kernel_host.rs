use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

const HOST_LABEL: &str = "main";
const HOST_REQUEST_EVENT: &str = "jarvis:kernel-host-request-v1";
const CLIENT_RESPONSE_EVENT: &str = "jarvis:kernel-client-response-v1";
const MIN_TIMEOUT_MS: u64 = 25;
const MAX_TIMEOUT_MS: u64 = 60_000;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KernelRequestKind {
    TurnDispatch,
    ApprovalCreate,
    ApprovalPresent,
    ApprovalDecide,
    ApprovalExecute,
    Cancel,
    ScheduledRetry,
    CommandCenterSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum KernelClientRequestV1 {
    TurnDispatch {
        version: u8,
        account_id: String,
        chat_id: String,
        user_message_id: String,
    },
    ApprovalCreate {
        version: u8,
        account_id: String,
        run_id: String,
        action_request_id: String,
    },
    ApprovalPresent {
        version: u8,
        account_id: String,
        approval_id: String,
    },
    ApprovalDecide {
        version: u8,
        account_id: String,
        approval_id: String,
        decision: ApprovalDecision,
    },
    ApprovalExecute {
        version: u8,
        account_id: String,
        approval_id: String,
    },
    Cancel {
        version: u8,
        account_id: String,
        run_id: String,
    },
    ScheduledRetry {
        version: u8,
        account_id: String,
        run_id: String,
        attempt_id: String,
    },
    CommandCenterSnapshot {
        version: u8,
        account_id: String,
    },
}

impl KernelClientRequestV1 {
    fn kind(&self) -> KernelRequestKind {
        match self {
            Self::TurnDispatch { .. } => KernelRequestKind::TurnDispatch,
            Self::ApprovalCreate { .. } => KernelRequestKind::ApprovalCreate,
            Self::ApprovalPresent { .. } => KernelRequestKind::ApprovalPresent,
            Self::ApprovalDecide { .. } => KernelRequestKind::ApprovalDecide,
            Self::ApprovalExecute { .. } => KernelRequestKind::ApprovalExecute,
            Self::Cancel { .. } => KernelRequestKind::Cancel,
            Self::ScheduledRetry { .. } => KernelRequestKind::ScheduledRetry,
            Self::CommandCenterSnapshot { .. } => KernelRequestKind::CommandCenterSnapshot,
        }
    }

    fn validate(&self) -> Result<(), &'static str> {
        let valid = match self {
            Self::TurnDispatch {
                version,
                account_id,
                chat_id,
                user_message_id,
            } => {
                *version == 1
                    && bounded_id(account_id)
                    && bounded_id(chat_id)
                    && bounded_id(user_message_id)
            }
            Self::ApprovalCreate {
                version,
                account_id,
                run_id,
                action_request_id,
            } => {
                *version == 1
                    && bounded_id(account_id)
                    && bounded_id(run_id)
                    && bounded_id(action_request_id)
            }
            Self::ApprovalPresent {
                version,
                account_id,
                approval_id,
            }
            | Self::ApprovalDecide {
                version,
                account_id,
                approval_id,
                ..
            }
            | Self::ApprovalExecute {
                version,
                account_id,
                approval_id,
            } => *version == 1 && bounded_id(account_id) && bounded_id(approval_id),
            Self::Cancel {
                version,
                account_id,
                run_id,
            } => *version == 1 && bounded_id(account_id) && bounded_id(run_id),
            Self::ScheduledRetry {
                version,
                account_id,
                run_id,
                attempt_id,
            } => {
                *version == 1
                    && bounded_id(account_id)
                    && bounded_id(run_id)
                    && bounded_id(attempt_id)
            }
            Self::CommandCenterSnapshot {
                version,
                account_id,
            } => *version == 1 && bounded_id(account_id),
        };
        valid.then_some(()).ok_or("kernel_request_invalid")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalStatus {
    Approved,
    Denied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalExecutionStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalRisk {
    Safe,
    Confirm,
    Dangerous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalPresentationParameter {
    field: String,
    safe_value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CancellationDeliveryState {
    Delivered,
    HandoffPending,
    NotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RetryState {
    Queued,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KernelRunStatus {
    Queued,
    Running,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRunSummary {
    run_id: String,
    status: KernelRunStatus,
    has_active_evidence: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KernelUnavailableReason {
    HostUnavailable,
    HostReleased,
    RequestTimedOut,
    ClientDisposed,
    InvalidResponse,
    KernelNotActivated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum KernelClientResponseV1 {
    TurnAccepted {
        version: u8,
        run_id: String,
    },
    ApprovalCreated {
        version: u8,
        approval_id: String,
    },
    ApprovalPresentation {
        version: u8,
        approval_id: String,
        action_id: String,
        expected_effect: String,
        risk: ApprovalRisk,
        parameters: Vec<ApprovalPresentationParameter>,
    },
    ApprovalDecided {
        version: u8,
        approval_id: String,
        status: ApprovalStatus,
    },
    ApprovalExecution {
        version: u8,
        approval_id: String,
        run_id: String,
        status: ApprovalExecutionStatus,
    },
    CancellationState {
        version: u8,
        run_id: String,
        state: CancellationDeliveryState,
    },
    RetryState {
        version: u8,
        run_id: String,
        state: RetryState,
    },
    CommandCenterSnapshot {
        version: u8,
        account_id: String,
        runs: Vec<KernelRunSummary>,
    },
    Unavailable {
        version: u8,
        request_kind: KernelRequestKind,
        reason: KernelUnavailableReason,
    },
}

impl KernelClientResponseV1 {
    fn kind(&self) -> Option<KernelRequestKind> {
        match self {
            Self::TurnAccepted { .. } => Some(KernelRequestKind::TurnDispatch),
            Self::ApprovalCreated { .. } => Some(KernelRequestKind::ApprovalCreate),
            Self::ApprovalPresentation { .. } => Some(KernelRequestKind::ApprovalPresent),
            Self::ApprovalDecided { .. } => Some(KernelRequestKind::ApprovalDecide),
            Self::ApprovalExecution { .. } => Some(KernelRequestKind::ApprovalExecute),
            Self::CancellationState { .. } => Some(KernelRequestKind::Cancel),
            Self::RetryState { .. } => Some(KernelRequestKind::ScheduledRetry),
            Self::CommandCenterSnapshot { .. } => Some(KernelRequestKind::CommandCenterSnapshot),
            Self::Unavailable { request_kind, .. } => Some(*request_kind),
        }
    }

    fn validate(&self) -> Result<(), &'static str> {
        let valid = match self {
            Self::TurnAccepted { version, run_id }
            | Self::CancellationState {
                version, run_id, ..
            }
            | Self::RetryState {
                version, run_id, ..
            } => *version == 1 && bounded_id(run_id),
            Self::ApprovalCreated {
                version,
                approval_id,
            }
            | Self::ApprovalDecided {
                version,
                approval_id,
                ..
            } => *version == 1 && bounded_id(approval_id),
            Self::ApprovalPresentation {
                version,
                approval_id,
                action_id,
                expected_effect,
                parameters,
                ..
            } => {
                *version == 1
                    && bounded_id(approval_id)
                    && nonblank(action_id)
                    && action_id.len() <= 128
                    && nonblank(expected_effect)
                    && expected_effect.len() <= 512
                    && parameters.len() <= 32
                    && parameters.iter().all(|parameter| {
                        nonblank(&parameter.field)
                            && parameter.field.len() <= 128
                            && parameter.safe_value.len() <= 160
                    })
            }
            Self::ApprovalExecution {
                version,
                approval_id,
                run_id,
                ..
            } => *version == 1 && bounded_id(approval_id) && bounded_id(run_id),
            Self::CommandCenterSnapshot {
                version,
                account_id,
                runs,
            } => {
                *version == 1
                    && bounded_id(account_id)
                    && runs.len() <= 1_000
                    && runs.iter().all(|run| bounded_id(&run.run_id))
            }
            Self::Unavailable { version, .. } => *version == 1,
        };
        valid.then_some(()).ok_or("kernel_response_invalid")
    }

    fn matches_request(&self, request: &KernelClientRequestV1) -> bool {
        if self.kind() != Some(request.kind()) {
            return false;
        }
        match (request, self) {
            (
                KernelClientRequestV1::ApprovalPresent { approval_id, .. },
                Self::ApprovalPresentation {
                    approval_id: response_approval_id,
                    ..
                },
            )
            | (
                KernelClientRequestV1::ApprovalDecide { approval_id, .. },
                Self::ApprovalDecided {
                    approval_id: response_approval_id,
                    ..
                },
            )
            | (
                KernelClientRequestV1::ApprovalExecute { approval_id, .. },
                Self::ApprovalExecution {
                    approval_id: response_approval_id,
                    ..
                },
            ) => approval_id == response_approval_id,
            (
                KernelClientRequestV1::Cancel { run_id, .. },
                Self::CancellationState {
                    run_id: response_run_id,
                    ..
                },
            )
            | (
                KernelClientRequestV1::ScheduledRetry { run_id, .. },
                Self::RetryState {
                    run_id: response_run_id,
                    ..
                },
            ) => run_id == response_run_id,
            (
                KernelClientRequestV1::CommandCenterSnapshot { account_id, .. },
                Self::CommandCenterSnapshot {
                    account_id: response_account_id,
                    ..
                },
            ) => account_id == response_account_id,
            (_, Self::Unavailable { .. })
            | (KernelClientRequestV1::TurnDispatch { .. }, Self::TurnAccepted { .. })
            | (KernelClientRequestV1::ApprovalCreate { .. }, Self::ApprovalCreated { .. }) => true,
            _ => false,
        }
    }
}

fn nonblank(value: &str) -> bool {
    !value.trim().is_empty()
}

fn bounded_id(value: &str) -> bool {
    nonblank(value) && value.len() <= 512
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelHostRegistration {
    epoch: u64,
    owner_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KernelClientRequestRegistration {
    epoch: u64,
    request_id: String,
    deadline_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelHostRequestEvent {
    epoch: u64,
    request_id: String,
    request: KernelClientRequestV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelClientResponseEvent {
    epoch: u64,
    request_id: String,
    response: KernelClientResponseV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnerCapture {
    label: String,
    process_id: u32,
    window_identity: u64,
    epoch: u64,
    token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostClaim {
    registration: KernelHostRegistration,
    destroy_capture: OwnerCapture,
}

#[derive(Debug)]
struct ReloadedHostClaim {
    claim: HostClaim,
    released: Vec<ClientDelivery>,
}

#[derive(Debug, Clone)]
struct Owner {
    capture: OwnerCapture,
}

#[derive(Debug, Clone)]
struct PendingRequest {
    requester_label: String,
    epoch: u64,
    deadline_ms: u64,
    request: KernelClientRequestV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HostDispatch {
    host_label: String,
    registration: KernelClientRequestRegistration,
    event: KernelHostRequestEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClientDelivery {
    requester_label: String,
    event: KernelClientResponseEvent,
}

#[derive(Debug, Default)]
struct KernelHostBroker {
    epoch: u64,
    next_window_identity: u64,
    owner: Option<Owner>,
    pending: HashMap<String, PendingRequest>,
}

impl KernelHostBroker {
    fn bump_epoch(&mut self) -> Result<u64, &'static str> {
        self.epoch = self
            .epoch
            .checked_add(1)
            .ok_or("kernel_host_epoch_exhausted")?;
        Ok(self.epoch)
    }

    fn claim(&mut self, label: &str, token: String) -> Result<HostClaim, &'static str> {
        if label != HOST_LABEL {
            return Err("kernel_host_wrong_window");
        }
        if !nonblank(&token) {
            return Err("kernel_host_token_invalid");
        }
        let epoch = self.bump_epoch()?;
        self.next_window_identity = self
            .next_window_identity
            .checked_add(1)
            .ok_or("kernel_host_identity_exhausted")?;
        let capture = OwnerCapture {
            label: label.to_string(),
            process_id: std::process::id(),
            window_identity: self.next_window_identity,
            epoch,
            token: token.clone(),
        };
        self.owner = Some(Owner {
            capture: capture.clone(),
        });
        Ok(HostClaim {
            registration: KernelHostRegistration {
                epoch,
                owner_token: token,
            },
            destroy_capture: capture,
        })
    }

    #[cfg(test)]
    fn register(&mut self, label: &str, token: String) -> Result<HostClaim, &'static str> {
        if self.owner.is_some() {
            return Err("kernel_host_already_registered");
        }
        self.claim(label, token)
    }

    fn register_reloaded_main(
        &mut self,
        label: &str,
        token: String,
    ) -> Result<ReloadedHostClaim, &'static str> {
        if label != HOST_LABEL {
            return Err("kernel_host_wrong_window");
        }
        if !nonblank(&token) {
            return Err("kernel_host_token_invalid");
        }
        let previous_epoch = self.owner.as_ref().map(|owner| owner.capture.epoch);
        let claim = self.claim(label, token)?;
        let released = previous_epoch
            .map(|epoch| self.drain_epoch(epoch, KernelUnavailableReason::HostReleased))
            .unwrap_or_default();
        Ok(ReloadedHostClaim { claim, released })
    }

    #[cfg(test)]
    fn owner_epoch(&self) -> Option<u64> {
        self.owner.as_ref().map(|owner| owner.capture.epoch)
    }

    fn request(
        &mut self,
        requester_label: &str,
        request: KernelClientRequestV1,
        now_ms: u64,
        timeout_ms: u64,
    ) -> Result<HostDispatch, &'static str> {
        request.validate()?;
        if !eligible_client_label(requester_label) {
            return Err("kernel_client_window_rejected");
        }
        let owner = self.owner.as_ref().ok_or("kernel_host_unavailable")?;
        let host_label = owner.capture.label.clone();
        let epoch = owner.capture.epoch;
        let request_id = loop {
            let candidate = format!("kreq-{epoch}-{}", nanoid::nanoid!(32));
            if !self.pending.contains_key(&candidate) {
                break candidate;
            }
        };
        let deadline_ms = now_ms.saturating_add(timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
        self.pending.insert(
            request_id.clone(),
            PendingRequest {
                requester_label: requester_label.to_string(),
                epoch,
                deadline_ms,
                request: request.clone(),
            },
        );
        Ok(HostDispatch {
            host_label,
            registration: KernelClientRequestRegistration {
                epoch,
                request_id: request_id.clone(),
                deadline_ms,
            },
            event: KernelHostRequestEvent {
                epoch,
                request_id,
                request,
            },
        })
    }

    fn respond(
        &mut self,
        label: &str,
        epoch: u64,
        token: &str,
        request_id: &str,
        response: KernelClientResponseV1,
        now_ms: u64,
    ) -> Result<ClientDelivery, &'static str> {
        self.validate_owner(label, epoch, token)?;
        response.validate()?;
        let pending = self
            .pending
            .get(request_id)
            .ok_or("kernel_request_missing")?;
        if pending.epoch != epoch {
            return Err("kernel_request_stale_epoch");
        }
        if now_ms >= pending.deadline_ms {
            self.pending.remove(request_id);
            return Err("kernel_request_timed_out");
        }
        if !response.matches_request(&pending.request) {
            return Err("kernel_response_kind_mismatch");
        }
        let pending = self
            .pending
            .remove(request_id)
            .expect("pending request exists");
        Ok(ClientDelivery {
            requester_label: pending.requester_label,
            event: KernelClientResponseEvent {
                epoch,
                request_id: request_id.to_string(),
                response,
            },
        })
    }

    fn expire(&mut self, epoch: u64, request_id: &str, now_ms: u64) -> Option<ClientDelivery> {
        let pending = self.pending.get(request_id)?;
        if pending.epoch != epoch || now_ms < pending.deadline_ms {
            return None;
        }
        let pending = self.pending.remove(request_id)?;
        Some(unavailable_delivery(
            request_id,
            pending,
            KernelUnavailableReason::RequestTimedOut,
        ))
    }

    fn abandon(&mut self, epoch: u64, request_id: &str) {
        if self
            .pending
            .get(request_id)
            .is_some_and(|pending| pending.epoch == epoch)
        {
            self.pending.remove(request_id);
        }
    }

    fn release(
        &mut self,
        label: &str,
        epoch: u64,
        token: &str,
    ) -> Result<Vec<ClientDelivery>, &'static str> {
        self.validate_owner(label, epoch, token)?;
        self.owner = None;
        self.bump_epoch()?;
        Ok(self.drain_epoch(epoch, KernelUnavailableReason::HostReleased))
    }

    fn destroyed(&mut self, capture: &OwnerCapture) -> Vec<ClientDelivery> {
        let matches = self.owner.as_ref().is_some_and(|owner| {
            owner.capture.label == capture.label
                && owner.capture.process_id == capture.process_id
                && owner.capture.window_identity == capture.window_identity
                && owner.capture.epoch == capture.epoch
                && owner.capture.token == capture.token
        });
        if !matches {
            return Vec::new();
        }
        self.owner = None;
        let _ = self.bump_epoch();
        self.drain_epoch(capture.epoch, KernelUnavailableReason::HostReleased)
    }

    fn shutdown(&mut self) -> Vec<ClientDelivery> {
        let Some(owner) = self.owner.take() else {
            return Vec::new();
        };
        let _ = self.bump_epoch();
        self.drain_epoch(owner.capture.epoch, KernelUnavailableReason::HostReleased)
    }

    fn validate_owner(&self, label: &str, epoch: u64, token: &str) -> Result<(), &'static str> {
        let owner = self.owner.as_ref().ok_or("kernel_host_unavailable")?;
        if label != HOST_LABEL || owner.capture.label != label {
            return Err("kernel_host_wrong_window");
        }
        if owner.capture.process_id != std::process::id()
            || owner.capture.epoch != epoch
            || owner.capture.token != token
        {
            return Err("kernel_host_stale_owner");
        }
        Ok(())
    }

    fn drain_epoch(&mut self, epoch: u64, reason: KernelUnavailableReason) -> Vec<ClientDelivery> {
        let request_ids: Vec<String> = self
            .pending
            .iter()
            .filter_map(|(request_id, pending)| {
                (pending.epoch == epoch).then_some(request_id.clone())
            })
            .collect();
        request_ids
            .into_iter()
            .filter_map(|request_id| {
                self.pending
                    .remove(&request_id)
                    .map(|pending| unavailable_delivery(&request_id, pending, reason))
            })
            .collect()
    }
}

fn eligible_client_label(label: &str) -> bool {
    nonblank(label)
        && label != HOST_LABEL
        && label != "dictation"
        && !label.starts_with("pet-")
        && !label.starts_with("preview-")
}

fn unavailable_delivery(
    request_id: &str,
    pending: PendingRequest,
    reason: KernelUnavailableReason,
) -> ClientDelivery {
    ClientDelivery {
        requester_label: pending.requester_label,
        event: KernelClientResponseEvent {
            epoch: pending.epoch,
            request_id: request_id.to_string(),
            response: KernelClientResponseV1::Unavailable {
                version: 1,
                request_kind: pending.request.kind(),
                reason,
            },
        },
    }
}

#[derive(Debug, Default)]
pub struct KernelHostState(Mutex<KernelHostBroker>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn with_broker<T>(
    state: &KernelHostState,
    operation: impl FnOnce(&mut KernelHostBroker) -> Result<T, &'static str>,
) -> Result<T, String> {
    let mut broker = state
        .0
        .lock()
        .map_err(|_| "kernel_host_state_unavailable".to_string())?;
    operation(&mut broker).map_err(str::to_string)
}

fn emit_delivery(app: &AppHandle, delivery: ClientDelivery) {
    if let Some(requester) = app.get_webview_window(&delivery.requester_label) {
        let _ = requester.emit(CLIENT_RESPONSE_EVENT, delivery.event);
    }
}

fn expire_pending(app: &AppHandle, epoch: u64, request_id: &str) {
    let delivery = app
        .state::<KernelHostState>()
        .0
        .lock()
        .ok()
        .and_then(|mut broker| broker.expire(epoch, request_id, now_ms()));
    if let Some(delivery) = delivery {
        emit_delivery(app, delivery);
    }
}

fn destroy_owner(app: &AppHandle, capture: &OwnerCapture) {
    let deliveries = app
        .state::<KernelHostState>()
        .0
        .lock()
        .map(|mut broker| broker.destroyed(capture))
        .unwrap_or_default();
    for delivery in deliveries {
        emit_delivery(app, delivery);
    }
}

#[tauri::command]
pub fn register_kernel_host(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, KernelHostState>,
) -> Result<KernelHostRegistration, String> {
    let token = nanoid::nanoid!(48);
    let replacement = with_broker(&state, |broker| {
        broker.register_reloaded_main(window.label(), token)
    })?;
    for delivery in replacement.released {
        emit_delivery(&app, delivery);
    }
    let claim = replacement.claim;
    let capture = claim.destroy_capture.clone();
    let destroy_app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            destroy_owner(&destroy_app, &capture);
        }
    });
    Ok(claim.registration)
}

#[tauri::command]
pub fn kernel_client_request(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, KernelHostState>,
    request: KernelClientRequestV1,
    timeout_ms: Option<u64>,
) -> Result<KernelClientRequestRegistration, String> {
    let dispatch = with_broker(&state, |broker| {
        broker.request(
            window.label(),
            request,
            now_ms(),
            timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        )
    })?;
    let Some(host) = app.get_webview_window(&dispatch.host_label) else {
        let _ = with_broker(&state, |broker| {
            broker.abandon(dispatch.event.epoch, &dispatch.event.request_id);
            Ok(())
        });
        return Err("kernel_host_unavailable".into());
    };
    if host
        .emit(HOST_REQUEST_EVENT, dispatch.event.clone())
        .is_err()
    {
        let _ = with_broker(&state, |broker| {
            broker.abandon(dispatch.event.epoch, &dispatch.event.request_id);
            Ok(())
        });
        return Err("kernel_host_unavailable".into());
    }

    let expiry_app = app.clone();
    let epoch = dispatch.event.epoch;
    let request_id = dispatch.event.request_id.clone();
    let wait_ms = dispatch.registration.deadline_ms.saturating_sub(now_ms());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(wait_ms));
        expire_pending(&expiry_app, epoch, &request_id);
    });
    Ok(dispatch.registration)
}

#[tauri::command]
pub fn kernel_host_respond(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, KernelHostState>,
    epoch: u64,
    owner_token: String,
    request_id: String,
    response: KernelClientResponseV1,
) -> Result<(), String> {
    let delivery = with_broker(&state, |broker| {
        broker.respond(
            window.label(),
            epoch,
            &owner_token,
            &request_id,
            response,
            now_ms(),
        )
    })?;
    emit_delivery(&app, delivery);
    Ok(())
}

#[tauri::command]
pub fn release_kernel_host(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, KernelHostState>,
    epoch: u64,
    owner_token: String,
) -> Result<(), String> {
    let deliveries = with_broker(&state, |broker| {
        broker.release(window.label(), epoch, &owner_token)
    })?;
    for delivery in deliveries {
        emit_delivery(&app, delivery);
    }
    Ok(())
}

pub fn release_on_process_exit(app: &AppHandle) {
    let deliveries = app
        .state::<KernelHostState>()
        .0
        .lock()
        .map(|mut broker| broker.shutdown())
        .unwrap_or_default();
    for delivery in deliveries {
        emit_delivery(app, delivery);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cancel_request() -> KernelClientRequestV1 {
        KernelClientRequestV1::Cancel {
            version: 1,
            account_id: "account-1".into(),
            run_id: "run-1".into(),
        }
    }

    fn cancellation_response() -> KernelClientResponseV1 {
        KernelClientResponseV1::CancellationState {
            version: 1,
            run_id: "run-1".into(),
            state: CancellationDeliveryState::Delivered,
        }
    }

    #[test]
    fn exact_main_is_the_only_owner_for_one_epoch() {
        let mut broker = KernelHostBroker::default();
        assert_eq!(
            broker.register("workbench-main", "secondary-token".into()),
            Err("kernel_host_wrong_window")
        );
        let owner = broker.register("main", "owner-token-1".into()).unwrap();
        assert_eq!(owner.registration.epoch, 1);
        assert_eq!(owner.destroy_capture.process_id, std::process::id());
        assert!(broker.register("main", "owner-token-2".into()).is_err());
        assert_eq!(broker.owner_epoch(), Some(1));
    }

    #[test]
    fn main_webview_reload_rotates_stale_authority_and_fails_old_pending_requests() {
        let mut broker = KernelHostBroker::default();
        let first = broker.register("main", "owner-token-1".into()).unwrap();
        let pending = broker
            .request("workbench-main", cancel_request(), 100, 1_000)
            .unwrap();

        let replacement = broker
            .register_reloaded_main("main", "owner-token-2".into())
            .unwrap();

        assert!(replacement.claim.registration.epoch > first.registration.epoch);
        assert_eq!(
            replacement
                .released
                .iter()
                .map(|delivery| &delivery.event.response)
                .collect::<Vec<_>>(),
            vec![&KernelClientResponseV1::Unavailable {
                version: 1,
                request_kind: KernelRequestKind::Cancel,
                reason: KernelUnavailableReason::HostReleased,
            }]
        );
        assert_eq!(
            broker.respond(
                "main",
                first.registration.epoch,
                "owner-token-1",
                &pending.registration.request_id,
                cancellation_response(),
                101,
            ),
            Err("kernel_host_stale_owner")
        );
        assert!(matches!(
            broker.register_reloaded_main("workbench-main", "secondary-token".into()),
            Err("kernel_host_wrong_window")
        ));
    }

    #[test]
    fn closed_client_routing_rejects_auxiliary_authority_and_cross_kind_responses() {
        let mut broker = KernelHostBroker::default();
        let owner = broker.register("main", "owner-token".into()).unwrap();
        assert!(broker
            .request("pet-overlay", cancel_request(), 100, 1_000)
            .is_err());
        assert!(broker
            .request("main", cancel_request(), 100, 1_000)
            .is_err());

        let dispatch = broker
            .request("workbench-main", cancel_request(), 100, 1_000)
            .unwrap();
        assert_eq!(dispatch.event.epoch, owner.registration.epoch);
        let request_prefix = format!("kreq-{}-", owner.registration.epoch);
        let request_nonce = dispatch
            .event
            .request_id
            .strip_prefix(&request_prefix)
            .expect("request ID is bound to the owner epoch");
        assert!(request_nonce.len() >= 32);
        let wrong = KernelClientResponseV1::TurnAccepted {
            version: 1,
            run_id: "run-1".into(),
        };
        assert!(broker
            .respond(
                "main",
                owner.registration.epoch,
                "owner-token",
                &dispatch.event.request_id,
                wrong,
                101,
            )
            .is_err());
        let wrong_request = KernelClientResponseV1::CancellationState {
            version: 1,
            run_id: "different-run".into(),
            state: CancellationDeliveryState::Delivered,
        };
        assert!(broker
            .respond(
                "main",
                owner.registration.epoch,
                "owner-token",
                &dispatch.event.request_id,
                wrong_request,
                101,
            )
            .is_err());
        let delivery = broker
            .respond(
                "main",
                owner.registration.epoch,
                "owner-token",
                &dispatch.event.request_id,
                cancellation_response(),
                102,
            )
            .unwrap();
        assert_eq!(delivery.requester_label, "workbench-main");
        assert!(broker
            .respond(
                "main",
                owner.registration.epoch,
                "owner-token",
                &dispatch.event.request_id,
                cancellation_response(),
                103,
            )
            .is_err());
    }

    #[test]
    fn release_and_abrupt_destroy_fail_pending_requests_and_isolate_stale_callbacks() {
        let mut broker = KernelHostBroker::default();
        let first = broker.register("main", "owner-token-1".into()).unwrap();
        broker
            .request("workbench-main", cancel_request(), 100, 1_000)
            .unwrap();
        let released = broker
            .release("main", first.registration.epoch, "owner-token-1")
            .unwrap();
        assert_eq!(released.len(), 1);
        assert!(matches!(
            released[0].event.response,
            KernelClientResponseV1::Unavailable {
                reason: KernelUnavailableReason::HostReleased,
                ..
            }
        ));

        let second = broker.register("main", "owner-token-2".into()).unwrap();
        assert!(second.registration.epoch > first.registration.epoch);
        assert!(broker.destroyed(&first.destroy_capture).is_empty());
        assert_eq!(broker.owner_epoch(), Some(second.registration.epoch));

        broker
            .request("workbench-main", cancel_request(), 200, 1_000)
            .unwrap();
        let destroyed = broker.destroyed(&second.destroy_capture);
        assert_eq!(destroyed.len(), 1);
        assert_eq!(broker.owner_epoch(), None);
        assert!(broker
            .register("workbench-main", "never-owner".into())
            .is_err());
        assert!(broker.register("main", "owner-token-3".into()).is_ok());
    }

    #[test]
    fn timed_out_and_stale_owner_responses_fail_closed() {
        let mut broker = KernelHostBroker::default();
        let owner = broker.register("main", "owner-token".into()).unwrap();
        let dispatch = broker
            .request("tool-window", cancel_request(), 100, 25)
            .unwrap();
        let expired = broker.expire(
            dispatch.event.epoch,
            &dispatch.event.request_id,
            dispatch.registration.deadline_ms,
        );
        assert!(matches!(
            expired.unwrap().event.response,
            KernelClientResponseV1::Unavailable {
                reason: KernelUnavailableReason::RequestTimedOut,
                ..
            }
        ));
        assert!(broker
            .respond(
                "main",
                owner.registration.epoch,
                "stale-token",
                &dispatch.event.request_id,
                cancellation_response(),
                130,
            )
            .is_err());
    }

    #[test]
    fn serde_rejects_generic_methods_arbitrary_targets_and_unknown_fields() {
        assert!(
            serde_json::from_value::<KernelClientRequestV1>(serde_json::json!({
                "version": 1,
                "kind": "invoke",
                "method": "credential_get"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<KernelClientRequestV1>(serde_json::json!({
                "version": 1,
                "kind": "cancel",
                "accountId": "account-1",
                "runId": "run-1",
                "targetLabel": "main"
            }))
            .is_err()
        );
    }

    #[test]
    fn native_validation_bounds_client_ids_and_snapshot_size() {
        let request = KernelClientRequestV1::Cancel {
            version: 1,
            account_id: "account-1".into(),
            run_id: "x".repeat(513),
        };
        assert_eq!(request.validate(), Err("kernel_request_invalid"));

        let response = KernelClientResponseV1::CommandCenterSnapshot {
            version: 1,
            account_id: "account-1".into(),
            runs: (0..1_001)
                .map(|index| KernelRunSummary {
                    run_id: format!("run-{index}"),
                    status: KernelRunStatus::Running,
                    has_active_evidence: true,
                })
                .collect(),
        };
        assert_eq!(response.validate(), Err("kernel_response_invalid"));
    }

    #[test]
    fn native_approval_presentation_request_is_closed_and_bounded() {
        let request = serde_json::from_value::<KernelClientRequestV1>(serde_json::json!({
            "version": 1,
            "kind": "approval_present",
            "accountId": "account-1",
            "approvalId": "approval-1"
        }))
        .expect("bounded approval presentation request");
        assert_eq!(request.kind(), KernelRequestKind::ApprovalPresent);
        assert_eq!(request.validate(), Ok(()));

        assert!(
            serde_json::from_value::<KernelClientRequestV1>(serde_json::json!({
                "version": 1,
                "kind": "approval_present",
                "accountId": "account-1",
                "approvalId": "approval-1",
                "rawParameters": { "path": "C:\\private\\secret.txt" }
            }))
            .is_err()
        );
    }

    #[test]
    fn native_approval_presentation_response_matches_only_the_exact_approval() {
        let request = KernelClientRequestV1::ApprovalPresent {
            version: 1,
            account_id: "account-1".into(),
            approval_id: "approval-1".into(),
        };
        let response = KernelClientResponseV1::ApprovalPresentation {
            version: 1,
            approval_id: "approval-1".into(),
            action_id: "file.search".into(),
            expected_effect: "Search the active project without changing files.".into(),
            risk: ApprovalRisk::Confirm,
            parameters: vec![ApprovalPresentationParameter {
                field: "query".into(),
                safe_value: "*.md".into(),
            }],
        };
        assert_eq!(response.kind(), Some(KernelRequestKind::ApprovalPresent));
        assert_eq!(response.validate(), Ok(()));
        assert!(response.matches_request(&request));

        let mismatched = KernelClientResponseV1::ApprovalPresentation {
            version: 1,
            approval_id: "approval-2".into(),
            action_id: "file.search".into(),
            expected_effect: "Search the active project without changing files.".into(),
            risk: ApprovalRisk::Confirm,
            parameters: vec![ApprovalPresentationParameter {
                field: "query".into(),
                safe_value: "*.md".into(),
            }],
        };
        assert!(!mismatched.matches_request(&request));
    }

    #[test]
    fn native_approval_presentation_response_rejects_oversized_redacted_fields() {
        let oversized_effect = KernelClientResponseV1::ApprovalPresentation {
            version: 1,
            approval_id: "approval-1".into(),
            action_id: "file.search".into(),
            expected_effect: "x".repeat(513),
            risk: ApprovalRisk::Safe,
            parameters: Vec::new(),
        };
        assert_eq!(oversized_effect.validate(), Err("kernel_response_invalid"));

        let oversized_safe_value = KernelClientResponseV1::ApprovalPresentation {
            version: 1,
            approval_id: "approval-1".into(),
            action_id: "file.search".into(),
            expected_effect: "Search the active project.".into(),
            risk: ApprovalRisk::Dangerous,
            parameters: vec![ApprovalPresentationParameter {
                field: "query".into(),
                safe_value: "x".repeat(161),
            }],
        };
        assert_eq!(
            oversized_safe_value.validate(),
            Err("kernel_response_invalid")
        );
    }
}
