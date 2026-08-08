import { Code2, ListTodo, Search, Sparkles } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useChatMessages } from './hooks';

const QUICK_PROMPTS = [
  {
    title: 'Ask Jarvis anything',
    description: 'General knowledge, help, ideas',
    icon: Sparkles,
    skillId: 'analyze',
  },
  {
    title: 'Plan a project',
    description: 'Break tasks into steps',
    icon: ListTodo,
    skillId: 'analyze',
  },
  {
    title: 'Review my code',
    description: 'Find issues and improve',
    icon: Code2,
    skillId: 'build',
  },
  {
    title: 'Research a topic',
    description: 'Deep dive and summarize',
    icon: Search,
    skillId: 'research',
  },
] as const;

const WELCOME_ART = {
  default: {
    alt: 'Open notebook, coffee, and desk tools',
    src: '/assets/themes/default/chat-welcome.webp',
  },
  jarvis: {
    alt: 'Jarvis listening notebook, cup, and pen',
    src: '/assets/themes/jarvis/chat-welcome.webp',
  },
  monochrome: {
    alt: 'Monochrome paper organizer, cup, and pencil',
    src: '/assets/themes/monochrome/chat-welcome.webp',
  },
  warm: {
    alt: 'Notebook, coffee, and writing tools',
    src: '/assets/themes/warm/reference/chat-notebook.png',
  },
} as const;

export function WarmChatWelcome({
  chatId,
  /** Dense layout for pet mini-panel (same 4 starters + art, panel-scaled). */
  compact = false,
}: {
  chatId: string;
  compact?: boolean;
}) {
  const messages = useChatMessages(chatId);
  const theme = useUIStore((state) => state.theme);
  const welcomeArt = WELCOME_ART[theme as keyof typeof WELCOME_ART] ?? WELCOME_ART.default;
  const insertPrompt = (text: string, skillId: string) => {
    window.dispatchEvent(
      new CustomEvent('jarvis:composer:insert-text', {
        detail: { chatId, text, skillId },
      }),
    );
  };

  if (messages.length > 0) return null;

  return (
    <section
      className={compact ? 'warm-chat-welcome warm-chat-welcome--compact' : 'warm-chat-welcome'}
      aria-labelledby="warm-chat-welcome-title"
      data-pet-chat-welcome={compact ? 'true' : undefined}
      data-chat-welcome-theme={theme}
    >
      <div className="warm-chat-welcome__content">
        <img
          alt={welcomeArt.alt}
          className="warm-chat-welcome__art"
          draggable={false}
          height="512"
          src={welcomeArt.src}
          width="512"
        />
        <h1 id="warm-chat-welcome-title">Start a conversation</h1>
        <p>Ask anything, explore ideas, or delegate to an agent.</p>
        <div className="warm-chat-welcome__prompts" aria-label="Conversation starters">
          {QUICK_PROMPTS.map(({ title, description, icon: Icon, skillId }) => (
            <button
              key={title}
              type="button"
              data-warm-quick-prompt={title}
              onClick={() => insertPrompt(title, skillId)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
