import { useUIStore } from '@/stores/ui';
import { useChatMessages } from './hooks';
import { resolveOrigamiWelcomeVariant } from './origamiWelcome';

export function OrigamiChatDecor() {
  const theme = useUIStore((state) => state.theme);
  if (theme !== 'vibespace' && theme !== 'origami') return null;

  return (
    <div aria-hidden="true" className="origami-chat-decor hidden" data-testid="origami-chat-decor">
      <img
        alt=""
        className="origami-chat-decor__ribbon"
        draggable={false}
        src="/assets/origami-chat/top-ribbon.svg"
      />
      <img
        alt=""
        className="origami-chat-decor__crane"
        draggable={false}
        src="/assets/origami-chat/crane.webp"
      />
      <img
        alt=""
        className="origami-chat-decor__foliage"
        draggable={false}
        src="/assets/origami-chat/left-foliage.webp"
      />
      <img
        alt=""
        className="origami-chat-decor__mountains"
        draggable={false}
        src="/assets/origami-chat/bottom-mountains.svg"
      />
      <img
        alt=""
        className="origami-chat-decor__flower"
        draggable={false}
        src="/assets/origami-chat/right-flower.webp"
      />
      {theme === 'origami' ? <OrigamiWelcomeArt /> : null}
    </div>
  );
}

function OrigamiWelcomeArt() {
  const activeChatId = useUIStore((state) => state.activeChatId);
  const messages = useChatMessages(activeChatId);
  if (!activeChatId || messages.length > 0) return null;

  const welcomeVariant = resolveOrigamiWelcomeVariant(activeChatId);
  return (
    <div
      className="origami-welcome-art"
      data-testid="origami-welcome-art"
      data-welcome-variant={welcomeVariant}
    >
      <img
        alt=""
        className={`origami-welcome-art__hero origami-welcome-art__hero--${welcomeVariant}`}
        draggable={false}
        src={`/assets/themes/origami/welcome-${welcomeVariant}.svg`}
      />
      <span className="origami-welcome-art__shadow" />
    </div>
  );
}
