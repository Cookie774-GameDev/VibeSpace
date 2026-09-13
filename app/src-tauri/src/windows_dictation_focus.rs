//! Retain a marshalled reference to the original editable control, never its text.
use windows::core::AgileReference;
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
        Variant::{VariantClear, VARIANT, VT_BOOL},
    },
    UI::Accessibility::{
        CUIAutomation8, IUIAutomation2, IUIAutomationElement, IUIAutomationSelectionItemPattern,
        IUIAutomationTextPattern, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId,
        UIA_EditControlTypeId, UIA_IsReadOnlyAttributeId, UIA_SelectionItemIsSelectedPropertyId,
        UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_TextPatternId,
        UIA_ValuePatternId,
    },
};

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Clone)]
pub struct SavedField {
    id: Vec<i32>,
    element: AgileReference<IUIAutomationElement>,
    tab: Option<AgileReference<IUIAutomationElement>>,
}

impl SavedField {
    pub fn restore(&self) -> Result<(), String> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|_| "Windows text access is unavailable.")?;
            let _apartment = ComApartment;
            if let Some(tab) = &self.tab {
                let selected = tab
                    .resolve()
                    .and_then(|tab| {
                        tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                            UIA_SelectionItemPatternId,
                        )
                    })
                    .map_err(|_| {
                        "The original browser tab is unavailable. Your transcript is kept."
                    })?;
                if !selected
                    .CurrentIsSelected()
                    .map_err(|_| "The original tab is unavailable.")?
                    .as_bool()
                {
                    selected.Select().map_err(|_| {
                        "Return to the original browser tab and retry. Your transcript is kept."
                    })?;
                }
            }
            let element = self.element.resolve().map_err(|_| {
                "The original text box is no longer available. Your transcript is kept."
            })?;
            if !is_editable(&element).unwrap_or(false) {
                return Err(
                    "The original text box is no longer editable. Your transcript is kept.".into(),
                );
            }
            element
                .SetFocus()
                .map_err(|_| "Return to the original page and retry. Your transcript is kept.")?;
            if focused_id()? != self.id {
                return Err(
                    "The original text box could not regain focus. Your transcript is kept.".into(),
                );
            }
            Ok(())
        }
    }
}

pub fn capture_editable() -> Option<SavedField> {
    match unsafe { probe() } {
        Ok(field) => field,
        Err(error) => {
            eprintln!(
                "[dictation] Windows focused-control probe failed: {:?}",
                error.code()
            );
            None
        }
    }
}

/// Run on a worker, not the native event loop. Unsupported/read-only surfaces
/// fail closed; an ordinary focused window alone is never sufficient.
pub fn focused_editable() -> Option<Vec<i32>> {
    capture_editable().map(|field| field.id)
}

unsafe fn probe() -> windows::core::Result<Option<SavedField>> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    let _apartment = ComApartment;
    let automation: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
    automation.SetConnectionTimeout(200)?;
    automation.SetTransactionTimeout(200)?;
    let element = automation.GetFocusedElement()?;
    if !element.CurrentHasKeyboardFocus()?.as_bool() || !is_editable(&element)? {
        return Ok(None);
    }
    let field = SavedField {
        id: runtime_id(&element)?,
        element: AgileReference::new(&element)?,
        tab: selected_browser_tab(&automation, &element),
    };
    if !element.CurrentHasKeyboardFocus()?.as_bool()
        || runtime_id(&automation.GetFocusedElement()?)? != field.id
    {
        return Ok(None);
    }
    Ok(Some(field))
}

/// A browser's tab strip lives outside its document. Remember only its selected
/// tab, not website widgets or text, so a take can return after tab switches.
unsafe fn selected_browser_tab(
    automation: &IUIAutomation2,
    field: &IUIAutomationElement,
) -> Option<AgileReference<IUIAutomationElement>> {
    let walker = automation.ControlViewWalker().ok()?;
    let mut ancestor = field.clone();
    let mut in_document = false;
    for _ in 0..32 {
        if ancestor.CurrentControlType().ok()? == UIA_DocumentControlTypeId {
            in_document = true;
            break;
        }
        ancestor = walker.GetParentElement(&ancestor).ok()?;
    }
    if !in_document {
        return None;
    }
    let root = automation
        .ElementFromHandle(windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow())
        .ok()?;
    let tab_type = automation
        .CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_TabItemControlTypeId.0),
        )
        .ok()?;
    let selected = automation
        .CreatePropertyCondition(UIA_SelectionItemIsSelectedPropertyId, &VARIANT::from(true))
        .ok()?;
    let condition = automation.CreateAndCondition(&tab_type, &selected).ok()?;
    let tabs = root.FindAll(TreeScope_Descendants, &condition).ok()?;
    for index in 0..tabs.Length().ok()?.min(512) {
        let tab = tabs.GetElement(index).ok()?;
        let Ok(selection) = tab
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
        else {
            continue;
        };
        if !selection.CurrentIsSelected().unwrap_or_default().as_bool() {
            continue;
        }
        let mut parent = tab.clone();
        let mut native_tab = true;
        for _ in 0..32 {
            if parent.CurrentControlType().ok()? == UIA_DocumentControlTypeId {
                native_tab = false;
                break;
            }
            match walker.GetParentElement(&parent) {
                Ok(next) => parent = next,
                Err(_) => break,
            }
        }
        if native_tab {
            return AgileReference::new(&tab).ok();
        }
    }
    None
}

unsafe fn focused_id() -> Result<Vec<i32>, String> {
    let automation: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
        .map_err(|_| "Windows text access is unavailable.")?;
    automation
        .SetConnectionTimeout(200)
        .map_err(|_| "Windows text access is unavailable.")?;
    automation
        .SetTransactionTimeout(200)
        .map_err(|_| "Windows text access is unavailable.")?;
    let element = automation
        .GetFocusedElement()
        .map_err(|_| "No text box is focused.")?;
    runtime_id(&element).map_err(|_| "The text box identity is unavailable.".into())
}

unsafe fn is_editable(element: &IUIAutomationElement) -> windows::core::Result<bool> {
    if !element.CurrentIsEnabled()?.as_bool() || element.CurrentIsPassword()?.as_bool() {
        return Ok(false);
    }
    let control = element.CurrentControlType()?;
    // Explorer/search suggestion boxes can expose an editable ComboBox rather
    // than Edit. The read-only pattern below still rejects selection-only lists.
    if control != UIA_EditControlTypeId
        && control != UIA_DocumentControlTypeId
        && control != UIA_ComboBoxControlTypeId
    {
        return Ok(false);
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
    Ok(editable)
}

unsafe fn runtime_id(element: &IUIAutomationElement) -> windows::core::Result<Vec<i32>> {
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
        return Err(windows::core::Error::from_hresult(
            windows::Win32::Foundation::E_INVALIDARG,
        ));
    }
    let mut pointer = std::ptr::null_mut();
    SafeArrayAccessData(array, &mut pointer)?;
    let id = std::slice::from_raw_parts(pointer as *const i32, length as usize).to_vec();
    SafeArrayUnaccessData(array)?;
    Ok(id)
}
