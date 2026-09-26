//! Closed, typed broker contract for the small SiYuan API subset approved for Phase 1.

use super::security::{validate_runtime_token, LOOPBACK_HOST};
use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fmt;
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

pub const MAX_IDENTIFIER_BYTES: usize = 128;
pub const MAX_QUERY_BYTES: usize = 512;
pub const MAX_SEARCH_RESULTS: u16 = 100;
pub const MAX_RELATION_RESULTS: usize = 100;
pub const MAX_BLOCK_CONTENT_BYTES: usize = 1_048_576;
pub const MAX_DOCUMENT_PATH_BYTES: usize = 4_096;
pub const MAX_SNAPSHOT_MEMO_BYTES: usize = 256;
pub const MAX_BATCH_BLOCKS: usize = 64;
pub const MAX_BATCH_BLOCK_TOTAL_BYTES: usize = 262_144;
const MAX_BATCH_APPEND_REQUEST_BLOCKS: usize = 8;
const MAX_BATCH_APPEND_REQUEST_MARKDOWN_BYTES: usize = 32 * 1024;
// Method-3 counts can include tag-only matches that its result filter omits.
// Bound their paging even when a caller asks for only a few final results.
const MAX_MANAGED_MARKER_SEARCH_PAGES: usize = 8;
const MAX_HTTP_RESPONSE_BYTES: u64 = 1_100_000;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const SEARCH_HTTP_TIMEOUT: Duration = Duration::from_secs(45);
static DOCUMENT_CREATE_MOVE_GUARD: Mutex<()> = Mutex::new(());

fn markdown_matches_managed_marker(observed: &str, requested: &str, marker: &str) -> bool {
    if observed == requested {
        return true;
    }
    let marker_comment = format!("<!-- {marker} -->");
    requested.contains(&marker_comment) && observed.contains(&marker_comment)
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub feature_enabled: bool,
    pub state: String,
    pub runtime_bundled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersion {
    pub version: String,
    pub commit: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub closed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSummary {
    pub id: String,
    pub notebook_id: String,
    pub path: String,
    pub content: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub notebook_id: String,
    pub path: String,
    pub markdown: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppendBlockInput {
    pub parent_id: String,
    pub markdown: String,
}

fn split_batch_append_requests(blocks: &[AppendBlockInput]) -> Vec<&[AppendBlockInput]> {
    let mut requests = Vec::new();
    let mut parent_start = 0;

    while parent_start < blocks.len() {
        let parent_id = blocks[parent_start].parent_id.as_str();
        let parent_end = blocks[parent_start..]
            .iter()
            .position(|block| block.parent_id.as_str() != parent_id)
            .map_or(blocks.len(), |offset| parent_start + offset);
        let mut chunk_start = parent_start;

        while chunk_start < parent_end {
            let mut chunk_end = chunk_start;
            let mut markdown_bytes = 0usize;
            while chunk_end < parent_end
                && chunk_end - chunk_start < MAX_BATCH_APPEND_REQUEST_BLOCKS
            {
                let next_bytes = markdown_bytes.saturating_add(blocks[chunk_end].markdown.len());
                if chunk_end > chunk_start && next_bytes > MAX_BATCH_APPEND_REQUEST_MARKDOWN_BYTES {
                    break;
                }
                // Keep a large valid block intact and isolate it in its own request.
                markdown_bytes = next_bytes;
                chunk_end += 1;
            }

            requests.push(&blocks[chunk_start..chunk_end]);
            chunk_start = chunk_end;
        }

        parent_start = parent_end;
    }

    requests
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrokerRequest<'a> {
    Status,
    ListNotebooks,
    CreateNotebook {
        name: &'a str,
    },
    SearchBlocks {
        query: &'a str,
        limit: u16,
    },
    GetBlock {
        id: &'a str,
    },
    ListInboundBacklinks {
        id: &'a str,
    },
    CreateDocument {
        notebook_id: &'a str,
        path: &'a str,
        markdown: &'a str,
    },
    CreateDocumentUnderParent {
        notebook_id: &'a str,
        map_root_id: &'a str,
        parent_id: &'a str,
        staging_path: &'a str,
        markdown: &'a str,
        marker: &'a str,
    },
    BatchAppendBlocks {
        notebook_id: &'a str,
        map_root_id: &'a str,
        blocks: &'a [AppendBlockInput],
    },
    UpdateBlock {
        map_root_id: &'a str,
        id: &'a str,
        expected_markdown: &'a str,
        markdown: &'a str,
    },
    DeleteBlock {
        map_root_id: &'a str,
        id: &'a str,
        expected_markdown: &'a str,
    },
    CreateDailyNote {
        notebook_id: &'a str,
    },
    CreateSnapshot {
        memo: &'a str,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrokerResponse {
    Status(RuntimeStatus),
    Notebooks(Vec<Notebook>),
    NotebookCreated(Notebook),
    SearchResults(Vec<BlockSummary>),
    Block(Block),
    BlockRelationIds(Vec<String>),
    Identifier(String),
    Identifiers(Vec<String>),
    MutationApplied,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClientError {
    FeatureDisabled,
    InvalidIdentifier,
    InvalidQuery,
    InvalidLimit,
    InvalidPath,
    InvalidContent,
    BlockNotFound,
    Conflict,
    ResponseTooLarge,
    ResponseTypeMismatch,
    TransportUnavailable,
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::FeatureDisabled => "siyuan_feature_disabled",
            Self::InvalidIdentifier => "siyuan_identifier_invalid",
            Self::InvalidQuery => "siyuan_query_invalid",
            Self::InvalidLimit => "siyuan_limit_invalid",
            Self::InvalidPath => "siyuan_path_invalid",
            Self::InvalidContent => "siyuan_content_invalid",
            Self::BlockNotFound => "siyuan_block_not_found",
            Self::Conflict => "siyuan_conflict",
            Self::ResponseTooLarge => "siyuan_response_too_large",
            Self::ResponseTypeMismatch => "siyuan_response_type_mismatch",
            Self::TransportUnavailable => "siyuan_transport_unavailable",
        })
    }
}

pub(crate) struct HttpSiyuanTransport {
    client: Client,
    base_url: String,
    token: String,
    search_timeout: Duration,
    session_cookie: Mutex<Option<String>>,
}

pub(crate) struct SurfaceSessionAuthority {
    origin: url::Url,
    cookie_value: String,
}

impl SurfaceSessionAuthority {
    pub(crate) fn into_parts(self) -> (url::Url, String) {
        (self.origin, self.cookie_value)
    }
}

impl fmt::Debug for HttpSiyuanTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpSiyuanTransport")
            .field("base_url", &self.base_url)
            .field("token", &"[REDACTED]")
            .field("session_cookie", &"[REDACTED]")
            .finish()
    }
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    code: i64,
    #[serde(default)]
    msg: String,
    data: T,
}

#[derive(Deserialize)]
struct NotebookData {
    notebooks: Vec<NotebookWire>,
}

#[derive(Deserialize)]
struct NotebookCreateData {
    notebook: NotebookWire,
}

#[derive(Deserialize)]
struct NotebookWire {
    id: String,
    name: String,
    closed: bool,
}

#[derive(Deserialize)]
struct SearchData {
    blocks: Vec<SearchBlockWire>,
    #[serde(default, rename = "matchedBlockCount")]
    matched_block_count: Option<usize>,
    #[serde(default, rename = "pageCount")]
    page_count: Option<usize>,
    #[serde(default, rename = "docMode")]
    doc_mode: Option<bool>,
}

#[derive(Deserialize)]
struct SearchBlockWire {
    id: String,
    #[serde(rename = "box")]
    notebook_id: String,
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct BlockInfoData {
    #[serde(rename = "box")]
    notebook_id: String,
    path: String,
    #[serde(rename = "rootID")]
    root_id: String,
}

#[derive(Deserialize)]
struct BlockKramdownData {
    id: String,
    kramdown: String,
}

#[derive(Deserialize)]
struct TransactionWire {
    #[serde(rename = "doOperations")]
    do_operations: Vec<OperationWire>,
}

#[derive(Deserialize)]
struct OperationWire {
    action: String,
    id: String,
    #[serde(rename = "parentID")]
    parent_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BacklinkData {
    unchanged: bool,
    revision: String,
    backlinks: Vec<BacklinkWire>,
    #[serde(rename = "linkRefsCount")]
    _link_refs_count: usize,
    backmentions: Vec<Value>,
    #[serde(rename = "mentionsCount")]
    _mentions_count: usize,
    k: String,
    mk: String,
    #[serde(rename = "box")]
    _notebook_id: String,
}

#[derive(Deserialize)]
struct BacklinkWire {
    id: String,
}

#[derive(Deserialize)]
struct DailyNoteData {
    id: String,
}

#[derive(Deserialize)]
struct BootProgressData {
    progress: i64,
}

impl HttpSiyuanTransport {
    pub(crate) fn new(port: u16, token: String) -> Result<Self, ClientError> {
        Self::new_with_timeouts(port, token, HTTP_TIMEOUT, SEARCH_HTTP_TIMEOUT)
    }

    fn new_with_timeouts(
        port: u16,
        token: String,
        ordinary_timeout: Duration,
        search_timeout: Duration,
    ) -> Result<Self, ClientError> {
        if port == 0 || validate_runtime_token(&token).is_err() {
            return Err(ClientError::TransportUnavailable);
        }
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(ordinary_timeout)
            .build()
            .map_err(|_| ClientError::TransportUnavailable)?;
        Ok(Self {
            client,
            base_url: format!("http://{LOOPBACK_HOST}:{port}"),
            token,
            search_timeout,
            session_cookie: Mutex::new(None),
        })
    }

    fn read_response_bytes(
        &self,
        mut response: reqwest::blocking::Response,
    ) -> Result<Vec<u8>, ClientError> {
        if !response.status().is_success() {
            return Err(ClientError::TransportUnavailable);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES)
        {
            return Err(ClientError::ResponseTooLarge);
        }
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(MAX_HTTP_RESPONSE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ClientError::TransportUnavailable)?;
        if bytes.len() as u64 > MAX_HTTP_RESPONSE_BYTES {
            return Err(ClientError::ResponseTooLarge);
        }
        Ok(bytes)
    }

    fn read_envelope<T: DeserializeOwned>(
        &self,
        response: reqwest::blocking::Response,
    ) -> Result<T, ClientError> {
        let bytes = self.read_response_bytes(response)?;
        let envelope: ApiEnvelope<T> =
            serde_json::from_slice(&bytes).map_err(|_| ClientError::ResponseTypeMismatch)?;
        if envelope.code != 0 {
            return Err(ClientError::TransportUnavailable);
        }
        Ok(envelope.data)
    }

    fn read_block_info_envelope(
        &self,
        response: reqwest::blocking::Response,
        id: &str,
    ) -> Result<Option<BlockInfoData>, ClientError> {
        let bytes = self.read_response_bytes(response)?;
        let envelope: ApiEnvelope<Option<BlockInfoData>> =
            serde_json::from_slice(&bytes).map_err(|_| ClientError::ResponseTypeMismatch)?;
        if envelope.code == 0 {
            return Ok(envelope.data);
        }
        let exact_missing_message = format!("Content block with id [{id}] not found");
        if envelope.code == -1 && envelope.data.is_none() && envelope.msg == exact_missing_message {
            return Ok(None);
        }
        Err(ClientError::TransportUnavailable)
    }

    fn ensure_authenticated(&self) -> Result<String, ClientError> {
        let mut session_cookie = self
            .session_cookie
            .lock()
            .map_err(|_| ClientError::TransportUnavailable)?;
        if let Some(cookie) = session_cookie.as_ref() {
            return Ok(cookie.clone());
        }

        let response = self
            .client
            .post(format!("{}/api/system/loginAuth", self.base_url))
            .json(&json!({
                "authCode": self.token,
                "captcha": "",
                "rememberMe": false,
            }))
            .send()
            .map_err(|_| ClientError::TransportUnavailable)?;
        let cookie = response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .filter(|value| value.starts_with("siyuan=") && value.len() <= 4_096)
            .ok_or(ClientError::TransportUnavailable)?
            .to_owned();
        let _: Value = self.read_envelope(response)?;
        *session_cookie = Some(cookie.clone());
        Ok(cookie)
    }

