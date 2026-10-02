//! A reversible lease on an external HWND; never owns or terminates its process.
use super::NativeBounds;
use windows::core::BOOL;
use windows::Win32::{
    Foundation::{GetLastError, SetLastError, HWND, LPARAM, WIN32_ERROR},
    UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetParent, GetWindowLongPtrW, GetWindowPlacement,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetParent, SetWindowLongPtrW,
        SetWindowPlacement, SetWindowPos, ShowWindow, GWL_EXSTYLE, GWL_STYLE, HWND_TOP,
        SHOW_WINDOW_CMD, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA,
        WINDOWPLACEMENT, WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW, WS_POPUP, WS_THICKFRAME,
        WS_VISIBLE,
    },
};

pub struct EmbeddedWindow {
    hwnd: isize,
    frame: isize,
    parent: isize,
    pid: u32,
    style: isize,
    ex_style: isize,
    placement: WINDOWPLACEMENT,
    frame_placement: WINDOWPLACEMENT,
    window_visible: bool,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttachmentCandidate {
    frame: isize,
    frame_pid: u32,
    content: isize,
    content_pid: u32,
}

impl AttachmentCandidate {
    pub fn frame_handle(self) -> isize {
        self.frame
    }
}

fn attachment_content(class: &str, frame: isize, packaged: Option<isize>) -> Option<isize> {
    match class {
        // A newly launched packaged app can expose this before its shell frame owns it.
        "Windows.UI.Core.CoreWindow" | "" => None,
        "ApplicationFrameWindow" => packaged,
        _ => Some(frame),
    }
}

pub fn candidate_for_attach(hwnd: isize) -> Option<AttachmentCandidate> {
    let frame = handle(hwnd);
    if !unsafe { IsWindow(Some(frame)) }.as_bool() || unsafe { GetParent(frame) }.is_ok() {
        return None;
    }
    let content = attachment_content(
        &class_name(frame),
        hwnd,
        packaged_content(frame).map(|window| window.0 as isize),
    )?;
    let mut frame_pid = 0;
    let mut content_pid = 0;
    unsafe {
        GetWindowThreadProcessId(frame, Some(&mut frame_pid));
        GetWindowThreadProcessId(handle(content), Some(&mut content_pid));
    }
    if frame_pid == 0 || content_pid == 0 || content_pid == std::process::id() {
        return None;
    }
    Some(AttachmentCandidate {
        frame: hwnd,
        frame_pid,
        content,
        content_pid,
    })
}

fn handle(value: isize) -> HWND {
    HWND(value as *mut std::ffi::c_void)
}

fn child_style(style: isize) -> isize {
    (style & !((WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_VISIBLE).0 as isize))
        | WS_CHILD.0 as isize
}

fn restore_show_state(window: HWND, placement: &WINDOWPLACEMENT, visible: bool) {
    let command = if visible {
        SHOW_WINDOW_CMD(placement.showCmd as i32)
    } else {
        SW_HIDE
    };
    unsafe {
        let _ = ShowWindow(window, command);
    }
}

fn placement_for_restore(placement: &WINDOWPLACEMENT, visible: bool) -> WINDOWPLACEMENT {
    let mut restored = *placement;
    if !visible {
        restored.showCmd = SW_HIDE.0 as u32;
    }
    restored
}

impl EmbeddedWindow {
    pub fn attach(hwnd: isize, parent: isize) -> Result<Self, String> {
        let candidate = candidate_for_attach(hwnd)
            .ok_or("This app has not exposed a compatible window for Workbench.")?;
        Self::attach_candidate(candidate, parent)
    }

    pub fn attach_candidate(candidate: AttachmentCandidate, parent: isize) -> Result<Self, String> {
        if candidate.frame == parent || candidate_for_attach(candidate.frame) != Some(candidate) {
            return Err("This app window changed while opening. Retry after it finishes opening.".into());
        }
        Self::attach_content(handle(candidate.frame), handle(candidate.content), parent)
    }

