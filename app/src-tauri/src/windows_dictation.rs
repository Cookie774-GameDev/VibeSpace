//! Windows-wide text delivery to the original control captured before recording.
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
#[path = "windows_dictation_clipboard.rs"]
mod clipboard;
#[path = "windows_dictation_focus.rs"]
mod focus;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    window: usize,
    process: u32,
}

static TARGET: Mutex<Option<(Target, focus::SavedField)>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);

trait Desktop {
    fn foreground(&self) -> Option<Target>;
    fn activate(&self, target: Target) -> bool;
    fn insert(&self, text: &str) -> Result<(), String>;
}

fn deliver(desktop: &impl Desktop, target: Option<Target>, text: &str) -> Result<(), String> {
    let target = target.ok_or("Select a text field and confirm dictation again.")?;
    if !desktop.activate(target) || desktop.foreground() != Some(target) {
        return Err("The original text window is no longer available for dictation.".into());
    }
    desktop.insert(text)
}

use windows::Win32::{
    Foundation::HWND,
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
            KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_CONTROL, VK_LWIN, VK_MENU, VK_RETURN, VK_RWIN,
            VK_SHIFT, VK_SPACE, VK_V,
        },
        WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
        },
    },
};

struct WindowsDesktop {
    owner: usize,
    expected: Option<Target>,
    generation: u64,
    field: focus::SavedField,
}

fn identify(window: HWND) -> Option<Target> {
    if window.0.is_null() || !unsafe { IsWindow(Some(window)) }.as_bool() {
        return None;
    }
    let mut process = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut process));
    }
    (process != 0).then_some(Target {
        window: window.0 as usize,
        process,
    })
}

impl Desktop for WindowsDesktop {
    fn foreground(&self) -> Option<Target> {
        identify(unsafe { GetForegroundWindow() })
    }

    fn activate(&self, target: Target) -> bool {
        let window = HWND(target.window as *mut _);
        if identify(window) != Some(target) {
            return false;
        }
        if self.foreground() == Some(target) {
            return true;
        }
        unsafe { SetForegroundWindow(window) }.as_bool()
    }

    fn insert(&self, text: &str) -> Result<(), String> {
        // Clipboard contention can wait for 200ms. Do that BEFORE restoring
        // focus, otherwise a tab/field change during the wait receives Ctrl+V.
        let restore = clipboard::prepare(self.owner, text)?;
        let result = (|| {
            self.field.restore()?;
            self.field.verify()?;
            if GENERATION.load(Ordering::SeqCst) != self.generation
                || self.foreground() != self.expected
            {
                Err("Focus changed before dictated text could be pasted.".into())
            } else {
                let inputs = paste_inputs();
                let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
                if sent == inputs.len() as u32 {
                    Ok(())
                } else {
                    Err("Windows could not deliver dictated text to this application.".into())
                }
            }
        })();
        restore();
        result
    }
}

fn paste_inputs() -> [INPUT; 4] {
    [
        (VK_CONTROL, KEYBD_EVENT_FLAGS(0)),
        (VK_V, KEYBD_EVENT_FLAGS(0)),
        (VK_V, KEYEVENTF_KEYUP),
        (VK_CONTROL, KEYEVENTF_KEYUP),
    ]
    .map(|(key, flags)| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    })
}

