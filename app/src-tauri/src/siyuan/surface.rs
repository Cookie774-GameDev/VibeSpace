use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use async_lock::Mutex as AsyncMutex;
use serde::{Deserialize, Serialize};
use tauri::{
    webview::{Cookie, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl, Window,
};

use super::SiyuanRuntimeState;

const SURFACE_LABEL: &str = "siyuan-context-vault";
const MAIN_WEBVIEW_ADDITIONAL_BROWSER_ARGS: &str = "--js-flags=--max-old-space-size=1536";
const SIYUAN_CHILD_CDP_PORT_ENV: &str = "VIBESPACE_SIYUAN_CHILD_CDP_PORT";
const GRAPH_REPORT_PREFIX: &str = "__VIBESPACE_SIYUAN_GRAPH__";
const GRAPH_BOOTSTRAP_RETRY_DELAYS_MS: [u64; 22] = [
    50, 100, 150, 250, 400, 600, 800, 1_000, 1_200, 1_500, 1_750, 2_000,
    2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000,
];
const NAVIGATION_PENDING: u8 = 0;
const NAVIGATION_ABOUT_BLANK: u8 = 1;
const NAVIGATION_MANAGED_ORIGIN: u8 = 2;
const NAVIGATION_UNEXPECTED: u8 = 3;
const SIYUAN_GRAPH_FIRST_INITIALIZATION_SCRIPT_TEMPLATE: &str = r#"
((targetDocumentId, targetNotebookId, graphMode, reportNonce, expectedOrigin) => {
  if (window.location.pathname === "/check-auth") return;
  const deadline = Date.now() + 30000;
  const local = graphMode === "local";
  const dockSelector = local
    ? '.dock__item[data-type="graph"]'
    : '.dock__item[data-type="globalGraph"]';
  const graphSelector = local ? ".sy__graph" : ".sy__globalGraph";
  const fullscreenSelector = '[data-type="fullscreen"]';
  let documentRequested = !local;
  let browserTargetPromise;
  let dockRequested = false;
  let dockReported = false;
  let fullscreenRequested = false;
  let timer;
  let finished = false;
  let pendingReport;
  let reportRetryTimer;

  const reportPrefix = `__VIBESPACE_SIYUAN_GRAPH__:${reportNonce}:`;
  const flushReport = () => {
    reportRetryTimer = undefined;
    if (!pendingReport) return;
    if (document.title.startsWith(reportPrefix)) {
      reportRetryTimer = window.setTimeout(flushReport, 25);
      return;
    }
    const [state, detail] = pendingReport;
    pendingReport = undefined;
    window.__vibespaceGraphPreviousTitle = document.title;
    const reportTitle = `__VIBESPACE_SIYUAN_GRAPH__:${reportNonce}:${state}:${detail}`;
    window.__vibespaceGraphReportTitle = reportTitle;
    document.title = reportTitle;
  };
  const report = (state, detail = "") => {
    if (!state) return;
    pendingReport = [state, detail];
    if (reportRetryTimer === undefined) flushReport();
  };

  report("loading", "eval-entered");
  if (window.top !== window) {
    report("failed", "siyuan_graph_frame_mismatch");
    return;
  }
  if (window.location.origin !== expectedOrigin) {
    report("failed", "siyuan_graph_origin_mismatch");
    return;
  }
  if (window.__vibespaceGraphBootstrapNonce === reportNonce) return;
  window.__vibespaceGraphBootstrapNonce = reportNonce;

  __MANAGED_PRESENTATION__

  const reportPhase = (phase) => {
    if (!finished && [
      "bootstrapped",
      "block-verified",
      "tree-opened",
      "graph-dock-found",
      "fullscreen-requested",
    ].includes(phase)) {
      report("loading", phase);
    }
  };

  const stop = (state, error = "") => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    if (!state || finished) {
      return;
    }
    finished = true;
    report(state, error);
  };

  const fail = (error) => stop("failed", [
    "siyuan_graph_target_timeout",
    "siyuan_graph_target_unavailable",
    "siyuan_graph_target_invalid",
  ].includes(error) ? error : "siyuan_graph_unavailable");

  reportPhase("bootstrapped");

  const waitFor = async (read) => {
    while (Date.now() < deadline) {
      const value = read();
      if (value) {
        return value;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("siyuan_graph_target_timeout");
  };

  const findTreeNode = (nodeId) => {
    const tree = Array.from(document.querySelectorAll("ul[data-url]")).find(
      (candidate) => candidate.dataset.url === targetNotebookId,
    );
    return tree?.querySelector(`[data-node-id="${nodeId}"]`);
  };

  const openBrowserTarget = async () => {
    const response = await fetch("/api/block/getBlockInfo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: targetDocumentId }),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    const notebookId = payload?.code === 0 ? payload.data?.box : undefined;
    const rootId = payload?.code === 0 ? payload.data?.rootID : undefined;
    const path = payload?.code === 0 ? payload.data?.path : undefined;
    const nodeIdPattern = /^\d{14}-[a-z0-9]{7}$/u;
    if (
      !response.ok ||
      notebookId !== targetNotebookId ||
      typeof rootId !== "string" ||
      !nodeIdPattern.test(rootId) ||
      typeof path !== "string" ||
      path.length > 4096
    ) {
      throw new Error("siyuan_graph_target_unavailable");
    }
    reportPhase("block-verified");

    const pathIds = path
      .split("/")
      .filter(Boolean)
      .map((part) => part.replace(/\.sy$/u, ""));
    if (
      pathIds.length === 0 ||
      pathIds.length > 128 ||
      pathIds[pathIds.length - 1] !== rootId ||
      pathIds.some((nodeId) => !nodeIdPattern.test(nodeId))
    ) {
      throw new Error("siyuan_graph_target_unavailable");
    }

    const fileDock = await waitFor(() =>
      document.querySelector('.dock__item[data-type="file"]'),
    );
    if (!fileDock.classList.contains("dock__item--active")) {
      fileDock.click();
    }
    const tree = await waitFor(() =>
      Array.from(document.querySelectorAll("ul[data-url]")).find(
        (candidate) => candidate.dataset.url === targetNotebookId,
      ),
    );
    const notebookRoot = tree.querySelector(':scope > li[data-type="navigation-root"]');
    const notebookArrow = notebookRoot?.querySelector(".b3-list-item__arrow");
    if (notebookRoot && !notebookArrow?.classList.contains("b3-list-item__arrow--open")) {
      notebookRoot.querySelector(".b3-list-item__toggle")?.click();
    }
    reportPhase("tree-opened");

    for (const [index, nodeId] of pathIds.entries()) {
      const node = await waitFor(() => findTreeNode(nodeId));
      if (index === pathIds.length - 1) {
        node.querySelector(".b3-list-item__text")?.click();
        break;
      }
      const arrow = node.querySelector(".b3-list-item__arrow");
      if (!arrow?.classList.contains("b3-list-item__arrow--open")) {
        node.querySelector(".b3-list-item__toggle")?.click();
      }
    }
    await waitFor(() =>
      Array.from(document.querySelectorAll(".protyle [data-node-id]")).find(
        (candidate) => candidate.dataset.nodeId === rootId,
      ),
    );
  };

  const tick = () => {
    try {
      if (Date.now() >= deadline) {
        fail("siyuan_graph_target_timeout");
        return;
      }

      if (!documentRequested) {
        const api = window.require?.("siyuan");
        const app = window.siyuan?.ws?.app;
        if (!targetDocumentId || !targetNotebookId) {
          fail("siyuan_graph_target_invalid");
          return;
        }
        if (!api?.openTab || !app) {
          if (!browserTargetPromise) {
            browserTargetPromise = openBrowserTarget()
              .then(() => {
                documentRequested = true;
              })
              .catch((error) => fail(error?.message));
          }
          return;
        }
        documentRequested = true;
        api.openTab({ app, doc: { id: targetDocumentId } });
        return;
      }

      const dock = document.querySelector(dockSelector);
      if (!dock) {
        return;
      }
      if (!dockReported) {
        dockReported = true;
        reportPhase("graph-dock-found");
      }

      const graph = document.querySelector(graphSelector);
      if (!graph || !dock.classList.contains("dock__item--active")) {
        if (!dockRequested) {
          dockRequested = true;
          dock.click();
        }
        return;
      }

      if (graph.classList.contains("fullscreen")) {
        stop("ready");
        return;
      }

      const fullscreen = graph.querySelector(fullscreenSelector);
      if (!fullscreen) {
        return;
      }

      if (!fullscreenRequested) {
        fullscreenRequested = true;
        reportPhase("fullscreen-requested");
        fullscreen.click();
      }
    } catch (_error) {
      fail("siyuan_graph_unavailable");
    }
  };

  timer = window.setInterval(tick, 200);
  tick();
})(__TARGET_DOCUMENT_ID__, __TARGET_NOTEBOOK_ID__, __GRAPH_MODE__, __REPORT_NONCE__, __EXPECTED_ORIGIN__);
"#;
const MIN_SURFACE_WIDTH: f64 = 320.0;
const MIN_SURFACE_HEIGHT: f64 = 240.0;
const MAX_SURFACE_EDGE: f64 = 16_384.0;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSurfaceStatus {
    created: bool,
    visible: bool,
    project_id: Option<String>,
    map_id: Option<String>,
    notebook_id: Option<String>,
    root_document_id: Option<String>,
    graph_mode: Option<String>,
    graph_state: Option<String>,
    graph_phase: Option<String>,
    graph_error: Option<String>,
}

struct SurfaceRecord {
    project_id: String,
    map_id: String,
    notebook_id: Option<String>,
    root_document_id: Option<String>,
    graph_mode: String,
    visible: bool,
    graph_state: String,
    graph_phase: String,
    graph_error: Option<String>,
    report_nonce: String,
    origin: String,
    operation_id: String,
}

static SURFACE_STATE: Mutex<Option<SurfaceRecord>> = Mutex::new(None);
static SURFACE_OPERATION: Mutex<Option<String>> = Mutex::new(None);
static SURFACE_MUTATION: AsyncMutex<()> = AsyncMutex::new(());

fn operation_ownership_matches(
    current_operation: Option<&str>,
    installed_operation: Option<&str>,
    requested_operation: &str,
    require_installed: bool,
) -> bool {
    current_operation == Some(requested_operation)
        && (!require_installed || installed_operation == Some(requested_operation))
}

fn operation_is_current(operation_id: &str) -> bool {
    SURFACE_OPERATION.lock().ok().is_some_and(|value| {
        operation_ownership_matches(value.as_deref(), None, operation_id, false)
    })
}

fn clear_current_operation(operation_id: &str) {
    if let Ok(mut operation) = SURFACE_OPERATION.lock() {
        if operation.as_deref() == Some(operation_id) {
            *operation = None;
        }
    }
}

fn retire_failed_open_locked(app: &AppHandle, operation_id: &str) {
    if !operation_is_current(operation_id) {
        return;
    }
    if let Some(webview) = app.get_webview(SURFACE_LABEL) {
        let _ = retire_surface_window(&webview);
    }
    if let Ok(mut state) = SURFACE_STATE.lock() {
        *state = None;
    }
    clear_current_operation(operation_id);
}

async fn retire_failed_open(app: &AppHandle, operation_id: &str) {
    let _mutation = SURFACE_MUTATION.lock().await;
    retire_failed_open_locked(app, operation_id);
}

fn public_error(code: &'static str) -> String {
    code.to_owned()
}

fn validate_identifier(value: &str, code: &'static str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(public_error(code))
    } else {
        Ok(())
    }
}

fn validate_siyuan_node_id(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 22
        && bytes[..14].iter().all(u8::is_ascii_digit)
        && bytes[14] == b'-'
        && bytes[15..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if valid {
        Ok(())
    } else {
        Err(public_error("siyuan_node_id_invalid"))
    }
}

fn graph_initialization_script(
    graph_mode: &str,
    notebook_id: Option<&str>,
    root_document_id: Option<&str>,
    report_nonce: &str,
    expected_origin: &url::Url,
) -> Result<String, String> {
    if !matches!(graph_mode, "local" | "global") {
        return Err(public_error("siyuan_surface_graph_mode_invalid"));
    }
    if graph_mode == "local" {
        validate_siyuan_node_id(
            notebook_id.ok_or_else(|| public_error("siyuan_surface_target_invalid"))?,
        )?;
        validate_siyuan_node_id(
            root_document_id.ok_or_else(|| public_error("siyuan_surface_target_invalid"))?,
        )?;
    } else if let Some(value) = root_document_id {
        validate_siyuan_node_id(value)?;
    }
    if let Some(value) = notebook_id {
        validate_siyuan_node_id(value)?;
    }
    let notebook = serde_json::to_string(&notebook_id)
        .map_err(|_| public_error("siyuan_surface_target_invalid"))?;
    let target = serde_json::to_string(&root_document_id)
        .map_err(|_| public_error("siyuan_surface_target_invalid"))?;
    let mode = serde_json::to_string(graph_mode)
        .map_err(|_| public_error("siyuan_surface_graph_mode_invalid"))?;
    let nonce = serde_json::to_string(report_nonce)
        .map_err(|_| public_error("siyuan_surface_target_invalid"))?;
    let expected_origin = serde_json::to_string(&expected_origin.origin().ascii_serialization())
        .map_err(|_| public_error("siyuan_surface_origin_invalid"))?;
    Ok(SIYUAN_GRAPH_FIRST_INITIALIZATION_SCRIPT_TEMPLATE
        .replace("__MANAGED_PRESENTATION__", include_str!("native_presentation.js"))
        .replace("__TARGET_DOCUMENT_ID__", &target)
        .replace("__TARGET_NOTEBOOK_ID__", &notebook)
        .replace("__GRAPH_MODE__", &mode)
        .replace("__REPORT_NONCE__", &nonce)
        .replace("__EXPECTED_ORIGIN__", &expected_origin))
}

fn parse_graph_report(
    title: &str,
    nonce: &str,
) -> Option<(&'static str, Option<&'static str>, &'static str)> {
    let prefix = format!("{GRAPH_REPORT_PREFIX}:{nonce}:");
    let payload = title.strip_prefix(&prefix)?;
    match payload {
        "loading:bootstrapped" => Some(("loading", None, "bootstrapped")),
        "loading:eval-entered" => Some(("loading", None, "eval-entered")),
        "loading:block-verified" => Some(("loading", None, "block-verified")),
        "loading:tree-opened" => Some(("loading", None, "tree-opened")),
        "loading:graph-dock-found" => Some(("loading", None, "graph-dock-found")),
        "loading:fullscreen-requested" => Some(("loading", None, "fullscreen-requested")),
        "ready:" => Some(("ready", None, "ready")),
        "failed:siyuan_graph_target_timeout" => {
            Some(("failed", Some("siyuan_graph_target_timeout"), "failed"))
        }
        "failed:siyuan_graph_target_unavailable" => {
            Some(("failed", Some("siyuan_graph_target_unavailable"), "failed"))
        }
        "failed:siyuan_graph_target_invalid" => {
            Some(("failed", Some("siyuan_graph_target_invalid"), "failed"))
        }
        "failed:siyuan_graph_unavailable" => {
            Some(("failed", Some("siyuan_graph_unavailable"), "failed"))
        }
        "failed:siyuan_graph_frame_mismatch" => {
            Some(("failed", Some("siyuan_graph_frame_mismatch"), "failed"))
        }
        "failed:siyuan_graph_origin_mismatch" => {
            Some(("failed", Some("siyuan_graph_origin_mismatch"), "failed"))
        }
        _ => None,
    }
}

fn schedule_graph_bootstrap_retry(
    webview: Webview,
    operation_id: String,
    report_nonce: String,
    initialization_script: String,
    navigation_classification: Arc<AtomicU8>,
    authenticated_document_loaded: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        for delay_ms in GRAPH_BOOTSTRAP_RETRY_DELAYS_MS {
            thread::sleep(Duration::from_millis(delay_ms));
            let should_retry = SURFACE_STATE.lock().ok().is_some_and(|state| {
                state.as_ref().is_some_and(|record| {
                    record.operation_id == operation_id
                        && record.report_nonce == report_nonce
                        && record.graph_state == "loading"
                        && matches!(
                            record.graph_phase.as_str(),
                            "starting"
                                | "document-loaded"
                                | "about-blank"
                                | "origin-navigated"
                                | "origin-reloaded"
                                | "origin-navigation-pending"
                                | "session-reload-requested"
                                | "navigation-status-unavailable"
                                | "navigation-unexpected"
                                | "bootstrap-dispatched"
                        )
                })
            });
            if !should_retry {
                return;
            }
            let main_webview = webview.clone();
            let operation_for_main = operation_id.clone();
            let nonce_for_main = report_nonce.clone();
            let script_for_main = initialization_script.clone();
            let authenticated_ready = authenticated_document_loaded.load(Ordering::Acquire);
            let navigation_phase = if !authenticated_ready {
                "origin-navigation-pending"
            } else {
                match navigation_classification.load(Ordering::Acquire) {
                    NAVIGATION_ABOUT_BLANK => "about-blank",
                    NAVIGATION_MANAGED_ORIGIN => "origin-navigated",
                    NAVIGATION_UNEXPECTED => "navigation-unexpected",
                    _ => "origin-navigation-pending",
                }
            };
            let may_evaluate = authenticated_ready
                && navigation_classification.load(Ordering::Acquire) == NAVIGATION_MANAGED_ORIGIN;
            let dispatch_result = webview.run_on_main_thread(move || {
                if let Ok(mut state) = SURFACE_STATE.lock() {
                    if let Some(record) = state.as_mut() {
                        if record.operation_id == operation_for_main
                            && record.report_nonce == nonce_for_main
                            && record.graph_state == "loading"
                        {
                            record.graph_phase = navigation_phase.to_owned();
                        }
                    }
                }
                if !may_evaluate {
                    return;
                }
                if main_webview.eval(&script_for_main).is_ok() {
                    if let Ok(mut state) = SURFACE_STATE.lock() {
                        if let Some(record) = state.as_mut() {
                            if record.operation_id == operation_for_main
                                && record.report_nonce == nonce_for_main
                                && record.graph_state == "loading"
                                && matches!(
                                    record.graph_phase.as_str(),
                                    "starting"
                                        | "document-loaded"
                                        | "about-blank"
                                        | "origin-navigated"
                                        | "origin-reloaded"
                                        | "origin-navigation-pending"
                                        | "session-reload-requested"
                                        | "navigation-unexpected"
                                )
                            {
                                record.graph_phase = "bootstrap-dispatched".to_owned();
                            }
                        }
                    }
                }
            });
            if dispatch_result.is_err() {
                if let Ok(mut state) = SURFACE_STATE.lock() {
                    if let Some(record) = state.as_mut() {
                        if record.operation_id == operation_id
                            && record.report_nonce == report_nonce
                        {
                            record.graph_phase = "navigation-status-unavailable".to_owned();
                        }
                    }
                }
            }
        }
        if let Ok(mut state) = SURFACE_STATE.lock() {
            if let Some(record) = state.as_mut() {
                if record.operation_id == operation_id
                    && record.report_nonce == report_nonce
                    && record.graph_state == "loading"
                {
                    record.graph_state = "failed".to_owned();
                    record.graph_phase = "failed".to_owned();
                    record.graph_error = Some("siyuan_graph_unavailable".to_owned());
                }
            }
        }
    });
}

fn graph_navigation_classification(expected_origin: &url::Url, candidate: &url::Url) -> u8 {
    if candidate.as_str() == "about:blank" {
        NAVIGATION_ABOUT_BLANK
    } else if navigation_allowed(expected_origin, candidate) {
        NAVIGATION_MANAGED_ORIGIN
    } else {
        NAVIGATION_UNEXPECTED
    }
}

fn siyuan_session_cookie_for_deletion() -> Cookie<'static> {
    Cookie::build(("siyuan", ""))
        .domain("127.0.0.1")
        .path("/")
        .build()
}

