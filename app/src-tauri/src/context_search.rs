use fs4::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tantivy::collector::TopDocs;
use tantivy::directory::error::OpenReadError;
use tantivy::query::{BooleanQuery, BoostQuery, PhraseQuery, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value as TantivyValue, FAST,
    INDEXED, STORED, STRING,
};
use tantivy::snippet::SnippetGenerator;
use tantivy::tokenizer::{
    LowerCaser, RemoveLongFilter, SimpleTokenizer, TextAnalyzer, TokenStream,
};
use tantivy::{Index, TantivyDocument, TantivyError, Term};
use tauri::Manager;

const ENGINE: &str = "tantivy-0.22.1";
const SCHEMA_VERSION: u32 = 1;
const TOKENIZER: &str = "vibespace_unicode_v1";
const WRITER_MEMORY_BYTES: usize = 50_000_000;
const MAX_DOCUMENTS_PER_MUTATION: usize = 1_000;
const MAX_DOCUMENT_BODY_BYTES: usize = 1_048_576;
const MAX_TOTAL_MUTATION_BYTES: usize = 64 * 1024 * 1024;
const MAX_PROPERTIES_BYTES: usize = 65_536;
const MAX_QUERY_BYTES: usize = 1_024;
const MAX_RESULTS: usize = 100;
const MAX_TAGS: usize = 128;
const MAX_PROPERTIES: usize = 256;
const MAX_NATIVE_CLAUSES: usize = 32;
const MAX_NATIVE_TOKENS: usize = 64;
const MAX_QUARANTINES_PER_SCOPE: usize = 2;
#[cfg(unix)]
const MAX_PERMISSION_ENTRIES: usize = 10_000;
const MAX_JAVASCRIPT_TIMESTAMP: i64 = 8_640_000_000_000_000;
const MAX_INDEX_SCOPES: usize = 512;
const MAX_CONCURRENT_WORKERS: usize = 4;
static CONTEXT_WORKERS: async_lock::Semaphore = async_lock::Semaphore::new(MAX_CONCURRENT_WORKERS);
static PROCESS_WRITER_BUDGET: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSearchMode {
    Quick,
    FullText,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSearchDocumentInput {
    pub document_id: String,
    pub source_id: String,
    pub title: String,
    pub path: String,
    pub source_type: String,
    pub body: String,
    pub tags: Vec<String>,
    pub properties: BTreeMap<String, Value>,
    pub updated_at: i64,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSearchQueryInput {
    pub mode: ContextSearchMode,
    pub query: String,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSearchResult {
    pub document_id: String,
    pub title: String,
    pub path: String,
    pub source_type: String,
    pub excerpt: String,
    pub match_reason: String,
    pub updated_at: i64,
    pub score: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSearchStatus {
    pub document_count: u64,
    pub index_id: String,
    pub engine: String,
    pub schema_version: u32,
    pub recovered_corruption: bool,
    pub needs_rebuild: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSearchReplaceRequest {
    pub account_id: String,
    pub map_id: String,
    pub documents: Vec<ContextSearchDocumentInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSearchDeleteRequest {
    pub account_id: String,
    pub map_id: String,
    pub document_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSearchRequest {
    pub account_id: String,
    pub map_id: String,
    pub mode: ContextSearchMode,
    pub query: String,
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSearchStatusRequest {
    pub account_id: String,
    pub map_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSearchMutationResult {
    pub affected_documents: usize,
    pub status: ContextSearchStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSearchQueryResult {
    pub results: Vec<ContextSearchResult>,
    pub status: ContextSearchStatus,
}

#[derive(Clone, Copy)]
struct IndexFields {
    document_id: Field,
    source_id: Field,
    title: Field,
    path: Field,
    source_type: Field,
    body: Field,
    tags: Field,
    properties: Field,
    updated_at: Field,
    content_hash: Field,
}

pub struct ContextSearchIndex {
    root: PathBuf,
    path: PathBuf,
    scope_key: String,
    lock_path: PathBuf,
    rebuild_marker_path: PathBuf,
    recovered_corruption: bool,
}

impl ContextSearchIndex {
    #[cfg(test)]
    fn open(root: &Path, account_id: &str, map_id: &str) -> Result<Self, String> {
        let root = prepare_root(root)?;
        Self::open_prepared(root, account_id, map_id)
    }

    fn open_from_trusted_base(
        trusted_base: &Path,
        relative_root: &Path,
        account_id: &str,
        map_id: &str,
    ) -> Result<Self, String> {
        let root = prepare_trusted_descendant(trusted_base, relative_root)?;
        Self::open_prepared(root, account_id, map_id)
    }

    fn open_prepared(root: PathBuf, account_id: &str, map_id: &str) -> Result<Self, String> {
        validate_scope_id(account_id, "account_id")?;
        validate_scope_id(map_id, "map_id")?;
        let scope_key = scoped_index_name(account_id, map_id);
        let path = root.join(&scope_key);
        let lock_path = root.join(format!(".lock-{scope_key}"));
        let rebuild_marker_path = root.join(format!(".needs-rebuild-{scope_key}"));
        let expected_schema = build_schema();

        let open_scope = || {
            with_scope_lock_at(&lock_path, || -> Result<bool, String> {
                reject_link_or_reparse(&path)?;
                let mut recovered_corruption = false;
                if path.exists() {
                    match Index::open_in_dir(&path) {
                        Ok(index) if index.schema() == expected_schema => {}
                        Ok(_) => {
                            mark_rebuild_required(&rebuild_marker_path)?;
                            quarantine_index(&root, &path, &scope_key)?;
                            recovered_corruption = true;
                            create_index(&root, &path, expected_schema.clone())?;
                        }
                        Err(error) if should_recover_from_open_error(&error) => {
                            mark_rebuild_required(&rebuild_marker_path)?;
                            quarantine_index(&root, &path, &scope_key)?;
                            recovered_corruption = true;
                            create_index(&root, &path, expected_schema.clone())?;
                        }
                        Err(error) => {
                            return Err(format!("context_search_index_open:{error}"));
                        }
                    }
                } else {
                    if has_verified_quarantine(&root, &scope_key)? {
                        mark_rebuild_required(&rebuild_marker_path)?;
                    }
                    create_index(&root, &path, expected_schema.clone())?;
                }
                Ok(recovered_corruption)
            })
        };
        let recovered_corruption = if path.exists() {
            open_scope()?
        } else {
            let registry_lock = root.join(".scope-registry.lock");
            with_scope_lock_at(&registry_lock, || {
                if !path.exists() {
                    ensure_scope_capacity(&root)?;
                }
                open_scope()
            })?
        };
        Ok(Self {
            root,
            path,
            scope_key,
            lock_path,
            rebuild_marker_path,
            recovered_corruption,
        })
    }

    fn with_scope_lock<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        with_scope_lock_at(&self.lock_path, operation)
    }

    pub fn acknowledge_rebuild(&self) -> Result<(), String> {
        self.with_scope_lock(|| {
            if self.rebuild_marker_path.exists() {
                ensure_regular_file(&self.rebuild_marker_path)?;
                fs::remove_file(&self.rebuild_marker_path)
                    .map_err(|error| format!("context_search_rebuild_acknowledge:{error}"))?;
            }
            Ok(())
        })
    }

    fn needs_rebuild(&self) -> Result<bool, String> {
        if self.rebuild_marker_path.exists() {
            ensure_regular_file(&self.rebuild_marker_path)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn ensure_index_path_safe(&self) -> Result<(), String> {
        ensure_contained_directory(&self.root, &self.path)
    }

    fn open_current_generation(&self) -> Result<(Index, IndexFields), String> {
        self.ensure_index_path_safe()?;
        let index = Index::open_in_dir(&self.path)
            .map_err(|error| format!("context_search_index_generation:{error}"))?;
        if index.schema() != build_schema() {
            return Err("context_search_index_generation_schema".to_string());
        }
        register_tokenizer(&index);
        let fields = index_fields(&index.schema())?;
        Ok((index, fields))
    }

    pub fn replace_documents(
        &self,
        documents: &[ContextSearchDocumentInput],
    ) -> Result<usize, String> {
        validate_documents(documents)?;
        self.with_scope_lock(|| {
            let (index, fields) = self.open_current_generation()?;
            with_writer_budget(|| {
                let mut writer = index
                    .writer::<TantivyDocument>(WRITER_MEMORY_BYTES)
                    .map_err(|error| format!("context_search_writer:{error}"))?;
                for document in documents {
                    writer.delete_term(Term::from_field_text(
                        fields.document_id,
                        &document.document_id,
                    ));
                    let properties = serde_json::to_string(&document.properties)
                        .map_err(|error| format!("context_search_properties_serialize:{error}"))?;
                    let mut indexed = TantivyDocument::default();
                    indexed.add_text(fields.document_id, &document.document_id);
                    indexed.add_text(fields.source_id, &document.source_id);
                    indexed.add_text(fields.title, &document.title);
                    indexed.add_text(fields.path, &document.path);
                    indexed.add_text(fields.source_type, &document.source_type);
                    indexed.add_text(fields.body, &document.body);
                    indexed.add_text(fields.tags, document.tags.join(" "));
                    indexed.add_text(fields.properties, properties);
                    indexed.add_i64(fields.updated_at, document.updated_at);
                    indexed.add_text(fields.content_hash, &document.content_hash);
                    writer
                        .add_document(indexed)
                        .map_err(|error| format!("context_search_add:{error}"))?;
                }
                writer
                    .commit()
                    .map_err(|error| format!("context_search_commit:{error}"))?;
                harden_tree_permissions(&self.path)?;
                Ok(documents.len())
            })
        })
    }

    pub fn delete_documents(&self, document_ids: &[String]) -> Result<usize, String> {
        if document_ids.len() > MAX_DOCUMENTS_PER_MUTATION {
            return Err("context_search_input_too_large".to_string());
        }
        let mut unique = std::collections::BTreeSet::new();
        for document_id in document_ids {
            validate_stable_id(document_id, "document_id")?;
            if !unique.insert(document_id) {
                return Err("context_search_duplicate_document_id".to_string());
            }
        }
        self.with_scope_lock(|| {
            let (index, fields) = self.open_current_generation()?;
            with_writer_budget(|| {
                let mut writer = index
                    .writer::<TantivyDocument>(WRITER_MEMORY_BYTES)
                    .map_err(|error| format!("context_search_writer:{error}"))?;
                for document_id in document_ids {
                    writer.delete_term(Term::from_field_text(fields.document_id, document_id));
                }
                writer
                    .commit()
                    .map_err(|error| format!("context_search_commit:{error}"))?;
                harden_tree_permissions(&self.path)?;
                Ok(document_ids.len())
            })
        })
    }

    pub fn query(
        &self,
        input: &ContextSearchQueryInput,
    ) -> Result<Vec<ContextSearchResult>, String> {
        validate_query(input)?;
        self.with_scope_lock(|| {
            let (index, fields) = self.open_current_generation()?;
            self.query_locked(&index, fields, input)
        })
    }

    fn query_locked(
        &self,
        index: &Index,
        index_fields: IndexFields,
        input: &ContextSearchQueryInput,
    ) -> Result<Vec<ContextSearchResult>, String> {
        let fields = match input.mode {
            ContextSearchMode::Quick => {
                vec![(index_fields.title, 3.0_f32), (index_fields.path, 2.0_f32)]
            }
            ContextSearchMode::FullText => vec![
                (index_fields.title, 3.0_f32),
                (index_fields.path, 2.0_f32),
                (index_fields.body, 1.0_f32),
                (index_fields.tags, 1.0_f32),
                (index_fields.properties, 1.0_f32),
            ],
        };
        let parsed = build_literal_query(&input.query, &fields)?;
        let reader = index
            .reader()
            .map_err(|error| format!("context_search_reader:{error}"))?;
        reader
            .reload()
            .map_err(|error| format!("context_search_reload:{error}"))?;
        let searcher = reader.searcher();
        let top_docs = searcher
            .search(parsed.as_ref(), &TopDocs::with_limit(input.limit))
            .map_err(|error| format!("context_search_query:{error}"))?;
        let mut snippet_generator = match input.mode {
            ContextSearchMode::Quick => None,
            ContextSearchMode::FullText => {
                let mut generator =
                    SnippetGenerator::create(&searcher, parsed.as_ref(), index_fields.body)
                        .map_err(|error| format!("context_search_snippet:{error}"))?;
                generator.set_max_num_chars(280);
                Some(generator)
            }
        };
        let mut results = Vec::with_capacity(top_docs.len());
        for (score, address) in top_docs {
            let document = searcher
                .doc::<TantivyDocument>(address)
                .map_err(|error| format!("context_search_document:{error}"))?;
            let body = stored_text(&document, index_fields.body)?;
            let excerpt = snippet_generator
                .as_mut()
                .map(|generator| generator.snippet_from_doc(&document))
                .filter(|snippet| !snippet.fragment().is_empty())
                .map(|snippet| snippet.fragment().to_string())
                .unwrap_or_else(|| bounded_prefix(&body, 280));
            results.push(ContextSearchResult {
                document_id: stored_text(&document, index_fields.document_id)?,
                title: stored_text(&document, index_fields.title)?,
                path: stored_text(&document, index_fields.path)?,
                source_type: stored_text(&document, index_fields.source_type)?,
                excerpt,
                match_reason: match input.mode {
                    ContextSearchMode::Quick => "title_or_path".to_string(),
                    ContextSearchMode::FullText => "full_text".to_string(),
                },
                updated_at: stored_i64(&document, index_fields.updated_at)?,
                score,
            });
        }
        Ok(results)
    }

    pub fn status(&self) -> Result<ContextSearchStatus, String> {
        self.with_scope_lock(|| {
            let (index, _) = self.open_current_generation()?;
            let reader = index
                .reader()
                .map_err(|error| format!("context_search_reader:{error}"))?;
            reader
                .reload()
                .map_err(|error| format!("context_search_reload:{error}"))?;
            Ok(ContextSearchStatus {
                document_count: reader.searcher().num_docs(),
                index_id: self.scope_key.clone(),
                engine: ENGINE.to_string(),
                schema_version: SCHEMA_VERSION,
                recovered_corruption: self.recovered_corruption,
                needs_rebuild: self.needs_rebuild()?,
            })
        })
    }
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    let indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let text = TextOptions::default()
        .set_indexing_options(indexing)
        .set_stored();
    builder.add_text_field("document_id", STRING | STORED);
    builder.add_text_field("source_id", STRING | STORED);
    builder.add_text_field("title", text.clone());
    builder.add_text_field("path", text.clone());
    builder.add_text_field("source_type", STRING | STORED);
    builder.add_text_field("body", text.clone());
    builder.add_text_field("tags", text.clone());
    builder.add_text_field("properties", text);
    builder.add_i64_field("updated_at", INDEXED | FAST | STORED);
    builder.add_text_field("content_hash", STRING | STORED);
    builder.build()
}

fn create_index(root: &Path, path: &Path, schema: Schema) -> Result<Index, String> {
    reject_link_or_reparse(path)?;
    fs::create_dir_all(path).map_err(|error| format!("context_search_index_create:{error}"))?;
    ensure_contained_directory(root, path)?;
    let index = Index::create_in_dir(path, schema)
        .map_err(|error| format!("context_search_index_create:{error}"))?;
    harden_tree_permissions(path)?;
    Ok(index)
}

fn should_recover_from_open_error(error: &TantivyError) -> bool {
    matches!(
        error,
        TantivyError::DataCorruption(_)
            | TantivyError::IncompatibleIndex(_)
            | TantivyError::DeserializeError(_)
            | TantivyError::OpenReadError(
                OpenReadError::FileDoesNotExist(_) | OpenReadError::IncompatibleIndex(_)
            )
    )
}

fn with_writer_budget<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = PROCESS_WRITER_BUDGET
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "context_search_writer_budget_poisoned".to_string())?;
    operation()
}

fn text_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(80))
        .filter(LowerCaser)
        .build()
}

fn register_tokenizer(index: &Index) {
    index.tokenizers().register(TOKENIZER, text_analyzer());
}

fn index_fields(schema: &Schema) -> Result<IndexFields, String> {
    let field = |name: &str| {
        schema
            .get_field(name)
            .map_err(|_| format!("context_search_schema_missing:{name}"))
    };
    Ok(IndexFields {
        document_id: field("document_id")?,
        source_id: field("source_id")?,
        title: field("title")?,
        path: field("path")?,
        source_type: field("source_type")?,
        body: field("body")?,
        tags: field("tags")?,
        properties: field("properties")?,
        updated_at: field("updated_at")?,
        content_hash: field("content_hash")?,
    })
}

fn scoped_index_name(account_id: &str, map_id: &str) -> String {
    format!("a{}-m{}", hash_scope(account_id), hash_scope(map_id))
}

fn hash_scope(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{digest:x}")[..32].to_string()
}

fn quarantine_index(root: &Path, path: &Path, scope_key: &str) -> Result<(), String> {
    ensure_contained_directory(root, path)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "context_search_clock_invalid".to_string())?
        .as_millis();
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "context_search_index_path_invalid".to_string())?;
    let mut quarantine = root.join(format!("{name}.corrupt-{timestamp}"));
    let mut suffix = 0_u32;
    while quarantine.exists() {
        suffix += 1;
        quarantine = root.join(format!("{name}.corrupt-{timestamp}-{suffix}"));
    }
    fs::rename(path, &quarantine).map_err(|error| format!("context_search_quarantine:{error}"))?;
    harden_tree_permissions(&quarantine)?;
    prune_quarantines(root, scope_key)
}

#[cfg(test)]
fn prepare_root(root: &Path) -> Result<PathBuf, String> {
    reject_link_or_reparse(root)?;
    fs::create_dir_all(root).map_err(|error| format!("context_search_root_create:{error}"))?;
    reject_link_or_reparse(root)?;
    harden_path_permissions(root, true)?;
    root.canonicalize()
        .map_err(|error| format!("context_search_root_canonicalize:{error}"))
}

fn prepare_trusted_descendant(
    trusted_base: &Path,
    relative_path: &Path,
) -> Result<PathBuf, String> {
    let canonical_base = trusted_base
        .canonicalize()
        .map_err(|error| format!("context_search_trusted_base:{error}"))?;
    let components = relative_path
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err("context_search_relative_root_invalid".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err("context_search_relative_root_invalid".to_string());
    }

    let mut current = canonical_base;
    for component in components {
        let child = current.join(component);
        reject_link_or_reparse(&child)?;
        if !child.exists() {
            match fs::create_dir(&child) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(format!("context_search_root_component_create:{error}"));
                }
            }
        }
        reject_link_or_reparse(&child)?;
        if !fs::metadata(&child)
            .map_err(|error| format!("context_search_root_component_metadata:{error}"))?
            .is_dir()
        {
            return Err("context_search_root_component_invalid".to_string());
        }
        let canonical_child = child
            .canonicalize()
            .map_err(|error| format!("context_search_root_component_canonicalize:{error}"))?;
        if canonical_child.parent() != Some(current.as_path()) {
            return Err("context_search_root_component_escape".to_string());
        }
        harden_path_permissions(&canonical_child, true)?;
        current = canonical_child;
    }
    Ok(current)
}

fn has_verified_quarantine(root: &Path, scope_key: &str) -> Result<bool, String> {
    let prefix = format!("{scope_key}.corrupt-");
    for entry in
        fs::read_dir(root).map_err(|error| format!("context_search_quarantine_list:{error}"))?
    {
        let entry = entry.map_err(|error| format!("context_search_quarantine_entry:{error}"))?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(&prefix) {
            reject_link_or_reparse(&entry.path())?;
            if entry
                .file_type()
                .map_err(|error| format!("context_search_quarantine_type:{error}"))?
                .is_dir()
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn live_scope_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 67
        && bytes[0] == b'a'
        && bytes[33] == b'-'
        && bytes[34] == b'm'
        && bytes[1..33].iter().all(u8::is_ascii_hexdigit)
        && bytes[35..].iter().all(u8::is_ascii_hexdigit)
}

fn ensure_scope_capacity(root: &Path) -> Result<(), String> {
    let mut count = 0_usize;
    for entry in fs::read_dir(root).map_err(|error| format!("context_search_scope_list:{error}"))? {
        let entry = entry.map_err(|error| format!("context_search_scope_entry:{error}"))?;
        let name = entry.file_name();
        if name.to_str().is_some_and(live_scope_name)
            && entry
                .file_type()
                .map_err(|error| format!("context_search_scope_type:{error}"))?
                .is_dir()
        {
            reject_link_or_reparse(&entry.path())?;
            count += 1;
            if count >= MAX_INDEX_SCOPES {
                return Err("context_search_scope_capacity".to_string());
            }
        }
    }
    Ok(())
}

fn reject_link_or_reparse(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("context_search_path_metadata:{error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err("context_search_path_link_rejected".to_string());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("context_search_path_link_rejected".to_string());
        }
    }
    Ok(())
}

fn ensure_contained_directory(root: &Path, path: &Path) -> Result<(), String> {
    reject_link_or_reparse(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("context_search_index_canonicalize:{error}"))?;
    if !canonical.starts_with(root) || canonical == root || !canonical.is_dir() {
        return Err("context_search_index_path_invalid".to_string());
    }
    Ok(())
}

fn with_scope_lock_at<T>(
    lock_path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    reject_link_or_reparse(lock_path)?;
    if lock_path.exists() {
        ensure_regular_file(lock_path)?;
    }
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path)
        .map_err(|error| format!("context_search_lock_open:{error}"))?;
    reject_link_or_reparse(lock_path)?;
    ensure_regular_file(lock_path)?;
    harden_path_permissions(lock_path, false)?;
    lock_file
        .lock_exclusive()
        .map_err(|error| format!("context_search_lock_acquire:{error}"))?;
    let result = operation();
    let unlock = lock_file
        .unlock()
        .map_err(|error| format!("context_search_lock_release:{error}"));
    match (result, unlock) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn mark_rebuild_required(marker_path: &Path) -> Result<(), String> {
    mark_rebuild_required_with(marker_path, sync_parent_directory)
}

fn mark_rebuild_required_with(
    marker_path: &Path,
    sync_parent: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    reject_link_or_reparse(marker_path)?;
    let marker = if marker_path.exists() {
        ensure_regular_file(marker_path)?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(marker_path)
            .map_err(|error| format!("context_search_rebuild_marker:{error}"))?
    } else {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(marker_path)
            .map_err(|error| format!("context_search_rebuild_marker:{error}"))?
    };
    harden_path_permissions(marker_path, false)?;
    marker
        .sync_all()
        .map_err(|error| format!("context_search_rebuild_marker_sync:{error}"))?;
    let parent = marker_path
        .parent()
        .ok_or_else(|| "context_search_rebuild_marker_parent".to_string())?;
    sync_parent(parent)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("context_search_rebuild_parent_sync:{error}"))
}

#[cfg(windows)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide = parent
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .map_err(|error| format!("context_search_rebuild_parent_open:{error}"))?;
    let flush_result = unsafe { FlushFileBuffers(handle) }
        .map_err(|error| format!("context_search_rebuild_parent_sync:{error}"));
    let close_result = unsafe { CloseHandle(handle) }
        .map_err(|error| format!("context_search_rebuild_parent_close:{error}"));
    match (flush_result, close_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
    }
}

fn ensure_regular_file(path: &Path) -> Result<(), String> {
    reject_link_or_reparse(path)?;
    if fs::metadata(path)
        .map_err(|error| format!("context_search_file_metadata:{error}"))?
        .is_file()
    {
        Ok(())
    } else {
        Err("context_search_file_type_invalid".to_string())
    }
}

fn prune_quarantines(root: &Path, scope_key: &str) -> Result<(), String> {
    let prefix = format!("{scope_key}.corrupt-");
    let mut quarantines = fs::read_dir(root)
        .map_err(|error| format!("context_search_quarantine_list:{error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let path = entry.path();
            if !name.starts_with(&prefix)
                || reject_link_or_reparse(&path).is_err()
                || !entry.file_type().ok()?.is_dir()
            {
                return None;
            }
            Some((name, path))
        })
        .collect::<Vec<_>>();
    quarantines.sort_by(|left, right| left.0.cmp(&right.0));
    let remove_count = quarantines.len().saturating_sub(MAX_QUARANTINES_PER_SCOPE);
    for (_, path) in quarantines.into_iter().take(remove_count) {
        ensure_contained_directory(root, &path)?;
        fs::remove_dir_all(&path)
            .map_err(|error| format!("context_search_quarantine_cleanup:{error}"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn harden_tree_permissions(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut inspected = 0_usize;
    while let Some(path) = pending.pop() {
        inspected += 1;
        if inspected > MAX_PERMISSION_ENTRIES {
            return Err("context_search_permission_tree_too_large".to_string());
        }
        reject_link_or_reparse(&path)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("context_search_permission_metadata:{error}"))?;
        let directory = metadata.is_dir();
        harden_path_permissions(&path, directory)?;
        if directory {
            for entry in fs::read_dir(&path)
                .map_err(|error| format!("context_search_permission_list:{error}"))?
            {
                pending.push(
                    entry
                        .map_err(|error| format!("context_search_permission_entry:{error}"))?
                        .path(),
                );
            }
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_tree_permissions(_root: &Path) -> Result<(), String> {
    // Windows inherits the protected per-user LocalAppData ACL. Tantivy may
    // remove transient files immediately after commit, so recursively walking
    // them here creates a false failure race without strengthening the ACL.
    Ok(())
}

#[cfg(unix)]
fn harden_path_permissions(path: &Path, directory: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if directory { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("context_search_permission_set:{error}"))
}

#[cfg(not(unix))]
fn harden_path_permissions(_path: &Path, _directory: bool) -> Result<(), String> {
    Ok(())
}

#[derive(Debug)]
struct NativeLiteralClause {
    text: String,
    phrase: bool,
}

fn parse_native_clauses(input: &str) -> Result<Vec<NativeLiteralClause>, String> {
    let mut clauses = Vec::new();
    let mut offset = 0_usize;
    while offset < input.len() {
        while offset < input.len() {
            let character = input[offset..]
                .chars()
                .next()
                .ok_or_else(|| "context_search_query_invalid".to_string())?;
            if !character.is_whitespace() {
                break;
            }
            offset += character.len_utf8();
        }
        if offset == input.len() {
            break;
        }

        let phrase = input[offset..].starts_with('"');
        if phrase {
            offset += 1;
            let start = offset;
            let mut closing = None;
            while offset < input.len() {
                let character = input[offset..]
                    .chars()
                    .next()
                    .ok_or_else(|| "context_search_query_invalid".to_string())?;
                if character == '"' {
                    closing = Some(offset);
                    break;
                }
                if character == '\\' {
                    return Err("context_search_query_invalid".to_string());
                }
                offset += character.len_utf8();
            }
            let end = closing.ok_or_else(|| "context_search_query_invalid".to_string())?;
            let text = &input[start..end];
            if text.trim().is_empty() {
                return Err("context_search_query_invalid".to_string());
            }
            offset = end + 1;
            if offset < input.len()
                && !input[offset..]
                    .chars()
                    .next()
                    .is_some_and(char::is_whitespace)
            {
                return Err("context_search_query_invalid".to_string());
            }
            clauses.push(NativeLiteralClause {
                text: text.to_string(),
                phrase: true,
            });
        } else {
            let start = offset;
            while offset < input.len() {
                let character = input[offset..]
                    .chars()
                    .next()
                    .ok_or_else(|| "context_search_query_invalid".to_string())?;
                if character.is_whitespace() {
                    break;
                }
                if character == '"' {
                    return Err("context_search_query_invalid".to_string());
                }
                offset += character.len_utf8();
            }
            clauses.push(NativeLiteralClause {
                text: input[start..offset].to_string(),
                phrase: false,
            });
        }
        if clauses.len() > MAX_NATIVE_CLAUSES {
            return Err("context_search_query_too_complex".to_string());
        }
    }
    if clauses.is_empty() {
        return Err("context_search_query_invalid".to_string());
    }
    Ok(clauses)
}

fn tokenize_native_literal(text: &str) -> Vec<String> {
    let mut analyzer = text_analyzer();
    let mut stream = analyzer.token_stream(text);
    let mut tokens = Vec::new();
    while stream.advance() {
        tokens.push(stream.token().text.clone());
    }
    tokens
}

fn field_literal_query(field: Field, tokens: &[String], phrase: bool) -> Box<dyn Query> {
    let terms = tokens
        .iter()
        .map(|token| Term::from_field_text(field, token))
        .collect::<Vec<_>>();
    if phrase && terms.len() > 1 {
        Box::new(PhraseQuery::new(terms))
    } else if terms.len() == 1 {
        Box::new(TermQuery::new(
            terms.into_iter().next().expect("one term"),
            IndexRecordOption::WithFreqsAndPositions,
        ))
    } else {
        Box::new(BooleanQuery::intersection(
            terms
                .into_iter()
                .map(|term| {
                    Box::new(TermQuery::new(
                        term,
                        IndexRecordOption::WithFreqsAndPositions,
                    )) as Box<dyn Query>
                })
                .collect(),
        ))
    }
}

fn build_literal_query(input: &str, fields: &[(Field, f32)]) -> Result<Box<dyn Query>, String> {
    let clauses = parse_native_clauses(input)?;
    let mut total_tokens = 0_usize;
    let mut clause_queries = Vec::with_capacity(clauses.len());
    for clause in clauses {
        let tokens = tokenize_native_literal(&clause.text);
        if tokens.is_empty() {
            return Err("context_search_query_invalid".to_string());
        }
        total_tokens = total_tokens.saturating_add(tokens.len());
        if total_tokens > MAX_NATIVE_TOKENS {
            return Err("context_search_query_too_complex".to_string());
        }
        let field_queries = fields
            .iter()
            .map(|(field, boost)| {
                let query = field_literal_query(*field, &tokens, clause.phrase);
                if (*boost - 1.0).abs() > f32::EPSILON {
                    Box::new(BoostQuery::new(query, *boost)) as Box<dyn Query>
                } else {
                    query
                }
            })
            .collect();
        clause_queries.push(Box::new(BooleanQuery::union(field_queries)) as Box<dyn Query>);
    }
    Ok(Box::new(BooleanQuery::intersection(clause_queries)))
}

fn validate_scope_id(value: &str, field: &str) -> Result<(), String> {
    validate_text(value, 500, field)?;
    if value
        .replace('\\', "/")
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err(format!("context_search_{field}_invalid"));
    }
    Ok(())
}

fn validate_stable_id(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:/-".contains(character))
        || !value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
    {
        return Err(format!("context_search_{field}_invalid"));
    }
    Ok(())
}

fn validate_text(value: &str, maximum: usize, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > maximum
        || value.trim() != value
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '\u{2028}' | '\u{2029}'))
    {
        return Err(format!("context_search_{field}_invalid"));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), String> {
    validate_text(value, 4_096, "path")?;
    if value.contains('\\')
        || value.starts_with('/')
        || value
            .split('/')
            .any(|segment| !portable_path_segment(segment))
    {
        return Err("context_search_path_invalid".to_string());
    }
    Ok(())
}

fn portable_path_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." || segment.contains('%') {
        return false;
    }
    if segment.contains(['/', '\\'])
        || segment
            .chars()
            .any(|character| character.is_control() || "<>:\"|?*".contains(character))
        || segment.ends_with([' ', '.'])
    {
        return false;
    }
    let base = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    !matches!(
        base.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "clock$"
            | "conin$"
            | "conout$"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

fn valid_property_name(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && value.len() <= 64
        && characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "__proto__" | "prototype" | "constructor" | "tostring" | "valueof"
        )
}

fn validate_property_value(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            text.len() <= 4_096
                && !text.chars().any(|character| {
                    character.is_control() || matches!(character, '\u{2028}' | '\u{2029}')
                })
        }
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Bool(_) => true,
        Value::Array(values) => {
            values.len() <= 128
                && values.iter().all(|entry| {
                    entry.as_str().is_some_and(|text| {
                        !text.is_empty()
                            && text.len() <= 4_096
                            && !text.chars().any(|character| character.is_control())
                    })
                })
        }
        Value::Null | Value::Object(_) => false,
    }
}

fn validate_documents(documents: &[ContextSearchDocumentInput]) -> Result<(), String> {
    if documents.len() > MAX_DOCUMENTS_PER_MUTATION {
        return Err("context_search_input_too_large".to_string());
    }
    let mut identifiers = std::collections::BTreeSet::new();
    let mut total_bytes = 0_usize;
    for document in documents {
        validate_stable_id(&document.document_id, "document_id")?;
        validate_stable_id(&document.source_id, "source_id")?;
        if !identifiers.insert(&document.document_id) {
            return Err("context_search_duplicate_document_id".to_string());
        }
        validate_text(&document.title, 1_000, "title")?;
        validate_relative_path(&document.path)?;
        validate_text(&document.source_type, 100, "source_type")?;
        if document.body.len() > MAX_DOCUMENT_BODY_BYTES
            || document.body.chars().any(|character| {
                (character.is_control() && !matches!(character, '\t' | '\n' | '\r'))
                    || matches!(character, '\u{2028}' | '\u{2029}')
            })
        {
            return Err("context_search_body_invalid".to_string());
        }
        if document.tags.len() > MAX_TAGS
            || document
                .tags
                .iter()
                .any(|tag| validate_text(tag, 200, "tag").is_err())
        {
            return Err("context_search_tags_invalid".to_string());
        }
        if document.properties.len() > MAX_PROPERTIES
            || document
                .properties
                .iter()
                .any(|(name, value)| !valid_property_name(name) || !validate_property_value(value))
        {
            return Err("context_search_properties_invalid".to_string());
        }
        let properties_bytes = serde_json::to_vec(&document.properties)
            .map_err(|error| format!("context_search_properties_serialize:{error}"))?
            .len();
        if properties_bytes > MAX_PROPERTIES_BYTES {
            return Err("context_search_properties_too_large".to_string());
        }
        if !(0..=MAX_JAVASCRIPT_TIMESTAMP).contains(&document.updated_at)
            || document.content_hash.len() != 64
            || !document
                .content_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("context_search_document_metadata_invalid".to_string());
        }
        total_bytes = total_bytes
            .saturating_add(document.title.len())
            .saturating_add(document.path.len())
            .saturating_add(document.body.len())
            .saturating_add(properties_bytes)
            .saturating_add(document.tags.iter().map(String::len).sum::<usize>());
        if total_bytes > MAX_TOTAL_MUTATION_BYTES {
            return Err("context_search_input_too_large".to_string());
        }
    }
    Ok(())
}

fn validate_query(input: &ContextSearchQueryInput) -> Result<(), String> {
    validate_text(&input.query, MAX_QUERY_BYTES, "query")?;
    if input.limit == 0 || input.limit > MAX_RESULTS {
        return Err("context_search_limit_invalid".to_string());
    }
    Ok(())
}

fn stored_text(document: &TantivyDocument, field: Field) -> Result<String, String> {
    document
        .get_first(field)
        .and_then(|value| value.as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "context_search_stored_document_invalid".to_string())
}

fn stored_i64(document: &TantivyDocument, field: Field) -> Result<i64, String> {
    document
        .get_first(field)
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "context_search_stored_document_invalid".to_string())
}

fn bounded_prefix(body: &str, maximum_characters: usize) -> String {
    let mut characters = body.chars();
    let mut prefix = characters
        .by_ref()
        .take(maximum_characters)
        .collect::<String>();
    if characters.next().is_some() && maximum_characters > 0 {
        prefix.pop();
        prefix.push('\u{2026}');
    }
    prefix
}

struct AppIndexLocation {
    trusted_base: PathBuf,
    relative_root: PathBuf,
}

fn app_index_location(app: &tauri::AppHandle) -> Result<AppIndexLocation, String> {
    let resolver = app.path();
    let trusted_base = resolver
        .local_data_dir()
        .map_err(|error| format!("context_search_local_data_path:{error}"))?;
    let app_root = resolver
        .app_local_data_dir()
        .map_err(|error| format!("context_search_app_data_path:{error}"))?;
    let relative_app = app_root
        .strip_prefix(&trusted_base)
        .map_err(|_| "context_search_app_data_escape".to_string())?;
    Ok(AppIndexLocation {
        trusted_base,
        relative_root: relative_app
            .join("context")
            .join("search")
            .join("tantivy-v1"),
    })
}

fn ensure_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("context_search_caller_not_authorized".to_string())
    }
}