/// Called by the native global shortcut BEFORE the overlay acquires focus.
pub fn capture_target() -> bool {
    let generation = GENERATION.load(Ordering::SeqCst);
    let foreground = identify(unsafe { GetForegroundWindow() });
    // Chromium/UIA focus notifications can trail a click. A short bounded retry
    // accepts the actual field after that notification instead of silently
    // ignoring the shortcut. Never follow focus into another window mid-probe.
    let mut field = None;
    for attempt in 0..4 {
        if foreground.is_none() || identify(unsafe { GetForegroundWindow() }) != foreground {
            return false;
        }
        field = focus::capture_editable();
        if field.is_some() {
            break;
        }
        if attempt < 3 {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    }
    let Some(field) = field else {
        return false;
    };
    if foreground.is_none() || identify(unsafe { GetForegroundWindow() }) != foreground {
        return false;
    }
    if let Ok(mut target) = TARGET.lock() {
        if target.is_none() && GENERATION.load(Ordering::SeqCst) == generation {
            GENERATION.fetch_add(1, Ordering::SeqCst);
            *target = foreground.map(|target| (target, field));
            return true;
        }
    }
    false
}

pub fn cancel() {
    if let Ok(mut target) = TARGET.lock() {
        GENERATION.fetch_add(1, Ordering::SeqCst);
        *target = None;
    }
}

pub fn paste(text: &str, owner: usize) -> Result<(), String> {
    let (target, field, generation) = {
        let saved = TARGET
            .lock()
            .map_err(|_| "Dictation is busy. Please retry.")?;
        (
            saved.as_ref().map(|(target, _)| *target),
            saved.as_ref().map(|(_, field)| field.clone()),
            GENERATION.load(Ordering::SeqCst),
        )
    };
    // Do not synthesize key-up events for physically held keys. Wait for the
    // confirming shortcut to be released so it cannot modify the inserted text.
    let keys = [
        VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN, VK_SPACE, VK_RETURN,
    ];
    let released = || {
        keys.iter()
            .all(|key| unsafe { GetAsyncKeyState(key.0 as i32) } >= 0)
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
    while !released() {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("Dictation was cancelled.".into());
        }
        if std::time::Instant::now() >= deadline {
            return Err("Release the shortcut keys and try again.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if GENERATION.load(Ordering::SeqCst) != generation {
        return Err("Dictation was cancelled.".into());
    }
    deliver(
        &WindowsDesktop {
            owner,
            expected: target,
            generation,
            field: field.ok_or("The original text box is unavailable. Your transcript is kept.")?,
        },
        target,
        text,
    )?;
    if let Ok(mut saved) = TARGET.lock() {
        if GENERATION.load(Ordering::SeqCst) == generation {
            *saved = None;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct FakeDesktop {
        focused: Option<Target>,
        activation: bool,
        inserted: Cell<bool>,
    }
    impl Desktop for FakeDesktop {
        fn foreground(&self) -> Option<Target> {
            self.focused
        }
        fn activate(&self, _: Target) -> bool {
            self.activation
        }
        fn insert(&self, _: &str) -> Result<(), String> {
            self.inserted.set(true);
            Ok(())
        }
    }
    const ORIGINAL: Target = Target {
        window: 1,
        process: 10,
    };

    #[test]
    fn confirmation_returns_to_the_original_window_after_many_focus_changes() {
        struct SwitchingDesktop {
            focused: Cell<Option<Target>>,
            inserted: Cell<bool>,
        }
        impl Desktop for SwitchingDesktop {
            fn foreground(&self) -> Option<Target> {
                self.focused.get()
            }
            fn activate(&self, target: Target) -> bool {
                self.focused.set(Some(target));
                true
            }
            fn insert(&self, _: &str) -> Result<(), String> {
                self.inserted.set(true);
                Ok(())
            }
        }
        let desktop = SwitchingDesktop {
            focused: Cell::new(Some(ORIGINAL)),
            inserted: Cell::new(false),
        };
        for window in 2..102 {
            desktop.focused.set(Some(Target {
                window,
                process: 20,
            }));
        }
        assert!(deliver(&desktop, Some(ORIGINAL), "saved take").is_ok());
        assert_eq!(desktop.foreground(), Some(ORIGINAL));
        assert!(desktop.inserted.get());
    }

    #[test]
    fn never_inserts_without_an_original_destination() {
        let desktop = FakeDesktop {
            focused: Some(ORIGINAL),
            activation: true,
            inserted: Cell::new(false),
        };
        assert!(deliver(&desktop, None, "hello").is_err());
        assert!(!desktop.inserted.get());
    }
    #[test]
    fn refused_focus_and_reused_window_handles_never_receive_text() {
        for (focused, activation) in [
            (Some(ORIGINAL), false),
            (
                Some(Target {
                    process: 11,
                    ..ORIGINAL
                }),
                true,
            ),
            (None, true),
        ] {
            let desktop = FakeDesktop {
                focused,
                activation,
                inserted: Cell::new(false),
            };
            assert!(deliver(&desktop, Some(ORIGINAL), "hello").is_err());
            assert!(!desktop.inserted.get());
        }
    }
    #[test]
    fn original_destination_receives_text_after_focus_is_verified() {
        let desktop = FakeDesktop {
            focused: Some(ORIGINAL),
            activation: true,
            inserted: Cell::new(false),
        };
        assert!(deliver(&desktop, Some(ORIGINAL), "hello").is_ok());
        assert!(desktop.inserted.get());
    }

    #[test]
    fn paste_uses_balanced_control_v_without_synthesizing_enter() {
        let inputs = paste_inputs();
        let keys: Vec<_> = inputs
            .iter()
            .map(|input| unsafe { input.Anonymous.ki.wVk })
            .collect();
        assert_eq!(keys, vec![VK_CONTROL, VK_V, VK_V, VK_CONTROL]);
        assert_eq!(unsafe { inputs[2].Anonymous.ki.dwFlags }, KEYEVENTF_KEYUP);
        assert_eq!(unsafe { inputs[3].Anonymous.ki.dwFlags }, KEYEVENTF_KEYUP);
    }
}