    fn post_public<T: DeserializeOwned>(
        &self,
        path: &'static str,
        body: Value,
    ) -> Result<T, ClientError> {
        let response = self
            .client
            .post(format!("{}{path}", self.base_url))
            .json(&body)
            .send()
            .map_err(|_| ClientError::TransportUnavailable)?;
        self.read_envelope(response)
    }

    fn post<T: DeserializeOwned>(&self, path: &'static str, body: Value) -> Result<T, ClientError> {
        let session_cookie = self.ensure_authenticated()?;
        let response = self
            .client
            .post(format!("{}{path}", self.base_url))
            .header(reqwest::header::COOKIE, session_cookie)
            .json(&body)
            .send()
            .map_err(|_| ClientError::TransportUnavailable)?;
        let result = self.read_envelope(response);
        if matches!(&result, Err(ClientError::ResponseTooLarge)) {
            // Routes are static and safe to identify; never log the request body,
            // session token, notebook identity, or any document content here.
            eprintln!("SiYuan response exceeded the size limit at endpoint {path}");
        }
        result
    }

    fn post_block_info(&self, id: &str) -> Result<Option<BlockInfoData>, ClientError> {
        let session_cookie = self.ensure_authenticated()?;
        let response = self
            .client
            .post(format!("{}/api/block/getBlockInfo", self.base_url))
            .header(reqwest::header::COOKIE, session_cookie)
            .json(&json!({ "id": id }))
            .send()
            .map_err(|_| ClientError::TransportUnavailable)?;
        self.read_block_info_envelope(response, id)
    }

    fn post_search<T: DeserializeOwned>(
        &self,
        path: &'static str,
        body: Value,
    ) -> Result<T, ClientError> {
        let session_cookie = self.ensure_authenticated()?;
        let response = self
            .client
            .post(format!("{}{path}", self.base_url))
            .timeout(self.search_timeout)
            .header(reqwest::header::COOKIE, session_cookie)
            .json(&body)
            .send()
            .map_err(|_| ClientError::TransportUnavailable)?;
        self.read_envelope(response)
    }

    fn runtime_version(&self) -> Result<String, ClientError> {
        self.post("/api/system/version", json!({}))
    }

    pub(crate) fn boot_progress(&self) -> Result<u8, ClientError> {
        let data: BootProgressData = self.post_public("/api/system/bootProgress", json!({}))?;
        u8::try_from(data.progress)
            .ok()
            .filter(|progress| *progress <= 100)
            .ok_or(ClientError::ResponseTypeMismatch)
    }

    pub(crate) fn verify_ready_session(&self) -> Result<(), ClientError> {
        self.ensure_authenticated()?;
        let version = self.runtime_version()?;
        if version == super::manifest::SIYUAN_UPSTREAM_TAG.trim_start_matches('v') {
            Ok(())
        } else {
            Err(ClientError::ResponseTypeMismatch)
        }
    }

    pub(crate) fn surface_session(&self) -> Result<SurfaceSessionAuthority, ClientError> {
        let cookie = self.ensure_authenticated()?;
        let cookie_value = cookie
            .strip_prefix("siyuan=")
            .filter(|value| !value.is_empty() && value.len() <= 4_096)
            .ok_or(ClientError::TransportUnavailable)?
            .to_owned();
        let origin = self
            .base_url
            .parse()
            .map_err(|_| ClientError::TransportUnavailable)?;
        Ok(SurfaceSessionAuthority {
            origin,
            cookie_value,
        })
    }

    pub(crate) fn verified_surface_session(&self) -> Result<SurfaceSessionAuthority, ClientError> {
        self.verify_ready_session()?;
        self.surface_session()
    }

    pub(crate) fn request_shutdown(&self) -> Result<(), ClientError> {
        let _: Value = self.post(
            "/api/system/exit",
            json!({
                "force": false,
                "execInstallPkg": 1,
                "setCurrentWorkspace": false,
            }),
        )?;
        Ok(())
    }

    fn notebooks(&self) -> Result<Vec<Notebook>, ClientError> {
        let data: NotebookData = self.post("/api/notebook/lsNotebooks", json!({}))?;
        if data.notebooks.len() > 1_000 {
            return Err(ClientError::ResponseTooLarge);
        }
        data.notebooks
            .into_iter()
            .map(|notebook| {
                validate_identifier(&notebook.id)?;
                if notebook.name.is_empty() || notebook.name.len() > 256 {
                    return Err(ClientError::ResponseTooLarge);
                }
                Ok(Notebook {
                    id: notebook.id,
                    name: notebook.name,
                    closed: notebook.closed,
                })
            })
            .collect()
    }

    fn create_notebook(&self, name: &str) -> Result<Notebook, ClientError> {
        let data: NotebookCreateData =
            self.post("/api/notebook/createNotebook", json!({ "name": name }))?;
        validate_identifier(&data.notebook.id)?;
        if data.notebook.name.is_empty() || data.notebook.name.len() > 256 {
            return Err(ClientError::ResponseTooLarge);
        }
        Ok(Notebook {
            id: data.notebook.id,
            name: data.notebook.name,
            closed: data.notebook.closed,
        })
    }

    fn search(&self, query: &str, limit: u16) -> Result<Vec<BlockSummary>, ClientError> {
        validate_query(query)?;
        if let Some(regex_query) = managed_node_marker_regex(query)? {
            return self.search_managed_marker(&regex_query, limit);
        }

        let data = self.search_page(query, limit, 1, 0)?;
        Self::validate_search_blocks(data.blocks, limit)
    }

    fn search_page(
        &self,
        query: &str,
        page_size: u16,
        page: usize,
        method: u8,
    ) -> Result<SearchData, ClientError> {
        self.post_search(
            "/api/search/fullTextSearchBlock",
            json!({
                "query": query,
                "page": page,
                "pageSize": page_size,
                "method": method,
                "searchHPath": false,
            }),
        )
    }

    fn search_managed_marker(
        &self,
        regex_query: &str,
        limit: u16,
    ) -> Result<Vec<BlockSummary>, ClientError> {
        let first = self.search_page(regex_query, limit, 1, 3)?;
        let matched_count = first
            .matched_block_count
            .ok_or(ClientError::ResponseTypeMismatch)?;
        let page_count = first.page_count.ok_or(ClientError::ResponseTypeMismatch)?;
        if first.doc_mode != Some(false) {
            return Err(ClientError::ResponseTypeMismatch);
        }
        if matched_count > usize::from(MAX_SEARCH_RESULTS) {
            return Err(ClientError::ResponseTooLarge);
        }

        let page_size = usize::from(limit);
        let expected_page_count = if matched_count == 0 {
            0
        } else {
            (matched_count + page_size - 1) / page_size
        };
        if (matched_count == 0 && !matches!(page_count, 0 | 1))
            || (matched_count != 0 && page_count != expected_page_count)
        {
            return Err(ClientError::ResponseTypeMismatch);
        }
        if page_count > MAX_MANAGED_MARKER_SEARCH_PAGES {
            return Err(ClientError::ResponseTooLarge);
        }
        if matched_count == 0 && !first.blocks.is_empty() {
            return Err(ClientError::ResponseTypeMismatch);
        }

        let mut results: Vec<BlockSummary> = Vec::new();
        let mut first_page = Some(first);
        // Do not stop at an empty filtered page: the API's page count may include
        // tag-only rows which are excluded from its returned blocks.
        for page in 1..=page_count {
            let data = if page == 1 {
                first_page.take().ok_or(ClientError::ResponseTypeMismatch)?
            } else {
                self.search_page(regex_query, limit, page, 3)?
            };
            if data.matched_block_count != Some(matched_count)
                || data.page_count != Some(page_count)
                || data.doc_mode != Some(false)
            {
                return Err(ClientError::ResponseTypeMismatch);
            }

            for block in Self::validate_search_blocks(data.blocks, limit)? {
                if let Some(previous) = results.iter().find(|item| item.id == block.id) {
                    if previous != &block {
                        return Err(ClientError::ResponseTypeMismatch);
                    }
                } else {
                    results.push(block);
                    if results.len() > page_size {
                        return Err(ClientError::ResponseTooLarge);
                    }
                }
            }
        }
        Ok(results)
    }

    fn validate_search_blocks(
        blocks: Vec<SearchBlockWire>,
        limit: u16,
    ) -> Result<Vec<BlockSummary>, ClientError> {
        if blocks.len() > usize::from(limit) {
            return Err(ClientError::ResponseTooLarge);
        }
        blocks
            .into_iter()
            .map(|block| {
                validate_identifier(&block.id)?;
                validate_identifier(&block.notebook_id)?;
                if block.path.len() > 4_096 || block.content.len() > MAX_BLOCK_CONTENT_BYTES {
                    return Err(ClientError::ResponseTooLarge);
                }
                Ok(BlockSummary {
                    id: block.id,
                    notebook_id: block.notebook_id,
                    path: block.path,
                    content: block.content,
                })
            })
            .collect()
    }

    fn block(&self, id: &str) -> Result<Block, ClientError> {
        let info = self.block_info(id)?;
        let markdown = self.block_markdown(id)?;
        Ok(Block {
            id: id.to_owned(),
            notebook_id: info.notebook_id,
            path: info.path,
            markdown,
        })
    }

    fn block_info(&self, id: &str) -> Result<BlockInfoData, ClientError> {
        // SiYuan v3.8.1 returns a successful envelope with `data: null` when
        // its database still knows an ID whose backing tree disappeared.
        // Preserve that distinction so callers can detach a stale binding
        // without treating an unknown response shape as safe.
        let info = self.post_block_info(id)?;
        let info = info.ok_or(ClientError::BlockNotFound)?;
        validate_identifier(&info.notebook_id)?;
        validate_identifier(&info.root_id)?;
        if info.path.len() > MAX_DOCUMENT_PATH_BYTES {
            return Err(ClientError::ResponseTooLarge);
        }
        if info.path.is_empty() || info.path.contains('\0') {
            return Err(ClientError::ResponseTypeMismatch);
        }
        Ok(info)
    }

    fn map_root_info(&self, map_root_id: &str) -> Result<BlockInfoData, ClientError> {
        let root = self.block_info(map_root_id)?;
        if root.root_id != map_root_id {
            return Err(ClientError::ResponseTypeMismatch);
        }
        Ok(root)
    }

    fn block_markdown(&self, id: &str) -> Result<String, ClientError> {
        let content: BlockKramdownData =
            self.post("/api/block/getBlockKramdown", json!({ "id": id }))?;
        if content.id != id {
            return Err(ClientError::ResponseTypeMismatch);
        }
        if content.kramdown.len() > MAX_BLOCK_CONTENT_BYTES {
            return Err(ClientError::ResponseTooLarge);
        }
        Ok(content.kramdown)
    }

    fn require_same_map(root: &BlockInfoData, target: &BlockInfoData) -> Result<(), ClientError> {
        if target.notebook_id != root.notebook_id
            || target.path != root.path
            || target.root_id != root.root_id
        {
            return Err(ClientError::ResponseTypeMismatch);
        }
        Ok(())
    }

    fn require_append_parent(
        root: &BlockInfoData,
        parent_id: &str,
        parent: &BlockInfoData,
    ) -> Result<(), ClientError> {
        if Self::require_same_map(root, parent).is_ok() {
            return Ok(());
        }
        let Some(root_stem) = root.path.strip_suffix(".sy") else {
            return Err(ClientError::ResponseTypeMismatch);
        };
        let child_prefix = format!("{root_stem}/");
        let contains_traversal_segment = parent
            .path
            .split('/')
            .any(|segment| segment == "." || segment == "..");
        if parent.notebook_id != root.notebook_id
            || parent.root_id != parent_id
            || !parent.path.starts_with(&child_prefix)
            || !parent.path.ends_with(".sy")
            || contains_traversal_segment
        {
            return Err(ClientError::ResponseTypeMismatch);
        }
        Ok(())
    }

    fn require_map_target(&self, map_root_id: &str, target_id: &str) -> Result<(), ClientError> {
        let root = self.map_root_info(map_root_id)?;
        if target_id != map_root_id {
            let target = self.block_info(target_id)?;
            // A mutation may target a block inside a descendant document.
            // Its authoritative document root, not the block ID, defines membership.
            Self::require_append_parent(&root, &target.root_id, &target)?;
        }
        Ok(())
    }

