//! A reversible lease on an external HWND; never owns or terminates its process.
use super::NativeBounds;
use windows::core::BOOL;
use windows::Win32::{
    Foundation::{GetLastError, SetLastError, HWND, LPARAM, WIN32_ERROR},
    UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetParent, GetWindowLongPtrW, GetWindowPlacement,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetParent, SetWindowLongPtrW,
        SetWindowPlacement, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_TOP,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_RESTORE, SW_SHOWNA,
        WINDOWPLACEMENT, WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW, WS_POPUP, WS_THICKFRAME,
    },
};

pub struct EmbeddedWindow {
    hwnd: isize,
    parent: isize,
    pid: u32,
    style: isize,
    ex_style: isize,
    placement: WINDOWPLACEMENT,
    original_parent: isize,
    frame_visible: bool,
}

fn class_name(window: HWND) -> String {
    let mut name = [0u16; 256];
    let length = unsafe { GetClassNameW(window, &mut name) } as usize;
    String::from_utf16_lossy(&name[..length])
}

// Some ApplicationFrameHost shell frames reject SetParent (error 87). Lease their
// actual CoreWindow content instead, retaining the frame for exact restoration.
fn packaged_content(frame: HWND) -> Option<HWND> {
    if class_name(frame) != "ApplicationFrameWindow" {
        return None;
    }
    unsafe extern "system" fn visit(child: HWND, data: LPARAM) -> BOOL {
        let result = unsafe { &mut *(data.0 as *mut Option<HWND>) };
        if class_name(child) == "Windows.UI.Core.CoreWindow"
            && unsafe { IsWindowVisible(child) }.as_bool()
        {
            *result = Some(child);
            return false.into();
        }
        true.into()
    }
    let mut result = None;
    let _ = unsafe {
        EnumChildWindows(
            Some(frame),
            Some(visit),
            LPARAM((&mut result as *mut Option<HWND>) as isize),
        )
    };
    result.filter(|child| unsafe { GetParent(*child) }.is_ok_and(|parent| parent == frame))
}

fn handle(value: isize) -> HWND {
    HWND(value as *mut std::ffi::c_void)
}

fn child_style(style: isize) -> isize {
    (style & !((WS_POPUP | WS_CAPTION | WS_THICKFRAME).0 as isize)) | WS_CHILD.0 as isize
}

impl EmbeddedWindow {
    pub fn attach(hwnd: isize, parent: isize) -> Result<Self, String> {
        let frame = handle(hwnd);
        if hwnd == parent
            || !unsafe { IsWindow(Some(frame)) }.as_bool()
            || unsafe { GetParent(frame) }.is_ok()
        {
            return Err("This app window cannot be hosted in Workbench.".into());
        }
        let window = packaged_content(frame).unwrap_or(frame);
        Self::attach_content(frame, window, parent)
    }

