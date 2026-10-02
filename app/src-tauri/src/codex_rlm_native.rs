// STAGING ONLY. Nested under cli_bridge so containment/reaping stays authoritative.
use super::*;
use crate::harness::codex_server::rlm_parent_binding;
use sha2::{Digest, Sha256};
use serde_json::Value;
use std::sync::OnceLock;

#[path = "codex_rlm_policy.rs"] mod policy;
pub(crate) const STRIP_PROVIDER_ENV:&[&str]=policy::STRIP_ENV;
pub(crate) fn configure_rlm_environment(command:&mut Command) {
    let preserved:Vec<_>=policy::ALLOW_ENV.iter().filter_map(|name|std::env::var_os(name).map(|value|(*name,value))).collect();
    command.env_clear();
    for (name,value) in preserved {command.env(name,value);}
    command.env("NO_COLOR","1");
}
fn verify_binary_certificate_bytes(executable_sha:&str,args:&[String],fast:bool,bytes:&[u8])->Result<(),String> {
    if executable_sha!=policy::PINNED_RUNTIME_SHA||format!("{:x}",Sha256::digest(bytes))!=policy::BINARY_CONFIG_CERTIFICATE_SHA {return Err("Codex binary/config certificate mismatch".into());}
    let certificate:Value=serde_json::from_slice(bytes).map_err(|_|"Codex certificate invalid")?;
    if certificate.get("proofScope").and_then(Value::as_str)!=Some("pinned-binary-config-loopback")||certificate.get("controls").and_then(Value::as_array).map(Vec::len)!=Some(9) {return Err("Codex binary/config proof unavailable".into());}
    let argv=serde_json::to_vec(args).map_err(|_|"Codex policy signature unavailable")?;
    let expected=if fast {policy::PRIORITY_ARGV_SHA}else{policy::STANDARD_ARGV_SHA};
    if format!("{:x}",Sha256::digest(argv))!=expected {return Err("Codex fixed policy signature mismatch".into());}
    Ok(())
}
fn verify_binary_certificate(executable_sha:&str,args:&[String],fast:bool)->Result<(),String> {
    verify_binary_certificate_bytes(executable_sha,args,fast,include_bytes!("codex_rlm_certificate.json"))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRlmParentBinding {
    pub caller: String, pub owner: String, pub generation: String,
    pub executable_id: String, pub executable_sha256: String,
    pub model: String, pub effort: String, pub fast: bool,
    pub profile_generation: String, pub account_hash: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest { pub owner: String, pub generation: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub authority_handle: String, pub request_id: String, pub prompt: String,
    pub timeout_ms: u64, pub output_limit_bytes: usize,
}
#[derive(Clone)]
struct Lease {
    parent: CodexRlmParentBinding, policy: policy::Authority,
    directory: PathBuf, expires: Instant,
}
static LEASES: OnceLock<Mutex<HashMap<String, Lease>>> = OnceLock::new();
fn leases() -> &'static Mutex<HashMap<String, Lease>> { LEASES.get_or_init(Default::default) }

pub fn account_hash(result: &serde_json::Value) -> Result<String, String> {
    let account = result.get("account").ok_or("Codex subscription account unavailable")?;
    if account.get("type").and_then(Value::as_str) != Some("chatgpt")
        || result.get("requiresOpenaiAuth").and_then(Value::as_bool) != Some(true) {
        return Err("Codex subscription account unverified".into());
    }
    let email = account.get("email").and_then(Value::as_str)
        .filter(|email| !email.trim().is_empty()).ok_or("Codex unique account unavailable")?;
    let mut digest = Sha256::new(); digest.update(b"S61-codex-account-v1\0"); digest.update(email.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

fn child_account_hash(executable: &Path) -> Result<String, String> {
    let mut command = Command::new(executable);
    command.args(["-c", "features.apps=false", "-c", "features.remote_plugin=false", "app-server", "--stdio"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    configure_rlm_environment(&mut command);
    let mut child = spawn_contained_process(&mut command)?;
    let mut input = child.child_mut()?.stdin.take().ok_or("Codex account stdin unavailable")?;
    let output = child.child_mut()?.stdout.take().ok_or("Codex account stdout unavailable")?;
    let (sender, receiver) = mpsc::sync_channel(16);
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(output);
        loop {
            let mut line = Vec::new();
            match reader.by_ref().take(262_145).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) if line.len() > 262_144 => return,
                Ok(_) => if sender.send(line).is_err() { return; },
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let result = (|| {
        let mut request = |value: Value| -> Result<(), String> {
            serde_json::to_writer(&mut input, &value).map_err(|_| "Codex account encoding failed")?;
            input.write_all(b"\n").and_then(|_| input.flush()).map_err(|_| "Codex account write failed".into())
        };
        request(serde_json::json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"vibespace","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}}))?;
        let receive = |id: u64| -> Result<Value,String> {
            loop {
                let wait=deadline.saturating_duration_since(Instant::now());
                if wait.is_zero() { return Err("Codex account proof timed out".into()); }
                let line=receiver.recv_timeout(wait).map_err(|_|"Codex account proof timed out")?;
                let value:Value=serde_json::from_slice(&line).map_err(|_|"Codex account protocol invalid")?;
                if value.get("id").and_then(Value::as_u64)!=Some(id) { continue; }
                return value.get("result").cloned().ok_or_else(||"Codex account proof rejected".into());
            }
        };
        receive(1)?;
        request(serde_json::json!({"method":"initialized","params":{}}))?;
        request(serde_json::json!({"id":2,"method":"account/read","params":{"refreshToken":false}}))?;
        account_hash(&receive(2)?)
    })();
    drop(input); drop(receiver);
    // Both success and failure reap the contained process tree before returning.
    let reaped=child.terminate_and_wait(); drop(child); let _=reader.join();
    reaped?; result
}

#[tauri::command]
pub async fn codex_rlm_prepare(app: tauri::AppHandle, webview: tauri::Webview, request: PrepareRequest) -> Result<Value,String> {
    let caller=webview.label().to_string();
    run_cli_blocking(move || {
        let parent=rlm_parent_binding(&app,&caller,&request.owner,&request.generation)?;
        if parent.model!="gpt-6-luna"||parent.effort!="low" { return Err("Codex exact child model unavailable".into()); }
        let state=app.state::<CliBridgeState>();
        let executable=state.resolve_trusted_executable(&parent.executable_id)?;
        let sha=format!("{:x}",Sha256::digest(fs::read(&executable).map_err(|_|"Codex runtime hash unavailable")?));
        if sha!=parent.executable_sha256||sha!=policy::PINNED_RUNTIME_SHA { return Err("Codex parent runtime changed".into()); }
        let version=probe_with_state(&state,CliProbeRequest { executable_id:parent.executable_id.clone(),args:vec!["--version".into()],timeout_ms:3000,output_limit_bytes:1024 })?;
        if version.exit_code!=Some(0)||version.timed_out||version.stdout.data.trim()!="codex-cli 0.159.2" { return Err("Codex exact runtime unavailable".into()); }
        let child_hash=child_account_hash(&executable)?;
        if child_hash!=parent.account_hash||parent!=rlm_parent_binding(&app,&caller,&request.owner,&request.generation)? { return Err("Codex child account binding changed".into()); }
        // Profile proof is derived above from live account RPC equality, not fixture booleans.
        let policy=policy::Authority { caller:parent.caller.clone(),owner:parent.owner.clone(),generation:parent.generation.clone(),executable_id:parent.executable_id.clone(),executable_sha256:sha.clone(),version:"codex-cli 0.159.2".into(),route:"official:openai-codex".into(),profile_generation:parent.profile_generation.clone(),config_generation:policy::BINARY_CONFIG_CERTIFICATE_SHA.into(),account_hash:child_hash.clone(),capability_generation:policy::BINARY_CONFIG_CERTIFICATE_SHA.into(),authenticated_profile_verified:true };
        let args=policy::authorize(&policy,&policy,&policy::ChildRequest {caller:&parent.caller,owner:&parent.owner,generation:&parent.generation,model:&parent.model,effort:&parent.effort,fast:parent.fast,prompt_bytes:1}).map_err(str::to_string)?;
        verify_binary_certificate(&sha,&args,parent.fast)?;
        let storage=app.path().app_data_dir().map_err(|_|"Codex private storage unavailable")?;
        let nonce=nanoid::nanoid!(32).replace(['-','_'],"A");
        let directory=policy::private_cwd(&storage,&nonce).map_err(str::to_string)?;
        let root=directory.parent().ok_or("Codex private directory unavailable")?;
        fs::create_dir_all(root).map_err(|_|"Codex private root unavailable")?;
        fs::create_dir(&directory).map_err(|_|"Codex exclusive directory unavailable")?;
        let directory=fs::canonicalize(&directory).map_err(|_|"Codex private directory unavailable")?;
        if directory.parent()!=Some(fs::canonicalize(root).map_err(|_|"Codex private root unavailable")?.as_path())||fs::read_dir(&directory).map_err(|_|"Codex directory unreadable")?.next().is_some() { return Err("Codex private directory invalid".into()); }
        let handle=format!("codex-rlm-authority-{}",nanoid::nanoid!(32));
        let mut map=leases().lock().map_err(|_|"Codex child authority unavailable")?;
        if map.len()>=8 { let _=fs::remove_dir(&directory);return Err("Codex child authority limit reached".into()); }
        map.insert(handle.clone(),Lease {parent:parent.clone(),policy,directory:directory.clone(),expires:Instant::now()+Duration::from_secs(30)});
        let runtime=serde_json::json!({"executableId":parent.executable_id,"executableSha256":sha,"version":"0.159.2","profileGeneration":parent.profile_generation,"authBillingRoute":"codex-cli-session","configPolicyGeneration":policy::BINARY_CONFIG_CERTIFICATE_SHA,"isolatedWorkingDirectory":directory});
        let mut capability=runtime.clone();let cap=capability.as_object_mut().ok_or("Codex descriptor invalid")?;
        for name in ["authenticatedProfileVerified","positiveControlVerified","negativeAppsVerified","negativeBuiltinsVerified"] { cap.insert(name.into(),Value::Bool(true)); }
        cap.insert("binaryConfigProofScope".into(),Value::String("pinned-binary-config-loopback".into()));
        cap.insert("binaryConfigCertificateHash".into(),Value::String(policy::BINARY_CONFIG_CERTIFICATE_SHA.into()));
        cap.insert("authenticatedModelControlsVerified".into(),Value::Bool(false));
        cap.insert("nativeModelAcceptance".into(),Value::String("pending".into()));
        cap.insert("modelIds".into(),serde_json::json!(["gpt-6-luna"]));cap.insert("efforts".into(),serde_json::json!(["low"]));cap.insert("fastVariants".into(),if parent.fast {serde_json::json!(["fast","priority"])} else {serde_json::json!(["standard"])});
        Ok(serde_json::json!({"authorityHandle":handle,"parent":{"caller":parent.caller,"owner":parent.owner,"generation":parent.generation},"runtime":runtime,"capability":capability,"accountHash":child_hash,"sameUniqueAccount":true}))
    }).await
}

#[tauri::command]
pub fn codex_rlm_revoke(webview: tauri::Webview, authority_handle:String) -> Result<(),String> {
    let mut map=leases().lock().map_err(|_|"Codex child authority unavailable")?;
    if map.get(&authority_handle).is_some_and(|lease|lease.parent.caller!=webview.label()) { return Err("Codex authority caller mismatch".into()); }
    if let Some(lease)=map.remove(&authority_handle) { let _=fs::remove_dir(lease.directory); }
    Ok(())
}

#[tauri::command]
pub async fn codex_rlm_start(app:tauri::AppHandle,webview:tauri::Webview,request:StartRequest)->Result<(),String> {
    let caller=webview.label().to_string();
    run_cli_blocking(move || start_rlm_internal(app,&caller,request)).await
}
fn start_rlm_internal(app:tauri::AppHandle,caller:&str,request:StartRequest)->Result<(),String> {
    validate_request_id(&request.request_id)?;
    if request.timeout_ms>30000||request.output_limit_bytes>262144 { return Err("Codex child limits invalid".into()); }
    let mut map=leases().lock().map_err(|_|"Codex child authority unavailable")?;
    let lease=map.get(&request.authority_handle).ok_or("Codex child authority unavailable")?;
    if lease.parent.caller!=caller { return Err("Codex authority caller mismatch".into()); }
    let lease=map.remove(&request.authority_handle).ok_or("Codex child authority unavailable")?;drop(map);
    let attempt=(|| {
        if Instant::now()>lease.expires||lease.parent!=rlm_parent_binding(&app,caller,&lease.parent.owner,&lease.parent.generation)? { return Err("Codex parent binding expired".into()); }
        if fs::canonicalize(&lease.directory).map_err(|_|"Codex private directory unavailable")?!=lease.directory||fs::read_dir(&lease.directory).map_err(|_|"Codex private directory unreadable")?.next().is_some() { return Err("Codex private directory changed".into()); }
        let args=policy::authorize(&lease.policy,&lease.policy,&policy::ChildRequest {caller,owner:&lease.parent.owner,generation:&lease.parent.generation,model:&lease.parent.model,effort:&lease.parent.effort,fast:lease.parent.fast,prompt_bytes:request.prompt.len()}).map_err(str::to_string)?;
        verify_binary_certificate(&lease.parent.executable_sha256,&args,lease.parent.fast)?;
        let state=app.state::<CliBridgeState>();
        let executable=state.resolve_trusted_executable(&lease.parent.executable_id)?;
        if format!("{:x}",Sha256::digest(fs::read(executable).map_err(|_|"Codex runtime unavailable")?))!=lease.parent.executable_sha256 { return Err("Codex child runtime changed".into()); }
        let executable=state.resolve_trusted_executable(&lease.parent.executable_id)?;
        if child_account_hash(&executable)?!=lease.parent.account_hash { return Err("Codex child account changed before dispatch".into()); }
        let mut prepared=prepare_start_request(&state,CliStartRequest {request_id:request.request_id.clone(),executable_id:lease.parent.executable_id.clone(),args,cwd:lease.directory.to_str().map(str::to_string),stdin:Some(request.prompt),timeout_ms:request.timeout_ms,output_limit_bytes:request.output_limit_bytes,tool_scope:None})?;
        prepared.strip_provider_environment=true;
        start_owned_rlm_supervisor(&app,&state,&request.request_id,prepared,lease.directory.clone())
    })();
    if attempt.is_err() { let _=fs::remove_dir(lease.directory); }
    attempt
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn unique_account_hash_never_contains_raw_identity() {
        let proof=account_hash(&serde_json::json!({"requiresOpenaiAuth":true,"account":{"type":"chatgpt","email":"fixture@example.invalid","planType":"fixture"}})).unwrap();
        assert_eq!(proof.len(),64);assert!(!proof.contains('@'));
    }
    #[test] fn plan_type_without_unique_identity_is_rejected() {
        assert!(account_hash(&serde_json::json!({"requiresOpenaiAuth":true,"account":{"type":"chatgpt","planType":"pro"}})).is_err());
    }
    #[test] fn api_auth_is_rejected() {
        assert!(account_hash(&serde_json::json!({"requiresOpenaiAuth":true,"account":{"type":"apiKey"}})).is_err());
    }
    #[test] fn unknown_request_fields_are_rejected() {
        assert!(serde_json::from_value::<StartRequest>(serde_json::json!({"authorityHandle":"fixture","requestId":"fixture","prompt":"fixture","timeoutMs":30000,"outputLimitBytes":262144,"args":["shell"]})).is_err());
    }
    fn certificate_args(fast:bool)->Vec<String> {
        let a=policy::Authority {caller:"main".into(),owner:"fixture".into(),generation:"fixture".into(),executable_id:"cli-executable-fixture".into(),executable_sha256:policy::PINNED_RUNTIME_SHA.into(),version:"codex-cli 0.159.2".into(),route:"official:openai-codex".into(),profile_generation:"fixture".into(),config_generation:policy::BINARY_CONFIG_CERTIFICATE_SHA.into(),account_hash:"a".repeat(64),capability_generation:policy::BINARY_CONFIG_CERTIFICATE_SHA.into(),authenticated_profile_verified:true};
        policy::authorize(&a,&a,&policy::ChildRequest {caller:"main",owner:"fixture",generation:"fixture",model:"gpt-6-luna",effort:"low",fast,prompt_bytes:1}).unwrap()
    }
    #[test] fn pinned_binary_and_exact_standard_policy_certificate_pass() {assert!(verify_binary_certificate(policy::PINNED_RUNTIME_SHA,&certificate_args(false),false).is_ok());}
    #[test] fn pinned_binary_and_exact_priority_policy_certificate_pass() {assert!(verify_binary_certificate(policy::PINNED_RUNTIME_SHA,&certificate_args(true),true).is_ok());}
    #[test] fn same_version_different_binary_certificate_rejected() {assert!(verify_binary_certificate(&"a".repeat(64),&certificate_args(false),false).is_err());}
    #[test] fn changed_feature_or_route_argv_rejected() {let mut args=certificate_args(false);args.push("features.apps=true".into());assert!(verify_binary_certificate(policy::PINNED_RUNTIME_SHA,&args,false).is_err());}
    #[test] fn changed_receipt_certificate_rejected() {assert!(verify_binary_certificate_bytes(policy::PINNED_RUNTIME_SHA,&certificate_args(false),false,b"{}").is_err());}
}
