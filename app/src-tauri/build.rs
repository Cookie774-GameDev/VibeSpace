// tauri-build: generates capability schemas, embeds the Tauri context, and
// hooks up the Cargo build script with platform-specific resources.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // tauri-build walks resources during Cargo compilation, before the CLI's
        // beforeBundleCommand. An empty directory is valid; no DLL glob or
        // placeholder file is introduced into debug/Cargo-only builds.
        let root = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
        let directory = root.join("resources").join("windows-runtime-dlls");
        for path in [root.join("resources"), directory.clone()] {
            if let Ok(metadata) = std::fs::symlink_metadata(&path) {
                assert!(metadata.is_dir() && !metadata.file_type().is_symlink(), "DLL resource path must be an unlinked directory");
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    assert_eq!(metadata.file_attributes() & 0x400, 0, "DLL resource path must not be a reparse point");
                }
            }
        }
        std::fs::create_dir_all(&directory).expect("Create empty Windows DLL resource directory");
    }
    tauri_build::build()
}