    fn attach_content(frame: HWND, window: HWND, parent: isize) -> Result<Self, String> {
        if !unsafe { IsWindow(Some(handle(parent))) }.as_bool() {
            return Err("Workbench host window is unavailable.".into());
        }
        let hwnd = window.0 as isize;
        let original_parent = unsafe { GetParent(window) }.map_or(0, |parent| parent.0 as isize);
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut pid));
        }
        if pid == std::process::id() {
            return Err("Cannot embed VibeSpace inside itself.".into());
        }
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        unsafe { GetWindowPlacement(window, &mut placement) }.map_err(|e| e.to_string())?;
        let lease = Self {
            hwnd,
            parent,
            pid,
            placement,
            style: unsafe { GetWindowLongPtrW(window, GWL_STYLE) },
            ex_style: unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) },
            original_parent,
            frame_visible: original_parent != 0 && unsafe { IsWindowVisible(frame) }.as_bool(),
        };
        let parent_error;
        unsafe {
            let _ = ShowWindow(window, SW_RESTORE);
            SetWindowLongPtrW(window, GWL_STYLE, child_style(lease.style));
            SetWindowLongPtrW(
                window,
                GWL_EXSTYLE,
                lease.ex_style & !(WS_EX_APPWINDOW.0 as isize),
            );
            // A successful SetParent can return NULL for a previous desktop parent.
            // Verify the resulting relationship instead of treating NULL as failure.
            SetLastError(WIN32_ERROR(0));
            let _ = SetParent(window, Some(handle(parent)));
            parent_error = GetLastError();
        }
        if !lease.is_attached() {
            unsafe {
                SetWindowLongPtrW(window, GWL_STYLE, lease.style);
                SetWindowLongPtrW(window, GWL_EXSTYLE, lease.ex_style);
                let _ = SetWindowPlacement(window, &lease.placement);
                let _ = SetWindowPos(
                    window,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED
                        | SWP_NOACTIVATE
                        | SWP_NOZORDER
                        | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                        | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE,
                );
            }
            return Err(format!(
                "Windows could not embed this app (SetParent error {}).",
                parent_error.0
            ));
        }
        if lease.original_parent != 0 {
            unsafe {
                let _ = ShowWindow(handle(lease.original_parent), SW_HIDE);
            }
        }
        Ok(lease)
    }

    pub fn is_attached(&self) -> bool {
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(handle(self.hwnd), Some(&mut pid));
        }
        pid == self.pid
            && unsafe { GetParent(handle(self.hwnd)) }
                .is_ok_and(|parent| parent.0 as isize == self.parent)
    }

    pub fn resize(&self, bounds: &NativeBounds, scale: f64) -> Result<(), String> {
        if !self.is_attached() {
            return Err("The app window closed or left Workbench.".into());
        }
        unsafe {
            SetWindowPos(
                handle(self.hwnd),
                None,
                (bounds.x * scale).round() as i32,
                (bounds.y * scale).round() as i32,
                (bounds.width * scale).round().max(1.) as i32,
                (bounds.height * scale).round().max(1.) as i32,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|e| e.to_string())?;
            let _ = ShowWindow(handle(self.hwnd), SW_SHOWNA);
        }
        Ok(())
    }

    pub fn raise(&self) {
        if self.is_attached() {
            unsafe {
                let _ = SetWindowPos(
                    handle(self.hwnd),
                    Some(HWND_TOP),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE
                        | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                        | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE,
                );
            }
        }
    }

    pub fn hide(&self) {
        if self.is_attached() {
            unsafe {
                let _ = ShowWindow(handle(self.hwnd), SW_HIDE);
            }
        }
    }
}

