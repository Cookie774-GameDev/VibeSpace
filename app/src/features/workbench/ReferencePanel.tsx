import * as React from 'react';
import { NotebookPen } from 'lucide-react';
import { resolveAccountJarvisArtifactPreview } from '@/features/jarvis-command-center/artifactAccess';
import { DevicePreviewPanel } from './DevicePreviewPanel';
import { EditorPanel } from './EditorPanel';
import { EmbeddedSurface, isEmbeddedSurfaceKind } from './EmbeddedSurface';
import { FilesPanel } from './FilesPanel';
import { JarvisPanel } from './JarvisPanel';
import { NativeAppPanel } from './NativeAppPanel';
import { NotesPanel } from './NotesPanel';

const NotesPage = React.lazy(() =>
  import('@/features/notes/NotesPage').then((module) => ({ default: module.NotesPage })),
);
import type {
  WorkbenchArtifactReferenceResolver,
  WorkbenchArtifactReferenceSnapshot,
  WorkbenchPanel,
} from './types';

interface ArtifactReferenceResolverContextValue {
  accountId: string;
  resolve: WorkbenchArtifactReferenceResolver;
}

type ArtifactPreviewRepository = Parameters<typeof resolveAccountJarvisArtifactPreview>[0];
type ArtifactReferenceResolverProviderProps = React.PropsWithChildren<
  { accountId: string } & (
    | { repository: ArtifactPreviewRepository; resolve?: never }
    | { resolve: WorkbenchArtifactReferenceResolver; repository?: never }
  )
>;

const ArtifactReferenceResolverContext =
  React.createContext<ArtifactReferenceResolverContextValue | null>(null);

export function ArtifactReferenceResolverProvider(props: ArtifactReferenceResolverProviderProps) {
  const { accountId, children } = props;
  const repository = props.repository;
  const injectedResolver = props.resolve;
  const resolve = React.useMemo<WorkbenchArtifactReferenceResolver>(() => {
    if (repository) {
      return async (input) =>
        (await resolveAccountJarvisArtifactPreview(repository, input)) ?? null;
    }
    return injectedResolver ?? (async () => null);
  }, [injectedResolver, repository]);
  const value = React.useMemo(() => ({ accountId, resolve }), [accountId, resolve]);
  return (
    <ArtifactReferenceResolverContext.Provider value={value}>
      {children}
    </ArtifactReferenceResolverContext.Provider>
  );
}

type ArtifactPreviewState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'ready'; artifact: WorkbenchArtifactReferenceSnapshot }>;

const ARTIFACT_ID_LIMIT = 512;
const ARTIFACT_TITLE_LIMIT = 512;
const ARTIFACT_SUMMARY_LIMIT = 2_048;
const ARTIFACT_PREVIEW_LIMIT = 48_000;
const ARTIFACT_DIGEST = /^[a-f0-9]{64}$/u;

function stableText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function safePreviewText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ARTIFACT_PREVIEW_LIMIT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function verifiedArtifactSnapshot(input: {
  accountId: string;
  artifactId: string;
  artifactDigest: string;
  value: Readonly<WorkbenchArtifactReferenceSnapshot> | null;
}): WorkbenchArtifactReferenceSnapshot | null {
  const value = input.value;
  if (
    !value ||
    value.accountId !== input.accountId ||
    value.artifactId !== input.artifactId ||
    value.artifactDigest !== input.artifactDigest ||
    !stableText(value.title, ARTIFACT_TITLE_LIMIT) ||
    (value.safeSummary !== undefined && !stableText(value.safeSummary, ARTIFACT_SUMMARY_LIMIT)) ||
    (value.preview.kind !== 'text' && value.preview.kind !== 'none') ||
    (value.preview.kind === 'text' &&
      (!safePreviewText(value.preview.text) || typeof value.preview.truncated !== 'boolean')) ||
    (value.preview.kind === 'none' && value.preview.truncated !== false)
  ) {
    return null;
  }
  return {
    accountId: value.accountId,
    artifactId: value.artifactId,
    artifactDigest: value.artifactDigest,
    title: value.title,
    ...(value.safeSummary === undefined ? {} : { safeSummary: value.safeSummary }),
    preview:
      value.preview.kind === 'text'
        ? { kind: 'text', text: value.preview.text, truncated: value.preview.truncated }
        : { kind: 'none', truncated: false },
  };
}

