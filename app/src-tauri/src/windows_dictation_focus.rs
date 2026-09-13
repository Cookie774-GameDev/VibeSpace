//! Read only the focused control's editability, never its text.
use windows::Win32::{
    System::{
        Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        Ole::{
            SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetLBound, SafeArrayGetUBound,
            SafeArrayUnaccessData,
        },
        Variant::{VariantClear, VT_BOOL},
    },
    UI::Accessibility::{
        CUIAutomation8, IUIAutomation2, IUIAutomationTextPattern, IUIAutomationValuePattern,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_IsReadOnlyAttributeId,
        UIA_TextPatternId, UIA_ValuePatternId,
    },
};

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

/// Run on a worker, not the native event loop. Unsupported/read-only surfaces
/// fail closed; an ordinary focused window alone is never sufficient.
pub fn focused_editable() -> Option<Vec<i32>> {
    unsafe { probe() }.ok().flatten()
}

unsafe fn probe() -> windows::core::Result<Option<Vec<i32>>> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    let _apartment = ComApartment;
    let automation: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
    automation.SetConnectionTimeout(200)?;
    automation.SetTransactionTimeout(200)?;
    let element = automation.GetFocusedElement()?;
    if !element.CurrentHasKeyboardFocus()?.as_bool()
        || !element.CurrentIsEnabled()?.as_bool()
        || element.CurrentIsPassword()?.as_bool()
    {
        return Ok(None);
    }
    let control = element.CurrentControlType()?;
    if control != UIA_EditControlTypeId && control != UIA_DocumentControlTypeId {
        return Ok(None);
    }
    let editable = if let Ok(value) =
        element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
    {
        !value.CurrentIsReadOnly()?.as_bool()
    } else {
        // Rich/multiline editors may expose only TextPattern. Unlike a static
        // document, their text range explicitly reports IsReadOnly=false.
        let pattern = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)?;
        let mut value = pattern
            .DocumentRange()?
            .GetAttributeValue(UIA_IsReadOnlyAttributeId)?;
        let editable = value.Anonymous.Anonymous.vt == VT_BOOL
            && !value.Anonymous.Anonymous.Anonymous.boolVal.as_bool();
        let _ = VariantClear(&mut value);
        editable
    };
    if !editable {
        return Ok(None);
    }
    // Keep only an opaque control identity. Revalidate it after restoring the
    // target window, so changing fields within that window cannot misroute text.
    let array = element.GetRuntimeId()?;
    struct RuntimeId(*mut windows::Win32::System::Com::SAFEARRAY);
    impl Drop for RuntimeId {
        fn drop(&mut self) {
            let _ = unsafe { SafeArrayDestroy(self.0) };
        }
    }
    let _array = RuntimeId(array);
    let low = SafeArrayGetLBound(array, 1)?;
    let high = SafeArrayGetUBound(array, 1)?;
    let length = high.saturating_sub(low).saturating_add(1);
    if !(1..=128).contains(&length) {
        return Ok(None);
    }
    let mut pointer = std::ptr::null_mut();
    SafeArrayAccessData(array, &mut pointer)?;
    let id = std::slice::from_raw_parts(pointer as *const i32, length as usize).to_vec();
    SafeArrayUnaccessData(array)?;
    Ok(Some(id))
}
