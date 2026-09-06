import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { CHATGPT_NATIVE_APP } from './nativeApps';
import { openNativeAppPanel } from './nativeAppPanels';

export function ChatGptAdeRedirect() {
  const route = useUIStore((state) => state.route);
  React.useEffect(() => {
    if (route !== 'ade') return;
    openNativeAppPanel(CHATGPT_NATIVE_APP);
    useUIStore.getState().setRoute('workbench');
  }, [route]);
  return null;
}

export default ChatGptAdeRedirect;