async fn run_context_worker<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let _permit = CONTEXT_WORKERS.acquire().await;
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("context_search_worker_join:{error}"))?
}

#[tauri::command]
pub async fn context_search_replace_documents(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: ContextSearchReplaceRequest,
) -> Result<ContextSearchMutationResult, String> {
    ensure_main_window(&window)?;
    let location = app_index_location(&app)?;
    run_context_worker(move || {
        let index = ContextSearchIndex::open_from_trusted_base(
            &location.trusted_base,
            &location.relative_root,
            &request.account_id,
            &request.map_id,
        )?;
        let affected_documents = index.replace_documents(&request.documents)?;
        Ok(ContextSearchMutationResult {
            affected_documents,
            status: index.status()?,
        })
    })
    .await
}

#[tauri::command]
pub async fn context_search_delete_documents(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: ContextSearchDeleteRequest,
) -> Result<ContextSearchMutationResult, String> {
    ensure_main_window(&window)?;
    let location = app_index_location(&app)?;
    run_context_worker(move || {
        let index = ContextSearchIndex::open_from_trusted_base(
            &location.trusted_base,
            &location.relative_root,
            &request.account_id,
            &request.map_id,
        )?;
        let affected_documents = index.delete_documents(&request.document_ids)?;
        Ok(ContextSearchMutationResult {
            affected_documents,
            status: index.status()?,
        })
    })
    .await
}

