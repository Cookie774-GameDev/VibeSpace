#[cfg(all(test, target_os = "windows"))]
mod s61_real_setup_lifecycle_tests {
    use super::*;
    const CHILD_CODE: &str = "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); (p/'grandchild.started').write_text(str(__import__('os').getpid())); time.sleep(8); (p/'late.finished').write_text('unexpected')";
    const ROOT_CODE: &str = "import pathlib,subprocess,sys,time,os; p=pathlib.Path(sys.argv[1]); subprocess.Popen([sys.executable,'-c',sys.argv[2],str(p)]); limit=time.monotonic()+3;\nwhile not (p/'grandchild.started').exists() and time.monotonic()<limit: time.sleep(.01)\n(p/'root.started').write_text(str(os.getpid()));\nif sys.argv[3]=='exit': sys.exit(0)\ntime.sleep(8)";
    fn fixture(label: &str) -> (PathBuf, String, RuntimeSetupControl) {
        let root = PathBuf::from(std::env::var("S61_FOUNDRY_LIFECYCLE_OUTPUT_ROOT").expect("ROOT-admitted disposable output required"));
        assert!(root.is_absolute() && root.is_dir());
        let python = std::env::var("S61_FOUNDRY_LIFECYCLE_PYTHON").expect("ROOT-attested existing Python required");
        assert!(Path::new(&python).is_absolute() && Path::new(&python).is_file());
        let token = format!("s61-lifecycle-{label}-{}", nanoid::nanoid!());
        let dir = root.join(&token); fs::create_dir(&dir).unwrap();
        let control = RuntimeSetupControl { setup_id: token, cancelled: Arc::new(AtomicBool::new(false)),
            deadline: Some(Instant::now()+Duration::from_secs(4)), owned_process: Arc::new(Mutex::new(None)),
            cleanup_pending: Arc::new(AtomicBool::new(false)) };
        (dir, python, control)
    }
    // This guard is armed BEFORE any spawn/marker/assertion; it covers unwinding too.
    static FAILED_CLEANUP_OWNERS: Mutex<Vec<RuntimeSetupControl>> = Mutex::new(Vec::new());
    struct FixtureCleanup { dir: PathBuf, control: RuntimeSetupControl }
    impl FixtureCleanup {
        fn new(dir: &Path, control: &RuntimeSetupControl) -> Self { Self {dir:dir.to_path_buf(), control:control.clone()} }
    }
    impl Drop for FixtureCleanup {
        fn drop(&mut self) {
            if let Err(error) = retry_owned_setup_cleanup(&self.control, Duration::from_secs(3)) {
                // Never claim cleanup or discard handles on unknown closure. ROOT's outer
                // KILL_ON_CLOSE watchdog still owns ALL descendants, including an inner-job
                // assignment failure's suspended root. Preserve typed failure evidence.
                let _ = fs::write(self.dir.join("cleanup-unconfirmed.json"), serde_json::to_vec(&serde_json::json!({
                    "setupToken":self.control.setup_id,"cleanupConfirmed":false,"error":error,
                    "handlesRetained":true,"outerWatchdogRequired":true})).unwrap_or_default());
                if let Ok(mut owners) = FAILED_CLEANUP_OWNERS.lock() { owners.push(self.control.clone()); }
                else { std::mem::forget(self.control.clone()); } // fail-closed ownership on poisoned audit state
            }
        }
    }
    fn command(python: &str, dir: &Path, mode: &str) -> Command {
        let mut command = hidden_command(python);
        command.args(["-c", ROOT_CODE]).arg(dir).args([CHILD_CODE, mode]); command
    }
    fn started(dir: &Path) -> bool { dir.join("root.started").is_file() && dir.join("grandchild.started").is_file() }
    fn wait_started(dir: &Path) {
        let until=Instant::now()+Duration::from_secs(3);
        while !started(dir) && Instant::now()<until { thread::sleep(Duration::from_millis(10)); }
        assert!(started(dir), "actual root and grandchild start markers required");
    }
    fn receipt(dir: &Path, case: &str, control: &RuntimeSetupControl, query_observed: bool) {
        assert!(started(dir));
        assert!(setup_cleanup_is_confirmed(control));
        thread::sleep(Duration::from_millis(100));
        assert!(!dir.join("late.finished").exists());
        fs::write(dir.join("receipt.json"), serde_json::to_vec_pretty(&serde_json::json!({
            "case":case,"setupToken":control.setup_id,"rootStarted":true,"grandchildStarted":true,
            "rootPID":fs::read_to_string(dir.join("root.started")).unwrap(),
            "grandchildPID":fs::read_to_string(dir.join("grandchild.started")).unwrap(),
            "explicitNonemptyJobObserved":query_observed,"rootReapAndEmptyJobConfirmed":true,
            "ownedHandleReleased":true,"cleanupPending":false,"lateMarkerAbsent":true,
            "proof":"actual production cleanup requires root reap AND empty-job query; no global PID kill/scan"})).unwrap()).unwrap();
    }
    #[test]
    fn real_root_exit_descendant_live_query_then_owned_cleanup() {
        let (dir, python, control)=fixture("root-exit"); let _cleanup=FixtureCleanup::new(&dir,&control);
        let mut cmd=command(&python,&dir,"exit");
        let job=crate::harness::runtime::version_probe_job::ProbeJob::create().unwrap();
        crate::harness::runtime::version_probe_job::configure_suspended(&mut cmd);
        with_setup_launch_authority(&control,Duration::from_secs(4),|owned| {
            let child=cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            *owned=Some(Box::new(NativeSetupProcess{child,job})); owned.as_mut().unwrap().start()
        }).unwrap();
        wait_started(&dir);
        let until=Instant::now()+Duration::from_secs(2);
        let root_exited=loop {
            let mut owned=control.owned_process.lock().unwrap();
            if owned.as_mut().unwrap().poll_root().unwrap().is_some(){break true}
            drop(owned); if Instant::now()>=until{break false} thread::sleep(Duration::from_millis(10));
        };
        assert!(root_exited);
        assert!(!control.owned_process.lock().unwrap().as_mut().unwrap().tree_empty().unwrap(),"real descendant keeps actual job nonempty after root exit");
        assert!(!setup_cleanup_is_confirmed(&control));
        retry_owned_setup_cleanup(&control,Duration::from_secs(3)).unwrap();
        receipt(&dir,"root-exit-descendant-live",&control,true);
    }
    #[test]
    fn real_whole_deadline_reaps_root_and_grandchild() {
        let (dir,python,mut control)=fixture("deadline"); let _cleanup=FixtureCleanup::new(&dir,&control);
        control.deadline=Some(Instant::now()+Duration::from_secs(2));
        let result=bounded_setup_process_output(command(&python,&dir,"hold"),&dir,Duration::from_secs(20),"disposable lifecycle",&control);
        assert!(result.unwrap_err().contains("deadline"));
        receipt(&dir,"whole-deadline",&control,false);
    }
    #[test]
    fn real_matching_cancel_reaps_root_and_grandchild() {
        let (dir,python,control)=fixture("cancel"); let _cleanup=FixtureCleanup::new(&dir,&control);
        let registry=Arc::new(Mutex::new(Some(control.clone())));
        std::thread::scope(|scope| {
            let caller_control=control.clone(); let caller_dir=dir.clone(); let caller_registry=registry.clone();
            let caller=scope.spawn(move || {wait_started(&caller_dir); cancel_runtime_setup_and_recover(&caller_registry,&caller_control.setup_id,Duration::from_secs(3))});
            let result=bounded_setup_process_output(command(&python,&dir,"hold"),&dir,Duration::from_secs(20),"disposable lifecycle",&control);
            assert!(caller.join().unwrap().unwrap()); assert!(result.unwrap_err().contains("cancelled"));
        });
        assert!(release_setup_if_closed(&registry,&control));
        receipt(&dir,"matching-cancel",&control,false);
    }
    struct FirstQueryFails { native: NativeSetupProcess, failed: bool }
    impl SetupProcessOps for FirstQueryFails {
        fn start(&mut self)->Result<(),String>{self.native.start()}
        fn terminate_tree(&mut self)->Result<(),String>{self.native.terminate_tree()}
        fn poll_root(&mut self)->Result<Option<std::process::ExitStatus>,String>{self.native.poll_root()}
        fn tree_empty(&mut self)->Result<bool,String>{if !self.failed {self.failed=true;Err("explicit fixture one-time query failure".into())}else{self.native.tree_empty()}}
    }
    #[test]
    fn real_same_token_retry_retains_handles_after_injected_query_failure() {
        let (dir,python,control)=fixture("retry"); let _cleanup=FixtureCleanup::new(&dir,&control); let registry=Mutex::new(Some(control.clone()));
        let mut cmd=command(&python,&dir,"hold");
        let job=crate::harness::runtime::version_probe_job::ProbeJob::create().unwrap();
        crate::harness::runtime::version_probe_job::configure_suspended(&mut cmd);
        with_setup_launch_authority(&control,Duration::from_secs(4),|owned| {
            let child=cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            *owned=Some(Box::new(FirstQueryFails{native:NativeSetupProcess{child,job},failed:false})); owned.as_mut().unwrap().start()
        }).unwrap(); wait_started(&dir);
        assert!(retry_owned_setup_cleanup(&control,Duration::from_secs(3)).unwrap_err().contains("one-time query failure"));
        assert!(control.owned_process.lock().unwrap().is_some());
        assert!(ensure_no_retained_setup(&registry).is_err());
        assert!(!cancel_runtime_setup_and_recover(&registry,"foreign-token",Duration::from_secs(3)).unwrap());
        assert!(cancel_runtime_setup_and_recover(&registry,&control.setup_id,Duration::from_secs(3)).unwrap());
        assert!(registry.lock().unwrap().is_none()); receipt(&dir,"same-token-injected-query-retry",&control,false);
    }
}