    fn inbound_backlinks(&self, id: &str) -> Result<Vec<String>, ClientError> {
        let data: BacklinkData = self.post(
            "/api/ref/getBacklink2",
            json!({
                "id": id,
                "k": "",
                "mk": "",
                "sort": "3",
                "mSort": "3",
                "containChildren": false,
            }),
        )?;
        if data.backlinks.len() > MAX_RELATION_RESULTS
            || data.backmentions.len() > MAX_RELATION_RESULTS
        {
            return Err(ClientError::ResponseTooLarge);
        }
        if data.unchanged || data.revision.is_empty() || !data.k.is_empty() || !data.mk.is_empty() {
            return Err(ClientError::ResponseTypeMismatch);
        }
        let mut seen = HashSet::new();
        let mut block_ids = Vec::with_capacity(data.backlinks.len());
        for backlink in data.backlinks {
            validate_identifier(&backlink.id)?;
            if seen.insert(backlink.id.clone()) {
                block_ids.push(backlink.id);
            }
        }
        Ok(block_ids)
    }

    fn create_document(
        &self,
        notebook_id: &str,
        document_path: &str,
        markdown: &str,
    ) -> Result<String, ClientError> {
        self.post(
            "/api/filetree/createDocWithMd",
            json!({
                "notebook": notebook_id,
                "path": document_path,
                "markdown": markdown,
            }),
        )
    }

    fn create_document_under_parent(
        &self,
        notebook_id: &str,
        map_root_id: &str,
        parent_id: &str,
        staging_path: &str,
        markdown: &str,
        marker: &str,
    ) -> Result<String, ClientError> {
        // SiYuan's document move path flushes and refreshes shared filesystem/index state.
        // Tauri commands construct independent transports, so keep the complete
        // receipt/create/move/verify boundary single-flight across those instances.
        let _guard = DOCUMENT_CREATE_MOVE_GUARD
            .lock()
            .map_err(|_| ClientError::TransportUnavailable)?;
        let root = self.map_root_info(map_root_id)?;
        if root.notebook_id != notebook_id {
            return Err(ClientError::ResponseTypeMismatch);
        }
        if parent_id != map_root_id {
            let parent = self.block_info(parent_id)?;
            Self::require_append_parent(&root, parent_id, &parent)?;
        }
        let mut recovered = Vec::new();
        let mut staged = Vec::new();
        for candidate in self.search(marker, MAX_SEARCH_RESULTS)? {
            if candidate.notebook_id != notebook_id {
                continue;
            }
            let document_id = candidate
                .path
                .rsplit('/')
                .next()
                .and_then(|filename| filename.strip_suffix(".sy"))
                .ok_or(ClientError::ResponseTypeMismatch)?;
            validate_identifier(document_id)?;
            let info = self.block_info(document_id)?;
            let observed_markdown = self.block_markdown(document_id)?;
            if info.notebook_id != notebook_id
                || info.root_id != document_id
                || !markdown_matches_managed_marker(&observed_markdown, markdown, marker)
            {
                continue;
            }
            if Self::require_append_parent(&root, document_id, &info).is_ok() {
                recovered.push(document_id.to_owned());
            } else if self.document_hpath(document_id)? == staging_path {
                staged.push(document_id.to_owned());
            }
        }
        recovered.sort();
        recovered.dedup();
        match recovered.as_slice() {
            [id] => return Ok(id.clone()),
            [] => {}
            _ => return Err(ClientError::ResponseTypeMismatch),
        }
        staged.sort();
        staged.dedup();
        let id = match staged.as_slice() {
            [id] => id.clone(),
            [] => self.create_document(notebook_id, staging_path, markdown)?,
            _ => return Err(ClientError::ResponseTypeMismatch),
        };
        let staged = self.block_info(&id)?;
        if staged.notebook_id != notebook_id || staged.root_id != id {
            return Err(ClientError::ResponseTypeMismatch);
        }
        let observed_markdown = self.block_markdown(&id)?;
        if !markdown_matches_managed_marker(&observed_markdown, markdown, marker) {
            return Err(ClientError::Conflict);
        }
        let move_result: Result<Value, ClientError> = self.post(
            "/api/filetree/moveDocsByID",
            json!({ "fromIDs": [id], "toID": parent_id }),
        );
        let moved = self.block_info(&id)?;
        if let Err(error) = Self::require_append_parent(&root, &id, &moved) {
            return Err(move_result.err().unwrap_or(error));
        }
        // A non-zero/lost move response is ambiguous. Exact post-move notebook/path
        // authority is the receipt; never issue a second move when it proves success.
        let _ = move_result;
        Ok(id)
    }

    fn document_hpath(&self, id: &str) -> Result<String, ClientError> {
        self.post("/api/filetree/getHPathByID", json!({ "id": id }))
    }

    fn batch_append_blocks(
        &self,
        notebook_id: &str,
        map_root_id: &str,
        blocks: &[AppendBlockInput],
    ) -> Result<Vec<String>, ClientError> {
        let root = self.map_root_info(map_root_id)?;
        if root.notebook_id != notebook_id {
            return Err(ClientError::ResponseTypeMismatch);
        }
        let mut verified_parents = HashSet::new();
        for block in blocks {
            if verified_parents.insert(block.parent_id.as_str()) && block.parent_id != map_root_id {
                let info = self.block_info(&block.parent_id)?;
                Self::require_append_parent(&root, &block.parent_id, &info)?;
            }
        }
        let request_batches = split_batch_append_requests(blocks);
        let mut ids = Vec::with_capacity(blocks.len());
        for parent_batch in request_batches {
            let transactions: Vec<TransactionWire> = self.post(
                "/api/block/batchAppendBlock",
                json!({
                    "blocks": parent_batch
                        .iter()
                        .map(|block| json!({
                            "data": block.markdown,
                            "dataType": "markdown",
                            "parentID": block.parent_id,
                        }))
                        .collect::<Vec<_>>()
                }),
            )?;
            if transactions.len() != parent_batch.len() {
                return Err(ClientError::ResponseTypeMismatch);
            }
            for (transaction, input) in transactions.into_iter().zip(parent_batch) {
                if transaction.do_operations.len() != 1 {
                    return Err(ClientError::ResponseTypeMismatch);
                }
                let operation = transaction
                    .do_operations
                    .into_iter()
                    .next()
                    .ok_or(ClientError::ResponseTypeMismatch)?;
                validate_identifier(&operation.id)?;
                // SiYuan normalizes the internal `appendInsert` transaction
                // action to the public API response action `insert` after
                // PerformTransactions assigns the final block ID.
                if operation.action != "insert" || operation.parent_id != input.parent_id {
                    return Err(ClientError::ResponseTypeMismatch);
                }
                ids.push(operation.id);
            }
        }
        Ok(ids)
    }

    fn update_block(
        &self,
        map_root_id: &str,
        id: &str,
        expected_markdown: &str,
        markdown: &str,
    ) -> Result<(), ClientError> {
        self.require_map_target(map_root_id, id)?;
        if self.block_markdown(id)? != expected_markdown {
            return Err(ClientError::Conflict);
        }
        let _: Value = self.post(
            "/api/block/updateBlock",
            json!({ "id": id, "dataType": "markdown", "data": markdown }),
        )?;
        Ok(())
    }

    fn delete_block(
        &self,
        map_root_id: &str,
        id: &str,
        expected_markdown: &str,
    ) -> Result<(), ClientError> {
        self.require_map_target(map_root_id, id)?;
        if self.block_markdown(id)? != expected_markdown {
            return Err(ClientError::Conflict);
        }
        let _: Value = self.post("/api/block/deleteBlock", json!({ "id": id }))?;
        Ok(())
    }

    fn create_daily_note(&self, notebook_id: &str) -> Result<String, ClientError> {
        let data: DailyNoteData = self.post(
            "/api/filetree/createDailyNote",
            json!({ "notebook": notebook_id }),
        )?;
        Ok(data.id)
    }

    fn create_snapshot(&self, memo: &str) -> Result<(), ClientError> {
        let _: Value = self.post("/api/repo/createSnapshot", json!({ "memo": memo }))?;
        Ok(())
    }
}

impl SiyuanTransport for HttpSiyuanTransport {
    fn send(&self, request: BrokerRequest<'_>) -> Result<BrokerResponse, ClientError> {
        match request {
            BrokerRequest::Status => self.runtime_version().map(|_| {
                BrokerResponse::Status(RuntimeStatus {
                    feature_enabled: true,
                    runtime_bundled: true,
                    state: "ready".to_owned(),
                })
            }),
            BrokerRequest::ListNotebooks => self.notebooks().map(BrokerResponse::Notebooks),
            BrokerRequest::CreateNotebook { name } => self
                .create_notebook(name)
                .map(BrokerResponse::NotebookCreated),
            BrokerRequest::SearchBlocks { query, limit } => {
                self.search(query, limit).map(BrokerResponse::SearchResults)
            }
            BrokerRequest::GetBlock { id } => self.block(id).map(BrokerResponse::Block),
            BrokerRequest::ListInboundBacklinks { id } => self
                .inbound_backlinks(id)
                .map(BrokerResponse::BlockRelationIds),
            BrokerRequest::CreateDocument {
                notebook_id,
                path,
                markdown,
            } => self
                .create_document(notebook_id, path, markdown)
                .map(BrokerResponse::Identifier),
            BrokerRequest::CreateDocumentUnderParent {
                notebook_id,
                map_root_id,
                parent_id,
                staging_path,
                markdown,
                marker,
            } => self
                .create_document_under_parent(
                    notebook_id,
                    map_root_id,
                    parent_id,
                    staging_path,
                    markdown,
                    marker,
                )
                .map(BrokerResponse::Identifier),
            BrokerRequest::BatchAppendBlocks {
                notebook_id,
                map_root_id,
                blocks,
            } => self
                .batch_append_blocks(notebook_id, map_root_id, blocks)
                .map(BrokerResponse::Identifiers),
            BrokerRequest::UpdateBlock {
                map_root_id,
                id,
                expected_markdown,
                markdown,
            } => self
                .update_block(map_root_id, id, expected_markdown, markdown)
                .map(|_| BrokerResponse::MutationApplied),
            BrokerRequest::DeleteBlock {
                map_root_id,
                id,
                expected_markdown,
            } => self
                .delete_block(map_root_id, id, expected_markdown)
                .map(|_| BrokerResponse::MutationApplied),
            BrokerRequest::CreateDailyNote { notebook_id } => self
                .create_daily_note(notebook_id)
                .map(BrokerResponse::Identifier),
            BrokerRequest::CreateSnapshot { memo } => self
                .create_snapshot(memo)
                .map(|_| BrokerResponse::MutationApplied),
        }
    }
}

pub trait SiyuanTransport {
    fn send(&self, request: BrokerRequest<'_>) -> Result<BrokerResponse, ClientError>;
}

pub struct SiyuanClient<T> {
    feature_enabled: bool,
    transport: T,
}

impl<T: SiyuanTransport> SiyuanClient<T> {
    pub fn new(feature_enabled: bool, transport: T) -> Self {
        Self {
            feature_enabled,
            transport,
        }
    }

    fn require_enabled(&self) -> Result<(), ClientError> {
        if self.feature_enabled {
            Ok(())
        } else {
            Err(ClientError::FeatureDisabled)
        }
    }