fn retire_surface_window(webview: &Webview) -> Result<(), tauri::Error> {
    let _ = webview.delete_cookie(siyuan_session_cookie_for_deletion());
    webview.close()
}

fn validate_bounds(bounds: &SiyuanSurfaceBounds) -> Result<(), String> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || bounds.x.abs() > MAX_SURFACE_EDGE
        || bounds.y.abs() > MAX_SURFACE_EDGE
        || bounds.width < MIN_SURFACE_WIDTH
        || bounds.height < MIN_SURFACE_HEIGHT
        || bounds.width > MAX_SURFACE_EDGE
        || bounds.height > MAX_SURFACE_EDGE
    {
        Err(public_error("siyuan_surface_bounds_invalid"))
    } else {
        Ok(())
    }
}

fn main_window(app: &AppHandle) -> Result<Window, String> {
    app.get_window("main")
        .ok_or_else(|| public_error("siyuan_surface_main_window_unavailable"))
}

fn debug_child_cdp_port(value: Option<&str>, debug_build: bool) -> Option<u16> {
    if !debug_build {
        return None;
    }
    value?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port >= 1024)
}

fn child_cdp_configuration(app: &AppHandle) -> Result<Option<(PathBuf, String)>, String> {
    let port = debug_child_cdp_port(
        std::env::var(SIYUAN_CHILD_CDP_PORT_ENV).ok().as_deref(),
        cfg!(debug_assertions),
    );
    let Some(port) = port else {
        return Ok(None);
    };
    let data_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| public_error("siyuan_surface_webview_unavailable"))?
        .join("webview-data")
        .join("siyuan-child-cdp")
        .join(port.to_string());
    let browser_args = format!(
        "{MAIN_WEBVIEW_ADDITIONAL_BROWSER_ARGS} --remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"
    );
    Ok(Some((data_directory, browser_args)))
}

