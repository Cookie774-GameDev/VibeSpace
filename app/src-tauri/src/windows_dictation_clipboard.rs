use windows::Win32::{
    Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
            OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
    },
};

const UNICODE_TEXT: u32 = 13;

// Windows consumes these DWORD=0 formats before publishing a clipboard item.
// Apply to both the temporary transcript and restoration to avoid Win+V spam.
const PRIVATE_FORMATS: [windows::core::PCWSTR; 2] = [
    windows::core::w!("CanIncludeInClipboardHistory"),
    windows::core::w!("CanUploadToCloudClipboard"),
];

fn exclude_history_and_sync() -> Result<(), String> {
    for name in PRIVATE_FORMATS {
        unsafe {
            let format = RegisterClipboardFormatW(name);
            if format == 0 {
                return Err("Could not protect dictation clipboard history.".into());
            }
            let memory = GlobalAlloc(GMEM_MOVEABLE, std::mem::size_of::<u32>())
                .map_err(|_| "Could not protect dictation clipboard history.")?;
            let pointer = GlobalLock(memory) as *mut u32;
            if pointer.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("Could not protect dictation clipboard history.".into());
            }
            pointer.write(0);
            let _ = GlobalUnlock(memory);
            if SetClipboardData(format, Some(HANDLE(memory.0))).is_err() {
                let _ = GlobalFree(Some(memory));
                return Err("Could not protect dictation clipboard history.".into());
            }
        }
    }
    Ok(())
}

struct Clipboard;
impl Clipboard {
    fn open(owner: HWND) -> Result<Self, String> {
        for _ in 0..20 {
            if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Err("The clipboard is busy. Please retry.".into())
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

// Called only while this process holds the clipboard open.
fn read_text() -> Option<String> {
    unsafe {
        let handle = HGLOBAL(GetClipboardData(UNICODE_TEXT).ok()?.0);
        let size = GlobalSize(handle) / 2;
        let pointer = GlobalLock(handle) as *const u16;
        if pointer.is_null() {
            return None;
        }
        let units = std::slice::from_raw_parts(pointer, size);
        let end = units.iter().position(|unit| *unit == 0).unwrap_or(size);
        let text = String::from_utf16(&units[..end]).ok();
        let _ = GlobalUnlock(handle);
        text
    }
}

fn write_text(text: &str) -> Result<(), String> {
    let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let memory = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2)
            .map_err(|_| "Could not prepare dictated text.")?;
        let pointer = GlobalLock(memory) as *mut u16;
        if pointer.is_null() {
            let _ = GlobalFree(Some(memory));
            return Err("Could not prepare dictated text.".into());
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len());
        let _ = GlobalUnlock(memory);
        let result = EmptyClipboard()
            .map_err(|_| "Could not copy dictated text.".to_string())
            .and_then(|_| exclude_history_and_sync())
            .and_then(|_| {
                SetClipboardData(UNICODE_TEXT, Some(HANDLE(memory.0)))
                    .map_err(|_| "Could not copy dictated text.".to_string())
            });
        if let Err(error) = result {
            let _ = GlobalFree(Some(memory));
            return Err(error);
        }
        // Windows owns memory after SetClipboardData succeeds.
        Ok(())
    }
}

pub fn prepare(owner: usize, text: &str) -> Result<impl FnOnce(), String> {
    let guard = Clipboard::open(HWND(owner as *mut _))?;
    let previous = read_text();
    write_text(text)?;
    let sequence = unsafe { GetClipboardSequenceNumber() };
    drop(guard);
    Ok(move || {
        if let Some(previous) = previous {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                if let Ok(_guard) = Clipboard::open(HWND(owner as *mut _)) {
                    // A user copy, including a copy of identical text, wins.
                    if unsafe { GetClipboardSequenceNumber() } == sequence {
                        let _ = write_text(&previous);
                    }
                }
            });
        }
    })
}