    pub fn status(&self) -> Result<RuntimeStatus, ClientError> {
        self.require_enabled()?;
        match self.transport.send(BrokerRequest::Status)? {
            BrokerResponse::Status(status) => Ok(status),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn list_notebooks(&self) -> Result<Vec<Notebook>, ClientError> {
        self.require_enabled()?;
        match self.transport.send(BrokerRequest::ListNotebooks)? {
            BrokerResponse::Notebooks(notebooks) => Ok(notebooks),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn create_notebook(&self, name: &str) -> Result<Notebook, ClientError> {
        self.require_enabled()?;
        validate_notebook_name(name)?;
        match self
            .transport
            .send(BrokerRequest::CreateNotebook { name })?
        {
            BrokerResponse::NotebookCreated(notebook) => {
                validate_identifier(&notebook.id)?;
                validate_notebook_name(&notebook.name)?;
                Ok(notebook)
            }
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn search_blocks(&self, query: &str, limit: u16) -> Result<Vec<BlockSummary>, ClientError> {
        self.require_enabled()?;
        validate_query(query)?;
        if limit == 0 || limit > MAX_SEARCH_RESULTS {
            return Err(ClientError::InvalidLimit);
        }
        match self
            .transport
            .send(BrokerRequest::SearchBlocks { query, limit })?
        {
            BrokerResponse::SearchResults(results) => {
                if results.len() > usize::from(limit)
                    || results
                        .iter()
                        .any(|block| block.content.len() > MAX_BLOCK_CONTENT_BYTES)
                {
                    Err(ClientError::ResponseTooLarge)
                } else {
                    Ok(results)
                }
            }
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn get_block(&self, id: &str) -> Result<Block, ClientError> {
        self.require_enabled()?;
        validate_identifier(id)?;
        match self.transport.send(BrokerRequest::GetBlock { id })? {
            BrokerResponse::Block(block) if block.markdown.len() <= MAX_BLOCK_CONTENT_BYTES => {
                Ok(block)
            }
            BrokerResponse::Block(_) => Err(ClientError::ResponseTooLarge),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn list_inbound_backlinks(&self, id: &str) -> Result<Vec<String>, ClientError> {
        self.require_enabled()?;
        validate_identifier(id)?;
        match self
            .transport
            .send(BrokerRequest::ListInboundBacklinks { id })?
        {
            BrokerResponse::BlockRelationIds(ids) => validate_relation_ids(ids),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn create_document(
        &self,
        notebook_id: &str,
        document_path: &str,
        markdown: &str,
    ) -> Result<String, ClientError> {
        self.require_enabled()?;
        validate_identifier(notebook_id)?;
        validate_document_path(document_path)?;
        validate_markdown(markdown)?;
        match self.transport.send(BrokerRequest::CreateDocument {
            notebook_id,
            path: document_path,
            markdown,
        })? {
            BrokerResponse::Identifier(id) => {
                validate_identifier(&id)?;
                Ok(id)
            }
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn create_document_under_parent(
        &self,
        notebook_id: &str,
        map_root_id: &str,
        parent_id: &str,
        staging_path: &str,
        markdown: &str,
        marker: &str,
    ) -> Result<String, ClientError> {
        self.require_enabled()?;
        validate_identifier(notebook_id)?;
        validate_identifier(map_root_id)?;
        validate_identifier(parent_id)?;
        validate_document_path(staging_path)?;
        validate_markdown(markdown)?;
        validate_query(marker)?;
        match self
            .transport
            .send(BrokerRequest::CreateDocumentUnderParent {
                notebook_id,
                map_root_id,
                parent_id,
                staging_path,
                markdown,
                marker,
            })? {
            BrokerResponse::Identifier(id) => {
                validate_identifier(&id)?;
                Ok(id)
            }
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn batch_append_blocks(
        &self,
        notebook_id: &str,
        map_root_id: &str,
        blocks: &[AppendBlockInput],
    ) -> Result<Vec<String>, ClientError> {
        self.require_enabled()?;
        validate_identifier(notebook_id)?;
        validate_identifier(map_root_id)?;
        if blocks.is_empty() || blocks.len() > MAX_BATCH_BLOCKS {
            return Err(ClientError::InvalidLimit);
        }
        let mut total_bytes = 0usize;
        for block in blocks {
            validate_identifier(&block.parent_id)?;
            validate_markdown(&block.markdown)?;
            total_bytes = total_bytes
                .checked_add(block.markdown.len())
                .ok_or(ClientError::InvalidContent)?;
        }
        if total_bytes > MAX_BATCH_BLOCK_TOTAL_BYTES {
            return Err(ClientError::InvalidContent);
        }
        match self.transport.send(BrokerRequest::BatchAppendBlocks {
            notebook_id,
            map_root_id,
            blocks,
        })? {
            BrokerResponse::Identifiers(ids) if ids.len() == blocks.len() => {
                let mut seen = HashSet::new();
                for id in &ids {
                    validate_identifier(id)?;
                    if !seen.insert(id) {
                        return Err(ClientError::ResponseTypeMismatch);
                    }
                }
                Ok(ids)
            }
            BrokerResponse::Identifiers(_) => Err(ClientError::ResponseTypeMismatch),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn update_block(
        &self,
        map_root_id: &str,
        id: &str,
        expected_markdown: &str,
        markdown: &str,
    ) -> Result<(), ClientError> {
        self.require_enabled()?;
        validate_identifier(map_root_id)?;
        validate_identifier(id)?;
        validate_markdown(expected_markdown)?;
        validate_markdown(markdown)?;
        match self.transport.send(BrokerRequest::UpdateBlock {
            map_root_id,
            id,
            expected_markdown,
            markdown,
        })? {
            BrokerResponse::MutationApplied => Ok(()),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn delete_block(
        &self,
        map_root_id: &str,
        id: &str,
        expected_markdown: &str,
    ) -> Result<(), ClientError> {
        self.require_enabled()?;
        validate_identifier(map_root_id)?;
        validate_identifier(id)?;
        validate_markdown(expected_markdown)?;
        match self.transport.send(BrokerRequest::DeleteBlock {
            map_root_id,
            id,
            expected_markdown,
        })? {
            BrokerResponse::MutationApplied => Ok(()),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn create_daily_note(&self, notebook_id: &str) -> Result<String, ClientError> {
        self.require_enabled()?;
        validate_identifier(notebook_id)?;
        match self
            .transport
            .send(BrokerRequest::CreateDailyNote { notebook_id })?
        {
            BrokerResponse::Identifier(id) => {
                validate_identifier(&id)?;
                Ok(id)
            }
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }

    pub fn create_snapshot(&self, memo: &str) -> Result<(), ClientError> {
        self.require_enabled()?;
        validate_snapshot_memo(memo)?;
        match self
            .transport
            .send(BrokerRequest::CreateSnapshot { memo })?
        {
            BrokerResponse::MutationApplied => Ok(()),
            _ => Err(ClientError::ResponseTypeMismatch),
        }
    }
}

fn validate_identifier(value: &str) -> Result<(), ClientError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Err(ClientError::InvalidIdentifier)
    } else {
        Ok(())
    }
}

fn validate_relation_ids(ids: Vec<String>) -> Result<Vec<String>, ClientError> {
    if ids.len() > MAX_RELATION_RESULTS {
        return Err(ClientError::ResponseTooLarge);
    }
    let mut seen = HashSet::new();
    for id in &ids {
        validate_identifier(id)?;
        if !seen.insert(id) {
            return Err(ClientError::ResponseTypeMismatch);
        }
    }
    Ok(ids)
}

fn validate_query(value: &str) -> Result<(), ClientError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_QUERY_BYTES
        || trimmed.chars().any(char::is_control)
    {
        Err(ClientError::InvalidQuery)
    } else {
        Ok(())
    }
}

fn managed_node_marker_regex(query: &str) -> Result<Option<String>, ClientError> {
    const PREFIX: &str = "vibespace-context-node:v1 map=";
    let Some(marker) = query.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    let Some((map_id, node_id)) = marker.split_once(" node=") else {
        return Err(ClientError::InvalidQuery);
    };
    if map_id.is_empty()
        || map_id.len() > 200
        || !map_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || node_id.is_empty()
        || node_id.len() > 500
        || !is_encode_uri_component(node_id)
    {
        return Err(ClientError::InvalidQuery);
    }

    let mut regex = String::with_capacity(query.len().saturating_mul(2));
    for ch in query.chars() {
        if r"\.+*?()|[]{}^$".contains(ch) {
            regex.push('\\');
        }
        regex.push(ch);
    }
    if regex.len() > MAX_QUERY_BYTES {
        return Err(ClientError::InvalidQuery);
    }
    Ok(Some(regex))
}

fn is_encode_uri_component(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            index += 1;
            continue;
        }
        if byte == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit()
        {
            index += 3;
            continue;
        }
        return false;
    }
    true
}

fn validate_notebook_name(value: &str) -> Result<(), ClientError> {
    if value.trim().is_empty()
        || value.len() > 256
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        Err(ClientError::InvalidContent)
    } else {
        Ok(())
    }
}

fn validate_document_path(value: &str) -> Result<(), ClientError> {
    if !value.starts_with('/')
        || value.len() > MAX_DOCUMENT_PATH_BYTES
        || value.contains('\0')
        || value
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        Err(ClientError::InvalidPath)
    } else {
        Ok(())
    }
}

fn validate_markdown(value: &str) -> Result<(), ClientError> {
    if value.is_empty() || value.len() > MAX_BLOCK_CONTENT_BYTES || value.contains('\0') {
        Err(ClientError::InvalidContent)
    } else {
        Ok(())
    }
}

fn validate_snapshot_memo(value: &str) -> Result<(), ClientError> {
    if value.trim().is_empty()
        || value.len() > MAX_SNAPSHOT_MEMO_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
    {
        Err(ClientError::InvalidContent)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{self, Receiver};
    use std::thread::JoinHandle;

    struct MockTransport {
        requests: RefCell<Vec<String>>,
        response: BrokerResponse,
    }

    impl MockTransport {
        fn new(response: BrokerResponse) -> Self {
            Self {
                requests: RefCell::new(Vec::new()),
                response,
            }
        }
    }

    impl SiyuanTransport for MockTransport {
        fn send(&self, request: BrokerRequest<'_>) -> Result<BrokerResponse, ClientError> {
            let request = match request {
                BrokerRequest::Status => "status".to_owned(),
                BrokerRequest::ListNotebooks => "list_notebooks".to_owned(),
                BrokerRequest::CreateNotebook { name } => {
                    format!("create_notebook:{}", name.len())
                }
                BrokerRequest::SearchBlocks { query, limit } => format!("search:{query}:{limit}"),
                BrokerRequest::GetBlock { id } => format!("get:{id}"),
                BrokerRequest::ListInboundBacklinks { id } => format!("inbound:{id}"),
                BrokerRequest::CreateDocument {
                    notebook_id,
                    path,
                    markdown,
                } => format!("create:{notebook_id}:{path}:{}", markdown.len()),
                BrokerRequest::CreateDocumentUnderParent {
                    notebook_id,
                    map_root_id,
                    parent_id,
                    staging_path,
                    markdown,
                    marker,
                } => format!(
                    "create_under_parent:{notebook_id}:{map_root_id}:{parent_id}:{staging_path}:{}:{}",
                    markdown.len(), marker.len()
                ),
                BrokerRequest::BatchAppendBlocks {
                    notebook_id,
                    map_root_id,
                    blocks,
                } => format!("batch_append:{notebook_id}:{map_root_id}:{}", blocks.len()),
                BrokerRequest::UpdateBlock {
                    map_root_id,
                    id,
                    expected_markdown,
                    markdown,
                } => format!(
                    "update:{map_root_id}:{id}:{}:{}",
                    expected_markdown.len(),
                    markdown.len()
                ),
                BrokerRequest::DeleteBlock {
                    map_root_id,
                    id,
                    expected_markdown,
                } => format!("delete:{map_root_id}:{id}:{}", expected_markdown.len()),
                BrokerRequest::CreateDailyNote { notebook_id } => {
                    format!("daily_note:{notebook_id}")
                }
                BrokerRequest::CreateSnapshot { memo } => {
                    format!("snapshot:{}", memo.len())
                }
            };
            self.requests.borrow_mut().push(request);
            Ok(self.response.clone())
        }
    }

    fn mock_http_server_with_delays(
        responses: Vec<(String, Duration)>,
    ) -> (u16, Receiver<String>, JoinHandle<()>) {
        let listener = TcpListener::bind((LOOPBACK_HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            for (response_body, delay) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                let mut content_length = 0_usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(length) = line.to_ascii_lowercase().strip_prefix("content-length: ")
                    {
                        content_length = length.trim().parse().unwrap();
                    }
                    request.push_str(&line);
                }
                let mut body = vec![0_u8; content_length];
                reader.read_exact(&mut body).unwrap();
                request.push_str(&String::from_utf8(body).unwrap());
                sender.send(request).unwrap();
                std::thread::sleep(delay);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: siyuan=vibespace-native-session; Path=/; HttpOnly; SameSite=Lax\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
            }
        });
        (port, receiver, handle)
    }

    fn mock_http_server(responses: Vec<String>) -> (u16, Receiver<String>, JoinHandle<()>) {
        mock_http_server_with_delays(
            responses
                .into_iter()
                .map(|response| (response, Duration::ZERO))
                .collect(),
        )
    }

    #[test]
    fn disabled_client_never_reaches_transport() {
        let transport = MockTransport::new(BrokerResponse::Status(RuntimeStatus {
            feature_enabled: true,
            state: "ready".to_owned(),
            runtime_bundled: true,
        }));
        let client = SiyuanClient::new(false, transport);
        assert_eq!(client.status(), Err(ClientError::FeatureDisabled));
        assert!(client.transport.requests.borrow().is_empty());
    }

    #[test]
    fn typed_search_emits_only_the_closed_broker_request() {
        let transport = MockTransport::new(BrokerResponse::SearchResults(vec![BlockSummary {
            id: "block-1".to_owned(),
            notebook_id: "notebook-1".to_owned(),
            path: "/spec".to_owned(),
            content: "Pinned v3.8.1".to_owned(),
        }]));
        let client = SiyuanClient::new(true, transport);
        let result = client
            .search_blocks("pinned", 10)
            .expect("typed search response");
        assert_eq!(result[0].id, "block-1");
        assert_eq!(
            client.transport.requests.borrow().as_slice(),
            ["search:pinned:10"]
        );
    }

    #[test]
    fn typed_relation_requests_validate_ids_counts_and_response_variants() {
        let malformed = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::BlockRelationIds(vec![
                "../escape".to_owned()
            ])),
        );
        assert_eq!(
            malformed.list_inbound_backlinks("target-1"),
            Err(ClientError::InvalidIdentifier)
        );
        let duplicate = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::BlockRelationIds(vec![
                "source-1".to_owned(),
                "source-1".to_owned(),
            ])),
        );
        assert_eq!(
            duplicate.list_inbound_backlinks("target-1"),
            Err(ClientError::ResponseTypeMismatch)
        );
        let over_limit = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::BlockRelationIds(
                (0..=MAX_RELATION_RESULTS)
                    .map(|index| format!("block-{index}"))
                    .collect(),
            )),
        );
        assert_eq!(
            over_limit.list_inbound_backlinks("target-1"),
            Err(ClientError::ResponseTooLarge)
        );
    }

    #[test]
    fn request_bounds_are_enforced_before_transport() {
        let transport = MockTransport::new(BrokerResponse::SearchResults(Vec::new()));
        let client = SiyuanClient::new(true, transport);
        assert_eq!(
            client.search_blocks("select\n*", 10),
            Err(ClientError::InvalidQuery)
        );
        assert_eq!(
            client.search_blocks("ok", 0),
            Err(ClientError::InvalidLimit)
        );
        assert!(client.transport.requests.borrow().is_empty());
    }

    #[test]
    fn typed_managed_write_requests_are_closed_and_content_redacted_from_audit_shape() {
        let notebook = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::NotebookCreated(Notebook {
                id: "20260820-notebook".to_owned(),
                name: "VibeSpace Project Vault".to_owned(),
                closed: false,
            })),
        );
        assert_eq!(
            notebook
                .create_notebook("VibeSpace Project Vault")
                .unwrap()
                .id,
            "20260820-notebook"
        );
        assert_eq!(
            notebook.transport.requests.borrow().as_slice(),
            ["create_notebook:23"]
        );

        let create = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifier("20260820-document".to_owned())),
        );
        assert_eq!(
            create
                .create_document("20260820-notebook", "/Decision", "# confidential")
                .unwrap(),
            "20260820-document"
        );
        assert_eq!(
            create.transport.requests.borrow().as_slice(),
            ["create:20260820-notebook:/Decision:14"]
        );

        let create_under_parent = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifier("20260820-child".to_owned())),
        );
        assert_eq!(
            create_under_parent
                .create_document_under_parent(
                    "20260820-notebook",
                    "20260820-maproot",
                    "20260820-parent",
                    "/VibeSpace Staging/20260820-maproot/node",
                    "# confidential",
                    "vibespace-context-node:v1 map=map-1 node=child",
                )
                .unwrap(),
            "20260820-child"
        );
        assert_eq!(
            create_under_parent.transport.requests.borrow().as_slice(),
            ["create_under_parent:20260820-notebook:20260820-maproot:20260820-parent:/VibeSpace Staging/20260820-maproot/node:14:46"]
        );

        let update = SiyuanClient::new(true, MockTransport::new(BrokerResponse::MutationApplied));
        update
            .update_block(
                "20260820-document",
                "20260820-document",
                "# before",
                "# after",
            )
            .unwrap();
        assert_eq!(
            update.transport.requests.borrow().as_slice(),
            ["update:20260820-document:20260820-document:8:7"]
        );

        let delete = SiyuanClient::new(true, MockTransport::new(BrokerResponse::MutationApplied));
        delete
            .delete_block("20260820-document", "20260820-document", "# expected")
            .unwrap();
        assert_eq!(
            delete.transport.requests.borrow().as_slice(),
            ["delete:20260820-document:20260820-document:10"]
        );

        let daily = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifier("20260820-daily".to_owned())),
        );
        assert_eq!(
            daily.create_daily_note("20260820-notebook").unwrap(),
            "20260820-daily"
        );
        assert_eq!(
            daily.transport.requests.borrow().as_slice(),
            ["daily_note:20260820-notebook"]
        );

        let snapshot = SiyuanClient::new(true, MockTransport::new(BrokerResponse::MutationApplied));
        snapshot.create_snapshot("Nightly run 2026-08-20").unwrap();
        assert_eq!(
            snapshot.transport.requests.borrow().as_slice(),
            ["snapshot:22"]
        );
    }

    #[test]
    fn managed_write_bounds_fail_before_transport() {
        let create = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifier("unused".to_owned())),
        );
        assert_eq!(
            create.create_document("20260820-notebook", "../escape", "# note"),
            Err(ClientError::InvalidPath)
        );
        assert_eq!(
            create.create_document("20260820-notebook", "/safe", ""),
            Err(ClientError::InvalidContent)
        );
        assert!(create.transport.requests.borrow().is_empty());