fn child_geometry(
    bounds: &SiyuanSurfaceBounds,
) -> Result<(LogicalPosition<f64>, LogicalSize<f64>), String> {
    validate_bounds(bounds)?;
    Ok((
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    ))
}

fn apply_bounds(webview: &Webview, bounds: &SiyuanSurfaceBounds) -> Result<(), String> {
    let (position, size) = child_geometry(bounds)?;
    webview
        .set_position(position)
        .map_err(|_| public_error("siyuan_surface_bounds_unavailable"))?;
    webview
        .set_size(size)
        .map_err(|_| public_error("siyuan_surface_bounds_unavailable"))?;
    Ok(())
}

fn navigation_allowed(origin: &url::Url, candidate: &url::Url) -> bool {
    if candidate.as_str() == "about:blank" {
        return true;
    }
    candidate.scheme() == "http"
        && candidate.username().is_empty()
        && candidate.password().is_none()
        && candidate.host_str() == Some("127.0.0.1")
        && candidate.scheme() == origin.scheme()
        && candidate.host_str() == origin.host_str()
        && candidate.port_or_known_default() == origin.port_or_known_default()
}

fn status(app: &AppHandle) -> SiyuanSurfaceStatus {
    let created = app.get_webview(SURFACE_LABEL).is_some();
    let state = SURFACE_STATE.lock().ok();
    let record = state.as_ref().and_then(|guard| guard.as_ref());
    SiyuanSurfaceStatus {
        created,
        visible: created && record.is_some_and(|value| value.visible),
        project_id: record.map(|value| value.project_id.clone()),
        map_id: record.map(|value| value.map_id.clone()),
        notebook_id: record.and_then(|value| value.notebook_id.clone()),
        root_document_id: record.and_then(|value| value.root_document_id.clone()),
        graph_mode: record.map(|value| value.graph_mode.clone()),
        graph_state: record.map(|value| value.graph_state.clone()),
        graph_phase: record.map(|value| value.graph_phase.clone()),
        graph_error: record.and_then(|value| value.graph_error.clone()),
    }
}