#[tauri::command]
pub async fn context_search_query(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: ContextSearchRequest,
) -> Result<ContextSearchQueryResult, String> {
    ensure_main_window(&window)?;
    let location = app_index_location(&app)?;
    run_context_worker(move || {
        let index = ContextSearchIndex::open_from_trusted_base(
            &location.trusted_base,
            &location.relative_root,
            &request.account_id,
            &request.map_id,
        )?;
        let results = index.query(&ContextSearchQueryInput {
            mode: request.mode,
            query: request.query,
            limit: request.limit,
        })?;
        Ok(ContextSearchQueryResult {
            results,
            status: index.status()?,
        })
    })
    .await
}

#[tauri::command]
pub async fn context_search_status(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: ContextSearchStatusRequest,
) -> Result<ContextSearchStatus, String> {
    ensure_main_window(&window)?;
    let location = app_index_location(&app)?;
    run_context_worker(move || {
        ContextSearchIndex::open_from_trusted_base(
            &location.trusted_base,
            &location.relative_root,
            &request.account_id,
            &request.map_id,
        )?
        .status()
    })
    .await
}

#[tauri::command]
pub async fn context_search_acknowledge_rebuild(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: ContextSearchStatusRequest,
) -> Result<ContextSearchStatus, String> {
    ensure_main_window(&window)?;
    let location = app_index_location(&app)?;
    run_context_worker(move || {
        let index = ContextSearchIndex::open_from_trusted_base(
            &location.trusted_base,
            &location.relative_root,
            &request.account_id,
            &request.map_id,
        )?;
        index.acknowledge_rebuild()?;
        index.status()
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let suffix = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "vibespace-context-search-{}-{nanos}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp root");
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn document(id: &str, title: &str, body: &str) -> ContextSearchDocumentInput {
        ContextSearchDocumentInput {
            document_id: id.to_string(),
            source_id: "source-one".to_string(),
            title: title.to_string(),
            path: format!("notes/{id}.md"),
            source_type: "markdown_note".to_string(),
            body: body.to_string(),
            tags: vec!["security".to_string()],
            properties: BTreeMap::from([
                ("severity".to_string(), Value::String("high".to_string())),
                ("release_blocker".to_string(), Value::Bool(true)),
            ]),
            updated_at: 1_752_600_000_000,
            content_hash: "a".repeat(64),
        }
    }

    #[test]
    fn indexes_queries_updates_and_deletes_without_cross_map_leakage() {
        let root = TempRoot::new();
        let index =
            ContextSearchIndex::open(&root.0, "account-one", "map-one").expect("open index");
        index
            .replace_documents(&[
                document(
                    "note-one",
                    "Café security audit",
                    "The subscription bypass is a release blocker.",
                ),
                document("note-two", "Ordinary note", "Nothing sensitive here."),
            ])
            .expect("index documents");

        let quick = index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::Quick,
                query: "café".to_string(),
                limit: 10,
            })
            .expect("quick query");
        assert_eq!(
            quick
                .iter()
                .map(|result| result.document_id.as_str())
                .collect::<Vec<_>>(),
            vec!["note-one"]
        );

        let full = index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "\"subscription bypass\"".to_string(),
                limit: 10,
            })
            .expect("full query");
        assert_eq!(full.len(), 1);
        assert!(full[0].excerpt.contains("subscription bypass"));

        index
            .replace_documents(&[document(
                "note-one",
                "Café security audit",
                "The entitlement is now repaired.",
            )])
            .expect("replace document");
        assert!(index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "subscription".to_string(),
                limit: 10,
            })
            .expect("query removed content")
            .is_empty());

        let other_map =
            ContextSearchIndex::open(&root.0, "account-one", "map-two").expect("other map");
        assert!(other_map
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "entitlement".to_string(),
                limit: 10,
            })
            .expect("isolated query")
            .is_empty());

        assert_eq!(
            index
                .delete_documents(&["note-one".to_string()])
                .expect("delete document"),
            1
        );
        assert_eq!(index.status().expect("status").document_count, 1);
    }

    #[test]
    fn treats_native_queries_as_bounded_literals_without_field_or_wildcard_escape() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");
        index
            .replace_documents(&[document("note-one", "Public title", "secret body content")])
            .expect("index document");

        assert!(index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::Quick,
                query: "body:secret".to_string(),
                limit: 10,
            })
            .expect("literal quick query")
            .is_empty());
        assert!(index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "content_hash:aaaaaaaa".to_string(),
                limit: 10,
            })
            .expect("literal full-text query")
            .is_empty());
        assert!(index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "[secret TO zebra]".to_string(),
                limit: 10,
            })
            .expect("literal range-shaped query")
            .is_empty());
        for query in [
            "*".to_string(),
            "\"unterminated".to_string(),
            (0..33)
                .map(|index| format!("clause{index}"))
                .collect::<Vec<_>>()
                .join(" "),
        ] {
            assert!(index
                .query(&ContextSearchQueryInput {
                    mode: ContextSearchMode::FullText,
                    query,
                    limit: 10,
                })
                .is_err());
        }
    }

    #[test]
    fn uses_hashed_scoped_paths_and_recovers_a_corrupt_derivative_index() {
        let root = TempRoot::new();
        let index =
            ContextSearchIndex::open(&root.0, "account/secret", "map:private").expect("open index");
        let status = index.status().expect("status");
        assert!(status.index_id.starts_with('a'));
        assert!(!Path::new(&status.index_id).is_absolute());
        assert!(!status.index_id.contains(root.0.to_string_lossy().as_ref()));
        assert!(!status.index_id.contains("account/secret"));
        assert!(!status.index_id.contains("map:private"));
        assert_eq!(status.engine, "tantivy-0.22.1");
        assert_eq!(status.schema_version, 1);
        assert!(!status.needs_rebuild);

        fs::write(index.path.join("meta.json"), b"not valid tantivy metadata")
            .expect("corrupt metadata");
        let recovered =
            ContextSearchIndex::open(&root.0, "account/secret", "map:private").expect("recover");
        assert!(recovered.recovered_corruption);
        let recovered_status = recovered.status().expect("recovered status");
        assert_eq!(recovered_status.document_count, 0);
        assert!(recovered_status.needs_rebuild);
        drop(recovered);

        let reopened =
            ContextSearchIndex::open(&root.0, "account/secret", "map:private").expect("reopen");
        assert!(reopened.status().expect("persistent marker").needs_rebuild);
        reopened.acknowledge_rebuild().expect("acknowledge rebuild");
        drop(reopened);
        assert!(
            !ContextSearchIndex::open(&root.0, "account/secret", "map:private")
                .expect("reopen after acknowledgement")
                .status()
                .expect("status after acknowledgement")
                .needs_rebuild
        );
        assert!(fs::read_dir(&root.0)
            .expect("read root")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
    }

    #[test]
    fn serializes_concurrent_first_open_and_bounds_quarantine_retention() {
        let root = Arc::new(TempRoot::new());
        let threads = (0..8)
            .map(|_| {
                let root = Arc::clone(&root);
                std::thread::spawn(move || {
                    ContextSearchIndex::open(&root.0, "account", "map")
                        .expect("concurrent open")
                        .status()
                        .expect("concurrent status")
                        .document_count
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            assert_eq!(thread.join().expect("thread"), 0);
        }

        for _ in 0..4 {
            let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");
            fs::write(index.path.join("meta.json"), b"corrupt").expect("corrupt metadata");
            drop(index);
            ContextSearchIndex::open(&root.0, "account", "map").expect("recover");
        }
        let quarantine_count = fs::read_dir(&root.0)
            .expect("read root")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .count();
        assert!(quarantine_count <= MAX_QUARANTINES_PER_SCOPE);
    }

    #[test]
    fn concurrently_prepares_the_same_trusted_descendant() {
        let base = Arc::new(TempRoot::new());
        let threads = (0..8)
            .map(|_| {
                let base = Arc::clone(&base);
                std::thread::spawn(move || {
                    prepare_trusted_descendant(&base.0, Path::new("app/context/search/tantivy-v1"))
                })
            })
            .collect::<Vec<_>>();
        let mut prepared = Vec::new();
        for thread in threads {
            prepared.push(
                thread
                    .join()
                    .expect("descendant thread")
                    .expect("prepare descendant"),
            );
        }
        assert!(prepared.windows(2).all(|paths| paths[0] == paths[1]));
    }

    #[test]
    fn marker_parent_sync_failure_is_reported_and_retryable() {
        let root = TempRoot::new();
        let marker = root.0.join(".needs-rebuild-test");
        let failure =
            mark_rebuild_required_with(
                &marker,
                |_| Err("injected_parent_sync_failure".to_string()),
            );
        assert!(failure.is_err());
        assert!(marker.is_file());
        mark_rebuild_required(&marker).expect("retry marker and parent sync");
    }

    #[test]
    fn orphan_quarantine_restores_the_persistent_rebuild_marker() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");
        fs::write(index.path.join("meta.json"), b"corrupt").expect("corrupt metadata");
        drop(index);
        let recovered = ContextSearchIndex::open(&root.0, "account", "map").expect("recover");
        recovered.acknowledge_rebuild().expect("remove marker");
        fs::remove_dir_all(&recovered.path).expect("remove current derivative generation");
        drop(recovered);

        let restored = ContextSearchIndex::open(&root.0, "account", "map").expect("restore");
        assert!(restored.status().expect("restored status").needs_rebuild);
    }

    #[test]
    fn marker_failure_preserves_the_live_generation_and_retry_recovers_safely() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");
        fs::write(index.path.join("meta.json"), b"corrupt").expect("corrupt metadata");
        fs::create_dir(&index.rebuild_marker_path).expect("block marker creation");
        drop(index);

        assert!(ContextSearchIndex::open(&root.0, "account", "map").is_err());
        let live_path = root.0.join(scoped_index_name("account", "map"));
        assert!(
            live_path.exists(),
            "recovery moved data before marker was durable"
        );

        fs::remove_dir(root.0.join(format!(
            ".needs-rebuild-{}",
            scoped_index_name("account", "map")
        )))
        .expect("remove marker blocker");
        let recovered = ContextSearchIndex::open(&root.0, "account", "map").expect("retry");
        assert!(recovered.status().expect("status").needs_rebuild);
    }

    #[test]
    fn concurrently_creates_the_trusted_app_data_descendant() {
        let base = Arc::new(TempRoot::new());
        let barrier = Arc::new(std::sync::Barrier::new(17));
        let workers = (0..16)
            .map(|_| {
                let base = Arc::clone(&base);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    prepare_trusted_descendant(&base.0, Path::new("context/search/tantivy-v1"))
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let roots = workers
            .into_iter()
            .map(|worker| worker.join().expect("worker").expect("trusted root"))
            .collect::<Vec<_>>();
        assert!(roots.windows(2).all(|pair| pair[0] == pair[1]));
    }

    #[test]
    fn stale_objects_reopen_the_current_generation_inside_the_scope_lock() {
        let root = TempRoot::new();
        let first = ContextSearchIndex::open(&root.0, "account", "map").expect("first open");
        first
            .replace_documents(&[document("note-one", "Original", "old generation")])
            .expect("initial index");
        fs::write(first.path.join("meta.json"), b"corrupt").expect("corrupt metadata");
        ContextSearchIndex::open(&root.0, "account", "map").expect("recover generation");

        first
            .replace_documents(&[document("note-two", "Current", "fresh generation")])
            .expect("write through stale object");
        let current = ContextSearchIndex::open(&root.0, "account", "map").expect("current open");
        assert_eq!(
            current
                .query(&ContextSearchQueryInput {
                    mode: ContextSearchMode::FullText,
                    query: "fresh".to_string(),
                    limit: 10,
                })
                .expect("query current generation")
                .len(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_in_the_app_data_descendant_chain() {
        use std::os::unix::fs::symlink;

        let base = TempRoot::new();
        let outside = TempRoot::new();
        symlink(&outside.0, base.0.join("context")).expect("create ancestor symlink");
        assert!(
            prepare_trusted_descendant(&base.0, Path::new("context/search/tantivy-v1")).is_err()
        );
    }

    #[test]
    fn caps_new_scope_directories() {
        let root = TempRoot::new();
        for index in 0..MAX_INDEX_SCOPES {
            fs::create_dir(
                root.0
                    .join(format!("a{index:032x}-m{:032x}", index + MAX_INDEX_SCOPES)),
            )
            .expect("create scope fixture");
        }
        assert!(ContextSearchIndex::open(&root.0, "overflow-account", "overflow-map").is_err());
    }

    #[test]
    fn validation_failure_preserves_the_previously_committed_document() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");
        index
            .replace_documents(&[document("note-one", "Original", "durable content")])
            .expect("initial commit");
        let mut invalid = document("note-one", "Replacement", "lost content");
        invalid.updated_at = MAX_JAVASCRIPT_TIMESTAMP + 1;
        assert!(index.replace_documents(&[invalid]).is_err());
        assert_eq!(
            index
                .query(&ContextSearchQueryInput {
                    mode: ContextSearchMode::FullText,
                    query: "durable".to_string(),
                    limit: 10,
                })
                .expect("query prior commit")
                .len(),
            1
        );
    }

    #[test]
    fn classifies_only_verified_index_corruption_as_rebuildable() {
        let corruption = tantivy::TantivyError::DataCorruption(
            tantivy::error::DataCorruption::comment_only("corrupt metadata"),
        );
        let transient = tantivy::TantivyError::InvalidArgument("not corruption".to_string());
        assert!(should_recover_from_open_error(&corruption));
        assert!(!should_recover_from_open_error(&transient));
    }

    #[test]
    fn serializes_the_process_wide_writer_memory_budget() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::Barrier;

        let barrier = Arc::new(Barrier::new(3));
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let threads = (0..2)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    barrier.wait();
                    with_writer_budget(|| {
                        let now = active.fetch_add(1, AtomicOrdering::SeqCst) + 1;
                        maximum.fetch_max(now, AtomicOrdering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(25));
                        active.fetch_sub(1, AtomicOrdering::SeqCst);
                        Ok(())
                    })
                    .expect("writer budget")
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for thread in threads {
            thread.join().expect("writer thread");
        }
        assert_eq!(maximum.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn unicode_case_folding_keeps_excerpt_offsets_valid() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");
        index
            .replace_documents(&[document("note-one", "Résumé", "Before ÉCLAIR after")])
            .expect("index");
        let results = index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "éclair".to_string(),
                limit: 10,
            })
            .expect("Unicode query");
        assert_eq!(results.len(), 1);
        assert!(results[0].excerpt.contains("ÉCLAIR"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_precreated_scoped_symlink_and_uses_owner_only_permissions() {
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

        let root = TempRoot::new();
        let outside = TempRoot::new();
        let scoped = root.0.join(scoped_index_name("account", "map"));
        symlink(&outside.0, &scoped).expect("create scoped symlink");
        assert!(ContextSearchIndex::open(&root.0, "account", "map").is_err());
        fs::remove_file(scoped).expect("remove symlink");

        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("safe open");
        assert_eq!(
            fs::metadata(&root.0)
                .expect("root metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&index.path).expect("index metadata").mode() & 0o777,
            0o700
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_precreated_scoped_reparse_point_when_supported() {
        use std::os::windows::fs::symlink_dir;

        let root = TempRoot::new();
        let outside = TempRoot::new();
        let scoped = root.0.join(scoped_index_name("account", "map"));
        match symlink_dir(&outside.0, &scoped) {
            Ok(()) => assert!(ContextSearchIndex::open(&root.0, "account", "map").is_err()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
                ) || error.raw_os_error() == Some(1314) => {}
            Err(error) => panic!("create scoped reparse point: {error}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_an_app_data_ancestor_reparse_point_when_supported() {
        use std::os::windows::fs::symlink_dir;

        let base = TempRoot::new();
        let outside = TempRoot::new();
        match symlink_dir(&outside.0, base.0.join("context")) {
            Ok(()) => assert!(prepare_trusted_descendant(
                &base.0,
                Path::new("context/search/tantivy-v1")
            )
            .is_err()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
                ) || error.raw_os_error() == Some(1314) => {}
            Err(error) => panic!("create ancestor reparse point: {error}"),
        }
    }

    #[test]
    fn returns_bounded_unicode_safe_tantivy_snippets() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open index");
        let mut long = document(
            "note-long",
            "Needle heading",
            &format!("{}needle context", "caf\u{e9} ".repeat(100_000)),
        );
        long.content_hash = "b".repeat(64);
        index.replace_documents(&[long]).expect("index long note");

        let full = index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "needle".to_string(),
                limit: 1,
            })
            .expect("full-text snippet");
        assert_eq!(full.len(), 1);
        assert!(full[0].excerpt.contains("needle"));
        assert!(full[0].excerpt.chars().count() <= 280);

        let quick = index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::Quick,
                query: "heading".to_string(),
                limit: 1,
            })
            .expect("quick fallback excerpt");
        assert_eq!(quick.len(), 1);
        assert!(quick[0].excerpt.chars().count() <= 280);
        assert!(quick[0].excerpt.ends_with('\u{2026}'));
    }

    #[test]
    fn rejects_unsafe_or_unbounded_documents_and_queries() {
        let root = TempRoot::new();
        assert!(ContextSearchIndex::open(&root.0, "../account", "map").is_err());
        let index = ContextSearchIndex::open(&root.0, "account", "map").expect("open");

        let mut unsafe_path = document("note-one", "One", "Body");
        unsafe_path.path = "../../private.txt".to_string();
        assert!(index.replace_documents(&[unsafe_path]).is_err());
        for path in [
            "C:/private.txt",
            "notes/%2e%2e/private.txt",
            "notes/%2Fprivate.txt",
            "notes/%252e%252e/private.txt",
            "notes/%252fprivate.txt",
            "notes/con/file.md",
            "notes/trailing./file.md",
        ] {
            let mut unsafe_path = document("note-one", "One", "Body");
            unsafe_path.path = path.to_string();
            assert!(
                index.replace_documents(&[unsafe_path]).is_err(),
                "accepted unsafe path {path}"
            );
        }

        let mut huge = document("note-one", "One", "Body");
        huge.body = "x".repeat(1_048_577);
        assert!(index.replace_documents(&[huge]).is_err());

        let mut future = document("note-one", "One", "Body");
        future.updated_at = MAX_JAVASCRIPT_TIMESTAMP + 1;
        assert!(index.replace_documents(&[future]).is_err());

        let mut multiline = document("note-multiline", "One", "line one\n\tline two\r\n");
        multiline.content_hash = "b".repeat(64);
        index
            .replace_documents(&[multiline])
            .expect("ordinary multiline body");
        for control in ['\u{001f}', '\u{007f}', '\u{0085}', '\u{2028}', '\u{2029}'] {
            let mut unsafe_body = document("note-control", "One", &format!("before{control}after"));
            unsafe_body.content_hash = "c".repeat(64);
            assert!(
                index.replace_documents(&[unsafe_body]).is_err(),
                "accepted unsafe body control U+{:04X}",
                control as u32
            );
        }

        assert!(index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "x".repeat(1_025),
                limit: 10,
            })
            .is_err());
        assert!(index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "safe".to_string(),
                limit: 101,
            })
            .is_err());
    }

    #[test]
    #[ignore = "representative local corpus benchmark; run explicitly at release checkpoints"]
    fn benchmarks_representative_local_corpus() {
        let root = TempRoot::new();
        let index = ContextSearchIndex::open(&root.0, "benchmark-account", "benchmark-map")
            .expect("open benchmark index");
        let documents = (0..250)
            .map(|number| {
                let mut input = document(
                    &format!("note-{number:04}"),
                    &format!("Benchmark note {number:04}"),
                    &format!(
                        "needle representative context {number:04} {}",
                        "ordinary searchable context ".repeat(640)
                    ),
                );
                input.content_hash = format!("{number:064x}");
                input
            })
            .collect::<Vec<_>>();

        let index_started = std::time::Instant::now();
        index
            .replace_documents(&documents)
            .expect("index representative corpus");
        let index_elapsed = index_started.elapsed();

        let query_started = std::time::Instant::now();
        let results = index
            .query(&ContextSearchQueryInput {
                mode: ContextSearchMode::FullText,
                query: "\"representative context\"".to_string(),
                limit: MAX_RESULTS,
            })
            .expect("query representative corpus");
        let query_elapsed = query_started.elapsed();
        let index_bytes = directory_size(&index.path);

        assert_eq!(results.len(), MAX_RESULTS);
        assert!(
            index_elapsed < std::time::Duration::from_secs(30),
            "representative indexing took {index_elapsed:?}"
        );
        assert!(
            query_elapsed < std::time::Duration::from_secs(2),
            "representative query took {query_elapsed:?}"
        );
        assert!(
            index_bytes < 64 * 1024 * 1024,
            "representative index used {index_bytes} bytes"
        );
        println!(
            "context_search_benchmark documents=250 source_bytes={} index_bytes={} index_ms={} query_ms={} results={}",
            documents.iter().map(|entry| entry.body.len()).sum::<usize>(),
            index_bytes,
            index_elapsed.as_millis(),
            query_elapsed.as_millis(),
            results.len()
        );
    }

    fn directory_size(root: &Path) -> u64 {
        let mut pending = vec![root.to_path_buf()];
        let mut bytes = 0_u64;
        while let Some(path) = pending.pop() {
            for entry in fs::read_dir(path).expect("read benchmark directory") {
                let entry = entry.expect("benchmark entry");
                let metadata = entry.metadata().expect("benchmark metadata");
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else {
                    bytes = bytes.saturating_add(metadata.len());
                }
            }
        }
        bytes
    }
}
