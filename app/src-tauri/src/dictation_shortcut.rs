use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

pub fn parse(combo: Option<&str>) -> Result<Shortcut, String> {
    match combo {
        None => Ok(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)),
        Some(combo) => combo.parse::<Shortcut>().map_err(|_| "Invalid dictation shortcut.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_and_custom_bindings() {
        assert_eq!(parse(None).unwrap(), parse(Some("Ctrl+Shift+Space")).unwrap());
        assert_ne!(parse(None).unwrap(), parse(Some("Ctrl+Space")).unwrap());
        assert_eq!(parse(Some("Alt+Shift+D")).unwrap(), Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::KeyD));
        assert!(parse(Some("not-a-key")).is_err());
    }
}