#[tauri::command]
pub async fn siyuan_surface_open(
    app: AppHandle,
    operation_id: String,
    project_id: String,
    map_id: String,
    notebook_id: Option<String>,
    root_document_id: Option<String>,
    graph_mode: String,
    bounds: SiyuanSurfaceBounds,
    state: State<'_, SiyuanRuntimeState>,
) -> Result<SiyuanSurfaceStatus, String> {
    validate_bounds(&bounds)?;
    validate_identifier(&operation_id, "siyuan_surface_operation_invalid")?;
    validate_identifier(&project_id, "siyuan_project_id_invalid")?;
    validate_identifier(&map_id, "siyuan_map_id_invalid")?;
    if let Some(value) = notebook_id.as_deref() {
        validate_siyuan_node_id(value)?;
    }
    if graph_mode == "local" && notebook_id.is_none() {
        return Err(public_error("siyuan_surface_target_invalid"));
    }
    {
        let _mutation = SURFACE_MUTATION.lock().await;
        *SURFACE_OPERATION
            .lock()
            .map_err(|_| public_error("siyuan_surface_state_unavailable"))? =
            Some(operation_id.clone());
    }
    let runtime = state.inner().clone();
    let project_for_runtime = project_id.clone();
    let authority = match tauri::async_runtime::spawn_blocking(move || {
        runtime
            .surface_session_with_recovery(&project_for_runtime)
            .map_err(|error| error.to_string())
    })
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            retire_failed_open(&app, &operation_id).await;
            return Err(error);
        }
        Err(_) => {
            retire_failed_open(&app, &operation_id).await;
            return Err(public_error("siyuan_surface_state_unavailable"));
        }
    };
    let _mutation = SURFACE_MUTATION.lock().await;
    if !operation_is_current(&operation_id) {
        return Err(public_error("siyuan_surface_open_cancelled"));
    }
    let (origin, cookie_value) = authority.into_parts();
    if origin.scheme() != "http"
        || origin.host_str() != Some("127.0.0.1")
        || origin.port().is_none()
        || origin.username() != ""
        || origin.password().is_some()
    {
        retire_failed_open_locked(&app, &operation_id);
        return Err(public_error("siyuan_surface_origin_invalid"));
    }

    let main = match main_window(&app) {
        Ok(value) => value,
        Err(error) => {
            retire_failed_open_locked(&app, &operation_id);
            return Err(error);
        }
    };
    let origin_key = origin.as_str().to_owned();
    if let Some(existing) = app.get_webview(SURFACE_LABEL) {
        let same_target = SURFACE_STATE
            .lock()
            .map_err(|_| public_error("siyuan_surface_state_unavailable"))?
            .as_ref()
            .is_some_and(|record| {
                record.project_id == project_id
                    && record.map_id == map_id
                    && record.notebook_id == notebook_id
                    && record.root_document_id == root_document_id
                    && record.graph_mode == graph_mode
                    && record.origin == origin_key
            });
        if same_target {
            if let Some(record) = SURFACE_STATE
                .lock()
                .map_err(|_| public_error("siyuan_surface_state_unavailable"))?
                .as_mut()
            {
                record.visible = true;
                record.graph_state = "loading".to_owned();
                record.graph_phase = "starting".to_owned();
                record.graph_error = None;
                record.operation_id = operation_id.clone();
            }
            let setup_result = (|| -> Result<(), String> {
                existing
                    .set_cookie(
                        Cookie::build(("siyuan", cookie_value))
                            .domain("127.0.0.1")
                            .path("/")
                            .http_only(true)
                            .build(),
                    )
                    .map_err(|_| public_error("siyuan_surface_session_unavailable"))?;
                existing
                    .navigate(origin.clone())
                    .map_err(|_| public_error("siyuan_surface_navigation_unavailable"))?;
                if let Ok(mut state) = SURFACE_STATE.lock() {
                    if let Some(record) = state.as_mut() {
                        if record.operation_id == operation_id {
                            record.graph_phase = "origin-reloaded".to_owned();
                        }
                    }
                }
                apply_bounds(&existing, &bounds)?;
                existing
                    .show()
                    .map_err(|_| public_error("siyuan_surface_window_unavailable"))?;
                Ok(())
            })();
            if let Err(error) = setup_result {
                let _ = retire_surface_window(&existing);
                if let Ok(mut state) = SURFACE_STATE.lock() {
                    *state = None;
                }
                clear_current_operation(&operation_id);
                return Err(error);
            }
            return Ok(status(&app));
        }
        let _ = retire_surface_window(&existing);
        *SURFACE_STATE
            .lock()
            .map_err(|_| public_error("siyuan_surface_state_unavailable"))? = None;
    }

    let report_nonce = nanoid::nanoid!(24);
    let initialization_script = match graph_initialization_script(
        &graph_mode,
        notebook_id.as_deref(),
        root_document_id.as_deref(),
        &report_nonce,
        &origin,
    ) {
        Ok(value) => value,
        Err(error) => {
            retire_failed_open_locked(&app, &operation_id);
            return Err(error);
        }
    };
    let allowed_origin = origin.clone();
    let navigation_classification = Arc::new(AtomicU8::new(NAVIGATION_PENDING));
    let navigation_classification_for_handler = Arc::clone(&navigation_classification);
    let page_load_origin = origin.clone();
    let page_load_nonce = report_nonce.clone();
    let page_load_operation = operation_id.clone();
    let authenticated_reload_requested = Arc::new(AtomicBool::new(false));
    let authenticated_reload_requested_for_handler = Arc::clone(&authenticated_reload_requested);
    let authenticated_document_loaded = Arc::new(AtomicBool::new(false));
    let authenticated_document_loaded_for_handler = Arc::clone(&authenticated_document_loaded);
    let page_load_navigation_classification = Arc::clone(&navigation_classification);
    let report_nonce_for_handler = report_nonce.clone();
    let retry_report_nonce = report_nonce.clone();
    let authenticated_root_url = origin.clone();
    let (position, size) = child_geometry(&bounds)?;
    // Make the managed SiYuan origin the child's first real document. On Windows,
    // initialization scripts registered on an about:blank child were not installed
    // into the later programmatic navigation even when WebView2 returned success.
    let mut builder = WebviewBuilder::new(SURFACE_LABEL, WebviewUrl::External(origin.clone()))
        .focused(true)
        .additional_browser_args(MAIN_WEBVIEW_ADDITIONAL_BROWSER_ARGS)
        .initialization_script(&initialization_script)
        .on_page_load(move |webview, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished)
                || payload.url().as_str() == "about:blank"
                || !navigation_allowed(&page_load_origin, payload.url())
            {
                return;
            }
            let is_auth_document = payload.url().path() == "/check-auth";
            page_load_navigation_classification.store(NAVIGATION_MANAGED_ORIGIN, Ordering::Release);
            let owns_surface = SURFACE_STATE.lock().ok().is_some_and(|mut state| {
                state.as_mut().is_some_and(|record| {
                    if record.operation_id != page_load_operation
                        || record.report_nonce != page_load_nonce
                    {
                        return false;
                    }
                    record.graph_phase = if authenticated_reload_requested_for_handler
                        .load(Ordering::Acquire)
                        && !is_auth_document
                    {
                        "document-loaded".to_owned()
                    } else if authenticated_reload_requested_for_handler.load(Ordering::Acquire) {
                        "origin-navigation-pending".to_owned()
                    } else {
                        "session-reload-requested".to_owned()
                    };
                    true
                })
            });
            if !owns_surface {
                return;
            }
            if !authenticated_reload_requested_for_handler.swap(true, Ordering::AcqRel) {
                let navigation_webview = webview.clone();
                let navigation_target = authenticated_root_url.clone();
                let navigation_operation = page_load_operation.clone();
                let navigation_nonce = page_load_nonce.clone();
                let dispatch_result = webview.run_on_main_thread(move || {
                    if navigation_webview.navigate(navigation_target).is_err() {
                        if let Ok(mut state) = SURFACE_STATE.lock() {
                            if let Some(record) = state.as_mut() {
                                if record.operation_id == navigation_operation
                                    && record.report_nonce == navigation_nonce
                                {
                                    record.graph_state = "failed".to_owned();
                                    record.graph_phase = "failed".to_owned();
                                    record.graph_error =
                                        Some("siyuan_graph_root_navigation_unavailable".to_owned());
                                }
                            }
                        }
                    }
                });
                if dispatch_result.is_err() {
                    if let Ok(mut state) = SURFACE_STATE.lock() {
                        if let Some(record) = state.as_mut() {
                            if record.operation_id == page_load_operation
                                && record.report_nonce == page_load_nonce
                            {
                                record.graph_state = "failed".to_owned();
                                record.graph_phase = "failed".to_owned();
                                record.graph_error =
                                    Some("siyuan_graph_main_thread_unavailable".to_owned());
                            }
                        }
                    }
                }
                return;
            }
            if is_auth_document {
                return;
            }
            authenticated_document_loaded_for_handler.store(true, Ordering::Release);
        })
        .on_document_title_changed(move |webview, title| {
            let Some((graph_state, graph_error, graph_phase)) =
                parse_graph_report(&title, &report_nonce_for_handler)
            else {
                return;
            };
            if let Ok(mut state) = SURFACE_STATE.lock() {
                if let Some(record) = state.as_mut() {
                    if record.report_nonce == report_nonce_for_handler {
                        record.graph_state = graph_state.to_owned();
                        record.graph_phase = graph_phase.to_owned();
                        record.graph_error = graph_error.map(str::to_owned);
                        eprintln!(
                            "siyuan_surface_graph_phase operation={} phase={}",
                            record.operation_id, graph_phase
                        );
                    }
                }
            }
            let _ = webview.eval(
                r#"if (window.__vibespaceGraphReportTitle === document.title) {
                  document.title = window.__vibespaceGraphPreviousTitle || "";
                  delete window.__vibespaceGraphReportTitle;
                  delete window.__vibespaceGraphPreviousTitle;
                }"#,
            );
        })
        .on_navigation(move |candidate| {
            let allowed = navigation_allowed(&allowed_origin, candidate);
            let classification = graph_navigation_classification(&allowed_origin, candidate);
            navigation_classification_for_handler.store(classification, Ordering::Release);
            allowed
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    let child_cdp = match child_cdp_configuration(&app) {
        Ok(value) => value,
        Err(error) => {
            retire_failed_open_locked(&app, &operation_id);
            return Err(error);
        }
    };
    if let Some((data_directory, browser_args)) = child_cdp {
        builder = builder
            .data_directory(data_directory)
            .additional_browser_args(&browser_args);
    }

    // Page-load handlers may run before `add_child` returns on WebView2. Publish
    // the exact operation first so the first authenticated/check-auth document
    // can claim its nonce and request the post-cookie managed-origin navigation.
    *SURFACE_STATE
        .lock()
        .map_err(|_| public_error("siyuan_surface_state_unavailable"))? = Some(SurfaceRecord {
        project_id,
        map_id,
        notebook_id,
        root_document_id,
        graph_mode,
        visible: true,
        graph_state: "loading".to_owned(),
        graph_phase: "starting".to_owned(),
        graph_error: None,
        report_nonce,
        origin: origin_key,
        operation_id: operation_id.clone(),
    });
    let webview = match main.add_child(builder, position, size) {
        Ok(value) => value,
        Err(_) => {
            retire_failed_open_locked(&app, &operation_id);
            return Err(public_error("siyuan_surface_webview_unavailable"));
        }
    };
    if !operation_is_current(&operation_id) {
        let _ = retire_surface_window(&webview);
        return Err(public_error("siyuan_surface_open_cancelled"));
    }
    let setup_result = (|| -> Result<(), String> {
        webview
            .set_cookie(
                Cookie::build(("siyuan", cookie_value))
                    .domain("127.0.0.1")
                    .path("/")
                    .http_only(true)
                    .build(),
            )
            .map_err(|_| public_error("siyuan_surface_session_unavailable"))?;
        // Do not reload here. WebView2 first creates the child on about:blank and then
        // performs the builder's queued managed-origin navigation. Reloading at this
        // point cancels that queued navigation and permanently reloads about:blank.
        if let Ok(mut state) = SURFACE_STATE.lock() {
            if let Some(record) = state.as_mut() {
                if record.operation_id == operation_id {
                    record.graph_phase = "origin-navigation-pending".to_owned();
                }
            }
        }
        apply_bounds(&webview, &bounds)?;
        webview
            .show()
            .map_err(|_| public_error("siyuan_surface_window_unavailable"))?;
        Ok(())
    })();
    if let Err(error) = setup_result {
        let _ = retire_surface_window(&webview);
        if let Ok(mut state) = SURFACE_STATE.lock() {
            if state
                .as_ref()
                .is_some_and(|record| record.operation_id == operation_id)
            {
                *state = None;
            }
        }
        clear_current_operation(&operation_id);
        return Err(error);
    }
    schedule_graph_bootstrap_retry(
        webview,
        operation_id,
        retry_report_nonce,
        initialization_script,
        navigation_classification,
        authenticated_document_loaded,
    );
    Ok(status(&app))
}

#[tauri::command]
pub async fn siyuan_surface_set_bounds(
    app: AppHandle,
    operation_id: String,
    bounds: SiyuanSurfaceBounds,
) -> Result<bool, String> {
    validate_bounds(&bounds)?;
    validate_identifier(&operation_id, "siyuan_surface_operation_invalid")?;
    let _mutation = SURFACE_MUTATION.lock().await;
    if !operation_is_current(&operation_id)
        || !SURFACE_STATE
            .lock()
            .map_err(|_| public_error("siyuan_surface_state_unavailable"))?
            .as_ref()
            .is_some_and(|record| record.operation_id == operation_id)
    {
        return Ok(false);
    }
    let Some(webview) = app.get_webview(SURFACE_LABEL) else {
        return Ok(false);
    };
    apply_bounds(&webview, &bounds)?;
    Ok(true)
}

#[tauri::command]
pub async fn siyuan_surface_hide(app: AppHandle, operation_id: String) -> Result<bool, String> {
    validate_identifier(&operation_id, "siyuan_surface_operation_invalid")?;
    let _mutation = SURFACE_MUTATION.lock().await;
    if !operation_is_current(&operation_id)
        || !SURFACE_STATE
            .lock()
            .map_err(|_| public_error("siyuan_surface_state_unavailable"))?
            .as_ref()
            .is_some_and(|record| record.operation_id == operation_id)
    {
        return Ok(false);
    }
    let Some(webview) = app.get_webview(SURFACE_LABEL) else {
        return Ok(false);
    };
    webview
        .hide()
        .map_err(|_| public_error("siyuan_surface_window_unavailable"))?;
    if let Some(record) = SURFACE_STATE
        .lock()
        .map_err(|_| public_error("siyuan_surface_state_unavailable"))?
        .as_mut()
    {
        record.visible = false;
    }
    Ok(true)
}

#[tauri::command]
pub async fn siyuan_surface_reload(app: AppHandle, operation_id: String) -> Result<bool, String> {
    validate_identifier(&operation_id, "siyuan_surface_operation_invalid")?;
    let _mutation = SURFACE_MUTATION.lock().await;
    if !operation_is_current(&operation_id)
        || !SURFACE_STATE
            .lock()
            .map_err(|_| public_error("siyuan_surface_state_unavailable"))?
            .as_ref()
            .is_some_and(|record| record.operation_id == operation_id)
    {
        return Ok(false);
    }
    let Some(webview) = app.get_webview(SURFACE_LABEL) else {
        return Ok(false);
    };
    webview
        .reload()
        .map_err(|_| public_error("siyuan_surface_navigation_unavailable"))?;
    Ok(true)
}

#[tauri::command]
pub async fn siyuan_surface_close(app: AppHandle, operation_id: String) -> Result<bool, String> {
    validate_identifier(&operation_id, "siyuan_surface_operation_invalid")?;
    let _mutation = SURFACE_MUTATION.lock().await;
    if !operation_is_current(&operation_id) {
        return Ok(false);
    }
    *SURFACE_STATE
        .lock()
        .map_err(|_| public_error("siyuan_surface_state_unavailable"))? = None;
    clear_current_operation(&operation_id);
    let Some(webview) = app.get_webview(SURFACE_LABEL) else {
        return Ok(false);
    };
    retire_surface_window(&webview)
        .map_err(|_| public_error("siyuan_surface_window_unavailable"))?;
    Ok(true)
}

#[tauri::command]
pub async fn siyuan_surface_status(app: AppHandle) -> SiyuanSurfaceStatus {
    // Child creation acquires the webview manager while dispatching work to the
    // UI thread. Never block that thread acquiring the same manager for polling.
    status(&app)
}

pub fn shutdown_surface(app: &AppHandle) {
    let Some(_mutation) = SURFACE_MUTATION.try_lock() else {
        return;
    };
    if let Some(webview) = app.get_webview(SURFACE_LABEL) {
        let _ = retire_surface_window(&webview);
    }
    if let Ok(mut state) = SURFACE_STATE.lock() {
        *state = None;
    }
    if let Ok(mut operation) = SURFACE_OPERATION.lock() {
        *operation = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_bounds_are_finite_bounded_and_useful() {
        assert!(validate_bounds(&SiyuanSurfaceBounds {
            x: 120.0,
            y: 80.0,
            width: 1_200.0,
            height: 800.0,
        })
        .is_ok());
        for bounds in [
            SiyuanSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: 319.0,
                height: 800.0,
            },
            SiyuanSurfaceBounds {
                x: f64::NAN,
                y: 0.0,
                width: 1_200.0,
                height: 800.0,
            },
            SiyuanSurfaceBounds {
                x: 0.0,
                y: 0.0,
                width: 1_200.0,
                height: 20_000.0,
            },
        ] {
            assert_eq!(
                validate_bounds(&bounds),
                Err("siyuan_surface_bounds_invalid".to_owned())
            );
        }
    }

    #[test]
    fn navigation_is_exact_random_loopback_origin_only() {
        let origin = url::Url::parse("http://127.0.0.1:61342/").unwrap();
        for allowed in [
            "about:blank",
            "http://127.0.0.1:61342/",
            "http://127.0.0.1:61342/stage/build/app/index.html#editor",
        ] {
            assert!(navigation_allowed(
                &origin,
                &url::Url::parse(allowed).unwrap()
            ));
        }
        for denied in [
            "http://localhost:61342/",
            "http://127.0.0.1:61343/",
            "https://127.0.0.1:61342/",
            "https://example.com/",
            "http://user@127.0.0.1:61342/",
        ] {
            assert!(!navigation_allowed(
                &origin,
                &url::Url::parse(denied).unwrap()
            ));
        }
        assert_eq!(
            graph_navigation_classification(&origin, &url::Url::parse("about:blank").unwrap()),
            NAVIGATION_ABOUT_BLANK
        );
        assert_eq!(
            graph_navigation_classification(
                &origin,
                &url::Url::parse("http://127.0.0.1:61342/stage/build/app/index.html").unwrap()
            ),
            NAVIGATION_MANAGED_ORIGIN
        );
        assert_eq!(
            graph_navigation_classification(
                &origin,
                &url::Url::parse("http://127.0.0.1:61343/").unwrap()
            ),
            NAVIGATION_UNEXPECTED
        );
    }

    #[test]
    fn public_status_contains_no_origin_cookie_or_runtime_secret_fields() {
        let value = serde_json::to_value(SiyuanSurfaceStatus {
            created: true,
            visible: true,
            project_id: Some("project-1".to_owned()),
            map_id: Some("map-1".to_owned()),
            notebook_id: Some("20260824010101-abcdefg".to_owned()),
            root_document_id: Some("20260824010102-abcdefg".to_owned()),
            graph_mode: Some("local".to_owned()),
            graph_state: Some("ready".to_owned()),
            graph_phase: Some("ready".to_owned()),
            graph_error: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "created": true,
                "visible": true,
                "projectId": "project-1",
                "mapId": "map-1",
                "notebookId": "20260824010101-abcdefg",
                "rootDocumentId": "20260824010102-abcdefg",
                "graphMode": "local",
                "graphState": "ready",
                "graphPhase": "ready",
                "graphError": null,
            })
        );
        let rendered = value.to_string().to_ascii_lowercase();
        for forbidden in ["cookie", "token", "port", "origin", "url"] {
            assert!(!rendered.contains(forbidden));
        }
    }

    #[test]
    fn surface_webview_browser_args_match_the_main_window_environment() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let main_window = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap();

        assert_eq!(
            main_window["additionalBrowserArgs"].as_str(),
            Some(MAIN_WEBVIEW_ADDITIONAL_BROWSER_ARGS)
        );
    }

    #[test]
    fn child_cdp_port_is_debug_only_and_validated() {
        assert_eq!(debug_child_cdp_port(Some(" 9334 "), true), Some(9334));
        assert_eq!(debug_child_cdp_port(Some("9334"), false), None);
        assert_eq!(debug_child_cdp_port(Some("0"), true), None);
        assert_eq!(debug_child_cdp_port(Some("1023"), true), None);
        assert_eq!(debug_child_cdp_port(Some("not-a-port"), true), None);
        assert_eq!(debug_child_cdp_port(None, true), None);
    }

    #[test]
    fn child_cdp_configuration_is_isolated_and_loopback_only() {
        let source = include_str!("surface.rs");
        assert!(source.contains("cfg!(debug_assertions)"));
        assert!(source.contains(".data_directory(data_directory)"));
        assert!(source.contains("--remote-debugging-address=127.0.0.1"));
        assert!(source.contains("--remote-debugging-port={port}"));
    }

    #[test]
    fn surface_is_a_true_child_webview_of_the_main_window() {
        let source = include_str!("surface.rs");
        let child_builder = ["Webview", "Builder::new("].join("");
        let add_child = [".add", "_child("].join("");
        let managed_child_lookup = ["app.get", "_webview(SURFACE_LABEL)"].join("");
        let independent_builder = ["Webview", "WindowBuilder"].join("");
        let native_owner = [".owner", "(&main)"].join("");
        let desktop_origin = ["main.inner", "_position()"].join("");

        assert!(source.contains(&child_builder));
        assert!(source.contains(&add_child));
        assert!(source.contains(&managed_child_lookup));
        assert!(!source.contains(&independent_builder));
        assert!(!source.contains(&native_owner));
        assert!(!source.contains(&desktop_origin));
    }

    #[test]
    fn renderer_surface_mutations_are_operation_bound_and_serialized() {
        let source = include_str!("surface.rs");
        for command in [
            "pub async fn siyuan_surface_set_bounds(",
            "pub async fn siyuan_surface_hide(",
            "pub async fn siyuan_surface_reload(",
        ] {
            let start = source.find(command).expect("surface command is registered");
            let remaining = &source[start..];
            let end = remaining
                .find("\n}\n")
                .expect("surface command has a bounded body");
            let body = &remaining[..end];
            assert!(
                body.contains("operation_id: String"),
                "{command} is unbound"
            );
            assert!(
                body.contains("SURFACE_MUTATION"),
                "{command} is not serialized"
            );
            assert!(
                body.contains("record.operation_id == operation_id"),
                "{command} does not verify record ownership"
            );
        }
        let close_start = source
            .find("pub async fn siyuan_surface_close(")
            .expect("close command is registered");
        let close_remaining = &source[close_start..];
        let close_end = close_remaining
            .find("\n}\n")
            .expect("close command has a bounded body");
        let close_body = &close_remaining[..close_end];
        assert!(close_body.contains("operation_id: String"));
        assert!(close_body.contains("SURFACE_MUTATION"));
        assert!(close_body.contains("operation_is_current(&operation_id)"));
        assert!(!close_body.contains("record.operation_id == operation_id"));
        assert!(close_body.contains("clear_current_operation(&operation_id)"));
        assert!(source.contains("retire_failed_open(&app, &operation_id)"));
        assert!(source.contains("retire_failed_open_locked(&app, &operation_id)"));
    }

    #[test]
    fn pending_close_and_stale_close_use_exact_operation_ownership() {
        assert!(operation_ownership_matches(
            Some("operation-b"),
            None,
            "operation-b",
            false
        ));
        assert!(!operation_ownership_matches(
            Some("operation-b"),
            Some("operation-a"),
            "operation-a",
            false
        ));
        assert!(!operation_ownership_matches(
            Some("operation-b"),
            None,
            "operation-b",
            true
        ));
        assert!(operation_ownership_matches(
            Some("operation-b"),
            Some("operation-b"),
            "operation-b",
            true
        ));
    }

    #[test]
    fn child_geometry_is_parent_relative_and_logical() {
        let (position, size) = child_geometry(&SiyuanSurfaceBounds {
            x: 120.5,
            y: 80.25,
            width: 1_200.0,
            height: 800.0,
        })
        .unwrap();

        assert_eq!(position, LogicalPosition::new(120.5, 80.25));
        assert_eq!(size, LogicalSize::new(1_200.0, 800.0));
    }

    #[test]
    fn graph_first_initialization_uses_only_official_bounded_dom_actions() {
        let origin = url::Url::parse("http://127.0.0.1:61342/").unwrap();
        let script = graph_initialization_script(
            "local",
            Some("20260824010101-abcdefg"),
            Some("20260824010102-abcdefg"),
            "report-nonce",
            &origin,
        )
        .expect("valid local graph target");

        for required in [
            r#".dock__item[data-type="graph"]"#,
            r#".dock__item[data-type="globalGraph"]"#,
            ".sy__graph",
            ".sy__globalGraph",
            r#"window.require?.("siyuan")"#,
            "window.siyuan?.ws?.app",
            r#"fetch("/api/block/getBlockInfo""#,
            "AbortSignal.timeout(5000)",
            "notebookId !== targetNotebookId",
            "path.length > 4096",
            "pathIds.length > 128",
            r#"/^\d{14}-[a-z0-9]{7}$/u"#,
            "ul[data-url]",
            "b3-list-item__toggle",
            "b3-list-item__text",
            "api.openTab({ app, doc: { id: targetDocumentId } })",
            "20260824010102-abcdefg",
            r#"[data-type="fullscreen"]"#,
            "window.top !== window",
            "window.location.origin !== expectedOrigin",
            r#"window.location.pathname === "/check-auth""#,
            r#"http://127.0.0.1:61342"#,
            "Date.now() + 30000",
            "window.setInterval(tick, 200)",
            "window.clearInterval(timer)",
            r#"reportPhase("bootstrapped")"#,
            "window.__vibespaceGraphBootstrapNonce === reportNonce",
            "try {",
            "catch (_error)",
            ".click()",
        ] {
            assert!(
                script.contains(required),
                "missing graph-first contract: {required}"
            );
        }

        for forbidden in [
            "Authorization",
            "token",
            "cookie",
            "document.cookie",
            "localStorage",
            "innerHTML",
            "eval(",
        ] {
            assert!(
                !script.contains(forbidden),
                "forbidden graph-first authority: {forbidden}"
            );
        }
        assert_eq!(script.matches("fetch(").count(), 1);
        assert_eq!(script.matches("/api/").count(), 1);
        assert_eq!(script.matches(".click()").count(), 6);
        // Presentation observers may clean up on navigation; graph readiness
        // must still be governed by the nonce and bounded bootstrap deadline.
        assert!(script.contains("() => observer.disconnect()"));
        assert_eq!(script.matches("pagehide").count(), 1);
    }

    #[test]
    fn graph_first_initialization_is_installed_on_the_child_builder() {
        let source = include_str!("surface.rs");
        let install_call = [".initialization", "_script(&initialization_script)"].join("");

        assert!(source.contains(&install_call));
        assert!(source.contains(".on_page_load(move |webview, payload|"));
        assert!(source.contains("PageLoadEvent::Finished"));
        assert!(source.contains("\"document-loaded\".to_owned()"));
        assert!(source.contains("session-reload-requested"));
        assert!(source.contains("authenticated_reload_requested_for_handler.swap(true"));
        let loaded_gate = ["authenticated_document_loaded", ".load(Ordering::Acquire)"].join("");
        let loaded_signal = [
            "authenticated_document_loaded_for_handler",
            ".store(true, Ordering::Release)",
        ]
        .join("");
        assert!(source.contains(&loaded_gate));
        assert!(source.contains(&loaded_signal));
        assert!(source.contains("payload.url().path() == \"/check-auth\""));
        let forbidden_direct_eval = ["webview.eval", "(&page_load_script)"].join("");
        let deferred_retry_eval = ["main_webview.eval", "(&script_for_main)"].join("");
        assert!(!source.contains(&forbidden_direct_eval));
        assert!(source.contains(&deferred_retry_eval));
        assert!(source.contains("payload.url().as_str() == \"about:blank\""));
        assert!(source.contains("WebviewUrl::External(origin.clone())"));
        let forbidden_blank_builder = ["WebviewUrl::External(", "blank)"].join("");
        assert!(!source.contains(&forbidden_blank_builder));
        assert!(source.contains("if !may_evaluate"));
        assert!(source.contains("origin-navigation-pending"));
        let cookie_index = source.find(".set_cookie(").unwrap();
        let navigate_index = source[cookie_index..].find(".navigate(").unwrap() + cookie_index;
        let show_index = source[navigate_index..].find(".show()").unwrap() + navigate_index;
        assert!(cookie_index < navigate_index && navigate_index < show_index);
        assert!(source.contains("navigation_webview.navigate(navigation_target)"));
        assert!(source.contains("siyuan_graph_root_navigation_unavailable"));
        assert!(source.contains("schedule_graph_bootstrap_retry("));
        assert!(source.contains("webview.run_on_main_thread(move ||"));
        assert!(source.contains(".on_navigation(move |candidate|"));
        assert!(source.contains("graph_navigation_classification(&allowed_origin, candidate)"));
        let forbidden_url_query = ["main_webview", ".url()"].join("");
        assert!(!source.contains(&forbidden_url_query));
        assert!(source.contains("&& record.graph_state == \"loading\""));
    }

    #[test]
    fn child_operation_state_is_published_before_the_first_page_load_can_fire() {
        let source = include_str!("surface.rs");
        let start = source
            .find("let mut builder = WebviewBuilder::new")
            .unwrap();
        let end = source[start..].find("let setup_result =").unwrap() + start;
        let open_slice = &source[start..end];
        let state_index = open_slice.find("= Some(SurfaceRecord {").unwrap();
        let add_child_index = open_slice.find("main.add_child(builder").unwrap();

        assert!(state_index < add_child_index);
    }

    #[test]
    fn graph_bootstrap_retries_are_bounded_inside_the_existing_deadline() {
        assert!(GRAPH_BOOTSTRAP_RETRY_DELAYS_MS[0] <= 100);
        assert!(GRAPH_BOOTSTRAP_RETRY_DELAYS_MS.iter().sum::<u64>() < 30_000);
        assert_eq!(GRAPH_BOOTSTRAP_RETRY_DELAYS_MS.len(), 22);
    }

    #[test]
    fn graph_target_validation_fails_closed() {
        let origin = url::Url::parse("http://127.0.0.1:61342/").unwrap();
        assert!(graph_initialization_script(
            "local",
            Some("20260824010101-abcdefg"),
            Some("20260824010102-abcdefg"),
            "report-nonce",
            &origin
        )
        .is_ok());
        assert!(graph_initialization_script("global", None, None, "report-nonce", &origin).is_ok());
        assert_eq!(
            graph_initialization_script(
                "local",
                Some("20260824010101-abcdefg"),
                None,
                "report-nonce",
                &origin
            ),
            Err("siyuan_surface_target_invalid".to_owned())
        );
        assert_eq!(
            graph_initialization_script("other", None, None, "report-nonce", &origin),
            Err("siyuan_surface_graph_mode_invalid".to_owned())
        );
        assert!(graph_initialization_script(
            "local",
            Some("20260824010101-abcdefg"),
            Some("bad');fetch('/api');"),
            "report-nonce",
            &origin
        )
        .is_err());
    }

    #[test]
    fn graph_reports_are_nonce_bound_and_fixed_code_only() {
        assert_eq!(
            parse_graph_report("__VIBESPACE_SIYUAN_GRAPH__:nonce-1:ready:", "nonce-1"),
            Some(("ready", None, "ready"))
        );
        assert_eq!(
            parse_graph_report(
                "__VIBESPACE_SIYUAN_GRAPH__:nonce-1:loading:bootstrapped",
                "nonce-1"
            ),
            Some(("loading", None, "bootstrapped"))
        );
        assert_eq!(
            parse_graph_report(
                "__VIBESPACE_SIYUAN_GRAPH__:nonce-1:loading:eval-entered",
                "nonce-1"
            ),
            Some(("loading", None, "eval-entered"))
        );
        assert_eq!(
            parse_graph_report(
                "__VIBESPACE_SIYUAN_GRAPH__:nonce-1:failed:siyuan_graph_origin_mismatch",
                "nonce-1"
            ),
            Some(("failed", Some("siyuan_graph_origin_mismatch"), "failed"))
        );
        assert_eq!(
            parse_graph_report(
                "__VIBESPACE_SIYUAN_GRAPH__:nonce-1:failed:siyuan_graph_target_timeout",
                "nonce-1"
            ),
            Some(("failed", Some("siyuan_graph_target_timeout"), "failed"))
        );
        assert!(parse_graph_report("__VIBESPACE_SIYUAN_GRAPH__:other:ready:", "nonce-1").is_none());
        assert!(parse_graph_report(
            "__VIBESPACE_SIYUAN_GRAPH__:nonce-1:failed:secret-detail",
            "nonce-1"
        )
        .is_none());
        assert!(parse_graph_report(
            "__VIBESPACE_SIYUAN_GRAPH__:nonce-1:loading:secret-detail",
            "nonce-1"
        )
        .is_none());
    }

    #[test]
    fn surface_retirement_never_clears_the_shared_webview_profile() {
        let source = include_str!("surface.rs");
        let profile_wide_clear = ["clear", "all", "browsing", "data"].join("_");
        let retirement_symbol = ["retire", "surface", "window"].join("_");
        let retirement_call = format!("{retirement_symbol}(");
        let cookie = siyuan_session_cookie_for_deletion();

        assert!(!source.contains(&profile_wide_clear));
        assert!(source.matches(&retirement_call).count() >= 5);
        assert_eq!(cookie.name(), "siyuan");
        assert_eq!(cookie.value(), "");
        assert_eq!(cookie.domain(), Some("127.0.0.1"));
        assert_eq!(cookie.path(), Some("/"));
    }
}