function ArtifactReferencePanel({
  panel,
  onUpdate,
}: {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}) {
  const authority = React.useContext(ArtifactReferenceResolverContext);
  const artifactId = panel.settings.artifactId;
  const artifactDigest = panel.settings.artifactDigest;
  const [state, setState] = React.useState<ArtifactPreviewState>({ kind: 'loading' });
  const onUpdateRef = React.useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  React.useEffect(() => {
    let current = true;
    let requestGeneration = 0;
    if (
      !authority ||
      !stableText(authority.accountId, ARTIFACT_ID_LIMIT) ||
      !stableText(artifactId, ARTIFACT_ID_LIMIT) ||
      typeof artifactDigest !== 'string' ||
      !ARTIFACT_DIGEST.test(artifactDigest)
    ) {
      setState({ kind: 'unavailable' });
      onUpdateRef.current({ status: 'error' });
      return () => {
        current = false;
      };
    }

    const resolveCurrent = (loading: boolean) => {
      const generation = ++requestGeneration;
      if (loading) {
        setState({ kind: 'loading' });
        onUpdateRef.current({ status: 'busy' });
      }
      void authority
        .resolve({ accountId: authority.accountId, artifactId })
        .then((value) => {
          if (!current || generation !== requestGeneration) return;
          const artifact = verifiedArtifactSnapshot({
            accountId: authority.accountId,
            artifactId,
            artifactDigest,
            value,
          });
          setState(artifact ? { kind: 'ready', artifact } : { kind: 'unavailable' });
          onUpdateRef.current({ status: artifact ? 'ready' : 'error' });
        })
        .catch(() => {
          if (current && generation === requestGeneration) {
            setState({ kind: 'unavailable' });
            onUpdateRef.current({ status: 'error' });
          }
        });
    };
    const revalidate = () => resolveCurrent(false);
    const revalidateVisible = () => {
      if (document.visibilityState === 'visible') revalidate();
    };

    resolveCurrent(true);
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidateVisible);

    return () => {
      current = false;
      requestGeneration += 1;
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidateVisible);
    };
  }, [artifactDigest, artifactId, authority]);

  if (state.kind === 'loading') {
    return (
      <div className="workbench-reference-panel" data-workbench-reference="artifact-reference">
        <p role="status">Loading artifact preview…</p>
      </div>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <div className="workbench-reference-panel" data-workbench-reference="artifact-reference">
        <div>
          <p className="workbench-reference-kicker">Artifact reference</p>
          <p role="alert">Artifact preview unavailable.</p>
        </div>
      </div>
    );
  }

  const { artifact } = state;
  return (
    <article
      className="workbench-reference-panel"
      data-workbench-reference="artifact-reference"
      data-artifact-id={artifact.artifactId}
    >
      <div>
        <p className="workbench-reference-kicker">Verified artifact</p>
        <h3>{artifact.title}</h3>
        {artifact.safeSummary ? <p>{artifact.safeSummary}</p> : null}
        {artifact.preview.kind === 'text' ? (
          <pre aria-label="Artifact preview">{artifact.preview.text}</pre>
        ) : (
          <p>No text preview is available.</p>
        )}
      </div>
    </article>
  );
}

interface ReferencePanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

export function ReferencePanel({ panel, onUpdate }: ReferencePanelProps) {
  if (panel.kind === 'native-app' || panel.kind === 'ade') {
    return <NativeAppPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'artifact-reference') {
    return <ArtifactReferencePanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'notes') {
    // Existing scratchpads retain their content and Desktop save workflow.
    if (typeof panel.settings.note === 'string' || panel.settings.filePath) {
      return <NotesPanel panel={panel} onUpdate={onUpdate} />;
    }
    return (
      <div
        className="workbench-embedded-surface"
        data-workbench-surface="notes"
        onWheel={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <React.Suspense fallback={<div className="workbench-panel-empty">Loading Notes…</div>}>
          <NotesPage />
        </React.Suspense>
      </div>
    );
  }

  if (panel.kind === 'editor') {
    return <EditorPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'device-preview') {
    return <DevicePreviewPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'files') {
    return <FilesPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (panel.kind === 'jarvis') {
    return <JarvisPanel panel={panel} onUpdate={onUpdate} />;
  }

  if (isEmbeddedSurfaceKind(panel.kind)) {
    return <EmbeddedSurface panel={panel} />;
  }

  return (
    <div className="workbench-reference-panel" data-workbench-reference={panel.kind}>
      <div className="workbench-reference-orbit" aria-hidden="true">
        <NotebookPen className="h-7 w-7" />
      </div>
      <div>
        <p className="workbench-reference-kicker">Workbench panel</p>
        <h3>{panel.title}</h3>
        <p>This panel type is not mapped to a live surface yet.</p>
      </div>
    </div>
  );
}