    fn attach_content(frame: HWND, window: HWND, parent: isize) -> Result<Self, String> {
        if !unsafe { IsWindow(Some(handle(parent))) }.as_bool() {
            return Err("Workbench host window is unavailable.".into());
        }
        let hwnd = window.0 as isize;
        let original_parent = unsafe { GetParent(window) }.map_or(0, |parent| parent.0 as isize);
        if frame != window && original_parent != frame.0 as isize {
            return Err("This app changed its content window while opening. Retry after it finishes opening.".into());
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
        let mut frame_placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if frame == window {
            frame_placement = placement;
        } else {
            unsafe { GetWindowPlacement(frame, &mut frame_placement) }
                .map_err(|e| e.to_string())?;
        }
        let style = unsafe { GetWindowLongPtrW(window, GWL_STYLE) };
        // IsWindowVisible includes ancestor visibility. A shown content child of
        // a hidden frame must retain its own WS_VISIBLE bit when it is returned.
        let window_visible = style & WS_VISIBLE.0 as isize != 0;
        let frame_style = if frame == window {
            style
        } else {
            unsafe { GetWindowLongPtrW(frame, GWL_STYLE) }
        };
        let frame_visible = frame_style & WS_VISIBLE.0 as isize != 0;
        let lease = Self {
            hwnd,
            frame: frame.0 as isize,
            parent,
            pid,
            placement,
            frame_placement,
            window_visible,
            style,
            ex_style: unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) },
            original_parent,
            frame_visible,
        };
        #[cfg(debug_assertions)]
        let frame_class = class_name(frame);
        #[cfg(debug_assertions)]
        let content_class = class_name(window);
        let parent_error;
        #[cfg(debug_assertions)]
        let style_error;
        #[cfg(debug_assertions)]
        let ex_style_error;
        unsafe {
            // Hide the actual top-level frame before touching a packaged child. This
            // prevents ApplicationFrameHost from remaining visible on the desktop
            // while its content HWND is moved into the Workbench window.
            if frame != window {
                let _ = ShowWindow(frame, SW_HIDE);
            }
            let _ = ShowWindow(window, SW_HIDE);
            #[cfg(debug_assertions)]
            SetLastError(WIN32_ERROR(0));
            SetWindowLongPtrW(window, GWL_STYLE, child_style(lease.style));
            #[cfg(debug_assertions)]
            {
                style_error = GetLastError();
            }
            #[cfg(debug_assertions)]
            SetLastError(WIN32_ERROR(0));
            SetWindowLongPtrW(
                window,
                GWL_EXSTYLE,
                lease.ex_style & !(WS_EX_APPWINDOW.0 as isize),
            );
            #[cfg(debug_assertions)]
            {
                ex_style_error = GetLastError();
            }
            // A successful SetParent can return NULL for a previous desktop parent.
            // Verify the resulting relationship instead of treating NULL as failure.
            SetLastError(WIN32_ERROR(0));
            let _ = SetParent(window, Some(handle(parent)));
            parent_error = GetLastError();
        }
        if !lease.is_attached() {
            #[cfg(debug_assertions)]
            let parent_after = unsafe { GetParent(window) }.map_or(0, |current| current.0 as isize);
            #[cfg(debug_assertions)]
            let style_after = unsafe { GetWindowLongPtrW(window, GWL_STYLE) };
            #[cfg(debug_assertions)]
            let ex_style_after = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) };
            #[cfg(debug_assertions)]
            let mut host_pid = 0;
            #[cfg(debug_assertions)]
            let host_thread =
                unsafe { GetWindowThreadProcessId(handle(parent), Some(&mut host_pid)) };
            #[cfg(debug_assertions)]
            let content_thread = unsafe { GetWindowThreadProcessId(window, None) };
            unsafe {
                let _ = SetParent(
                    window,
                    (lease.original_parent != 0).then(|| handle(lease.original_parent)),
                );
                SetWindowLongPtrW(window, GWL_STYLE, lease.style & !(WS_VISIBLE.0 as isize));
                SetWindowLongPtrW(window, GWL_EXSTYLE, lease.ex_style);
                let _ = SetWindowPlacement(
                    window,
                    &placement_for_restore(&lease.placement, lease.window_visible),
                );
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
                restore_show_state(window, &lease.placement, lease.window_visible);
                if frame != window {
                    let _ = SetWindowPlacement(
                        frame,
                        &placement_for_restore(&lease.frame_placement, lease.frame_visible),
                    );
                    restore_show_state(frame, &lease.frame_placement, lease.frame_visible);
                }
            }
            #[cfg(debug_assertions)]
            {
                return Err(format!(
                    "Windows could not embed this app (SetParent error {}; debug frame_class={}, content_class={}, frame={:#x}, content={:#x}, target={:#x}, original_parent={:#x}, parent_after={:#x}, content_pid={}, host_pid={}, content_thread={}, host_thread={}, style_before={:#x}, style_after={:#x}, style_error={}, ex_style_before={:#x}, ex_style_after={:#x}, ex_style_error={}).",
                    parent_error.0,
                    frame_class,
                    content_class,
                    frame.0 as isize,
                    hwnd,
                    parent,
                    original_parent,
                    parent_after,
                    pid,
                    host_pid,
                    content_thread,
                    host_thread,
                    lease.style,
                    style_after,
                    style_error.0,
                    lease.ex_style,
                    ex_style_after,
                    ex_style_error.0,
                ));
            }
            #[cfg(not(debug_assertions))]
            return Err(format!(
                "Windows could not embed this app (SetParent error {}).",
                parent_error.0
            ));
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
            // Keep it hidden until the original placement and parent are restored.
            SetWindowLongPtrW(
                handle(self.hwnd),
                GWL_STYLE,
                self.style & !(WS_VISIBLE.0 as isize),
            );
            SetWindowLongPtrW(handle(self.hwnd), GWL_EXSTYLE, self.ex_style);
            let _ = SetWindowPlacement(
                handle(self.hwnd),
                &placement_for_restore(&self.placement, self.window_visible),
            );
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
            restore_show_state(handle(self.hwnd), &self.placement, self.window_visible);
            if self.frame != self.hwnd {
                let frame = handle(self.frame);
                let _ = SetWindowPlacement(
                    frame,
                    &placement_for_restore(&self.frame_placement, self.frame_visible),
                );
                restore_show_state(frame, &self.frame_placement, self.frame_visible);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_content_requires_its_ready_shell_frame() {
        // The R7 Calculator transient HWND must never be treated as a desktop frame.
        assert_eq!(
            attachment_content("Windows.UI.Core.CoreWindow", 31981676, None),
            None
        );
        assert_eq!(
            attachment_content("ApplicationFrameWindow", 2099686, None),
            None
        );
        assert_eq!(
            attachment_content("ApplicationFrameWindow", 2099686, Some(31981676)),
            Some(31981676)
        );
        assert_eq!(attachment_content("Notepad", 68106, None), Some(68106));
        assert_eq!(attachment_content("", 68106, None), None);
    }
    #[test]
    fn hosts_resizes_hides_and_restores_a_disposable_external_window() {
        check_external_window(false);
    }

    #[test]
    fn restores_content_to_its_original_frame_after_hosting() {
        check_external_window(true);
    }

    #[test]
    fn restores_a_hidden_content_frame_after_hosting() {
        check_external_window_with_visibility(true, false);
    }

    #[test]
    fn restores_the_original_hidden_state_of_a_hosted_window() {
        check_external_window_visibility(false);
    }

    fn check_external_window(content: bool) {
        check_external_window_with_visibility(content, true);
    }

    fn check_external_window_visibility(initially_visible: bool) {
        check_external_window_with_visibility(false, initially_visible);
    }

    fn check_external_window_with_visibility(content: bool, initially_visible: bool) {
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
        let script = r#"
                Add-Type -AssemblyName System.Windows.Forms
                $form = New-Object System.Windows.Forms.Form
                $form.Text = 'VibeSpace native host unit test'
                $form.ShowInTaskbar = $false
                $form.Opacity = 0
                $panel = New-Object System.Windows.Forms.Panel
                $panel.SetBounds(12, 18, 240, 160)
                $form.Controls.Add($panel)
                $hideBeforeAttach = [bool]::Parse($env:VIBESPACE_EMBED_TEST_HIDE_BEFORE_ATTACH)
                $form.Add_Shown({ if ($hideBeforeAttach) { $form.Hide() }; [Console]::WriteLine(('{0},{1}' -f $form.Handle.ToInt64(), $panel.Handle.ToInt64())); [Console]::Out.Flush() })
                [System.Windows.Forms.Application]::Run($form)
            "#;
        let hide_before_attach = (!initially_visible).to_string();
        let mut child = Child(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
                .env(
                    "VIBESPACE_EMBED_TEST_HIDE_BEFORE_ATTACH",
                    &hide_before_attach,
                )
                .creation_flags(0x0800_0000)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
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
        let original_frame_style = unsafe { GetWindowLongPtrW(handle(frame), GWL_STYLE) };
        assert_eq!(
            unsafe { IsWindowVisible(handle(hwnd)) }.as_bool(),
            initially_visible
        );
        if content && !initially_visible {
            // The child is locally shown, but its hidden parent makes its
            // effective visibility false. Restoration must preserve both facts.
            assert_ne!(original_style & WS_VISIBLE.0 as isize, 0);
            assert_eq!(original_frame_style & WS_VISIBLE.0 as isize, 0);
        }
        let mut original_rect = RECT::default();
        unsafe { GetWindowRect(handle(hwnd), &mut original_rect) }.unwrap();
        {
            let host = if content {
                EmbeddedWindow::attach_content(handle(frame), handle(hwnd), parent.0 .0 as isize)
            } else {
                EmbeddedWindow::attach(hwnd, parent.0 .0 as isize)
            }
            .unwrap();
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
            assert_eq!(
                unsafe { IsWindowVisible(handle(frame)) }.as_bool(),
                initially_visible
            );
        } else {
            assert!(unsafe { GetParent(handle(hwnd)) }.is_err());
            assert_eq!(
                unsafe { IsWindowVisible(handle(hwnd)) }.as_bool(),
                initially_visible
            );
        }
        assert_eq!(
            unsafe { GetWindowLongPtrW(handle(hwnd), GWL_STYLE) },
            original_style
        );
        assert_eq!(
            unsafe { GetWindowLongPtrW(handle(frame), GWL_STYLE) },
            original_frame_style
        );
        assert_eq!(
            unsafe { IsWindowVisible(handle(hwnd)) }.as_bool(),
            initially_visible
        );
        let mut restored_rect = RECT::default();
        unsafe { GetWindowRect(handle(hwnd), &mut restored_rect) }.unwrap();
        assert_eq!(restored_rect, original_rect);
        assert!(child.0.try_wait().unwrap().is_none());
    }

    #[test]
    fn child_style_hides_until_resize_and_keeps_child_clipping() {
        use windows::Win32::UI::WindowsAndMessaging::{WS_CLIPCHILDREN, WS_VISIBLE};
        let original =
            (WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_VISIBLE | WS_CLIPCHILDREN).0 as isize;
        let child = child_style(original);
        assert_ne!(child & WS_CHILD.0 as isize, 0);
        assert_eq!(
            child & (WS_POPUP | WS_CAPTION | WS_THICKFRAME).0 as isize,
            0
        );
        assert_eq!(child & WS_VISIBLE.0 as isize, 0);
        assert_eq!(
            child & WS_CLIPCHILDREN.0 as isize,
            WS_CLIPCHILDREN.0 as isize
        );
    }

    #[test]
    fn hidden_window_restore_does_not_reopen_it_on_the_desktop() {
        let placement = WINDOWPLACEMENT {
            showCmd: 1,
            ..Default::default()
        };
        assert_eq!(
            placement_for_restore(&placement, false).showCmd,
            SW_HIDE.0 as u32
        );
        assert_eq!(
            placement_for_restore(&placement, true).showCmd,
            placement.showCmd
        );
    }
}