        let snapshot = SiyuanClient::new(true, MockTransport::new(BrokerResponse::MutationApplied));
        assert_eq!(
            snapshot.create_snapshot("line\nbreak"),
            Err(ClientError::InvalidContent)
        );
        assert!(snapshot.transport.requests.borrow().is_empty());
    }

    #[test]
    fn batch_append_bounds_and_duplicate_response_ids_fail_closed() {
        assert_eq!(MAX_BATCH_BLOCK_TOTAL_BYTES, 262_144);
        let blocks = vec![
            AppendBlockInput {
                parent_id: "parent-1".to_owned(),
                markdown: "# First".to_owned(),
            },
            AppendBlockInput {
                parent_id: "parent-2".to_owned(),
                markdown: "# Second".to_owned(),
            },
        ];
        let ordered = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifiers(vec![
                "child-1".to_owned(),
                "child-2".to_owned(),
            ])),
        );
        assert_eq!(
            ordered
                .batch_append_blocks("20260820-notebook", "map-root", &blocks)
                .unwrap(),
            ["child-1", "child-2"]
        );
        assert_eq!(
            ordered.transport.requests.borrow().as_slice(),
            ["batch_append:20260820-notebook:map-root:2"]
        );

        let invalid_count = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifiers(Vec::new())),
        );
        assert_eq!(
            invalid_count.batch_append_blocks("20260820-notebook", "map-root", &[]),
            Err(ClientError::InvalidLimit)
        );
        let too_many = (0..=MAX_BATCH_BLOCKS)
            .map(|index| AppendBlockInput {
                parent_id: format!("parent-{index}"),
                markdown: "x".to_owned(),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            invalid_count.batch_append_blocks("20260820-notebook", "map-root", &too_many),
            Err(ClientError::InvalidLimit)
        );
        assert!(invalid_count.transport.requests.borrow().is_empty());

        let exact_limit = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifiers(vec!["child-limit".to_owned()])),
        );
        assert_eq!(
            exact_limit
                .batch_append_blocks(
                    "20260820-notebook",
                    "map-root",
                    &[AppendBlockInput {
                        parent_id: "map-root".to_owned(),
                        markdown: "x".repeat(MAX_BATCH_BLOCK_TOTAL_BYTES),
                    }],
                )
                .unwrap(),
            ["child-limit"]
        );

        let oversized = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Identifiers(vec!["unused".to_owned()])),
        );
        assert_eq!(
            oversized.batch_append_blocks(
                "20260820-notebook",
                "map-root",
                &[AppendBlockInput {
                    parent_id: "parent-1".to_owned(),
                    markdown: "x".repeat(MAX_BATCH_BLOCK_TOTAL_BYTES + 1),
                }],
            ),
            Err(ClientError::InvalidContent)
        );
        assert!(oversized.transport.requests.borrow().is_empty());

        for response in [
            BrokerResponse::Identifiers(vec!["child-1".to_owned()]),
            BrokerResponse::Identifiers(vec!["child-1".to_owned(), "child-1".to_owned()]),
        ] {
            let malformed = SiyuanClient::new(true, MockTransport::new(response));
            assert_eq!(
                malformed.batch_append_blocks("20260820-notebook", "map-root", &blocks),
                Err(ClientError::ResponseTypeMismatch)
            );
        }
    }

    #[test]
    fn response_variants_and_payload_sizes_are_fail_closed() {
        let mismatch = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Notebooks(Vec::new())),
        );
        assert_eq!(mismatch.status(), Err(ClientError::ResponseTypeMismatch));

        let too_large = SiyuanClient::new(
            true,
            MockTransport::new(BrokerResponse::Block(Block {
                id: "block-1".to_owned(),
                notebook_id: "notebook-1".to_owned(),
                path: "/spec".to_owned(),
                markdown: "x".repeat(MAX_BLOCK_CONTENT_BYTES + 1),
            })),
        );
        assert_eq!(
            too_large.get_block("block-1"),
            Err(ClientError::ResponseTooLarge)
        );
    }

    #[test]
    fn errors_are_stable_codes_without_transport_or_token_detail() {
        let rendered = ClientError::TransportUnavailable.to_string();
        assert_eq!(rendered, "siyuan_transport_unavailable");
        assert!(!rendered.contains("token"));
        assert!(!rendered.contains("http"));
    }

    #[test]
    fn native_http_transport_keeps_auth_code_in_native_login_and_uses_session_cookie() {
        let token = "0".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"notebooks":[{"id":"20260820-book","name":"Project","closed":false}]}}"#
                .to_owned(),
        ]);
        let transport = HttpSiyuanTransport::new(port, token.clone()).unwrap();
        assert!(!format!("{transport:?}").contains(token.as_str()));
        let client = SiyuanClient::new(true, transport);
        assert_eq!(client.list_notebooks().unwrap()[0].name, "Project");
        let login = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(login.contains(token.as_str()));
        assert!(request.starts_with("POST /api/notebook/lsNotebooks HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("cookie: siyuan=vibespace-native-session"));
        assert!(!request.contains(token.as_str()));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        server.join().unwrap();
    }

    #[test]
    fn native_search_transport_selects_full_text_mode_and_never_sql() {
        let token = "a".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"blocks":[{"id":"20260820-block","box":"20260820-book","path":"/spec.sy","content":"Pinned runtime"}]}}"#
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());
        assert_eq!(
            client.search_blocks("pinned", 5).unwrap()[0].id,
            "20260820-block"
        );
        let login = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(request.starts_with("POST /api/search/fullTextSearchBlock HTTP/1.1"));
        assert!(request.contains("\"method\":0"));
        assert!(request.contains("\"searchHPath\":false"));
        assert!(!request.contains("/api/query/sql"));
        assert!(!request.contains(token.as_str()));
        server.join().unwrap();
    }

    #[test]
    fn native_managed_marker_search_uses_literal_regex_mode() {
        let token = "m".repeat(32);
        // `node` is the real encodeURIComponent form. It deliberately retains
        // Go-RE2 metacharacters that must be escaped before method-3 search.
        let marker = "vibespace-context-node:v1 map=map-1 node=path%3Afile.*(thing)";
        let response = json!({
            "code": 0,
            "msg": "",
            "data": {
                "blocks": [{
                    "id": "marker-block",
                    "box": "20260820-notebook",
                    "path": "/20260820-maproot/20260820-child.sy",
                    "content": marker,
                }],
                "matchedBlockCount": 1,
                "pageCount": 1,
                "docMode": false,
            },
        })
        .to_string();
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            response,
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());
        let results = client.search_blocks(marker, 50).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, marker);

        let login = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(request.starts_with("POST /api/search/fullTextSearchBlock HTTP/1.1"));
        // The mock server captures headers and body without retaining the blank
        // separator line; the first JSON object is the request body.
        let body_start = request.find('{').expect("search request body");
        let body = &request[body_start..];
        let body: Value = serde_json::from_str(body).expect("search JSON body");
        assert_eq!(body["method"], 3);
        assert_eq!(
            body["query"],
            r"vibespace-context-node:v1 map=map-1 node=path%3Afile\.\*\(thing\)"
        );
        assert_eq!(body["page"], 1);
        assert_eq!(body["pageSize"], 50);
        assert!(!request.contains(token.as_str()));
        server.join().unwrap();
    }

    #[test]
    fn native_managed_marker_search_pages_and_fails_closed_over_requested_limit() {
        let marker = "vibespace-context-node:v1 map=map-1 node=path%3Afile.*(thing)";
        let page_response = |blocks: Value| {
            json!({
                "code": 0,
                "msg": "",
                "data": {
                    "blocks": blocks,
                    "matchedBlockCount": 3,
                    "pageCount": 2,
                    "docMode": false,
                },
            })
            .to_string()
        };
        let block = |id: &str| {
            json!({
                "id": id,
                "box": "20260820-notebook",
                "path": "/20260820-maproot/20260820-child.sy",
                "content": marker,
            })
        };
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            page_response(json!([block("child-1"), block("child-2")])),
            page_response(json!([block("child-3")])),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "m".repeat(32)).unwrap(),
        );

        assert_eq!(
            client.search_blocks(marker, 2),
            Err(ClientError::ResponseTooLarge)
        );

        let _login = requests.recv().unwrap();
        for (expected_page, request) in [1, 2]
            .into_iter()
            .zip([requests.recv().unwrap(), requests.recv().unwrap()])
        {
            let body_start = request.find('{').expect("search request body");
            let body: Value = serde_json::from_str(&request[body_start..]).unwrap();
            assert_eq!(body["method"], 3);
            assert_eq!(body["page"], expected_page);
            assert_eq!(body["pageSize"], 2);
        }
        server.join().unwrap();
    }

    #[test]
    fn native_managed_marker_search_rejects_raw_candidate_scan_over_global_cap() {
        let marker = "vibespace-context-node:v1 map=map-1 node=path%3Afile";
        let response = json!({
            "code": 0,
            "msg": "",
            "data": {
                "blocks": [{
                    "id": "child-1",
                    "box": "20260820-notebook",
                    "path": "/20260820-maproot/20260820-child.sy",
                    "content": marker,
                }],
                "matchedBlockCount": 101,
                "pageCount": 3,
                "docMode": false,
            },
        })
        .to_string();
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            response,
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "n".repeat(32)).unwrap(),
        );

        assert_eq!(
            client.search_blocks(marker, 50),
            Err(ClientError::ResponseTooLarge)
        );
        let _login = requests.recv().unwrap();
        let request = requests.recv().unwrap();
        let body_start = request.find('{').expect("search request body");
        let body: Value = serde_json::from_str(&request[body_start..]).unwrap();
        assert_eq!(body["method"], 3);
        assert_eq!(body["page"], 1);
        assert_eq!(body["pageSize"], 50);
        assert!(requests.try_recv().is_err());
        server.join().unwrap();
    }

    #[test]
    fn native_managed_marker_search_requires_exact_bounded_marker_shape() {
        assert_eq!(managed_node_marker_regex("ordinary search"), Ok(None));
        assert_eq!(
            managed_node_marker_regex("vibespace-context-node:v1 map=map-1 node=../not-encoded"),
            Err(ClientError::InvalidQuery)
        );
        let long_marker = format!(
            "vibespace-context-node:v1 map=map-1 node={}",
            "x.".repeat(200)
        );
        assert_eq!(
            managed_node_marker_regex(&long_marker),
            Err(ClientError::InvalidQuery)
        );
    }

    #[test]
    fn native_search_has_a_bounded_extended_timeout_without_widening_ordinary_requests() {
        assert_eq!(HTTP_TIMEOUT, Duration::from_secs(15));
        assert_eq!(SEARCH_HTTP_TIMEOUT, Duration::from_secs(45));

        let token = "b".repeat(32);
        let delayed = Duration::from_millis(120);
        let ordinary_timeout = Duration::from_millis(40);
        let search_timeout = Duration::from_millis(250);
        let (search_port, search_requests, search_server) = mock_http_server_with_delays(vec![
            (
                r#"{"code":0,"msg":"","data":null}"#.to_owned(),
                Duration::ZERO,
            ),
            (
                r#"{"code":0,"msg":"","data":{"blocks":[]}}"#.to_owned(),
                delayed,
            ),
        ]);
        let search_client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new_with_timeouts(
                search_port,
                token.clone(),
                ordinary_timeout,
                search_timeout,
            )
            .unwrap(),
        );
        assert_eq!(search_client.search_blocks("bounded", 5), Ok(Vec::new()));
        let search_login = search_requests.recv().unwrap();
        let search_request = search_requests.recv().unwrap();
        assert!(search_login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(search_request.starts_with("POST /api/search/fullTextSearchBlock HTTP/1.1"));
        assert!(search_request.contains("\"method\":0"));
        assert!(!search_request.contains(token.as_str()));
        search_server.join().unwrap();

        let (ordinary_port, ordinary_requests, ordinary_server) =
            mock_http_server_with_delays(vec![
                (
                    r#"{"code":0,"msg":"","data":null}"#.to_owned(),
                    Duration::ZERO,
                ),
                (
                    r#"{"code":0,"msg":"","data":{"notebooks":[]}}"#.to_owned(),
                    delayed,
                ),
            ]);
        let ordinary_client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new_with_timeouts(
                ordinary_port,
                token.clone(),
                ordinary_timeout,
                search_timeout,
            )
            .unwrap(),
        );
        assert_eq!(
            ordinary_client.list_notebooks(),
            Err(ClientError::TransportUnavailable)
        );
        let ordinary_login = ordinary_requests.recv().unwrap();
        let ordinary_request = ordinary_requests.recv().unwrap();
        assert!(ordinary_login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(ordinary_request.starts_with("POST /api/notebook/lsNotebooks HTTP/1.1"));
        assert!(!ordinary_request.contains(token.as_str()));
        ordinary_server.join().unwrap();

        let (bounded_port, bounded_requests, bounded_server) = mock_http_server_with_delays(vec![
            (
                r#"{"code":0,"msg":"","data":null}"#.to_owned(),
                Duration::ZERO,
            ),
            (
                r#"{"code":0,"msg":"","data":{"blocks":[]}}"#.to_owned(),
                delayed,
            ),
        ]);
        let bounded_client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new_with_timeouts(
                bounded_port,
                token.clone(),
                search_timeout,
                ordinary_timeout,
            )
            .unwrap(),
        );
        assert_eq!(
            bounded_client.search_blocks("bounded", 5),
            Err(ClientError::TransportUnavailable)
        );
        assert_eq!(
            ClientError::TransportUnavailable.to_string(),
            "siyuan_transport_unavailable"
        );
        let bounded_login = bounded_requests.recv().unwrap();
        let bounded_request = bounded_requests.recv().unwrap();
        assert!(bounded_login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(bounded_request.starts_with("POST /api/search/fullTextSearchBlock HTTP/1.1"));
        assert!(!bounded_request.contains(token.as_str()));
        bounded_server.join().unwrap();
    }

    #[test]
    fn native_get_block_combines_bounded_metadata_and_kramdown_endpoints() {
        let token = "f".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-book","path":"/spec.sy","rootID":"20260820-block"}}"#.to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-block","kramdown":"# Spec"}}"##
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());
        let block = client.get_block("20260820-block").unwrap();
        assert_eq!(block.notebook_id, "20260820-book");
        assert_eq!(block.markdown, "# Spec");
        let login = requests.recv().unwrap();
        let first = requests.recv().unwrap();
        let second = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(first.starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(second.starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(!first.contains(token.as_str()));
        assert!(!second.contains(token.as_str()));
        server.join().unwrap();
    }

    #[test]
    fn native_get_block_classifies_a_missing_tree_without_requesting_kramdown() {
        let token = "m".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":-1,"msg":"Content block with id [20260820-missing] not found","data":null}"#
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client.get_block("20260820-missing"),
            Err(ClientError::BlockNotFound)
        );
        assert_eq!(
            ClientError::BlockNotFound.to_string(),
            "siyuan_block_not_found"
        );

        let login = requests.recv().unwrap();
        let block_info = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(block_info.starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(!block_info.contains(token.as_str()));
        server.join().unwrap();
    }

    #[test]
    fn native_get_block_keeps_legacy_success_null_missing_semantics() {
        let token = "m".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client.get_block("20260820-missing"),
            Err(ClientError::BlockNotFound)
        );

        let login = requests.recv().unwrap();
        let block_info = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(block_info.starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        server.join().unwrap();
    }

    #[test]
    fn native_get_block_keeps_other_nonzero_envelopes_transport_fail_closed() {
        let token = "m".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":-1,"msg":"Content block with id [20260820-nearby] not found","data":null}"#
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client.get_block("20260820-missing"),
            Err(ClientError::TransportUnavailable)
        );

        let login = requests.recv().unwrap();
        let block_info = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(block_info.starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        server.join().unwrap();
    }

    #[test]
    fn native_backlinks_use_only_the_fixed_official_list_endpoint() {
        let token = "r".repeat(32);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"unchanged":false,"revision":"bl1:revision","backlinks":[{"id":"source-2","box":"book-1","name":"Source","hPath":"/Source","type":"path","nodeType":"NodeDocument","subType":"","depth":0,"count":1,"folded":false,"updated":"20260820","created":"20260820"}],"linkRefsCount":1,"backmentions":[],"mentionsCount":0,"k":"","mk":"","box":"book-1"}}"#.to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());
        assert_eq!(
            client.list_inbound_backlinks("target-1").unwrap(),
            ["source-2"]
        );

        let login = requests.recv().unwrap();
        let inbound = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(inbound.starts_with("POST /api/ref/getBacklink2 HTTP/1.1"));
        let body: Value =
            serde_json::from_str(&inbound[inbound.find('{').expect("captured request body")..])
                .unwrap();
        let mut keys = body
            .as_object()
            .expect("JSON object body")
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(keys, ["containChildren", "id", "k", "mSort", "mk", "sort"]);
        for required in [
            "\"id\":\"target-1\"",
            "\"k\":\"\"",
            "\"mk\":\"\"",
            "\"sort\":\"3\"",
            "\"mSort\":\"3\"",
            "\"containChildren\":false",
        ] {
            assert!(inbound.contains(required), "missing fixed field {required}");
        }
        assert!(!inbound.contains(&token));
        assert!(!inbound.contains("/api/query/sql"));
        assert!(!inbound.contains("getBacklinkDoc"));
        assert!(!inbound.contains("getBackmentionDoc"));
        server.join().unwrap();
    }

    #[test]
    fn native_boot_auth_version_and_shutdown_contract_is_cookie_scoped() {
        let token = "q".repeat(48);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":{"progress":100,"details":"ready"}}"#.to_owned(),
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":"3.8.1"}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"closeTimeout":0}}"#.to_owned(),
        ]);
        let transport = HttpSiyuanTransport::new(port, token.clone()).unwrap();

        assert_eq!(transport.boot_progress(), Ok(100));
        assert_eq!(transport.verify_ready_session(), Ok(()));
        assert_eq!(transport.request_shutdown(), Ok(()));

        let boot = requests.recv().unwrap();
        let login = requests.recv().unwrap();
        let version = requests.recv().unwrap();
        let shutdown = requests.recv().unwrap();
        assert!(boot.starts_with("POST /api/system/bootProgress HTTP/1.1"));
        assert!(!boot.contains(&token));
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(login.contains(&token));
        assert!(version.starts_with("POST /api/system/version HTTP/1.1"));
        assert!(shutdown.starts_with("POST /api/system/exit HTTP/1.1"));
        assert!(shutdown.contains("\"force\":false"));
        for request in [&version, &shutdown] {
            assert!(request
                .to_ascii_lowercase()
                .contains("cookie: siyuan=vibespace-native-session"));
            assert!(!request.contains(&token));
        }
        server.join().unwrap();
    }

    #[test]
    fn verified_surface_session_reuses_the_authenticated_cookie() {
        let token = "s".repeat(48);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":"3.8.1"}"#.to_owned(),
        ]);
        let transport = HttpSiyuanTransport::new(port, token.clone()).unwrap();

        let (origin, cookie) = transport.verified_surface_session().unwrap().into_parts();
        assert_eq!(origin.scheme(), "http");
        assert_eq!(origin.host_str(), Some(LOOPBACK_HOST));
        assert_eq!(origin.port(), Some(port));
        assert_eq!(cookie, "vibespace-native-session");

        let login = requests.recv().unwrap();
        let version = requests.recv().unwrap();
        assert!(login.starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(login.contains(&token));
        assert!(version.starts_with("POST /api/system/version HTTP/1.1"));
        assert!(version
            .to_ascii_lowercase()
            .contains("cookie: siyuan=vibespace-native-session"));
        assert!(!version.contains(&token));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_managed_writes_use_only_typed_cookie_scoped_official_endpoints() {
        let token = "w".repeat(48);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"notebook":{"id":"20260820-notebook","name":"VibeSpace Project Vault","closed":false}}}"#.to_owned(),
            r#"{"code":0,"msg":"","data":"20260820-document"}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"id":"20260820-daily"}}"#.to_owned(),
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/decision.sy","rootID":"20260820-document"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-document","kramdown":"# Before"}}"##
                .to_owned(),
            r#"{"code":0,"msg":"","data":[]}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/decision.sy","rootID":"20260820-document"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-document","kramdown":"# After"}}"##
                .to_owned(),
            r#"{"code":0,"msg":"","data":[]}"#.to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client
                .create_notebook("VibeSpace Project Vault")
                .unwrap()
                .id,
            "20260820-notebook"
        );
        assert_eq!(
            client
                .create_document("20260820-notebook", "/Decision", "# Before")
                .unwrap(),
            "20260820-document"
        );
        assert_eq!(
            client.create_daily_note("20260820-notebook").unwrap(),
            "20260820-daily"
        );
        client.create_snapshot("Before managed update").unwrap();
        client
            .update_block(
                "20260820-document",
                "20260820-document",
                "# Before",
                "# After",
            )
            .unwrap();
        client
            .delete_block("20260820-document", "20260820-document", "# After")
            .unwrap();

        let captured: Vec<String> = (0..11).map(|_| requests.recv().unwrap()).collect();
        assert!(captured[0].starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(captured[1].starts_with("POST /api/notebook/createNotebook HTTP/1.1"));
        assert!(captured[2].starts_with("POST /api/filetree/createDocWithMd HTTP/1.1"));
        assert!(captured[3].starts_with("POST /api/filetree/createDailyNote HTTP/1.1"));
        assert!(captured[4].starts_with("POST /api/repo/createSnapshot HTTP/1.1"));
        assert!(captured[5].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[6].starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(captured[7].starts_with("POST /api/block/updateBlock HTTP/1.1"));
        assert!(captured[8].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[9].starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(captured[10].starts_with("POST /api/block/deleteBlock HTTP/1.1"));
        assert!(captured[2].contains("\"notebook\":\"20260820-notebook\""));
        assert!(captured[7].contains("\"dataType\":\"markdown\""));
        assert!(captured[4].contains("\"memo\":\"Before managed update\""));
        for request in captured.iter().skip(1) {
            assert!(request
                .to_ascii_lowercase()
                .contains("cookie: siyuan=vibespace-native-session"));
            assert!(!request.contains(&token));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            assert!(!request.contains("/api/query/sql"));
        }
        server.join().unwrap();
    }

    #[test]
    fn native_document_create_moves_and_verifies_the_exact_active_map_parent() {
        let token = "p".repeat(48);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot.sy","rootID":"20260820-maproot"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"blocks":[]}}"#.to_owned(),
            r#"{"code":0,"msg":"","data":"20260820-child"}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-staging.sy","rootID":"20260820-child"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-child","kramdown":"# Node"}}"##
                .to_owned(),
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot/20260820-child.sy","rootID":"20260820-child"}}"#
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client
                .create_document_under_parent(
                    "20260820-notebook",
                    "20260820-maproot",
                    "20260820-maproot",
                    "/VibeSpace Staging/20260820-maproot/node",
                    "# Node",
                    "vibespace-context-node:v1 map=map-1 node=child",
                )
                .unwrap(),
            "20260820-child"
        );

        let captured = (0..8).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[0].starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(captured[1].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[2].starts_with("POST /api/search/fullTextSearchBlock HTTP/1.1"));
        assert!(captured[3].starts_with("POST /api/filetree/createDocWithMd HTTP/1.1"));
        assert!(captured[4].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[5].starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(captured[6].starts_with("POST /api/filetree/moveDocsByID HTTP/1.1"));
        assert!(captured[7].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        let move_body: Value =
            serde_json::from_str(&captured[6][captured[6].find('{').expect("move request body")..])
                .unwrap();
        assert_eq!(
            move_body,
            json!({ "fromIDs": ["20260820-child"], "toID": "20260820-maproot" })
        );
        for request in captured.iter().skip(1) {
            assert!(!request.contains(&token));
            assert!(!request.contains("/api/query/sql"));
        }
        server.join().unwrap();
    }

    #[test]
    fn exact_parent_create_recovers_the_unique_staged_receipt_and_reconciles_a_lost_move_response()
    {
        let token = "s".repeat(48);
        let marker = "vibespace-context-node:v1 map=map-1 node=child";
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot.sy","rootID":"20260820-maproot"}}"#
                .to_owned(),
            format!(
                r#"{{"code":0,"msg":"","data":{{"blocks":[{{"id":"marker-block","box":"20260820-notebook","path":"/20260820-stage/20260820-child.sy","content":"{marker}"}}]}}}}"#
            ),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-stage/20260820-child.sy","rootID":"20260820-child"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-child","kramdown":"# Node"}}"##
                .to_owned(),
            r#"{"code":0,"msg":"","data":"/VibeSpace Staging/20260820-maproot/node"}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-stage/20260820-child.sy","rootID":"20260820-child"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-child","kramdown":"# Node"}}"##
                .to_owned(),
            r#"{"code":-1,"msg":"response delivery failed","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot/20260820-child.sy","rootID":"20260820-child"}}"#
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client
                .create_document_under_parent(
                    "20260820-notebook",
                    "20260820-maproot",
                    "20260820-maproot",
                    "/VibeSpace Staging/20260820-maproot/node",
                    "# Node",
                    marker,
                )
                .unwrap(),
            "20260820-child"
        );

        let captured = (0..10)
            .map(|_| requests.recv().unwrap())
            .collect::<Vec<_>>();
        assert!(captured[5].starts_with("POST /api/filetree/getHPathByID HTTP/1.1"));
        assert!(captured[8].starts_with("POST /api/filetree/moveDocsByID HTTP/1.1"));
        assert!(!captured
            .iter()
            .any(|request| request.contains("createDocWithMd")));
        server.join().unwrap();
    }

    #[test]
    fn exact_parent_document_mutations_share_one_process_guard() {
        let first = DOCUMENT_CREATE_MOVE_GUARD.lock().unwrap();
        assert!(DOCUMENT_CREATE_MOVE_GUARD.try_lock().is_err());
        drop(first);
    }

    #[test]
    fn exact_parent_create_recovers_one_marker_receipt_before_any_second_mutation() {
        let token = "r".repeat(48);
        let marker = "vibespace-context-node:v1 map=map-1 node=child";
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot.sy","rootID":"20260820-maproot"}}"#
                .to_owned(),
            format!(
                r#"{{"code":0,"msg":"","data":{{"blocks":[{{"id":"marker-block","box":"20260820-notebook","path":"/20260820-maproot/20260820-child.sy","content":"{marker}"}}]}}}}"#
            ),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot/20260820-child.sy","rootID":"20260820-child"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-child","kramdown":"# Node"}}"##
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client
                .create_document_under_parent(
                    "20260820-notebook",
                    "20260820-maproot",
                    "20260820-maproot",
                    "/VibeSpace Staging/20260820-maproot/node",
                    "# Node",
                    marker,
                )
                .unwrap(),
            "20260820-child"
        );

        let captured = (0..5).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[2].starts_with("POST /api/search/fullTextSearchBlock HTTP/1.1"));
        assert!(!captured
            .iter()
            .any(|request| request.contains("createDocWithMd")));
        assert!(!captured
            .iter()
            .any(|request| request.contains("moveDocsByID")));
        server.join().unwrap();
    }

    #[test]
    fn exact_parent_create_accepts_marker_bound_kramdown_normalization() {
        let token = "n".repeat(48);
        let marker = "vibespace-context-node:v1 map=map-1 node=child";
        let requested = format!("<!-- {marker} -->\n# Node\n\nPath: `C:\\\\Projects\\\\demo`\n");
        let normalized = format!("<!-- {marker} -->\n# Node\n\nPath: C:\\\\Projects\\\\demo\n");
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot.sy","rootID":"20260820-maproot"}}"#
                .to_owned(),
            format!(
                r#"{{"code":0,"msg":"","data":{{"blocks":[{{"id":"marker-block","box":"20260820-notebook","path":"/20260820-maproot/20260820-child.sy","content":"{marker}"}}]}}}}"#
            ),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/20260820-maproot/20260820-child.sy","rootID":"20260820-child"}}"#
                .to_owned(),
            format!(
                r#"{{"code":0,"msg":"","data":{{"id":"20260820-child","kramdown":{}}}}}"#,
                serde_json::to_string(&normalized).unwrap()
            ),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());

        assert_eq!(
            client
                .create_document_under_parent(
                    "20260820-notebook",
                    "20260820-maproot",
                    "20260820-maproot",
                    "/VibeSpace Staging/20260820-maproot/node",
                    &requested,
                    marker,
                )
                .unwrap(),
            "20260820-child"
        );

        let captured = (0..5).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(!captured
            .iter()
            .any(|request| request.contains("createDocWithMd")));
        assert!(!captured
            .iter()
            .any(|request| request.contains("moveDocsByID")));
        server.join().unwrap();
    }

    #[test]
    fn managed_marker_matching_rejects_prefix_collisions() {
        let marker = "vibespace-context-node:v1 map=map-1 node=child";
        let requested = format!("<!-- {marker} -->\n# Node\n");
        let normalized = format!("<!-- {marker} -->\n# Normalized Node\n");
        let colliding =
            "<!-- vibespace-context-node:v1 map=map-1 node=child-extra -->\n# Other Node\n";

        assert!(markdown_matches_managed_marker(
            &requested, &requested, marker
        ));
        assert!(markdown_matches_managed_marker(
            &normalized,
            &requested,
            marker
        ));
        assert!(!markdown_matches_managed_marker(
            colliding, &requested, marker
        ));
    }

    #[test]
    fn native_batch_append_authenticates_once_verifies_unique_parents_and_preserves_order() {
        let token = "b".repeat(48);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/one.sy","rootID":"parent-1"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/one.sy","rootID":"parent-1"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":[{"doOperations":[{"action":"insert","id":"child-1","parentID":"parent-1"}]},{"doOperations":[{"action":"insert","id":"child-2","parentID":"parent-1"}]}]}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":[{"doOperations":[{"action":"insert","id":"child-3","parentID":"parent-2"}]}]}"#
                .to_owned(),
        ]);
        let client =
            SiyuanClient::new(true, HttpSiyuanTransport::new(port, token.clone()).unwrap());
        let ids = client
            .batch_append_blocks(
                "20260820-notebook",
                "parent-1",
                &[
                    AppendBlockInput {
                        parent_id: "parent-1".to_owned(),
                        markdown: "# First".to_owned(),
                    },
                    AppendBlockInput {
                        parent_id: "parent-1".to_owned(),
                        markdown: "# Second".to_owned(),
                    },
                    AppendBlockInput {
                        parent_id: "parent-2".to_owned(),
                        markdown: "# Third".to_owned(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(ids, ["child-1", "child-2", "child-3"]);

        let captured = (0..5).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[0].starts_with("POST /api/system/loginAuth HTTP/1.1"));
        assert!(captured[1].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[2].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[3].starts_with("POST /api/block/batchAppendBlock HTTP/1.1"));
        assert!(captured[4].starts_with("POST /api/block/batchAppendBlock HTTP/1.1"));
        assert_eq!(
            captured
                .iter()
                .filter(|request| request.contains("/api/system/loginAuth"))
                .count(),
            1
        );
        assert_eq!(
            captured
                .iter()
                .filter(|request| request.contains("/api/block/getBlockInfo"))
                .count(),
            2
        );
        assert_eq!(
            captured
                .iter()
                .filter(|request| request.contains("/api/block/batchAppendBlock"))
                .count(),
            2
        );
        let first_parent: Value = serde_json::from_str(
            &captured[1][captured[1].find('{').expect("first parent request body")..],
        )
        .unwrap();
        let second_parent: Value = serde_json::from_str(
            &captured[2][captured[2].find('{').expect("second parent request body")..],
        )
        .unwrap();
        assert_eq!(first_parent, json!({ "id": "parent-1" }));
        assert_eq!(second_parent, json!({ "id": "parent-2" }));
        let batch: Value = serde_json::from_str(
            &captured[3][captured[3].find('{').expect("batch request body")..],
        )
        .unwrap();
        assert_eq!(
            batch,
            json!({
                "blocks": [
                    { "data": "# First", "dataType": "markdown", "parentID": "parent-1" },
                    { "data": "# Second", "dataType": "markdown", "parentID": "parent-1" },
                ]
            })
        );
        let second_batch: Value = serde_json::from_str(
            &captured[4][captured[4].find('{').expect("second batch request body")..],
        )
        .unwrap();
        assert_eq!(
            second_batch,
            json!({
                "blocks": [
                    { "data": "# Third", "dataType": "markdown", "parentID": "parent-2" },
                ]
            })
        );
        for request in captured.iter().skip(1) {
            assert!(request
                .to_ascii_lowercase()
                .contains("cookie: siyuan=vibespace-native-session"));
            assert!(!request.contains(&token));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
        }
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_splits_same_parent_requests_by_count_and_bytes_preserving_id_order() {
        let response_for_ids = |range: std::ops::Range<usize>| {
            let transactions = range
                .map(|index| {
                    format!(
                        r#"{{"doOperations":[{{"action":"insert","id":"child-{index}","parentID":"map-root"}}]}}"#
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!(r#"{{"code":0,"msg":"","data":[{transactions}]}}"#)
        };
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map.sy","rootID":"map-root"}}"#.to_owned(),
            response_for_ids(0..8),
            response_for_ids(8..10),
            response_for_ids(10..11),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "s".repeat(48)).unwrap(),
        );
        let mut blocks = (0..9)
            .map(|index| AppendBlockInput {
                parent_id: "map-root".to_owned(),
                markdown: format!("small-{index}"),
            })
            .collect::<Vec<_>>();
        blocks.extend((9..11).map(|index| AppendBlockInput {
            parent_id: "map-root".to_owned(),
            markdown: format!(
                "large-{index}:{}",
                char::from(b'a' + index as u8).to_string().repeat(20 * 1024)
            ),
        }));

        let ids = client
            .batch_append_blocks("20260820-notebook", "map-root", &blocks)
            .expect("large same-parent inputs are split into bounded requests");
        assert_eq!(
            ids,
            (0..11)
                .map(|index| format!("child-{index}"))
                .collect::<Vec<_>>()
        );

        let captured = (0..5).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        let batch_requests = captured
            .iter()
            .filter(|request| request.contains("/api/block/batchAppendBlock"))
            .collect::<Vec<_>>();
        assert_eq!(batch_requests.len(), 3);
        let expected_sizes = [8, 2, 1];
        let mut expected_block_index = 0;
        for (request, expected_size) in batch_requests.iter().zip(expected_sizes) {
            let body_start = request.find('{').expect("batch request JSON body");
            let body: Value = serde_json::from_str(&request[body_start..]).unwrap();
            let requested_blocks = body["blocks"].as_array().unwrap();
            assert_eq!(requested_blocks.len(), expected_size);
            let markdown_bytes = requested_blocks
                .iter()
                .map(|block| block["data"].as_str().unwrap().len())
                .sum::<usize>();
            assert!(markdown_bytes <= 32 * 1024);
            for block in requested_blocks {
                assert_eq!(block["parentID"], "map-root");
                assert_eq!(
                    block["data"].as_str().unwrap(),
                    blocks[expected_block_index].markdown
                );
                expected_block_index += 1;
            }
        }
        assert_eq!(expected_block_index, blocks.len());
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_does_not_retry_when_response_size_is_ambiguous() {
        let oversized_response = format!(
            r#"{{"code":0,"msg":"","data":"{}"}}"#,
            "x".repeat(MAX_HTTP_RESPONSE_BYTES as usize + 1)
        );
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map.sy","rootID":"map-root"}}"#.to_owned(),
            oversized_response,
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "u".repeat(48)).unwrap(),
        );

        assert_eq!(
            client.batch_append_blocks(
                "20260820-notebook",
                "map-root",
                &[AppendBlockInput {
                    parent_id: "map-root".to_owned(),
                    markdown: "<!-- vibespace-context-node:v1 map=map-1 node=ambiguous -->\n# Node"
                        .to_owned(),
                }],
            ),
            Err(ClientError::ResponseTooLarge)
        );
        let captured = (0..3).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert_eq!(
            captured
                .iter()
                .filter(|request| request.contains("/api/block/batchAppendBlock"))
                .count(),
            1
        );
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_accepts_a_child_document_inside_the_verified_map_path() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map/Nodes/folder.sy","rootID":"folder-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":[{"doOperations":[{"action":"insert","id":"file-block","parentID":"folder-root"}]}]}"#
                .to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "c".repeat(48)).unwrap(),
        );

        assert_eq!(
            client
                .batch_append_blocks(
                    "20260820-notebook",
                    "map-root",
                    &[AppendBlockInput {
                        parent_id: "folder-root".to_owned(),
                        markdown: "# File".to_owned(),
                    }],
                )
                .unwrap(),
            ["file-block"]
        );

        let captured = (0..4).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[1].contains("/api/block/getBlockInfo"));
        assert!(captured[2].contains("/api/block/getBlockInfo"));
        assert!(captured[3].contains("/api/block/batchAppendBlock"));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_rejects_a_traversal_shaped_child_path_before_write() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map/../other.sy","rootID":"other-root"}}"#
                .to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "t".repeat(48)).unwrap(),
        );

        assert_eq!(
            client.batch_append_blocks(
                "20260820-notebook",
                "map-root",
                &[AppendBlockInput {
                    parent_id: "other-root".to_owned(),
                    markdown: "# Must not write".to_owned(),
                }],
            ),
            Err(ClientError::ResponseTypeMismatch)
        );
        let captured = (0..3).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/batchAppendBlock")));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_rejects_parent_outside_the_verified_notebook_before_write() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"other-notebook","path":"/one.sy","rootID":"parent-1"}}"#.to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "v".repeat(48)).unwrap(),
        );
        assert_eq!(
            client.batch_append_blocks(
                "20260820-notebook",
                "parent-1",
                &[AppendBlockInput {
                    parent_id: "parent-1".to_owned(),
                    markdown: "# First".to_owned(),
                }],
            ),
            Err(ClientError::ResponseTypeMismatch)
        );
        let captured = (0..2).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[1].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/batchAppendBlock")));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_rejects_a_non_root_authority_id_before_write() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map.sy","rootID":"actual-map-root"}}"#
                .to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "r".repeat(48)).unwrap(),
        );
        assert_eq!(
            client.batch_append_blocks(
                "20260820-notebook",
                "map-child",
                &[AppendBlockInput {
                    parent_id: "map-child".to_owned(),
                    markdown: "# Must not write".to_owned(),
                }],
            ),
            Err(ClientError::ResponseTypeMismatch)
        );
        let captured = (0..2).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/batchAppendBlock")));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_batch_append_rejects_same_notebook_parent_from_a_different_map() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-one.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-two.sy","rootID":"other-map-root"}}"#
                .to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "m".repeat(48)).unwrap(),
        );
        assert_eq!(
            client.batch_append_blocks(
                "20260820-notebook",
                "map-root",
                &[AppendBlockInput {
                    parent_id: "other-map-parent".to_owned(),
                    markdown: "# Must not write".to_owned(),
                }],
            ),
            Err(ClientError::ResponseTypeMismatch)
        );
        let captured = (0..3).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/batchAppendBlock")));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_update_rejects_same_notebook_target_from_a_different_map() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-one.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-two.sy","rootID":"other-map-root"}}"#
                .to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "u".repeat(48)).unwrap(),
        );
        assert_eq!(
            client.update_block(
                "map-root",
                "other-map-block",
                "# Expected",
                "# Must not write",
            ),
            Err(ClientError::ResponseTypeMismatch)
        );
        let captured = (0..3).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/getBlockKramdown")
                && !request.contains("/api/block/updateBlock")));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_update_accepts_a_managed_child_document_under_the_exact_map_root() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-root.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-root/child.sy","rootID":"child"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"child","kramdown":"# Before"}}"##
                .to_owned(),
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "n".repeat(48)).unwrap(),
        );

        assert_eq!(
            client.update_block("map-root", "child", "# Before", "# After"),
            Ok(())
        );

        let captured = (0..5).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[1].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[2].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[3].starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(captured[4].starts_with("POST /api/block/updateBlock HTTP/1.1"));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_update_accepts_a_file_block_inside_a_managed_child_document() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-root.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-root/child.sy","rootID":"child"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"child-file","kramdown":"# Before"}}"##
                .to_owned(),
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "n".repeat(48)).unwrap(),
        );

        assert_eq!(
            client.update_block("map-root", "child-file", "# Before", "# After"),
            Ok(())
        );

        let captured = (0..5).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured[1].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[2].starts_with("POST /api/block/getBlockInfo HTTP/1.1"));
        assert!(captured[3].starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(captured[4].starts_with("POST /api/block/updateBlock HTTP/1.1"));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_delete_rejects_same_notebook_target_from_a_different_map() {
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-one.sy","rootID":"map-root"}}"#
                .to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/map-two.sy","rootID":"other-map-root"}}"#
                .to_owned(),
        ]);
        let client = SiyuanClient::new(
            true,
            HttpSiyuanTransport::new(port, "d".repeat(48)).unwrap(),
        );
        assert_eq!(
            client.delete_block("map-root", "other-map-block", "# Expected"),
            Err(ClientError::ResponseTypeMismatch)
        );
        let captured = (0..3).map(|_| requests.recv().unwrap()).collect::<Vec<_>>();
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/getBlockKramdown")
                && !request.contains("/api/block/deleteBlock")));
        server.join().unwrap();
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn native_update_conflict_never_emits_a_mutation_request() {
        let token = "c".repeat(48);
        let (port, requests, server) = mock_http_server(vec![
            r#"{"code":0,"msg":"","data":null}"#.to_owned(),
            r#"{"code":0,"msg":"","data":{"box":"20260820-notebook","path":"/decision.sy","rootID":"20260820-document"}}"#
                .to_owned(),
            r##"{"code":0,"msg":"","data":{"id":"20260820-document","kramdown":"# User edit"}}"##
                .to_owned(),
        ]);
        let client = SiyuanClient::new(true, HttpSiyuanTransport::new(port, token).unwrap());
        assert_eq!(
            client.update_block(
                "20260820-document",
                "20260820-document",
                "# Expected",
                "# Replacement",
            ),
            Err(ClientError::Conflict)
        );
        let captured: Vec<String> = (0..3).map(|_| requests.recv().unwrap()).collect();
        assert!(captured[2].starts_with("POST /api/block/getBlockKramdown HTTP/1.1"));
        assert!(captured
            .iter()
            .all(|request| !request.contains("/api/block/updateBlock")));
        server.join().unwrap();
    }
}
