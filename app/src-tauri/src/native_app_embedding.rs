//! A reversible lease on an external HWND; never owns or terminates its process.
use super::NativeBounds;
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        GetParent, GetWindowLongPtrW, GetWindowPlacement, GetWindowThreadProcessId, IsWindow,
        SetParent, SetWindowLongPtrW, SetWindowPlacement, SetWindowPos, ShowWindow, GWL_EXSTYLE,
        GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_RESTORE,
        SW_SHOWNA, WINDOWPLACEMENT, WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW, WS_POPUP, WS_THICKFRAME,
    },
};

pub struct EmbeddedWindow {
    hwnd: isize,
    parent: isize,
    pid: u32,
    style: isize,
    ex_style: isize,
    placement: WINDOWPLACEMENT,
}

fn handle(value: isize) -> HWND {
    HWND(value as *mut std::ffi::c_void)
}

fn child_style(style: isize) -> isize {
    (style & !((WS_POPUP | WS_CAPTION | WS_THICKFRAME).0 as isize)) | WS_CHILD.0 as isize
}

impl EmbeddedWindow {
    pub fn attach(hwnd: isize, parent: isize) -> Result<Self, String> {
        let window = handle(hwnd);
        if hwnd == parent
            || !unsafe { IsWindow(Some(window)) }.as_bool()
            || unsafe { GetParent(window) }.is_ok()
        {
            return Err("This app window cannot be hosted in Workbench.".into());
        }
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
        };
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
            let _ = SetParent(window, Some(handle(parent)));
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
            return Err(
                "Windows prevented this app from embedding (permissions or window compatibility)."
                    .into(),
            );
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
            let _ = SetParent(handle(self.hwnd), None);
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosts_resizes_hides_and_restores_a_disposable_external_window() {
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
                $form.Add_Shown({ [Console]::WriteLine($form.Handle.ToInt64()); [Console]::Out.Flush() })
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
        let hwnd: isize = rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
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
            let host = EmbeddedWindow::attach(hwnd, parent.0 .0 as isize).unwrap();
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
        assert!(unsafe { GetParent(handle(hwnd)) }.is_err());
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
