import * as React from 'react';
import { natureAvatarForIdentity } from './natureAvatarAssignment';
import { natureAvatarFraming } from './natureAvatarFraming';
import './NatureAvatar.css';

type Action = 'idle' | 'hello' | 'message' | 'inactive';
type Step = { frame: number; ms: number };
type Profile = {
  id: string;
  name: string;
  atlas: string;
  frames: number;
  sequences: Record<Action, Step[]>;
};
type Manifest = { version: number; cellSize: number; columns: number; profiles: Profile[] };

let manifestRequest: Promise<Manifest> | undefined;
function loadManifest(): Promise<Manifest> {
  if (!manifestRequest)
    manifestRequest = fetch('/relay-avatars/nature/manifest.json')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Nature avatar manifest HTTP ${response.status}`);
        const result = (await response.json()) as Manifest;
        if (result.version !== 1 || result.columns !== 6 || result.profiles.length !== 27) {
          throw new Error('Invalid nature avatar manifest');
        }
        return result;
      })
      .catch((error) => {
        manifestRequest = undefined;
        throw error;
      });
  return manifestRequest;
}

export interface NatureAvatarProps {
  identity: string;
  name?: string;
  size?: number;
  /** Change this key only for a newly delivered message. Historical mounts stay neutral. */
  reactionKey?: string | number | null;
  /** Play one message reaction for a freshly delivered message on first mount. */
  reactOnMount?: boolean;
  inactive?: boolean;
  active?: boolean;
  className?: string;
  decorative?: boolean;
}

export function NatureAvatar({
  identity,
  name,
  size = 32,
  reactionKey,
  reactOnMount = false,
  inactive = false,
  active = true,
  className,
  decorative = false,
}: NatureAvatarProps) {
  const assignment = React.useMemo(() => natureAvatarForIdentity(identity), [identity]);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const [frame, setFrame] = React.useState(0);
  const [visible, setVisible] = React.useState(true);
  const [motionAllowed, setMotionAllowed] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const element = React.useRef<HTMLSpanElement>(null);
  const previousReaction = React.useRef(reactionKey);
  const pendingMessages = React.useRef(reactOnMount ? 1 : 0);
  const requestMessage = React.useRef<(() => void) | null>(null);
  const requestHello = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    let mounted = true;
    setProfile(null);
    setFrame(0);
    loadManifest()
      .then((manifest) => {
        if (mounted) {
          setProfile(manifest.profiles.find((item) => item.id === assignment.profileId) ?? null);
          setLoadError(false);
        }
      })
      .catch(() => {
        if (mounted) setLoadError(true);
      });
    return () => {
      mounted = false;
    };
  }, [assignment.profileId]);

  React.useEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.01,
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(!document.hidden && !media?.matches);
    update();
    document.addEventListener('visibilitychange', update);
    media?.addEventListener?.('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      media?.removeEventListener?.('change', update);
    };
  }, []);

  React.useEffect(() => {
    if (
      !inactive &&
      previousReaction.current !== reactionKey &&
      reactionKey !== null &&
      reactionKey !== undefined
    ) {
      pendingMessages.current++;
      requestMessage.current?.();
    }
    previousReaction.current = reactionKey;
  }, [reactionKey]);

  React.useEffect(() => {
    if (!profile) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Action | 'rest' = 'rest';
    let stopped = false;
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const stepsFor = (action: Action) => profile.sequences[action] ?? [];
    const rest = () => {
      current = 'rest';
      setFrame(0);
      clear();
      timer = setTimeout(() => start('idle'), 4200 + (assignment.ordinal % 7) * 280);
    };
    const start = (action: Action) => {
      if (stopped) return;
      clear();
      current = action;
      const steps = stepsFor(action);
      if (!steps.length) {
        rest();
        return;
      }
      let index = 0;
      const advance = () => {
        if (stopped) return;
        const step = steps[index];
        setFrame(step.frame);
        timer = setTimeout(() => {
          index++;
          if (index < steps.length) {
            advance();
            return;
          }
          if (action === 'inactive') return;
          if (pendingMessages.current > 0) {
            pendingMessages.current--;
            start('message');
          } else rest();
        }, step.ms);
      };
      advance();
    };
    requestMessage.current = () => {
      if (!active || !visible || !motionAllowed) return;
      if (current !== 'message' && !inactive && pendingMessages.current > 0) {
        pendingMessages.current--;
        start('message');
      }
    };
    requestHello.current = () => {
      if (
        active &&
        visible &&
        motionAllowed &&
        !inactive &&
        (current === 'rest' || current === 'idle')
      )
        start('hello');
    };
    if (!active || !visible || !motionAllowed) {
      pendingMessages.current = 0;
      setFrame(inactive ? (stepsFor('inactive').at(-1)?.frame ?? 0) : 0);
    } else if (inactive) start('inactive');
    else if (pendingMessages.current > 0) requestMessage.current();
    else rest();
    return () => {
      stopped = true;
      clear();
      requestMessage.current = null;
      requestHello.current = null;
    };
  }, [profile, active, visible, motionAllowed, inactive, assignment.ordinal]);

  const column = frame % 6;
  const row = Math.floor(frame / 6);
  const framing = natureAvatarFraming(assignment.profileId);
  const frameSize = size * framing.zoom;
  const label = `${name ?? identity} — ${profile?.name ?? 'nature'} avatar${assignment.monochrome ? ', black and white' : ''}`;
  return (
    <span
      ref={element}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      className={`nature-avatar${className ? ` ${className}` : ''}`}
      data-nature-avatar={identity}
      data-profile={assignment.profileId}
      data-monochrome={assignment.monochrome ? 'true' : 'false'}
      data-frame={frame}
      data-avatar-ready={profile ? 'true' : 'false'}
      data-load-error={loadError ? 'true' : undefined}
      onPointerEnter={() => requestHello.current?.()}
      onFocus={() => requestHello.current?.()}
      style={{ width: size, height: size }}
    >
      <span
        className="nature-avatar__sheet"
        aria-hidden="true"
        style={{
          backgroundImage: `url(/relay-avatars/nature/${assignment.profileId}.webp)`,
          backgroundSize: `${frameSize * 6}px auto`,
          backgroundPosition: `${size / 2 - (column + framing.focusX) * frameSize}px ${size / 2 - (row + framing.focusY) * frameSize}px`,
        }}
      />
    </span>
  );
}