impl Drop for EmbeddedWindow {
    fn drop(&mut self) {
        if !self.is_attached() {
            return;
        }
        unsafe {
            // Detach before restoring the desktop frame, position, and show state.
            let _ = SetParent(
                handle(self.hwnd),
                (self.original_parent != 0).then(|| handle(self.original_parent)),
            );
            SetWindowLongPtrW(handle(self.hwnd), GWL_STYLE, self.style);
            SetWindowLongPtrW(handle(self.hwnd), GWL_EXSTYLE, self.ex_style);
            let _ = SetWindowPlacement(handle(self.hwnd), &self.placement);
            let _ = SetWindowPos(
                handle(self.hwnd),
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED
                    | SWP_NOACTIVATE
                    | SWP_NOZORDER
                    | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE
                    | windows::Win32::UI::WindowsAndMessaging::SWP_NOSIZE,
            );
            if self.frame_visible {
                let _ = ShowWindow(handle(self.original_parent), SW_SHOWNA);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosts_resizes_hides_and_restores_a_disposable_external_window() {
        check_external_window(false);
    }

    #[test]
    fn restores_content_to_its_original_frame_after_hosting() {
        check_external_window(true);
    }

    fn check_external_window(content: bool) {
        use std::{
            io::{BufRead, BufReader},
            os::windows::process::CommandExt,
            process::{Command, Stdio},
            sync::mpsc,
            time::Duration,
        };
        use windows::{
            core::w,
            Win32::{
                Foundation::RECT,
                UI::WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, GetWindowRect, IsWindowVisible,
                    WS_OVERLAPPEDWINDOW,
                },
            },
        };
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        struct Parent(HWND);
        impl Drop for Parent {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }
        // Only this disposable helper is terminated. No installed/user app is touched.
        let mut child = Child(Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", r#"
                Add-Type -AssemblyName System.Windows.Forms
                $form = New-Object System.Windows.Forms.Form
                $form.Text = 'VibeSpace native host unit test'
                $form.ShowInTaskbar = $false
                $form.Opacity = 0
                $panel = New-Object System.Windows.Forms.Panel
                $panel.SetBounds(12, 18, 240, 160)
                $form.Controls.Add($panel)
                $form.Add_Shown({ [Console]::WriteLine(('{0},{1}' -f $form.Handle.ToInt64(), $panel.Handle.ToInt64())); [Console]::Out.Flush() })
                [System.Windows.Forms.Application]::Run($form)
            "#]).creation_flags(0x0800_0000).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().unwrap());
        let output = child.0.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(output).read_line(&mut line);
            let _ = tx.send(line);
        });
        let handles: Vec<isize> = rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap()
            .trim()
            .split(',')
            .map(|value| value.parse().unwrap())
            .collect();
        let frame = handles[0];
        let hwnd = if content { handles[1] } else { frame };
        let parent = Parent(
            unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("Workbench test host"),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    800,
                    600,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .unwrap(),
        );
        let original_style = unsafe { GetWindowLongPtrW(handle(hwnd), GWL_STYLE) };
        let mut original_rect = RECT::default();
        unsafe { GetWindowRect(handle(hwnd), &mut original_rect) }.unwrap();
        {
            let host = if content {
                EmbeddedWindow::attach_content(handle(frame), handle(hwnd), parent.0 .0 as isize)
            } else {
                EmbeddedWindow::attach(hwnd, parent.0 .0 as isize)
            }.unwrap();
            if content {
                assert!(!unsafe { IsWindowVisible(handle(frame)) }.as_bool());
            }
            assert!(host.is_attached());
            host.resize(
                &NativeBounds {
                    x: 10.,
                    y: 20.,
                    width: 320.,
                    height: 240.,
                },
                1.5,
            )
            .unwrap();
            let mut rect = RECT::default();
            unsafe { GetWindowRect(handle(hwnd), &mut rect) }.unwrap();
            assert_eq!((rect.right - rect.left, rect.bottom - rect.top), (480, 360));
            host.hide();
            assert!(!unsafe { IsWindowVisible(handle(hwnd)) }.as_bool());
        }
        if content {
            assert_eq!(unsafe { GetParent(handle(hwnd)) }.unwrap(), handle(frame));
            assert!(unsafe { IsWindowVisible(handle(frame)) }.as_bool());
        } else {
            assert!(unsafe { GetParent(handle(hwnd)) }.is_err());
        }
        assert_eq!(
            unsafe { GetWindowLongPtrW(handle(hwnd), GWL_STYLE) },
            original_style
        );
        let mut restored_rect = RECT::default();
        unsafe { GetWindowRect(handle(hwnd), &mut restored_rect) }.unwrap();
        assert_eq!(restored_rect, original_rect);
        assert!(child.0.try_wait().unwrap().is_none());
    }

    #[test]
    fn child_style_preserves_app_flags_and_removes_only_the_desktop_frame() {
        use windows::Win32::UI::WindowsAndMessaging::{WS_CLIPCHILDREN, WS_VISIBLE};
        let original =
            (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_VISIBLE | WS_CLIPCHILDREN).0 as isize;
        let child = child_style(original);
        assert_ne!(child & WS_CHILD.0 as isize, 0);
        assert_eq!(
            child & (WS_POPUP | WS_CAPTION | WS_THICKFRAME).0 as isize,
            0
        );
        assert_eq!(
            child & (WS_VISIBLE | WS_CLIPCHILDREN).0 as isize,
            (WS_VISIBLE | WS_CLIPCHILDREN).0 as isize
        );
    }
}
