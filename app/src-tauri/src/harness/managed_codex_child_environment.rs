use std::path::Path;
use std::process::Command;

/// Keep proxy catalog discovery on the same verified executable as app-server.
pub fn bind_codex_executable(command: &mut Command, executable: &Path) {
    command.env("CODEX_CLI_PATH", executable);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn proxy_uses_selected_executable_without_changing_parent_environment() {
        let before = std::env::var_os("CODEX_CLI_PATH");
        let mut child = Command::new("bun");
        child.env("CODEX_CLI_PATH", "C:/protected/codex.exe");
        let selected = Path::new("D:/managed/codex.exe");
        bind_codex_executable(&mut child, selected);
        let actual = child.get_envs().find(|(key, _)| *key == OsStr::new("CODEX_CLI_PATH"));
        assert_eq!(actual, Some((OsStr::new("CODEX_CLI_PATH"), Some(selected.as_os_str()))));
        assert_eq!(std::env::var_os("CODEX_CLI_PATH"), before);
    }
}
