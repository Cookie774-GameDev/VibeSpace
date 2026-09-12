import * as React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  FileDown,
  FileUp,
  Hand,
  Heading,
  LassoSelect,
  ListTree,
  Maximize2,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Settings2,
  Square,
  StickyNote,
  Type,
  Undo2,
  Upload,
  Wallpaper,
} from 'lucide-react';
import { canvasBlockAccessibleLabel, canvasZoomAnnouncement } from './accessibility';
import {
  CANVAS_MAX_TEXT_LENGTH,
  blockById,
  createCanvasBlock,
  createCanvasDocument,
  pageOrderedBlocks,
  parseCanvasBlockId,
  parseCanvasDocument,
  resolveEdgelessLayout,
  withBlockAdded,
  withBlockContent,
  withBlockRemoved,
  withBackground,
  withCamera,
  withLayoutMode,
  withPlacement,
  withPresentationNote,
  withPresentationOrder,
  withTitle,
  type CanvasBlock,
  type CanvasBlockKind,
  type CanvasBackground,
  type CanvasBackgroundKind,
  type CanvasCamera,
  type CanvasDocument,
  type CanvasLayoutMode,
  type CanvasSpatialPlacement,
} from './contracts';
import { db } from '@/lib/db';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { WallpaperHost } from '@/features/workbench/WallpaperHost';
import { WallpaperPicker } from '@/features/workbench/WallpaperPicker';
import { normalizeWallpaperConfig } from '@/features/workbench/wallpaperConfig';
import type { WallpaperId, WorkbenchWallpaperConfig } from '@/features/workbench/types';
import '@/features/workbench/workbench.css';
import { compileCanvasAiContext } from './aiContext';
import { publishActiveCanvasAiContextProvider } from './aiContextRegistry';
import {
  cameraZoomPercent,
  createCameraNavigator,
  fitWorldBounds,
  panCameraByScreenDelta,
  resetCamera,
  screenToWorld,
  zoomCameraAtScreenPoint,
} from './camera';
import { copyBlocks, cutBlocks, pasteBlocks, type CanvasClipboardPayload } from './clipboard';
import { createCanvasHistory, type CanvasHistory, type CanvasHistoryActionKind } from './history';
import { CANVAS_MARKDOWN_MAX_SOURCE_LENGTH, parseMarkdownToBlockContents } from './markdown';
import { exportCanvas, type CanvasExportArtifact, type CanvasExportFormat } from './importExport';
import { decodeCanvasPackage, encodeCanvasPackage } from './packageFormat';
import {
  createCustomCanvasTemplateStore,
  deleteCustomTemplate,
  duplicateCustomTemplate,
  instantiateCanvasTemplate,
  instantiateCustomTemplate,
  listBuiltInCanvasTemplates,
  listCustomTemplates,
  previewCustomTemplate,
  renameCustomTemplate,
  saveCanvasDocumentAsTemplate,
  type CanvasTemplate,
  type CanvasTemplatePreview,
  type CustomCanvasTemplateStore,
} from './templates';
import {
  createCanvasTemplatePersistenceRepository,
  type CanvasTemplatePersistenceRepository,
} from './templatePersistence';
import {
  clearCanvasSelection,
  createCanvasSelection,
  lassoSelect,
  marqueeSelect,
  selectAllCanvasBlocks,
  selectCanvasBlock,
  selectionHas,
} from './selection';
import { createCanvasSpatialIndex } from './spatialIndex';
import { CanvasOutline } from './CanvasOutline';
import {
  addMindMapChild,
  addMindMapSibling as appendMindMapSibling,
  createMindMap,
  navigateMindMap,
  reorderMindMapBranch,
  setMindMapBranchCollapsed,
  setMindMapDirection,
  setMindMapConnectorStyle,
  setMindMapNodeStyle,
  type MindMapConnectorStyle,
  type MindMapDirection,
  type MindMapNodeShape,
} from './mindmaps';
import {
  createCanvasAutosaveController,
  registerCanvasWorkspaceFlush,
  type CanvasAutosaveController,
  type CanvasPersistenceStatus,
  type CanvasRecoveryEntry,
} from './autosave';
import {
  createCanvasPersistencePort,
  createCanvasPersistenceRepository,
  type CanvasPersistenceRepository,
  type CanvasPersistenceScope,
} from './persistence';
import {
  canEnterFullscreen,
  enterPresentMode,
  exitPresentMode,
  frameZoomTarget,
  moveFrame,
  nextFrame,
  presentationFromDocument,
  presentationProgress,
  previousFrame,
  type PresentationState,
} from './presentation';
import {
  subscribeCanvasGlobalSearchNavigation,
  takePendingCanvasGlobalSearchNavigation,
  type CanvasGlobalSearchSelection,
} from './globalSearch';
import {
  CANVAS_SEARCH_LIMITS,
  cameraForFocusTarget,
  createCanvasSearchIndex,
  projectCanvasDocumentForSearch,
  type CanvasSearchResult,
} from './search';
import {
  alignCanvasPlacements,
  distributeCanvasPlacements,
  reorderCanvasPlacement,
  resizeCanvasPlacement,
  resizeCanvasPlacementFromHandle,
  rotateCanvasPlacement,
  rotateCanvasPlacementFromPointer,
  type CanvasAlignment,
  type CanvasDistributionAxis,
  type CanvasResizeHandle,
  type CanvasZOrderCommand,
} from './geometry';
import {
  CANVAS_GRID_SIZE,
  CANVAS_SNAP_THRESHOLD_PX,
  canvasSnapBounds,
  snapCanvasDrag,
  type CanvasSnapBounds,
  type CanvasSnapGuide,
} from './snapping';
import {
  CANVAS_SHAPE_KINDS,
  parseCanvasShape,
  createCanvasShape,
  type CanvasShape,
  type CanvasShapeKind,
} from './shapes';
import './sakura-canvas.css';

type CanvasTool = 'select' | 'lasso' | 'hand' | 'note';
type CanvasPlacementField = 'x' | 'y' | 'width' | 'height' | 'rotation';

const CANVAS_TOOL_LABELS: Readonly<Record<CanvasTool, string>> = Object.freeze({
  select: 'Select',
  lasso: 'Lasso',
  hand: 'Hand',
  note: 'Note',
});

const CANVAS_BLOCK_KIND_LABELS: Readonly<Record<CanvasBlockKind, string>> = Object.freeze({
  heading: 'Heading',
  text: 'Text',
  note: 'Note',
  code: 'Code',
  'mind-map': 'Mind map',
  shape: 'Shape',
});

const CANVAS_BACKGROUND_LABELS: Readonly<Record<CanvasBackgroundKind, string>> = Object.freeze({
  plain: 'Plain paper',
  dots: 'Dot grid',
  grid: 'Square grid',
  lines: 'Lined paper',
});

const CANVAS_ALIGNMENT_LABELS: Readonly<Record<CanvasAlignment, string>> = Object.freeze({
  left: 'Left',
  'horizontal-center': 'Horizontal center',
  right: 'Right',
  top: 'Top',
  'vertical-center': 'Vertical center',
  bottom: 'Bottom',
});

const CANVAS_Z_ORDER_LABELS: Readonly<Record<CanvasZOrderCommand, string>> = Object.freeze({
  forward: 'Bring forward',
  backward: 'Send backward',
  front: 'Bring to front',
  back: 'Send to back',
});

const CANVAS_Z_ORDER_ARIA_LABELS: Readonly<Record<CanvasZOrderCommand, string>> = Object.freeze({
  forward: 'Bring selected object forward',
  backward: 'Send selected object backward',
  front: 'Bring selected object to front',
  back: 'Send selected object to back',
});

const CANVAS_PLACEMENT_FIELD_LABELS: Readonly<Record<CanvasPlacementField, string>> = Object.freeze(
  {
    x: 'X',
    y: 'Y',
    width: 'Width',
    height: 'Height',
    rotation: 'Rotation',
  },
);

const CANVAS_PLACEMENT_ARIA_LABELS: Readonly<Record<CanvasPlacementField, string>> = Object.freeze({
  x: 'Selected object X',
  y: 'Selected object Y',
  width: 'Selected object width',
  height: 'Selected object height',
  rotation: 'Selected object rotation',
});

const CANVAS_POSITION_LIMIT = 1_000_000_000;
const CANVAS_SIZE_LIMIT = 10_000_000;
const CANVAS_RESIZE_HANDLES: readonly CanvasResizeHandle[] = [
  'northwest',
  'northeast',
  'southeast',
  'southwest',
];

const CANVAS_RESIZE_HANDLE_STYLES: Readonly<Record<CanvasResizeHandle, React.CSSProperties>> = {
  northwest: { left: -6, top: -6, cursor: 'nwse-resize' },
  northeast: { right: -6, top: -6, cursor: 'nesw-resize' },
  southeast: { right: -6, bottom: -6, cursor: 'nwse-resize' },
  southwest: { left: -6, bottom: -6, cursor: 'nesw-resize' },
};

type CanvasDirectGeometryGesture =
  | {
      readonly kind: 'resize';
      readonly pointerId: number;
      readonly blockId: string;
      readonly handle: CanvasResizeHandle;
      readonly startX: number;
      readonly startY: number;
      readonly zoom: number;
      readonly before: CanvasSpatialPlacement;
      readonly current: CanvasSpatialPlacement;
      readonly moved: boolean;
    }
  | {
      readonly kind: 'rotate';
      readonly pointerId: number;
      readonly blockId: string;
      readonly center: Readonly<{ x: number; y: number }>;
      readonly startPointer: Readonly<{ x: number; y: number }>;
      readonly before: CanvasSpatialPlacement;
      readonly current: CanvasSpatialPlacement;
      readonly moved: boolean;
    };

function sameCanvasPlacement(
  left: CanvasSpatialPlacement | undefined,
  right: CanvasSpatialPlacement,
): boolean {
  return (
    left !== undefined &&
    left.blockId === right.blockId &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height &&
    left.rotation === right.rotation &&
    left.z === right.z &&
    left.locked === right.locked &&
    left.hidden === right.hidden
  );
}

function selectionHasLockedPlacement(document: CanvasDocument, ids: readonly string[]): boolean {
  if (document.layoutMode !== 'edgeless') return false;
  const placements = resolveEdgelessLayout(document);
  return ids.some((id) => placements.get(parseCanvasBlockId(id))?.locked === true);
}

function canvasBackgroundStyle(background: CanvasBackground): React.CSSProperties {
  const lineColor = 'rgba(104, 86, 64, 0.22)';
  switch (background.kind) {
    case 'dots':
      return {
        backgroundColor: background.color,
        backgroundImage: `radial-gradient(circle, ${lineColor} 1px, transparent 1px)`,
        backgroundSize: '24px 24px',
      };
    case 'grid':
      return {
        backgroundColor: background.color,
        backgroundImage: [
          `linear-gradient(to right, ${lineColor} 1px, transparent 1px)`,
          `linear-gradient(to bottom, ${lineColor} 1px, transparent 1px)`,
        ].join(', '),
        backgroundSize: '24px 24px',
      };
    case 'lines':
      return {
        backgroundColor: background.color,
        backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent 27px, ${lineColor} 28px)`,
        backgroundSize: '100% 28px',
      };
    case 'plain':
      return {
        backgroundColor: background.color,
        backgroundImage: 'none',
      };
  }
}

const INITIAL_DOCUMENT = createCanvasDocument({
  id: 'local-canvas-draft',
  projectId: 'local-project',
  ownerId: 'local-user',
  title: 'Untitled canvas',
  now: 1,
});

const CAMERA_VIEWPORT = Object.freeze({ width: 1200, height: 800 });
const CAMERA_CENTER = Object.freeze({ x: 600, y: 400 });
let documentSequence = 0;

export interface CanvasPagePersistenceBinding {
  readonly repository: CanvasPersistenceRepository;
  readonly templateRepository?: CanvasTemplatePersistenceRepository;
  readonly scope: CanvasPersistenceScope | null;
  readonly autosaveDelayMs?: number;
  readonly now?: () => number;
  readonly createDocumentId?: () => string;
}

export interface CanvasPageProps {
  readonly persistence?: CanvasPagePersistenceBinding;
}

type CanvasPersistenceUiStatus = CanvasPersistenceStatus | 'loading';
type CanvasVisualExportFormat = Extract<
  CanvasExportFormat,
  'png' | 'svg' | 'pdf' | 'presentation-pdf'
>;
type CanvasVisualExportScope = 'all' | 'selection' | 'frame';

const PERSISTENCE_LABELS: Readonly<Record<CanvasPersistenceUiStatus, string>> = Object.freeze({
  saved: 'Saved locally',
  saving: 'Saving…',
  offline: 'Saved offline',
  'local-only': 'Saved locally',
  syncing: 'Syncing…',
  'sync-error': 'Save failed',
  'recovered-unsaved-work': 'Recovered unsaved work',
  loading: 'Loading local canvas…',
});

const VISUAL_EXPORT_LABELS: Readonly<Record<CanvasVisualExportFormat, string>> = Object.freeze({
  png: 'PNG',
  svg: 'SVG',
  pdf: 'PDF',
  'presentation-pdf': 'Presentation PDF',
});

function createDocumentId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `canvas-${globalThis.crypto.randomUUID()}`;
  }
  documentSequence += 1;
  return `canvas-${Date.now().toString(36)}-${documentSequence.toString(36)}`;
}

function safeExportTitle(title: string): string {
  return (
    title
      .trim()
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'canvas'
  );
}

function selectedPresentationFrameIds(
  document: CanvasDocument,
  selectedIds: readonly string[],
): readonly string[] {
  if (selectedIds.length !== 1) return [];
  const selectedId = selectedIds[0];
  const selectedFrameId = document.presentationOrder.find((frameId) => frameId === selectedId);
  return selectedFrameId ? [selectedFrameId] : [];
}

function presentationFrameLabel(block: CanvasBlock | undefined): string {
  if (!block) return 'Unavailable frame';
  const content = block.content;
  const label =
    content.kind === 'mind-map'
      ? content.map.nodes.find((node) => node.id === content.map.rootId)?.label
      : content.kind === 'shape'
        ? content.shape.text
        : content.text;
  const normalized = label?.trim().replace(/\s+/g, ' ');
  return normalized
    ? normalized.slice(0, 80)
    : `Untitled ${CANVAS_BLOCK_KIND_LABELS[block.content.kind]}`;
}

function templateContentLabel(content: CanvasBlock['content']): string {
  if (content.kind === 'mind-map') {
    return (
      content.map.nodes.find((node) => node.id === content.map.rootId)?.label ?? 'Untitled mind map'
    );
  }
  if (content.kind === 'shape') {
    return content.shape.text?.trim() || `Untitled ${content.shape.kind} shape`;
  }
  return content.text.trim() || `Untitled ${content.kind}`;
}

function shapeVisualStyle(shape: CanvasShape): React.CSSProperties {
  const gradient = shape.gradient
    ? shape.gradient.kind === 'linear'
      ? `linear-gradient(${shape.gradient.angle}deg, ${shape.gradient.stops
          .map((stop) => `${stop.color} ${stop.offset * 100}%`)
          .join(', ')})`
      : `radial-gradient(circle, ${shape.gradient.stops
          .map((stop) => `${stop.color} ${stop.offset * 100}%`)
          .join(', ')})`
    : undefined;
  const clipPathByKind: Partial<Record<CanvasShapeKind, string>> = {
    diamond: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
    triangle: 'polygon(50% 0, 100% 100%, 0 100%)',
    hexagon: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)',
    'speech-bubble': 'polygon(0 0, 100% 0, 100% 78%, 62% 78%, 50% 100%, 42% 78%, 0 78%)',
    callout: 'polygon(0 0, 100% 0, 100% 75%, 28% 75%, 12% 100%, 16% 75%, 0 75%)',
  };
  return {
    background: gradient ?? shape.fill?.color ?? 'transparent',
    borderColor: shape.borderColor ?? 'transparent',
    borderWidth: shape.borderWidth,
    borderStyle: shape.dash === 'solid' ? 'solid' : shape.dash,
    borderRadius:
      shape.kind === 'ellipse' || shape.kind === 'actor'
        ? '9999px'
        : shape.kind === 'cloud'
          ? '45%'
          : shape.kind === 'cylinder'
            ? '50% / 12%'
            : shape.kind === 'rounded-rectangle'
              ? shape.cornerRadius
              : shape.cornerRadius,
    clipPath: clipPathByKind[shape.kind],
    opacity: shape.opacity,
    boxShadow: shape.shadow
      ? `${shape.shadow.offsetX}px ${shape.shadow.offsetY}px ${shape.shadow.blur}px ${shape.shadow.color}`
      : undefined,
  };
}

function currentCanvasSearchResultLabel(result: CanvasSearchResult): string {
  const title = result.object.title.trim();
  if (title) return title;
  const firstLine = result.object.text.split(/\r?\n/u)[0]?.trim() ?? '';
  if (firstLine) return firstLine.slice(0, 80);
  return `Untitled ${result.object.objectType}`;
}

function presenterNotesForFrame(document: CanvasDocument, frameId: string): string {
  return document.presentationNotes.find((entry) => entry.frameId === frameId)?.text ?? '';
}

function supportsPresentationFullscreen(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof HTMLElement !== 'undefined' &&
    typeof HTMLElement.prototype.requestFullscreen === 'function' &&
    typeof document.exitFullscreen === 'function'
  );
}

interface ToolButtonProps {
  readonly active: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

function ToolButton({ active, label, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-monochrome-state={active ? 'selected' : 'idle'}
      onClick={onClick}
      className={[
        'inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:transition-none',
        active
          ? 'border-foreground/20 bg-foreground text-background [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-accent-cyan'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export function CanvasPage({ persistence }: CanvasPageProps = {}) {
  const cloudSession = useAuthStore((state) => state.cloudSession);
  const localUserId = useAuthStore((state) => state.localUserId);
  const projectId = useAuthStore((state) => state.projectId);
  const canvasRouteActive = useUIStore((state) => state.route === 'canvas');
  const accountIdentity = resolveAccountIdentity({ cloudSession, localUserId });
  const defaultRepository = React.useMemo(() => createCanvasPersistenceRepository(db), []);
  const defaultTemplateRepository = React.useMemo(
    () => createCanvasTemplatePersistenceRepository(db),
    [],
  );
  const defaultScope = React.useMemo<CanvasPersistenceScope | null>(
    () =>
      accountIdentity
        ? {
            accountId: accountIdentity.accountId,
            projectId: projectId ?? 'local-project',
            ownerId: accountIdentity.accountId,
          }
        : null,
    [accountIdentity?.accountId, projectId],
  );
  const activeRepository = persistence?.repository ?? defaultRepository;
  const activeTemplateRepository =
    persistence === undefined
      ? defaultTemplateRepository
      : (persistence.templateRepository ?? null);
  const activeScope = persistence === undefined ? defaultScope : persistence.scope;
  const persistenceScopeKey = activeScope
    ? `${activeScope.accountId}\u0000${activeScope.projectId}\u0000${activeScope.ownerId}`
    : '';
  const historyRef = React.useRef<CanvasHistory<CanvasDocument>>(
    createCanvasHistory(INITIAL_DOCUMENT),
  );
  const [document, setDocument] = React.useState(INITIAL_DOCUMENT);
  const documentRef = React.useRef<CanvasDocument>(INITIAL_DOCUMENT);
  const fullscreenSupported = supportsPresentationFullscreen();
  const [presentation, setPresentation] = React.useState<PresentationState>(() =>
    presentationFromDocument(INITIAL_DOCUMENT, { fullscreen: fullscreenSupported }),
  );
  const [presentationFullscreen, setPresentationFullscreen] = React.useState(false);
  const [presentationFullscreenMessage, setPresentationFullscreenMessage] = React.useState('');
  const [showPresenterNotes, setShowPresenterNotes] = React.useState(false);
  const presentationTriggerRef = React.useRef<HTMLButtonElement>(null);
  const presentationRegionRef = React.useRef<HTMLElement>(null);
  const presentationDragFrameRef = React.useRef<string | null>(null);
  const wasPresentingRef = React.useRef(false);
  const autosaveRef = React.useRef<CanvasAutosaveController | null>(null);
  const autosaveUnsubscribeRef = React.useRef<(() => void) | null>(null);
  const workspaceUnbindRef = React.useRef<(() => void) | null>(null);
  const hydrationGeneration = React.useRef(0);
  const [persistenceStatus, setPersistenceStatus] =
    React.useState<CanvasPersistenceUiStatus>('local-only');
  const [recoveryOffer, setRecoveryOffer] = React.useState<CanvasRecoveryEntry | null>(null);
  const [camera, setCameraState] = React.useState(resetCamera);
  const cameraRef = React.useRef(camera);
  const cameraNavigator = React.useRef(createCameraNavigator(camera));
  const [, refreshCameraNavigation] = React.useReducer((revision: number) => revision + 1, 0);
  const setCamera = React.useCallback(
    (action: React.SetStateAction<CanvasCamera>, recordLocation = true) => {
      const next = typeof action === 'function' ? action(cameraRef.current) : action;
      cameraRef.current = next;
      if (recordLocation) {
        cameraNavigator.current.visit(next);
        refreshCameraNavigation();
      }
      setCameraState(next);
      if (recordLocation && next !== documentRef.current.camera) {
        const nextDocument = withCamera(documentRef.current, next);
        documentRef.current = nextDocument;
        setDocument(nextDocument);
        autosaveRef.current?.schedule(nextDocument);
      }
    },
    [],
  );
  const restoreCameraLocation = React.useCallback((next: CanvasCamera) => {
    cameraRef.current = next;
    setCameraState(next);
    refreshCameraNavigation();
    const nextDocument = withCamera(documentRef.current, next);
    documentRef.current = nextDocument;
    setDocument(nextDocument);
    autosaveRef.current?.schedule(nextDocument);
  }, []);
  const [tool, setTool] = React.useState<CanvasTool>('select');
  const [selected, setSelected] = React.useState(createCanvasSelection);
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [propertiesOpen, setPropertiesOpen] = React.useState(false);
  const [wallpaperPickerOpen, setWallpaperPickerOpen] = React.useState(false);
  const [canvasSearchText, setCanvasSearchText] = React.useState('');
  const [canvasSearchObjectType, setCanvasSearchObjectType] = React.useState('');
  const [canvasSearchFrameId, setCanvasSearchFrameId] = React.useState('');
  const [packageMessage, setPackageMessage] = React.useState('');
  const builtInTemplates = React.useMemo(listBuiltInCanvasTemplates, []);
  const [selectedBuiltInTemplateId, setSelectedBuiltInTemplateId] = React.useState<string>(
    builtInTemplates[0]?.id ?? 'blank',
  );
  const [customTemplateStore, setCustomTemplateStore] = React.useState(
    createCustomCanvasTemplateStore,
  );
  const [customTemplateName, setCustomTemplateName] = React.useState('');
  const [templateRenameDrafts, setTemplateRenameDrafts] = React.useState<
    Readonly<Record<string, string>>
  >({});
  const [previewedTemplateId, setPreviewedTemplateId] = React.useState<string | null>(null);
  const templateSequence = React.useRef(0);
  const templateClock = React.useRef(0);
  const templatePersistenceGeneration = React.useRef(0);
  const [templatePersistenceBusy, setTemplatePersistenceBusy] = React.useState(false);
  const [visualExportFormat, setVisualExportFormat] =
    React.useState<CanvasVisualExportFormat>('png');
  const [visualExportScope, setVisualExportScope] = React.useState<CanvasVisualExportScope>('all');
  const [visualExportScale, setVisualExportScale] = React.useState(1);
  const [marqueeVisual, setMarqueeVisual] = React.useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);
  const [lassoVisual, setLassoVisual] = React.useState<readonly { x: number; y: number }[] | null>(
    null,
  );
  const [objectSnapping, setObjectSnapping] = React.useState(true);
  const [gridSnapping, setGridSnapping] = React.useState(false);
  const [snapGuides, setSnapGuides] = React.useState<readonly CanvasSnapGuide[]>([]);
  const sequence = React.useRef(0);
  const clipboardSequence = React.useRef(0);
  const clipboard = React.useRef<CanvasClipboardPayload | null>(null);
  const cursorScreenPoint = React.useRef<{ x: number; y: number } | null>(null);
  const clock = React.useRef(INITIAL_DOCUMENT.updatedAt);
  const spaceHeld = React.useRef(false);
  const panPointer = React.useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const activePointers = React.useRef(new Map<number, { x: number; y: number }>());
  const pinch = React.useRef<{
    distance: number;
    center: { x: number; y: number };
  } | null>(null);
  const objectDrag = React.useRef<{
    pointerId: number;
    ids: readonly string[];
    x: number;
    y: number;
    zoom: number;
    movingBounds: CanvasSnapBounds;
    targets: readonly CanvasSpatialPlacement[];
    rawTotalX: number;
    rawTotalY: number;
    totalX: number;
    totalY: number;
    moved: boolean;
  } | null>(null);
  const directGeometryGesture = React.useRef<CanvasDirectGeometryGesture | null>(null);
  const blockElements = React.useRef(new Map<string, HTMLElement>());
  const workspaceRef = React.useRef<HTMLElement>(null);
  const pendingSearchFocusBlockId = React.useRef<string | null>(null);
  const geometryOverlayRef = React.useRef<HTMLDivElement>(null);
  const suppressObjectClick = React.useRef(false);
  const marqueeGesture = React.useRef<{
    pointerId: number;
    start: { x: number; y: number };
    end: { x: number; y: number };
    baseIds: readonly string[];
  } | null>(null);
  const lassoGesture = React.useRef<{
    pointerId: number;
    points: readonly { x: number; y: number }[];
    baseIds: readonly string[];
  } | null>(null);

  React.useEffect(() => {
    const generation = templatePersistenceGeneration.current + 1;
    templatePersistenceGeneration.current = generation;
    setCustomTemplateStore(createCustomCanvasTemplateStore());
    setTemplateRenameDrafts({});
    setPreviewedTemplateId(null);
    if (!activeScope || !activeTemplateRepository) {
      setTemplatePersistenceBusy(false);
      return;
    }

    const scope = {
      accountId: activeScope.accountId,
      ownerId: activeScope.ownerId,
      projectId: activeScope.projectId,
    };
    let cancelled = false;
    setTemplatePersistenceBusy(true);
    void activeTemplateRepository.load(scope).then(
      (store) => {
        if (cancelled || templatePersistenceGeneration.current !== generation) return;
        setCustomTemplateStore(store);
        setTemplateRenameDrafts(
          Object.fromEntries(store.templates.map((template) => [template.id, template.title])),
        );
        setTemplatePersistenceBusy(false);
      },
      (error: unknown) => {
        if (cancelled || templatePersistenceGeneration.current !== generation) return;
        setTemplatePersistenceBusy(false);
        setPackageMessage(
          `Load templates failed: ${
            error instanceof Error ? error.message : 'unknown template storage error'
          }`,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    activeScope?.accountId,
    activeScope?.ownerId,
    activeScope?.projectId,
    activeTemplateRepository,
    persistenceScopeKey,
  ]);

  React.useEffect(() => {
    const blockId = pendingSearchFocusBlockId.current;
    if (!blockId) return;
    const element = blockElements.current.get(blockId);
    if (!element) return;
    pendingSearchFocusBlockId.current = null;
    element.focus();
  }, [camera, document, selected]);

  const detachAutosave = React.useCallback(() => {
    workspaceUnbindRef.current?.();
    workspaceUnbindRef.current = null;
    autosaveUnsubscribeRef.current?.();
    autosaveUnsubscribeRef.current = null;
    const controller = autosaveRef.current;
    autosaveRef.current = null;
    if (controller) void controller.dispose();
  }, []);

  const replaceActiveDocument = React.useCallback((next: CanvasDocument) => {
    historyRef.current = createCanvasHistory(next);
    documentRef.current = next;
    clock.current = next.updatedAt;
    sequence.current = 0;
    clipboardSequence.current = 0;
    clipboard.current = null;
    cursorScreenPoint.current = null;
    cameraRef.current = next.camera;
    cameraNavigator.current = createCameraNavigator(next.camera);
    setCameraState(next.camera);
    refreshCameraNavigation();
    setSelected(clearCanvasSelection);
    setPresentation((current) => presentationFromDocument(next, current.capabilities));
    setDocument(next);
  }, []);

  const attachAutosave = React.useCallback(
    (
      repository: CanvasPersistenceRepository,
      scope: CanvasPersistenceScope,
      initialRevision: number,
    ) => {
      detachAutosave();
      const controller = createCanvasAutosaveController({
        persistence: createCanvasPersistencePort(repository, scope),
        initialRevision,
        delayMs: persistence?.autosaveDelayMs,
        now: persistence?.now,
      });
      autosaveRef.current = controller;
      setPersistenceStatus(controller.getState().status);
      autosaveUnsubscribeRef.current = controller.subscribe((state) => {
        setPersistenceStatus(state.status);
      });
      workspaceUnbindRef.current = registerCanvasWorkspaceFlush(controller);
      return controller;
    },
    [detachAutosave, persistence?.autosaveDelayMs, persistence?.now],
  );

  React.useEffect(() => {
    hydrationGeneration.current += 1;
    const generation = hydrationGeneration.current;
    let cancelled = false;
    setRecoveryOffer(null);

    if (!activeScope) {
      detachAutosave();
      if (documentRef.current.ownerId !== INITIAL_DOCUMENT.ownerId) {
        replaceActiveDocument(INITIAL_DOCUMENT);
      }
      setPersistenceStatus('local-only');
      return () => {
        cancelled = true;
      };
    }

    const scope = activeScope;
    const navigationScope = {
      ownerId: scope.ownerId,
      projectId: scope.projectId,
    };
    const pendingNavigation = takePendingCanvasGlobalSearchNavigation(navigationScope);
    setPersistenceStatus('loading');
    const requestedDocument = pendingNavigation
      ? activeRepository.load(scope, pendingNavigation.documentId).then(async (loaded) => ({
          loaded: loaded ?? (await activeRepository.loadLatest(scope)),
          navigation: loaded ? pendingNavigation : undefined,
        }))
      : activeRepository.loadLatest(scope).then((loaded) => ({
          loaded,
          navigation: undefined as CanvasGlobalSearchSelection | undefined,
        }));
    void Promise.all([requestedDocument, activeRepository.listRecovery(scope)]).then(
      ([request, recovery]) => {
        if (cancelled || hydrationGeneration.current !== generation) return;
        const now = persistence?.now?.() ?? Date.now();
        const base =
          request.loaded ??
          createCanvasDocument({
            id: persistence?.createDocumentId?.() ?? createDocumentId(),
            projectId: scope.projectId,
            ownerId: scope.ownerId,
            title: 'Untitled canvas',
            now,
          });
        const next = request.navigation ? withCamera(base, request.navigation.camera) : base;
        replaceActiveDocument(next);
        const controller = attachAutosave(activeRepository, scope, base.localRevision);
        if (request.navigation) {
          controller.schedule(next);
          if (next.blocks.some((block) => block.id === request.navigation?.objectId)) {
            setSelected(createCanvasSelection([request.navigation.objectId]));
          }
        }
        setRecoveryOffer(recovery[0] ?? null);
      },
      () => {
        if (cancelled || hydrationGeneration.current !== generation) return;
        detachAutosave();
        setPersistenceStatus('sync-error');
      },
    );

    const openNavigation = async (selection: CanvasGlobalSearchSelection) => {
      const currentController = autosaveRef.current;
      await currentController?.flush();
      if (cancelled || hydrationGeneration.current !== generation) return;
      if (
        currentController?.getState().status === 'sync-error' ||
        currentController?.getState().status === 'recovered-unsaved-work'
      ) {
        setPersistenceStatus(currentController.getState().status);
        return;
      }
      const loaded = await activeRepository.load(scope, selection.documentId);
      if (!loaded || cancelled || hydrationGeneration.current !== generation) return;
      const focused = withCamera(loaded, selection.camera);
      replaceActiveDocument(focused);
      const controller = attachAutosave(activeRepository, scope, loaded.localRevision);
      controller.schedule(focused);
      if (focused.blocks.some((block) => block.id === selection.objectId)) {
        setSelected(createCanvasSelection([selection.objectId]));
      }
    };
    const unsubscribeNavigation = subscribeCanvasGlobalSearchNavigation(
      navigationScope,
      (selection) => {
        void openNavigation(selection);
      },
    );

    return () => {
      cancelled = true;
      unsubscribeNavigation();
      if (hydrationGeneration.current === generation) {
        detachAutosave();
      }
    };
  }, [
    activeRepository,
    activeScope?.accountId,
    activeScope?.ownerId,
    activeScope?.projectId,
    attachAutosave,
    detachAutosave,
    persistence?.createDocumentId,
    persistence?.now,
    persistenceScopeKey,
    replaceActiveDocument,
  ]);

  React.useEffect(() => {
    if (
      !canvasRouteActive ||
      activeScope === null ||
      activeScope.accountId !== activeScope.ownerId ||
      persistenceStatus === 'loading' ||
      document.projectId !== activeScope.projectId ||
      document.ownerId !== activeScope.ownerId
    ) {
      return;
    }
    const publishedDocument = document;
    const selectedBlockIds = [...selected.ids];
    const selectedFrameId =
      selectedBlockIds.find((candidate) =>
        publishedDocument.presentationOrder.some((frameId) => frameId === candidate),
      ) ?? null;
    return publishActiveCanvasAiContextProvider({
      accountId: activeScope.accountId,
      ownerId: activeScope.ownerId,
      projectId: activeScope.projectId,
      canvasId: publishedDocument.id,
      selectedFrameId,
      getContext: () =>
        compileCanvasAiContext({
          document: publishedDocument,
          selectedBlockIds,
        }),
      captureSnapshot: () => {
        const capturedAt = Date.now();
        const artifact = exportCanvas(publishedDocument, {
          format: 'png',
          scope: { kind: 'all' },
          width: 1280,
          height: 720,
          scale: 1,
          background: publishedDocument.background.color,
          filename: `${safeExportTitle(publishedDocument.title)}-snapshot.png`,
        });
        return {
          id: `canvas-snapshot-${publishedDocument.id}-${capturedAt}`,
          canvasId: publishedDocument.id,
          projectId: publishedDocument.projectId,
          capturedAt,
          filename: artifact.filename,
          mimeType: 'image/png' as const,
          bytes: artifact.bytes,
        };
      },
    });
  }, [
    activeScope,
    canvasRouteActive,
    document,
    persistenceScopeKey,
    persistenceStatus,
    selected.ids,
  ]);

  const commit = React.useCallback(
    (
      kind: CanvasHistoryActionKind,
      label: string,
      transition: (current: CanvasDocument, now: number) => CanvasDocument,
      coalesceKey?: string,
    ) => {
      clock.current += 1;
      const next = transition(documentRef.current, clock.current);
      historyRef.current.commit({
        id: `canvas-action-${clock.current}`,
        label,
        kind,
        timestamp: clock.current,
        after: next,
        coalesceKey,
      });
      documentRef.current = next;
      setDocument(next);
      autosaveRef.current?.schedule(next);
    },
    [],
  );

  const applyHistorySnapshot = React.useCallback((snapshot: CanvasDocument) => {
    const current = documentRef.current;
    clock.current = Math.max(clock.current, current.updatedAt, snapshot.updatedAt) + 1;
    const next = parseCanvasDocument({
      ...snapshot,
      id: current.id,
      projectId: current.projectId,
      ownerId: current.ownerId,
      localRevision: current.localRevision + 1,
      syncRevision: current.syncRevision,
      createdAt: current.createdAt,
      updatedAt: clock.current,
    });
    documentRef.current = next;
    cameraRef.current = next.camera;
    setCameraState(next.camera);
    setDocument(next);
    autosaveRef.current?.schedule(next);
  }, []);

  const undo = React.useCallback(() => {
    if (!historyRef.current.canUndo()) return;
    applyHistorySnapshot(historyRef.current.undo());
  }, [applyHistorySnapshot]);

  const redo = React.useCallback(() => {
    if (!historyRef.current.canRedo()) return;
    applyHistorySnapshot(historyRef.current.redo());
  }, [applyHistorySnapshot]);

  const deleteSelected = React.useCallback(() => {
    if (selected.ids.length === 0) return;
    const ids = selected.ids;
    if (selectionHasLockedPlacement(documentRef.current, ids)) return;
    commit(
      'object-delete',
      `Delete ${ids.length} canvas object${ids.length === 1 ? '' : 's'}`,
      (current, now) => ids.reduce((next, id) => withBlockRemoved(next, id, now), current),
    );
    setSelected(clearCanvasSelection);
  }, [commit, selected.ids]);

  const nudgeSelected = React.useCallback(
    (x: number, y: number) => {
      if (selected.ids.length === 0 || document.layoutMode !== 'edgeless') return;
      const ids = selected.ids;
      if (selectionHasLockedPlacement(documentRef.current, ids)) return;
      commit(
        'object-move',
        `Move ${ids.length} canvas object${ids.length === 1 ? '' : 's'}`,
        (current, now) =>
          ids.reduce((next, id) => {
            const placement = resolveEdgelessLayout(next).get(parseCanvasBlockId(id));
            if (!placement) return next;
            return withPlacement(
              next,
              { ...placement, x: placement.x + x, y: placement.y + y },
              now,
            );
          }, current),
        `keyboard-nudge:${ids.join(',')}`,
      );
    },
    [commit, document.layoutMode, selected.ids],
  );

  const commitPlacementTransformation = React.useCallback(
    (
      kind: CanvasHistoryActionKind,
      label: string,
      transform: (
        placements: readonly CanvasSpatialPlacement[],
      ) => readonly CanvasSpatialPlacement[],
      coalesceKey?: string,
    ) => {
      commit(
        kind,
        label,
        (current, now) => {
          const placements = [...resolveEdgelessLayout(current).values()];
          const previousById = new Map(
            placements.map((placement) => [placement.blockId, placement] as const),
          );
          return transform(placements).reduce(
            (next, placement) =>
              sameCanvasPlacement(previousById.get(placement.blockId), placement)
                ? next
                : withPlacement(next, placement, now),
            current,
          );
        },
        coalesceKey,
      );
    },
    [commit],
  );

  const alignSelected = React.useCallback(
    (alignment: CanvasAlignment) => {
      if (selected.ids.length < 2 || documentRef.current.layoutMode !== 'edgeless') return;
      const ids = selected.ids;
      if (selectionHasLockedPlacement(documentRef.current, ids)) return;
      commitPlacementTransformation(
        'object-move',
        `Align ${ids.length} canvas objects ${CANVAS_ALIGNMENT_LABELS[alignment].toLowerCase()}`,
        (placements) => alignCanvasPlacements(placements, ids, alignment),
      );
    },
    [commitPlacementTransformation, selected.ids],
  );

  const distributeSelected = React.useCallback(
    (axis: CanvasDistributionAxis) => {
      if (selected.ids.length < 3 || documentRef.current.layoutMode !== 'edgeless') return;
      const ids = selected.ids;
      if (selectionHasLockedPlacement(documentRef.current, ids)) return;
      commitPlacementTransformation(
        'object-move',
        `Distribute ${ids.length} canvas objects ${axis}ly`,
        (placements) => distributeCanvasPlacements(placements, ids, axis),
      );
    },
    [commitPlacementTransformation, selected.ids],
  );

  const reorderSelected = React.useCallback(
    (command: CanvasZOrderCommand) => {
      if (selected.ids.length !== 1 || documentRef.current.layoutMode !== 'edgeless') return;
      const [id] = selected.ids;
      if (selectionHasLockedPlacement(documentRef.current, [id])) return;
      commitPlacementTransformation('style-change', CANVAS_Z_ORDER_LABELS[command], (placements) =>
        reorderCanvasPlacement(placements, id, command),
      );
    },
    [commitPlacementTransformation, selected.ids],
  );

  const updateSelectedPlacementField = React.useCallback(
    (field: CanvasPlacementField, rawValue: string) => {
      if (
        selected.ids.length !== 1 ||
        documentRef.current.layoutMode !== 'edgeless' ||
        rawValue.trim() === ''
      ) {
        return;
      }
      const parsedValue = Number(rawValue);
      if (!Number.isFinite(parsedValue)) return;
      const [id] = selected.ids;
      if (selectionHasLockedPlacement(documentRef.current, [id])) return;
      const value =
        field === 'x' || field === 'y'
          ? Math.max(-CANVAS_POSITION_LIMIT, Math.min(CANVAS_POSITION_LIMIT, parsedValue))
          : field === 'width' || field === 'height'
            ? Math.min(CANVAS_SIZE_LIMIT, parsedValue)
            : parsedValue;
      const kind: CanvasHistoryActionKind =
        field === 'rotation'
          ? 'object-rotate'
          : field === 'width' || field === 'height'
            ? 'object-resize'
            : 'object-move';
      commitPlacementTransformation(
        kind,
        `Change canvas object ${field}`,
        (placements) =>
          placements.map((placement) => {
            if (placement.blockId !== id) return placement;
            if (field === 'rotation') {
              return rotateCanvasPlacement(placement, value);
            }
            return resizeCanvasPlacement(placement, {
              x: field === 'x' ? value : placement.x,
              y: field === 'y' ? value : placement.y,
              width: field === 'width' ? value : placement.width,
              height: field === 'height' ? value : placement.height,
            });
          }),
        `canvas-placement:${id}:${field}`,
      );
    },
    [commitPlacementTransformation, selected.ids],
  );

  const toggleSelectedPlacementState = React.useCallback(
    (field: 'locked' | 'hidden') => {
      if (selected.ids.length !== 1 || documentRef.current.layoutMode !== 'edgeless') return;
      const [id] = selected.ids;
      const currentPlacement = resolveEdgelessLayout(documentRef.current).get(
        parseCanvasBlockId(id),
      );
      if (!currentPlacement) return;
      const nextValue = !currentPlacement[field];
      const verb =
        field === 'locked' ? (nextValue ? 'Lock' : 'Unlock') : nextValue ? 'Hide' : 'Show';
      commit('style-change', `${verb} canvas object`, (current, now) => {
        const placement = resolveEdgelessLayout(current).get(parseCanvasBlockId(id));
        return placement
          ? withPlacement(current, { ...placement, [field]: nextValue }, now)
          : current;
      });
    },
    [commit, selected.ids],
  );

  const copySelected = React.useCallback(() => {
    if (selected.ids.length === 0) return;
    clipboard.current = copyBlocks(documentRef.current, selected.ids);
  }, [selected.ids]);

  const pastePayload = React.useCallback(
    (
      payload: CanvasClipboardPayload,
      label: string,
      destination?: { readonly x: number; readonly y: number },
    ) => {
      const pastedIds: string[] = [];
      const offset =
        destination && payload.placements.length > 0
          ? {
              dx: destination.x - Math.min(...payload.placements.map((placement) => placement.x)),
              dy: destination.y - Math.min(...payload.placements.map((placement) => placement.y)),
            }
          : { dx: 24, dy: 24 };
      commit('object-create', label, (current, now) =>
        pasteBlocks(current, payload, {
          now,
          offset,
          generateId: () => {
            let id: string;
            do {
              clipboardSequence.current += 1;
              id = `${documentRef.current.id}-copy-${clipboardSequence.current}`;
            } while (blockById(documentRef.current, id));
            pastedIds.push(id);
            return id;
          },
        }),
      );
      setSelected(createCanvasSelection(pastedIds));
    },
    [commit],
  );

  const pasteClipboard = React.useCallback(() => {
    if (clipboard.current) {
      const destination =
        documentRef.current.layoutMode === 'edgeless' && cursorScreenPoint.current
          ? screenToWorld(cameraRef.current, CAMERA_VIEWPORT, cursorScreenPoint.current)
          : undefined;
      pastePayload(clipboard.current, 'Paste canvas objects', destination);
    }
  }, [pastePayload]);

  const duplicateSelected = React.useCallback(() => {
    if (selected.ids.length === 0) return;
    pastePayload(copyBlocks(documentRef.current, selected.ids), 'Duplicate canvas objects');
  }, [pastePayload, selected.ids]);

  const cutSelected = React.useCallback(() => {
    if (selected.ids.length === 0) return;
    const ids = selected.ids;
    if (selectionHasLockedPlacement(documentRef.current, ids)) return;
    clipboard.current = copyBlocks(documentRef.current, ids);
    commit(
      'object-delete',
      `Cut ${ids.length} canvas object${ids.length === 1 ? '' : 's'}`,
      (current, now) => cutBlocks(current, ids, now),
    );
    setSelected(clearCanvasSelection);
  }, [commit, selected.ids]);

  const exitPresentation = React.useCallback(() => {
    const region = presentationRegionRef.current;
    if (
      region &&
      typeof globalThis.document.exitFullscreen === 'function' &&
      globalThis.document.fullscreenElement === region
    ) {
      void globalThis.document.exitFullscreen().catch(() => {
        setPresentationFullscreenMessage('Could not exit presentation fullscreen');
      });
    }
    setShowPresenterNotes(false);
    setPresentation((current) => exitPresentMode(current));
  }, []);

  React.useEffect(() => {
    setPresentation((current) =>
      current.status === 'presenting'
        ? current
        : presentationFromDocument(document, current.capabilities),
    );
  }, [document.presentationNotes, document.presentationOrder]);

  React.useEffect(() => {
    const syncFullscreenState = () => {
      const region = presentationRegionRef.current;
      setPresentationFullscreen(
        region !== null && globalThis.document.fullscreenElement === region,
      );
    };
    globalThis.document.addEventListener('fullscreenchange', syncFullscreenState);
    syncFullscreenState();
    return () => globalThis.document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  React.useEffect(() => {
    if (presentation.status === 'presenting') {
      wasPresentingRef.current = true;
      presentationRegionRef.current?.focus();
      return;
    }
    if (wasPresentingRef.current) {
      wasPresentingRef.current = false;
      presentationTriggerRef.current?.focus();
    }
  }, [presentation.status]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (presentation.status === 'presenting') {
        if (event.key === 'Escape') {
          event.preventDefault();
          exitPresentation();
          return;
        }
        if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
          event.preventDefault();
          setPresentation((current) => nextFrame(current));
          return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault();
          setPresentation((current) => previousFrame(current));
          return;
        }
      }
      if (isEditableTarget(event.target)) return;
      if (event.key === 'Escape' && selected.ids.length > 0) {
        event.preventDefault();
        setSelected(clearCanvasSelection);
        return;
      }
      if (event.code === 'Space' && document.layoutMode === 'edgeless') {
        event.preventDefault();
        spaceHeld.current = true;
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'c' && selected.ids.length > 0) {
          event.preventDefault();
          copySelected();
          return;
        }
        if (key === 'x' && selected.ids.length > 0) {
          event.preventDefault();
          cutSelected();
          return;
        }
        if (key === 'v' && clipboard.current) {
          event.preventDefault();
          pasteClipboard();
          return;
        }
        if (key === 'd' && selected.ids.length > 0) {
          event.preventDefault();
          duplicateSelected();
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(selectAllCanvasBlocks(documentRef.current.pageOrder));
        return;
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === 'Delete' || event.key === 'Backspace')
      ) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.startsWith('Arrow')) {
        const amount = event.shiftKey ? 10 : 1;
        const deltaByKey: Record<string, readonly [number, number]> = {
          ArrowLeft: [-amount, 0],
          ArrowRight: [amount, 0],
          ArrowUp: [0, -amount],
          ArrowDown: [0, amount],
        };
        const delta = deltaByKey[event.key];
        if (delta && selected.ids.length > 0 && document.layoutMode === 'edgeless') {
          event.preventDefault();
          nudgeSelected(delta[0], delta[1]);
          return;
        }
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spaceHeld.current = false;
      }
    };
    const onBlur = () => {
      spaceHeld.current = false;
      panPointer.current = null;
      activePointers.current.clear();
      pinch.current = null;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    copySelected,
    cutSelected,
    deleteSelected,
    document.layoutMode,
    duplicateSelected,
    exitPresentation,
    nudgeSelected,
    pasteClipboard,
    presentation.status,
    redo,
    selected.ids.length,
    undo,
  ]);

  React.useEffect(() => {
    const existing = new Set<string>(document.blocks.map((block) => block.id));
    setSelected((current) => createCanvasSelection(current.ids.filter((id) => existing.has(id))));
  }, [document.blocks]);

  const pointerPoint = (event: React.PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const readPinch = () => {
    const [first, second] = [...activePointers.current.values()];
    if (!first || !second) return null;
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (document.layoutMode !== 'edgeless') return;
    const point = pointerPoint(event);
    cursorScreenPoint.current = point;
    activePointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (
      activePointers.current.size === 1 &&
      event.target === event.currentTarget &&
      tool === 'lasso' &&
      event.button === 0 &&
      event.pointerType !== 'touch'
    ) {
      event.preventDefault();
      const gesture = {
        pointerId: event.pointerId,
        points: [point],
        baseIds:
          event.shiftKey || event.ctrlKey || event.metaKey
            ? selected.ids
            : ([] as readonly string[]),
      };
      lassoGesture.current = gesture;
      setLassoVisual(gesture.points);
      return;
    }

    if (
      activePointers.current.size === 1 &&
      event.target === event.currentTarget &&
      tool === 'select' &&
      event.button === 0 &&
      event.pointerType !== 'touch'
    ) {
      event.preventDefault();
      const gesture = {
        pointerId: event.pointerId,
        start: point,
        end: point,
        baseIds:
          event.shiftKey || event.ctrlKey || event.metaKey
            ? selected.ids
            : ([] as readonly string[]),
      };
      marqueeGesture.current = gesture;
      setMarqueeVisual({ start: point, end: point });
      return;
    }

    if (activePointers.current.size === 2) {
      pinch.current = readPinch();
      panPointer.current = null;
      return;
    }

    if (
      tool === 'hand' ||
      spaceHeld.current ||
      event.button === 1 ||
      event.pointerType === 'touch'
    ) {
      event.preventDefault();
      panPointer.current = { pointerId: event.pointerId, ...point };
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (document.layoutMode !== 'edgeless') return;
    const point = pointerPoint(event);
    cursorScreenPoint.current = point;
    if (!activePointers.current.has(event.pointerId)) return;
    activePointers.current.set(event.pointerId, point);

    const activeLasso = lassoGesture.current;
    if (activeLasso?.pointerId === event.pointerId) {
      event.preventDefault();
      const previous = activeLasso.points.at(-1);
      if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) {
        const points = [...activeLasso.points, point];
        lassoGesture.current = { ...activeLasso, points };
        setLassoVisual(points);
      }
      return;
    }

    const activeMarquee = marqueeGesture.current;
    if (activeMarquee?.pointerId === event.pointerId) {
      event.preventDefault();
      marqueeGesture.current = { ...activeMarquee, end: point };
      setMarqueeVisual({ start: activeMarquee.start, end: point });
      return;
    }

    const previousPinch = pinch.current;
    const nextPinch = readPinch();
    if (previousPinch && nextPinch && previousPinch.distance > 0 && nextPinch.distance > 0) {
      event.preventDefault();
      setCamera((current) => {
        const panned = panCameraByScreenDelta(current, {
          x: nextPinch.center.x - previousPinch.center.x,
          y: nextPinch.center.y - previousPinch.center.y,
        });
        return zoomCameraAtScreenPoint(
          panned,
          CAMERA_VIEWPORT,
          nextPinch.center,
          panned.zoom * (nextPinch.distance / previousPinch.distance),
        );
      }, false);
      pinch.current = nextPinch;
      return;
    }

    const previous = panPointer.current;
    if (previous?.pointerId !== event.pointerId) return;
    event.preventDefault();
    setCamera(
      (current) =>
        panCameraByScreenDelta(current, { x: point.x - previous.x, y: point.y - previous.y }),
      false,
    );
    panPointer.current = { pointerId: event.pointerId, ...point };
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    const activeLasso = lassoGesture.current;
    if (activeLasso?.pointerId === event.pointerId) {
      if (event.type === 'pointercancel') {
        setSelected(createCanvasSelection(activeLasso.baseIds));
      } else {
        const end = pointerPoint(event);
        const previous = activeLasso.points.at(-1);
        const points =
          previous && Math.hypot(end.x - previous.x, end.y - previous.y) < 2
            ? activeLasso.points
            : [...activeLasso.points, end];
        if (points.length >= 3) {
          const worldPoints = points.map((point) =>
            screenToWorld(cameraRef.current, CAMERA_VIEWPORT, point),
          );
          const placements = [...resolveEdgelessLayout(documentRef.current).values()]
            .filter((placement) => !placement.hidden)
            .map((placement) => ({ ...placement, id: placement.blockId }));
          const inLasso = lassoSelect(placements, worldPoints);
          setSelected(createCanvasSelection([...activeLasso.baseIds, ...inLasso.ids]));
        } else {
          setSelected(createCanvasSelection(activeLasso.baseIds));
        }
      }
      lassoGesture.current = null;
      setLassoVisual(null);
    }
    const activeMarquee = marqueeGesture.current;
    if (activeMarquee?.pointerId === event.pointerId) {
      if (event.type === 'pointercancel') {
        setSelected(createCanvasSelection(activeMarquee.baseIds));
      } else {
        const end = pointerPoint(event);
        const startWorld = screenToWorld(camera, CAMERA_VIEWPORT, activeMarquee.start);
        const endWorld = screenToWorld(camera, CAMERA_VIEWPORT, end);
        const placements = [...resolveEdgelessLayout(documentRef.current).values()]
          .filter((placement) => !placement.hidden)
          .map((placement) => ({ ...placement, id: placement.blockId }));
        const inMarquee = marqueeSelect(placements, startWorld, endWorld);
        setSelected(createCanvasSelection([...activeMarquee.baseIds, ...inMarquee.ids]));
      }
      marqueeGesture.current = null;
      setMarqueeVisual(null);
    }
    const completedCameraGesture =
      panPointer.current?.pointerId === event.pointerId || pinch.current !== null;
    activePointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (panPointer.current?.pointerId === event.pointerId) {
      panPointer.current = null;
    }
    pinch.current = activePointers.current.size === 2 ? readPinch() : null;
    if (completedCameraGesture) {
      setCamera(cameraRef.current);
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (document.layoutMode !== 'edgeless') return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const factor = Math.exp(-event.deltaY * 0.001);
    setCamera((current) =>
      zoomCameraAtScreenPoint(current, CAMERA_VIEWPORT, point, current.zoom * factor),
    );
  };

  const onObjectPointerDown = (event: React.PointerEvent<HTMLElement>, blockId: string) => {
    if (
      document.layoutMode !== 'edgeless' ||
      tool === 'hand' ||
      spaceHeld.current ||
      event.button === 1 ||
      event.pointerType === 'touch'
    ) {
      return;
    }
    const ids = selectionHas(selected, blockId) ? selected.ids : [blockId];
    if (selectionHasLockedPlacement(documentRef.current, ids)) return;
    event.stopPropagation();
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (!selectionHas(selected, blockId)) {
      setSelected(selectCanvasBlock(selected, blockId));
    }
    const placementById = resolveEdgelessLayout(documentRef.current);
    const movingPlacements = ids.flatMap((id) => {
      const placement = placementById.get(parseCanvasBlockId(id));
      return placement ? [placement] : [];
    });
    if (movingPlacements.length !== ids.length) return;
    const selectedIds = new Set(ids);
    const targets = [...visibleEdgelessBlockIds].flatMap((id) => {
      if (selectedIds.has(id)) return [];
      const placement = placementById.get(parseCanvasBlockId(id));
      return placement && !placement.hidden ? [placement] : [];
    });
    setSnapGuides([]);
    objectDrag.current = {
      pointerId: event.pointerId,
      ids,
      x: event.clientX,
      y: event.clientY,
      zoom: camera.zoom,
      movingBounds: canvasSnapBounds(movingPlacements),
      targets,
      rawTotalX: 0,
      rawTotalY: 0,
      totalX: 0,
      totalY: 0,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onObjectPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = objectDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = (event.clientX - drag.x) / drag.zoom;
    const y = (event.clientY - drag.y) / drag.zoom;
    if (x === 0 && y === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rawTotalX = drag.rawTotalX + x;
    const rawTotalY = drag.rawTotalY + y;
    const snappingDisabled = event.altKey;
    const snapped = snapCanvasDrag({
      movingBounds: drag.movingBounds,
      delta: { x: rawTotalX, y: rawTotalY },
      targets: objectSnapping && !snappingDisabled ? drag.targets : [],
      threshold: CANVAS_SNAP_THRESHOLD_PX / drag.zoom,
      gridSize: gridSnapping && !snappingDisabled ? CANVAS_GRID_SIZE : null,
    });
    const totalX = snapped.delta.x;
    const totalY = snapped.delta.y;
    setSnapGuides(snapped.guides);
    for (const id of drag.ids) {
      const element = blockElements.current.get(id);
      if (element) {
        const rotation = resolveEdgelessLayout(documentRef.current).get(
          parseCanvasBlockId(id),
        )?.rotation;
        element.style.transform = `translate(${totalX}px, ${totalY}px) rotate(${rotation ?? 0}deg)`;
      }
    }
    objectDrag.current = {
      ...drag,
      x: event.clientX,
      y: event.clientY,
      rawTotalX,
      rawTotalY,
      totalX,
      totalY,
      moved: true,
    };
  };

  const onObjectPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    const drag = objectDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    for (const id of drag.ids) {
      const element = blockElements.current.get(id);
      if (element) {
        const rotation = resolveEdgelessLayout(documentRef.current).get(
          parseCanvasBlockId(id),
        )?.rotation;
        element.style.transform = `rotate(${rotation ?? 0}deg)`;
      }
    }
    if (drag.moved && event.type !== 'pointercancel') {
      commit(
        'object-move',
        `Move ${drag.ids.length} canvas object${drag.ids.length === 1 ? '' : 's'}`,
        (current, now) =>
          drag.ids.reduce((next, id) => {
            const placement = resolveEdgelessLayout(next).get(parseCanvasBlockId(id));
            if (!placement) return next;
            return withPlacement(
              next,
              {
                ...placement,
                x: placement.x + drag.totalX,
                y: placement.y + drag.totalY,
              },
              now,
            );
          }, current),
      );
    }
    suppressObjectClick.current = drag.moved;
    setSnapGuides([]);
    objectDrag.current = null;
  };

  const previewDirectGeometry = (placement: CanvasSpatialPlacement) => {
    const apply = (element: HTMLElement | null | undefined) => {
      if (!element) return;
      element.style.left = `${placement.x}px`;
      element.style.top = `${placement.y}px`;
      element.style.width = `${placement.width}px`;
      element.style.height = `${placement.height}px`;
      element.style.transform = `rotate(${placement.rotation}deg)`;
    };
    apply(blockElements.current.get(placement.blockId));
    apply(geometryOverlayRef.current);
  };

  const boundedDirectGeometry = (placement: CanvasSpatialPlacement) =>
    resizeCanvasPlacement(placement, {
      x: Math.max(-CANVAS_POSITION_LIMIT, Math.min(CANVAS_POSITION_LIMIT, placement.x)),
      y: Math.max(-CANVAS_POSITION_LIMIT, Math.min(CANVAS_POSITION_LIMIT, placement.y)),
      width: Math.min(CANVAS_SIZE_LIMIT, placement.width),
      height: Math.min(CANVAS_SIZE_LIMIT, placement.height),
    });

  const commitDirectGeometry = (
    kind: 'object-resize' | 'object-rotate',
    label: string,
    blockId: string,
    finalPlacement: CanvasSpatialPlacement,
  ) => {
    commit(kind, label, (current, now) => {
      const placement = resolveEdgelessLayout(current).get(parseCanvasBlockId(blockId));
      return placement
        ? withPlacement(
            current,
            {
              ...placement,
              x: finalPlacement.x,
              y: finalPlacement.y,
              width: finalPlacement.width,
              height: finalPlacement.height,
              rotation: finalPlacement.rotation,
            },
            now,
          )
        : current;
    });
  };

  const beginDirectResize = (
    event: React.PointerEvent<HTMLButtonElement>,
    placement: CanvasSpatialPlacement,
    handle: CanvasResizeHandle,
  ) => {
    if (event.button !== 0 || placement.locked || placement.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    setSnapGuides([]);
    directGeometryGesture.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      blockId: placement.blockId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      zoom: cameraRef.current.zoom,
      before: placement,
      current: placement,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const beginDirectRotation = (
    event: React.PointerEvent<HTMLButtonElement>,
    placement: CanvasSpatialPlacement,
  ) => {
    if (event.button !== 0 || placement.locked || placement.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const workspaceBounds = workspaceRef.current?.getBoundingClientRect();
    const currentCamera = cameraRef.current;
    const centerWorld = {
      x: placement.x + placement.width / 2,
      y: placement.y + placement.height / 2,
    };
    const center = {
      x:
        (workspaceBounds?.left ?? 0) +
        CAMERA_CENTER.x +
        (centerWorld.x - currentCamera.x) * currentCamera.zoom,
      y:
        (workspaceBounds?.top ?? 0) +
        CAMERA_CENTER.y +
        (centerWorld.y - currentCamera.y) * currentCamera.zoom,
    };
    setSnapGuides([]);
    directGeometryGesture.current = {
      kind: 'rotate',
      pointerId: event.pointerId,
      blockId: placement.blockId,
      center,
      startPointer: { x: event.clientX, y: event.clientY },
      before: placement,
      current: placement,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onDirectGeometryPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = directGeometryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (
      gesture.kind === 'rotate' &&
      Math.hypot(event.clientX - gesture.center.x, event.clientY - gesture.center.y) < 0.001
    ) {
      return;
    }
    const unbounded =
      gesture.kind === 'resize'
        ? resizeCanvasPlacementFromHandle(gesture.before, gesture.handle, {
            x: (event.clientX - gesture.startX) / gesture.zoom,
            y: (event.clientY - gesture.startY) / gesture.zoom,
          })
        : rotateCanvasPlacementFromPointer(gesture.before, gesture.center, gesture.startPointer, {
            x: event.clientX,
            y: event.clientY,
          });
    const current = boundedDirectGeometry(unbounded);
    previewDirectGeometry(current);
    directGeometryGesture.current = { ...gesture, current, moved: true };
  };

  const onDirectGeometryPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = directGeometryGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (!gesture.moved || event.type === 'pointercancel') {
      previewDirectGeometry(gesture.before);
    } else {
      const finalPlacement = gesture.current;
      commitDirectGeometry(
        gesture.kind === 'resize' ? 'object-resize' : 'object-rotate',
        gesture.kind === 'resize' ? 'Resize canvas object' : 'Rotate canvas object',
        gesture.blockId,
        finalPlacement,
      );
    }
    directGeometryGesture.current = null;
  };

  const onResizeHandleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    placement: CanvasSpatialPlacement,
    handle: CanvasResizeHandle,
  ) => {
    const amount = event.shiftKey ? 10 : 1;
    const deltaByKey: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {
      ArrowLeft: { x: -amount, y: 0 },
      ArrowRight: { x: amount, y: 0 },
      ArrowUp: { x: 0, y: -amount },
      ArrowDown: { x: 0, y: amount },
    };
    const delta = deltaByKey[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const next = boundedDirectGeometry(resizeCanvasPlacementFromHandle(placement, handle, delta));
    commitDirectGeometry('object-resize', 'Resize canvas object', placement.blockId, next);
  };

  const onRotateHandleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    placement: CanvasSpatialPlacement,
  ) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const amount = event.shiftKey ? 15 : 1;
    const next = rotateCanvasPlacement(
      placement,
      placement.rotation + (event.key === 'ArrowRight' ? amount : -amount),
    );
    commitDirectGeometry('object-rotate', 'Rotate canvas object', placement.blockId, next);
  };

  const addBlock = (kind: Exclude<CanvasBlockKind, 'mind-map' | 'shape'>) => {
    let blockNumber: number;
    let blockId: string;
    do {
      sequence.current += 1;
      blockNumber = sequence.current;
      blockId = `${documentRef.current.id}-${kind}-${blockNumber}`;
    } while (blockById(documentRef.current, blockId));
    const content =
      kind === 'heading'
        ? ({ kind, level: 2, text: `New heading ${blockNumber}` } as const)
        : kind === 'code'
          ? ({ kind, language: 'typescript', text: `// New code block ${blockNumber}` } as const)
          : ({ kind, text: `New ${kind} ${blockNumber}` } as const);
    commit('object-create', `Add ${kind} ${blockNumber}`, (current, now) =>
      withBlockAdded(
        current,
        createCanvasBlock({
          id: blockId,
          content,
          now,
        }),
        now,
      ),
    );
  };

  const addNote = () => addBlock('note');

  const addMindMap = () => {
    let blockNumber: number;
    let blockId: string;
    do {
      sequence.current += 1;
      blockNumber = sequence.current;
      blockId = `${documentRef.current.id}-mind-map-${blockNumber}`;
    } while (blockById(documentRef.current, blockId));
    commit('object-create', `Add mind map ${blockNumber}`, (current, now) =>
      withBlockAdded(
        current,
        createCanvasBlock({
          id: blockId,
          content: {
            kind: 'mind-map',
            map: createMindMap({
              id: `mind-map-${blockNumber}`,
              rootId: `mind-map-root-${blockNumber}`,
              label: `New mind map ${blockNumber}`,
              now,
            }),
          },
          now,
        }),
        now,
      ),
    );
  };

  const addShape = () => {
    let blockNumber: number;
    let blockId: string;
    do {
      sequence.current += 1;
      blockNumber = sequence.current;
      blockId = `${documentRef.current.id}-shape-${blockNumber}`;
    } while (blockById(documentRef.current, blockId));
    commit('object-create', `Add shape ${blockNumber}`, (current, now) =>
      withBlockAdded(
        current,
        createCanvasBlock({
          id: blockId,
          content: {
            kind: 'shape',
            shape: createCanvasShape({
              id: blockId,
              kind: 'rectangle',
              fill: '#f2c94c',
              borderColor: '#8a6d1d',
              borderWidth: 2,
              cornerRadius: 16,
              text: `New shape ${blockNumber}`,
            }),
          },
          now,
        }),
        now,
      ),
    );
  };

  const addMindMapChildToRoot = (blockId: string) => {
    commit('block-change', 'Add mind-map branch', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      const map = content.map;
      const root = map.nodes.find((node) => node.id === map.rootId);
      if (!root) return current;
      const branchNumber = root.childIds.length + 1;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: addMindMapChild(map, {
            parentId: root.id,
            nodeId: `${map.id}-branch-${branchNumber}`,
            label: `New branch ${branchNumber}`,
            now,
          }),
        },
        now,
      );
    });
  };

  const toggleMindMapRootCollapsed = (blockId: string) => {
    commit('block-change', 'Toggle mind-map branch', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      const map = content.map;
      const root = map.nodes.find((node) => node.id === map.rootId);
      if (!root) return current;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: setMindMapBranchCollapsed(map, root.id, !root.collapsed, now),
        },
        now,
      );
    });
  };

  const addMindMapSibling = (blockId: string, siblingId: string) => {
    commit('block-change', 'Add mind-map sibling', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      const sibling = content.map.nodes.find((node) => node.id === siblingId);
      if (!sibling || sibling.parentId === null) return current;
      const parent = content.map.nodes.find((node) => node.id === sibling.parentId);
      const branchNumber = (parent?.childIds.length ?? 0) + 1;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: appendMindMapSibling(content.map, {
            siblingId,
            nodeId: `${content.map.id}-branch-${branchNumber}`,
            label: `New branch ${branchNumber}`,
            now,
          }),
        },
        now,
      );
    });
  };

  const moveMindMapBranchEarlier = (blockId: string, nodeId: string) => {
    commit('block-change', 'Reorder mind-map branch', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      const node = content.map.nodes.find((entry) => entry.id === nodeId);
      if (!node || node.parentId === null) return current;
      const parent = content.map.nodes.find((entry) => entry.id === node.parentId);
      const index = parent?.childIds.indexOf(node.id) ?? -1;
      if (!parent || index <= 0) return current;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: reorderMindMapBranch(content.map, {
            parentId: parent.id,
            nodeId: node.id,
            index: index - 1,
            now,
          }),
        },
        now,
      );
    });
  };

  const changeMindMapDirection = (blockId: string, value: string) => {
    commit('block-change', 'Change mind-map direction', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: setMindMapDirection(content.map, value as MindMapDirection, now),
        },
        now,
      );
    });
  };

  const changeMindMapConnectorStyle = (blockId: string, value: string) => {
    commit('block-change', 'Change mind-map connector style', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: setMindMapConnectorStyle(content.map, value as MindMapConnectorStyle, now),
        },
        now,
      );
    });
  };

  const changeMindMapRootShape = (blockId: string, value: string) => {
    commit('block-change', 'Change mind-map root shape', (current, now) => {
      const block = blockById(current, blockId);
      const content = block?.content;
      if (!content || content.kind !== 'mind-map') return current;
      const root = content.map.nodes.find((node) => node.id === content.map.rootId);
      if (!root) return current;
      return withBlockContent(
        current,
        blockId,
        {
          kind: 'mind-map',
          map: setMindMapNodeStyle(content.map, root.id, { shape: value as MindMapNodeShape }, now),
        },
        now,
      );
    });
  };

  const navigateMindMapNode = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    map: Parameters<typeof navigateMindMap>[0],
    nodeId: string,
  ) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const nextId = navigateMindMap(map, nodeId, event.key as Parameters<typeof navigateMindMap>[2]);
    const container = event.currentTarget.closest<HTMLElement>('[data-mind-map-id]');
    const next = [
      ...(container?.querySelectorAll<HTMLButtonElement>('[data-mind-map-node-id]') ?? []),
    ].find((element) => element.dataset.mindMapNodeId === nextId);
    next?.focus();
  };

  const updateBlockText = (blockId: string, text: string) => {
    if (selectionHasLockedPlacement(documentRef.current, [blockId])) return;
    commit(
      'text-change',
      'Edit canvas block',
      (current, now) => {
        const block = blockById(current, blockId);
        if (!block || block.content.kind === 'mind-map' || block.content.kind === 'shape') {
          return current;
        }
        return withBlockContent(current, blockId, { ...block.content, text }, now);
      },
      `canvas-block:${blockId}`,
    );
  };

  const updateShape = (
    blockId: string,
    update: Readonly<Partial<Pick<CanvasShape, 'kind' | 'fill' | 'text'>>>,
  ) => {
    if (selectionHasLockedPlacement(documentRef.current, [blockId])) return;
    commit(
      'block-change',
      'Edit canvas shape',
      (current, now) => {
        const block = blockById(current, blockId);
        if (!block || block.content.kind !== 'shape') return current;
        return withBlockContent(
          current,
          blockId,
          {
            kind: 'shape',
            shape: parseCanvasShape({ ...block.content.shape, ...update }),
          },
          now,
        );
      },
      `canvas-shape:${blockId}`,
    );
  };

  const updateHeadingLevel = (blockId: string, level: number) => {
    if (!Number.isInteger(level) || level < 1 || level > 6) return;
    if (selectionHasLockedPlacement(documentRef.current, [blockId])) return;
    commit('block-change', 'Change heading level', (current, now) => {
      const block = blockById(current, blockId);
      if (!block || block.content.kind !== 'heading') return current;
      return withBlockContent(
        current,
        blockId,
        { ...block.content, level: level as 1 | 2 | 3 | 4 | 5 | 6 },
        now,
      );
    });
  };

  const startPresentation = () => {
    if (document.presentationOrder.length === 0) return;
    setPresentation((current) =>
      enterPresentMode(presentationFromDocument(documentRef.current, current.capabilities)),
    );
  };

  const togglePresentationFullscreen = async () => {
    const region = presentationRegionRef.current;
    if (!region || !canEnterFullscreen(presentation)) return;
    setPresentationFullscreenMessage('');
    try {
      if (globalThis.document.fullscreenElement === region) {
        await globalThis.document.exitFullscreen();
        return;
      }
      if (globalThis.document.fullscreenElement) {
        setPresentationFullscreenMessage('Another view is already fullscreen');
        return;
      }
      await region.requestFullscreen();
    } catch {
      setPresentationFullscreenMessage('Presentation fullscreen was rejected');
    }
  };

  const importPackage = async (file: File) => {
    try {
      const imported = decodeCanvasPackage(await file.text()).document;
      clock.current = Math.max(clock.current, imported.updatedAt);
      commit('block-change', 'Import canvas package', (current, now) =>
        parseCanvasDocument({
          ...imported,
          id: current.id,
          projectId: current.projectId,
          ownerId: current.ownerId,
          localRevision: current.localRevision + 1,
          syncRevision: current.syncRevision,
          createdAt: current.createdAt,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
        }),
      );
      setSelected(clearCanvasSelection);
      setCamera(imported.camera);
      setPackageMessage(`Imported ${file.name}`);
    } catch (error) {
      setPackageMessage(
        error instanceof Error
          ? `Import failed: ${error.message}`
          : 'Import failed: invalid package',
      );
    }
  };

  const importMarkdown = async (file: File) => {
    try {
      const target = documentRef.current;
      const targetIdentity = {
        id: target.id,
        projectId: target.projectId,
        ownerId: target.ownerId,
      };
      if (file.size > CANVAS_MARKDOWN_MAX_SOURCE_LENGTH) {
        throw new Error(
          `file exceeds the ${CANVAS_MARKDOWN_MAX_SOURCE_LENGTH.toLocaleString()} byte limit`,
        );
      }
      const source = await file.text();
      const active = documentRef.current;
      if (
        active.id !== targetIdentity.id ||
        active.projectId !== targetIdentity.projectId ||
        active.ownerId !== targetIdentity.ownerId
      ) {
        throw new Error('active canvas changed before the file finished loading');
      }
      const contents = parseMarkdownToBlockContents(source);
      if (contents.length === 0) {
        throw new Error('document contains no importable blocks');
      }

      commit(
        'object-create',
        `Import ${contents.length} Markdown ${contents.length === 1 ? 'block' : 'blocks'}`,
        (current, now) => {
          const knownIds = new Set<string>(current.blocks.map((block) => block.id));
          const importedBlocks = contents.map((content) => {
            let blockId: string;
            do {
              sequence.current += 1;
              blockId = `canvas-markdown-${content.kind}-${sequence.current.toString(36)}`;
            } while (knownIds.has(blockId));
            knownIds.add(blockId);
            return createCanvasBlock({ id: blockId, content, now });
          });
          return parseCanvasDocument({
            ...current,
            blocks: [...current.blocks, ...importedBlocks],
            pageOrder: [...current.pageOrder, ...importedBlocks.map((block) => block.id)],
            localRevision: current.localRevision + 1,
            updatedAt: now,
          });
        },
      );
      setPackageMessage(
        `Imported ${contents.length} Markdown ${contents.length === 1 ? 'block' : 'blocks'} from ${file.name || 'document.md'}`,
      );
    } catch (error) {
      setPackageMessage(
        error instanceof Error
          ? `Markdown import failed: ${error.message}`
          : 'Markdown import failed: invalid document',
      );
    }
  };

  const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    try {
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const downloadDocument = (content: BlobPart, type: string, extension: string): void => {
    downloadBlob(
      new Blob([content], { type }),
      `${safeExportTitle(documentRef.current.title)}${extension}`,
    );
  };

  const downloadArtifact = (artifact: CanvasExportArtifact, mimeType = artifact.mimeType): void => {
    const bytes = new Uint8Array(artifact.bytes.byteLength);
    bytes.set(artifact.bytes);
    downloadBlob(new Blob([bytes.buffer], { type: mimeType }), artifact.filename);
  };

  const exportVisualDocument = (): void => {
    try {
      const frameIds = selectedPresentationFrameIds(documentRef.current, selected.ids);
      if (
        visualExportFormat !== 'presentation-pdf' &&
        visualExportScope === 'frame' &&
        frameIds.length === 0
      ) {
        setPackageMessage('Select one presentation frame to export');
        return;
      }
      const artifact = exportCanvas(documentRef.current, {
        format: visualExportFormat,
        scope:
          visualExportFormat === 'presentation-pdf'
            ? { kind: 'presentation' }
            : visualExportScope === 'frame'
              ? { kind: 'frame', blockIds: frameIds }
              : visualExportScope === 'selection'
                ? { kind: 'objects', blockIds: selected.ids }
                : { kind: 'all' },
        width: 1280,
        height: 720,
        scale: visualExportScale,
        background: documentRef.current.background.color,
      });
      downloadArtifact(artifact);
      setPackageMessage(`${VISUAL_EXPORT_LABELS[visualExportFormat]} export downloaded`);
    } catch (error) {
      setPackageMessage(
        error instanceof Error
          ? `Canvas export failed: ${error.message}`
          : 'Canvas export failed: invalid document',
      );
    }
  };

  const exportMarkdown = () => {
    try {
      downloadArtifact(
        exportCanvas(documentRef.current, {
          format: 'markdown',
          scope: { kind: 'all' },
          background: documentRef.current.background.color,
        }),
        'text/markdown;charset=utf-8',
      );
      setPackageMessage('Markdown document exported');
    } catch (error) {
      setPackageMessage(
        error instanceof Error
          ? `Markdown export failed: ${error.message}`
          : 'Markdown export failed: invalid document',
      );
    }
  };

  const exportPackage = () => {
    downloadDocument(
      encodeCanvasPackage(documentRef.current),
      'application/json',
      '.vibespace-canvas.json',
    );
    setPackageMessage('Canvas package exported');
  };

  const setLayout = (layoutMode: CanvasLayoutMode) => {
    if (document.layoutMode === layoutMode) return;
    commit('mode-change', `Switch to ${layoutMode} layout`, (current, now) =>
      withLayoutMode(current, layoutMode, now),
    );
  };

  const setBackgroundKind = (kind: CanvasBackgroundKind) => {
    if (document.background.kind === kind) return;
    commit('style-change', `Use ${CANVAS_BACKGROUND_LABELS[kind]}`, (current, now) =>
      withBackground(current, { ...current.background, kind }, now),
    );
  };

  const setBackgroundColor = (color: string) => {
    if (document.background.color === color) return;
    commit(
      'style-change',
      'Change canvas background color',
      (current, now) => withBackground(current, { ...current.background, color }, now),
      'canvas:background-color',
    );
  };

  const setCanvasWallpaper = React.useCallback(
    (id: WallpaperId, assetUrl?: string) => {
      commit('style-change', 'Change Canvas wallpaper', (current, now) =>
        withBackground(
          current,
          {
            ...current.background,
            wallpaper: normalizeWallpaperConfig({
              ...current.background.wallpaper,
              id,
              assetUrl,
            }),
          },
          now,
        ),
      );
    },
    [commit],
  );

  const configureCanvasWallpaper = React.useCallback(
    (patch: Partial<WorkbenchWallpaperConfig>) => {
      commit(
        'style-change',
        'Configure Canvas wallpaper',
        (current, now) =>
          withBackground(
            current,
            {
              ...current.background,
              wallpaper: normalizeWallpaperConfig({
                ...current.background.wallpaper,
                ...patch,
              }),
            },
            now,
          ),
        'canvas:wallpaper-config',
      );
    },
    [commit],
  );

  const setZoom = (factor: number) => {
    setCamera((current) =>
      zoomCameraAtScreenPoint(current, CAMERA_VIEWPORT, CAMERA_CENTER, current.zoom * factor),
    );
  };

  const fitContent = () => {
    const placements = [...resolveEdgelessLayout(document).values()].filter(
      (placement) => !placement.hidden,
    );
    if (placements.length === 0) {
      setCamera(resetCamera());
      return;
    }
    const left = Math.min(...placements.map((placement) => placement.x));
    const top = Math.min(...placements.map((placement) => placement.y));
    const right = Math.max(...placements.map((placement) => placement.x + placement.width));
    const bottom = Math.max(...placements.map((placement) => placement.y + placement.height));
    setCamera(
      fitWorldBounds(
        { x: left, y: top, width: right - left, height: bottom - top },
        CAMERA_VIEWPORT,
      ),
    );
  };

  const restoreRecovery = () => {
    if (!recoveryOffer || !activeScope) return;
    const entry = recoveryOffer;
    replaceActiveDocument(entry.document);
    const controller = attachAutosave(activeRepository, activeScope, entry.baseRevision);
    controller.schedule(entry.document);
    setRecoveryOffer(null);
    setPersistenceStatus('recovered-unsaved-work');
  };

  const discardRecovery = async () => {
    if (!recoveryOffer || !activeScope) return;
    const entry = recoveryOffer;
    try {
      await activeRepository.clearRecovery(activeScope, entry.id);
      setRecoveryOffer((current) => (current?.id === entry.id ? null : current));
    } catch {
      setPersistenceStatus('sync-error');
    }
  };

  const nextTemplateId = () => {
    templateSequence.current += 1;
    return `template-${documentRef.current.id}-${templateSequence.current}`;
  };

  const nextTemplateTimestamp = () => {
    const suppliedNow = persistence?.now?.() ?? Date.now();
    templateClock.current = Math.max(templateClock.current + 1, suppliedNow);
    return templateClock.current;
  };

  const reportTemplateFailure = (action: string, error: unknown) => {
    setPackageMessage(
      `${action} failed: ${error instanceof Error ? error.message : 'unknown template error'}`,
    );
  };

  const activateTemplateDocument = (next: CanvasDocument, templateTitle: string) => {
    replaceActiveDocument(next);
    autosaveRef.current?.schedule(next);
    setPackageMessage(`Created a new canvas from ${templateTitle}`);
  };

  const createFromBuiltInTemplate = (template: CanvasTemplate) => {
    if (!window.confirm(`Replace the current canvas with a new ${template.title} canvas?`)) {
      return;
    }
    try {
      const next = instantiateCanvasTemplate(template, {
        documentId: persistence?.createDocumentId?.() ?? createDocumentId(),
        projectId: documentRef.current.projectId,
        ownerId: documentRef.current.ownerId,
        now: nextTemplateTimestamp(),
      });
      activateTemplateDocument(next, template.title);
    } catch (error) {
      reportTemplateFailure('Create canvas', error);
    }
  };

  const persistCustomTemplateStore = async (
    nextStore: CustomCanvasTemplateStore,
    action: string,
    onPersisted: () => void,
  ): Promise<void> => {
    const generation = templatePersistenceGeneration.current;
    const repository = activeTemplateRepository;
    const scope = activeScope
      ? {
          accountId: activeScope.accountId,
          ownerId: activeScope.ownerId,
          projectId: activeScope.projectId,
        }
      : null;
    setTemplatePersistenceBusy(true);
    try {
      if (repository && scope) {
        await repository.replace(scope, nextStore);
      }
      if (templatePersistenceGeneration.current !== generation) return;
      setCustomTemplateStore(nextStore);
      onPersisted();
    } catch (error) {
      if (templatePersistenceGeneration.current === generation) {
        reportTemplateFailure(action, error);
      }
    } finally {
      if (templatePersistenceGeneration.current === generation) {
        setTemplatePersistenceBusy(false);
      }
    }
  };

  const saveCurrentCanvasTemplate = async () => {
    try {
      const result = saveCanvasDocumentAsTemplate(customTemplateStore, {
        source: documentRef.current,
        templateId: nextTemplateId(),
        ownerId: documentRef.current.ownerId,
        projectId: documentRef.current.projectId,
        title: customTemplateName.trim() || documentRef.current.title,
        now: nextTemplateTimestamp(),
      });
      await persistCustomTemplateStore(result.store, 'Save template', () => {
        setTemplateRenameDrafts((current) => ({
          ...current,
          [result.template.id]: result.template.title,
        }));
        setCustomTemplateName('');
        setPackageMessage(`Saved ${result.template.title} as a custom template`);
      });
    } catch (error) {
      reportTemplateFailure('Save template', error);
    }
  };

  const createFromCustomTemplate = (templateId: string, templateTitle: string) => {
    if (!window.confirm(`Replace the current canvas with a new ${templateTitle} canvas?`)) {
      return;
    }
    try {
      const next = instantiateCustomTemplate(customTemplateStore, {
        templateId,
        documentId: persistence?.createDocumentId?.() ?? createDocumentId(),
        ownerId: documentRef.current.ownerId,
        projectId: documentRef.current.projectId,
        now: nextTemplateTimestamp(),
      });
      activateTemplateDocument(next, templateTitle);
    } catch (error) {
      reportTemplateFailure('Create canvas', error);
    }
  };

  const duplicateTemplate = async (templateId: string, templateTitle: string) => {
    try {
      const now = nextTemplateTimestamp();
      const duplicated = duplicateCustomTemplate(customTemplateStore, {
        templateId,
        newTemplateId: nextTemplateId(),
        ownerId: documentRef.current.ownerId,
        projectId: documentRef.current.projectId,
        now,
      });
      const renamed = renameCustomTemplate(duplicated.store, {
        templateId: duplicated.template.id,
        title: `${templateTitle} copy`,
        ownerId: documentRef.current.ownerId,
        projectId: documentRef.current.projectId,
        now,
      });
      await persistCustomTemplateStore(renamed.store, 'Duplicate template', () => {
        setTemplateRenameDrafts((current) => ({
          ...current,
          [renamed.template.id]: renamed.template.title,
        }));
        setPackageMessage(`Duplicated ${templateTitle}`);
      });
    } catch (error) {
      reportTemplateFailure('Duplicate template', error);
    }
  };

  const applyTemplateRename = async (templateId: string, previousTitle: string) => {
    try {
      const result = renameCustomTemplate(customTemplateStore, {
        templateId,
        title: templateRenameDrafts[templateId] ?? previousTitle,
        ownerId: documentRef.current.ownerId,
        projectId: documentRef.current.projectId,
        now: nextTemplateTimestamp(),
      });
      await persistCustomTemplateStore(result.store, 'Rename template', () => {
        setTemplateRenameDrafts((current) => ({
          ...current,
          [templateId]: result.template.title,
        }));
        setPackageMessage(`Renamed template to ${result.template.title}`);
      });
    } catch (error) {
      reportTemplateFailure('Rename template', error);
    }
  };

  const removeCustomTemplate = async (templateId: string, templateTitle: string) => {
    if (!window.confirm(`Delete the custom template ${templateTitle}?`)) return;
    try {
      const result = deleteCustomTemplate(customTemplateStore, {
        templateId,
        ownerId: documentRef.current.ownerId,
        projectId: documentRef.current.projectId,
      });
      await persistCustomTemplateStore(result.store, 'Delete template', () => {
        setPreviewedTemplateId((current) => (current === templateId ? null : current));
        setTemplateRenameDrafts((current) => {
          const { [templateId]: _removed, ...remaining } = current;
          return remaining;
        });
        setPackageMessage(`Deleted template ${templateTitle}`);
      });
    } catch (error) {
      reportTemplateFailure('Delete template', error);
    }
  };

  const blocks = pageOrderedBlocks(document);
  const selectedBuiltInTemplate =
    builtInTemplates.find((template) => template.id === selectedBuiltInTemplateId) ??
    builtInTemplates[0]!;
  const scopedCustomTemplates = listCustomTemplates(customTemplateStore, {
    ownerId: document.ownerId,
    projectId: document.projectId,
  });
  let customTemplatePreview: CanvasTemplatePreview | null = null;
  if (previewedTemplateId) {
    try {
      customTemplatePreview = previewCustomTemplate(customTemplateStore, {
        templateId: previewedTemplateId,
        ownerId: document.ownerId,
        projectId: document.projectId,
      });
    } catch {
      customTemplatePreview = null;
    }
  }
  const currentCanvasSearch = React.useMemo(() => {
    const projection = projectCanvasDocumentForSearch(document);
    return {
      index: createCanvasSearchIndex(projection.objects),
      objectTypes: [...new Set(projection.objects.map((object) => object.objectType))].sort(),
    };
  }, [document]);
  const canvasSearchActive =
    canvasSearchText.trim().length > 0 ||
    canvasSearchObjectType.length > 0 ||
    canvasSearchFrameId.length > 0;
  const canvasSearchResults = React.useMemo(
    () =>
      canvasSearchActive
        ? currentCanvasSearch.index.query({
            text: canvasSearchText.trim() || undefined,
            objectType: canvasSearchObjectType || undefined,
            frameId: canvasSearchFrameId || undefined,
            limit: 20,
          })
        : [],
    [
      canvasSearchActive,
      canvasSearchFrameId,
      canvasSearchObjectType,
      canvasSearchText,
      currentCanvasSearch.index,
    ],
  );
  const focusCurrentCanvasSearchResult = (result: CanvasSearchResult) => {
    const current = documentRef.current;
    const block = blockById(current, result.object.id);
    if (block) {
      pendingSearchFocusBlockId.current = block.id;
      setSelected(createCanvasSelection([block.id]));
    } else {
      pendingSearchFocusBlockId.current = null;
      setSelected(clearCanvasSelection);
      workspaceRef.current?.focus();
    }
    if (current.layoutMode === 'edgeless') {
      setCamera(cameraForFocusTarget(result.focus, CAMERA_VIEWPORT, 120));
    }
  };
  const selectedBlocks = selected.ids.flatMap((blockId) => {
    const block = blockById(document, blockId);
    return block ? [block] : [];
  });
  const selectedBlock = selectedBlocks.length === 1 ? selectedBlocks[0] : undefined;
  const selectedBlockIsPresentationFrame = selectedBlock
    ? document.presentationOrder.includes(selectedBlock.id)
    : false;
  const activePresentationFrame =
    presentation.status === 'presenting' && presentation.currentIndex >= 0
      ? presentation.frames[presentation.currentIndex]
      : undefined;
  const activePresentationBlock = activePresentationFrame
    ? blockById(document, activePresentationFrame.id)
    : undefined;
  const activePresentationMindMap =
    activePresentationBlock?.content.kind === 'mind-map'
      ? activePresentationBlock.content.map
      : undefined;
  const activePresentationMindMapRoot = activePresentationMindMap?.nodes.find(
    (node) => node.id === activePresentationMindMap.rootId,
  );
  const activePresentationProgress = presentationProgress(presentation);
  const zoomAnnouncement = canvasZoomAnnouncement(camera.zoom);
  const toggleSelectedPresentationFrame = () => {
    if (!selectedBlock) return;
    const blockId = selectedBlock.id;
    const alreadyIncluded = document.presentationOrder.includes(blockId);
    commit(
      'block-change',
      alreadyIncluded ? 'Remove presentation frame' : 'Add presentation frame',
      (current, now) => {
        const nextOrder = current.presentationOrder.includes(blockId)
          ? current.presentationOrder.filter((entry) => entry !== blockId)
          : [...current.presentationOrder, blockId];
        return withPresentationOrder(current, nextOrder, now);
      },
    );
  };
  const reorderPresentationFrame = (blockId: string, toIndex: number) => {
    commit('block-change', 'Reorder presentation frame', (current, now) => {
      const fromIndex = current.presentationOrder.findIndex((entry) => entry === blockId);
      if (
        fromIndex < 0 ||
        !Number.isInteger(toIndex) ||
        toIndex < 0 ||
        toIndex >= current.presentationOrder.length ||
        fromIndex === toIndex
      ) {
        return current;
      }
      const reordered = moveFrame(presentationFromDocument(current), blockId, toIndex);
      return withPresentationOrder(
        current,
        reordered.frames.map((frame) => frame.id),
        now,
      );
    });
  };
  const updatePresentationNotes = (blockId: string, notes: string) => {
    if (presenterNotesForFrame(documentRef.current, blockId) === notes) return;
    commit('block-change', 'Edit presenter notes', (current, now) =>
      withPresentationNote(current, blockId, notes, now),
    );
  };
  const zoomToPresentationFrame = (blockId: string) => {
    const current = documentRef.current;
    if (current.layoutMode !== 'edgeless') return;
    const frameIndex = current.presentationOrder.findIndex((entry) => entry === blockId);
    if (frameIndex < 0) return;
    const visiblePlacements = [...resolveEdgelessLayout(current).values()].filter(
      (placement) => !placement.hidden,
    );
    const target = frameZoomTarget(
      presentationFromDocument(current),
      frameIndex,
      visiblePlacements,
      CAMERA_VIEWPORT,
      120,
    );
    if (!target) return;
    setSelected(createCanvasSelection([blockId]));
    setCamera(target);
  };
  const placementById = resolveEdgelessLayout(document);
  const selectedPlacement = selectedBlock ? placementById.get(selectedBlock.id) : undefined;
  const selectedObjectsLocked = selectionHasLockedPlacement(document, selected.ids);
  const minimap = React.useMemo(() => {
    const placements = [...resolveEdgelessLayout(document).values()].filter(
      (placement) => !placement.hidden,
    );
    const viewportBounds = {
      x: camera.x - CAMERA_VIEWPORT.width / camera.zoom / 2,
      y: camera.y - CAMERA_VIEWPORT.height / camera.zoom / 2,
      width: CAMERA_VIEWPORT.width / camera.zoom,
      height: CAMERA_VIEWPORT.height / camera.zoom,
    };
    const bounds = [...placements, viewportBounds];
    const left = Math.min(...bounds.map((item) => item.x));
    const top = Math.min(...bounds.map((item) => item.y));
    const right = Math.max(...bounds.map((item) => item.x + item.width));
    const bottom = Math.max(...bounds.map((item) => item.y + item.height));
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const rectangle = (item: { x: number; y: number; width: number; height: number }) => ({
      left: `${((item.x - left) / width) * 100}%`,
      top: `${((item.y - top) / height) * 100}%`,
      width: `${Math.max(2, (item.width / width) * 100)}%`,
      height: `${Math.max(2, (item.height / height) * 100)}%`,
    });
    return {
      placements: placements.map((placement) => ({
        blockId: placement.blockId,
        rectangle: rectangle(placement),
      })),
      viewport: rectangle(viewportBounds),
    };
  }, [camera, document]);
  const goBack = () => {
    restoreCameraLocation(cameraNavigator.current.back());
  };
  const goForward = () => {
    restoreCameraLocation(cameraNavigator.current.forward());
  };
  const visibleEdgelessBlockIds = React.useMemo(() => {
    const index = createCanvasSpatialIndex();
    for (const placement of resolveEdgelessLayout(document).values()) {
      if (placement.hidden) continue;
      index.upsert(placement);
    }
    return new Set(
      index.queryViewport(camera, CAMERA_VIEWPORT).map((placement) => placement.blockId),
    );
  }, [camera, document]);
  const visibleEdgelessBlocks = blocks.filter((block) => visibleEdgelessBlockIds.has(block.id));
  const renderBlockEditor = (block: CanvasBlock) => {
    const content = block.content;
    if (content.kind === 'mind-map') {
      const root = content.map.nodes.find((node) => node.id === content.map.rootId);
      const nodesById = new Map(content.map.nodes.map((node) => [node.id, node]));
      const rootChildren = root
        ? root.childIds.flatMap((nodeId) => {
            const node = nodesById.get(nodeId);
            return node ? [node] : [];
          })
        : [];
      return (
        <section
          aria-label={`Mind map: ${root?.label ?? 'Untitled'}`}
          data-mind-map-id={content.map.id}
          className="space-y-2"
        >
          {root ? (
            <button
              type="button"
              aria-label={`Mind map node: ${root.label}`}
              data-mind-map-node-id={root.id}
              onKeyDown={(event) => navigateMindMapNode(event, content.map, root.id)}
              className="text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {root.label}
            </button>
          ) : (
            <p className="text-sm font-medium">Untitled</p>
          )}
          <button
            type="button"
            aria-label={`Add child to ${root?.label ?? 'Untitled'}`}
            onClick={(event) => {
              event.stopPropagation();
              addMindMapChildToRoot(block.id);
            }}
            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Add child
          </button>
          <button
            type="button"
            aria-label={`${root?.collapsed ? 'Expand' : 'Collapse'} ${root?.label ?? 'Untitled'}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleMindMapRootCollapsed(block.id);
            }}
            className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {root?.collapsed ? 'Expand' : 'Collapse'}
          </button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Direction
            <select
              aria-label="Mind map direction"
              value={content.map.direction}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => changeMindMapDirection(block.id, event.currentTarget.value)}
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="right">Right</option>
              <option value="left">Left</option>
              <option value="both">Both</option>
              <option value="down">Down</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Connector
            <select
              aria-label="Mind map connector style"
              value={content.map.connectorStyle}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => changeMindMapConnectorStyle(block.id, event.currentTarget.value)}
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              <option value="curved">Curved</option>
              <option value="elbow">Elbow</option>
              <option value="straight">Straight</option>
            </select>
          </label>
          {root ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Root shape
              <select
                aria-label="Mind map root shape"
                value={root.style.shape}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => changeMindMapRootShape(block.id, event.currentTarget.value)}
                className="rounded border border-border bg-background px-2 py-1 text-foreground"
              >
                <option value="rounded">Rounded</option>
                <option value="pill">Pill</option>
                <option value="card">Card</option>
              </select>
            </label>
          ) : null}
          {root?.collapsed ? null : (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {rootChildren.map((node, index) => (
                <li key={node.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Mind map node: ${node.label}`}
                    data-mind-map-node-id={node.id}
                    onKeyDown={(event) => navigateMindMapNode(event, content.map, node.id)}
                    className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {node.label}
                  </button>
                  <button
                    type="button"
                    aria-label={`Add sibling to ${node.label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      addMindMapSibling(block.id, node.id);
                    }}
                    className="rounded border border-border px-2 py-1 text-xs"
                  >
                    Add sibling
                  </button>
                  {index > 0 ? (
                    <button
                      type="button"
                      aria-label={`Move ${node.label} before ${rootChildren[index - 1]?.label ?? 'previous branch'}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        moveMindMapBranchEarlier(block.id, node.id);
                      }}
                      className="rounded border border-border px-2 py-1 text-xs"
                    >
                      Move up
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    }
    if (content.kind === 'shape') {
      return (
        <div
          role="img"
          aria-label={`Canvas shape: ${canvasBlockAccessibleLabel(block)}`}
          data-shape-kind={content.shape.kind}
          data-shape-fill={content.shape.fill?.color ?? ''}
          className="flex h-full min-h-20 w-full items-center justify-center p-6 text-center text-sm font-medium"
          style={shapeVisualStyle(content.shape)}
        >
          <span>{content.shape.text ?? 'Unlabeled shape'}</span>
        </div>
      );
    }
    return (
      <textarea
        aria-label={`Edit ${content.kind} block`}
        value={content.text}
        rows={content.kind === 'heading' ? 1 : content.kind === 'code' ? 6 : 3}
        spellCheck={content.kind !== 'code'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => updateBlockText(block.id, event.currentTarget.value)}
        className={[
          'h-full min-h-8 w-full resize-none bg-transparent text-sm outline-none',
          content.kind === 'heading' ? 'text-lg font-semibold' : '',
          content.kind === 'code' ? 'font-mono text-xs' : '',
        ].join(' ')}
      />
    );
  };

  return (
    <div
      data-monochrome-route="canvas"
      data-sakura-route="canvas"
      data-sakura-intensity="quiet"
      className="mc7d-canvas flex h-full min-h-0 w-full flex-col bg-background text-foreground"
    >
      <header
        data-monochrome-surface="canvas-header"
        data-sakura-surface="canvas-header"
        className="flex min-h-14 items-center gap-3 border-b border-border bg-background px-4 [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
      >
        <div className="min-w-0 flex-1">
          <h1 className="sr-only">Infinite Idea Canvas</h1>
          <input
            aria-label="Canvas title"
            value={document.title}
            onChange={(event) => {
              const title = event.currentTarget.value;
              commit(
                'text-change',
                'Rename canvas',
                (current, now) => withTitle(current, title, now),
                'canvas:title',
              );
            }}
            className="w-full max-w-sm truncate rounded border border-transparent bg-transparent px-2 py-1 font-medium outline-none hover:border-border focus:border-ring"
          />
          <p className="px-2 text-xs text-muted-foreground">
            {activeScope ? PERSISTENCE_LABELS[persistenceStatus] : 'Local draft'}
          </p>
        </div>

        <div
          data-monochrome-surface="canvas-layout-switcher"
          data-sakura-surface="canvas-layout-switcher"
          className="inline-flex rounded-md border border-border p-1 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-mono"
          aria-label="Canvas layout"
        >
          {(['page', 'edgeless'] as const).map((layout) => (
            <button
              key={layout}
              type="button"
              aria-label={`${layout === 'page' ? 'Page' : 'Edgeless'} layout`}
              aria-pressed={document.layoutMode === layout}
              data-monochrome-state={document.layoutMode === layout ? 'selected' : 'idle'}
              onClick={() => setLayout(layout)}
              className={[
                'rounded px-3 py-1 text-xs font-medium capitalize transition-colors [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:transition-none',
                document.layoutMode === layout
                  ? 'bg-foreground text-background [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-accent-cyan'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {layout}
            </button>
          ))}
        </div>
        <details className="relative">
          <summary className="inline-flex h-9 cursor-pointer list-none items-center rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            Templates
          </summary>
          <div
            role="group"
            aria-label="Canvas template manager"
            aria-busy={templatePersistenceBusy}
            data-monochrome-surface="canvas-templates"
            data-sakura-surface="canvas-templates"
            className="absolute right-0 top-11 z-50 max-h-[70vh] w-[32rem] space-y-4 overflow-auto rounded-lg border border-border bg-background p-4 shadow-lg [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <p role="status" aria-label="Custom template persistence status" className="sr-only">
              {templatePersistenceBusy ? 'Updating custom templates' : 'Custom templates ready'}
            </p>
            <section aria-labelledby="built-in-template-heading" className="space-y-2">
              <h2 id="built-in-template-heading" className="text-sm font-semibold">
                Built-in templates
              </h2>
              <div className="flex items-end gap-2">
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  Template
                  <select
                    aria-label="Built-in canvas template"
                    value={selectedBuiltInTemplate.id}
                    onChange={(event) => setSelectedBuiltInTemplateId(event.currentTarget.value)}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                  >
                    {builtInTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  aria-label={`Create canvas from ${selectedBuiltInTemplate.title}`}
                  onClick={() => createFromBuiltInTemplate(selectedBuiltInTemplate)}
                  className="rounded-md bg-foreground px-3 py-2 text-xs font-medium text-background"
                >
                  Use template
                </button>
              </div>
              <section
                role="region"
                aria-label="Built-in template preview"
                className="rounded-md border border-border bg-muted/20 p-3"
              >
                <p className="text-sm font-medium">{selectedBuiltInTemplate.title}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedBuiltInTemplate.layoutMode} · {selectedBuiltInTemplate.blocks.length}{' '}
                  {selectedBuiltInTemplate.blocks.length === 1 ? 'object' : 'objects'}
                </p>
                {selectedBuiltInTemplate.blocks.length > 0 ? (
                  <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
                    {selectedBuiltInTemplate.blocks.slice(0, 5).map((block, index) => (
                      <li key={`${selectedBuiltInTemplate.id}:${index}`}>
                        {block.mindMapLabel ?? templateContentLabel(block.content)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Empty starting canvas</p>
                )}
              </section>
            </section>

            <section aria-labelledby="custom-template-heading" className="space-y-2">
              <h2 id="custom-template-heading" className="text-sm font-semibold">
                Custom templates
              </h2>
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCurrentCanvasTemplate();
                }}
              >
                <label className="flex-1 space-y-1 text-xs text-muted-foreground">
                  Name
                  <input
                    aria-label="Custom template name"
                    value={customTemplateName}
                    onChange={(event) => setCustomTemplateName(event.currentTarget.value)}
                    placeholder={document.title}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                  />
                </label>
                <button
                  type="submit"
                  aria-label="Save current canvas as template"
                  disabled={templatePersistenceBusy}
                  className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-muted"
                >
                  Save current
                </button>
              </form>
              <ul aria-label="Custom canvas templates" className="space-y-3">
                {scopedCustomTemplates.length === 0 ? (
                  <li className="text-xs text-muted-foreground">No custom templates yet.</li>
                ) : (
                  scopedCustomTemplates.map((template) => (
                    <li key={template.id} className="space-y-2 rounded-md border border-border p-3">
                      <p className="text-sm font-medium">{template.title}</p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          aria-label={`Create canvas from ${template.title}`}
                          disabled={templatePersistenceBusy}
                          onClick={() => createFromCustomTemplate(template.id, template.title)}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Use
                        </button>
                        <button
                          type="button"
                          aria-label={`Preview template ${template.title}`}
                          aria-pressed={previewedTemplateId === template.id}
                          onClick={() =>
                            setPreviewedTemplateId((current) =>
                              current === template.id ? null : template.id,
                            )
                          }
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Preview
                        </button>
                        <button
                          type="button"
                          aria-label={`Duplicate template ${template.title}`}
                          disabled={templatePersistenceBusy}
                          onClick={() => void duplicateTemplate(template.id, template.title)}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Duplicate
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete template ${template.title}`}
                          disabled={templatePersistenceBusy}
                          onClick={() => void removeCustomTemplate(template.id, template.title)}
                          className="rounded border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                        >
                          Delete
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <input
                          aria-label={`Rename template ${template.title}`}
                          value={templateRenameDrafts[template.id] ?? template.title}
                          onChange={(event) => {
                            const title = event.currentTarget.value;
                            setTemplateRenameDrafts((current) => ({
                              ...current,
                              [template.id]: title,
                            }));
                          }}
                          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          aria-label={`Apply template name ${template.title}`}
                          disabled={templatePersistenceBusy}
                          onClick={() => void applyTemplateRename(template.id, template.title)}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Rename
                        </button>
                      </div>
                      {customTemplatePreview?.id === template.id ? (
                        <section
                          role="region"
                          aria-label={`Template preview ${template.title}`}
                          className="rounded border border-border bg-muted/20 p-2"
                        >
                          <p className="text-xs text-muted-foreground">
                            {customTemplatePreview.layoutMode} · {customTemplatePreview.blockCount}{' '}
                            {customTemplatePreview.blockCount === 1 ? 'object' : 'objects'}
                          </p>
                          {customTemplatePreview.blocks.length > 0 ? (
                            <ul className="mt-1 list-inside list-disc text-xs">
                              {customTemplatePreview.blocks.map((content, index) => (
                                <li key={`${template.id}:preview:${index}`}>
                                  {templateContentLabel(content)}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-xs text-muted-foreground">Empty template</p>
                          )}
                        </section>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            </section>
          </div>
        </details>
        <details className="relative">
          <summary
            aria-label="Search current canvas"
            className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Search aria-hidden size={15} />
            Search
          </summary>
          <div
            role="search"
            aria-label="Current canvas search"
            data-monochrome-surface="canvas-search"
            data-sakura-surface="canvas-search"
            className="absolute right-0 top-11 z-50 w-96 space-y-3 rounded-lg border border-border bg-background p-3 shadow-lg [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <input
              type="search"
              aria-label="Canvas search text"
              value={canvasSearchText}
              maxLength={CANVAS_SEARCH_LIMITS.maxQueryTextLength}
              onChange={(event) => setCanvasSearchText(event.currentTarget.value)}
              placeholder="Search this canvas"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                Object type
                <select
                  aria-label="Canvas search object type"
                  value={canvasSearchObjectType}
                  onChange={(event) => setCanvasSearchObjectType(event.currentTarget.value)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  <option value="">All object types</option>
                  {currentCanvasSearch.objectTypes.map((objectType) => (
                    <option key={objectType} value={objectType}>
                      {objectType}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Presentation frame
                <select
                  aria-label="Canvas search presentation frame"
                  value={canvasSearchFrameId}
                  onChange={(event) => setCanvasSearchFrameId(event.currentTarget.value)}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                >
                  <option value="">All frames</option>
                  {document.presentationOrder.map((frameId) => (
                    <option key={frameId} value={frameId}>
                      {presentationFrameLabel(blockById(document, frameId))}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {canvasSearchActive ? (
              canvasSearchResults.length > 0 ? (
                <ul
                  aria-label="Current canvas search results"
                  className="max-h-64 space-y-1 overflow-auto"
                >
                  {canvasSearchResults.map((result) => {
                    const label = currentCanvasSearchResultLabel(result);
                    return (
                      <li key={result.object.id}>
                        <button
                          type="button"
                          aria-label={`Focus search result ${label}`}
                          onClick={() => focusCurrentCanvasSearchResult(result)}
                          className="flex w-full items-center justify-between gap-3 rounded-md border border-transparent px-2 py-2 text-left text-sm hover:border-border hover:bg-muted"
                        >
                          <span className="min-w-0 truncate">{label}</span>
                          <span className="shrink-0 text-xs capitalize text-muted-foreground">
                            {result.object.objectType}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No matching canvas objects.</p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                Enter text or choose a filter to search this canvas.
              </p>
            )}
          </div>
        </details>
        <details className="relative">
          <summary className="inline-flex h-9 cursor-pointer list-none items-center rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            Presentation order
          </summary>
          <div
            role="group"
            aria-label="Presentation organizer"
            data-monochrome-surface="canvas-frames"
            data-sakura-surface="canvas-frames"
            className="absolute right-0 top-11 z-50 w-80 space-y-2 rounded-lg border border-border bg-background p-3 shadow-lg [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <p className="text-xs text-muted-foreground">
              Drag frames into position or use the move controls.
            </p>
            {document.presentationOrder.length === 0 ? (
              <p className="text-sm text-muted-foreground">No presentation frames yet.</p>
            ) : (
              <ol aria-label="Canvas presentation order" className="space-y-2">
                {document.presentationOrder.map((frameId, index) => {
                  const label = presentationFrameLabel(blockById(document, frameId));
                  const placement = placementById.get(frameId);
                  const canZoom = document.layoutMode === 'edgeless' && placement?.hidden === false;
                  const notes = presenterNotesForFrame(document, frameId);
                  return (
                    <li
                      key={`${frameId}:${notes}`}
                      aria-label={`Presentation frame ${index + 1}: ${label}`}
                      draggable
                      onDragStart={(event) => {
                        presentationDragFrameRef.current = frameId;
                        if (event.dataTransfer) {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', frameId);
                        }
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const draggedId = presentationDragFrameRef.current;
                        presentationDragFrameRef.current = null;
                        if (draggedId) reorderPresentationFrame(draggedId, index);
                      }}
                      onDragEnd={() => {
                        presentationDragFrameRef.current = null;
                      }}
                      data-monochrome-surface="canvas-frame"
                      className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-2 rounded-md border border-border bg-muted/20 p-2 [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-background"
                    >
                      <span aria-hidden className="cursor-grab text-muted-foreground">
                        ⋮⋮
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {index + 1}. {label}
                      </span>
                      <button
                        type="button"
                        aria-label={`Zoom to ${label}`}
                        disabled={!canZoom}
                        onClick={() => zoomToPresentationFrame(frameId)}
                        className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                      >
                        Focus
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${label} earlier`}
                        disabled={index === 0}
                        onClick={() => reorderPresentationFrame(frameId, index - 1)}
                        className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${label} later`}
                        disabled={index === document.presentationOrder.length - 1}
                        onClick={() => reorderPresentationFrame(frameId, index + 1)}
                        className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
                      >
                        ↓
                      </button>
                      <textarea
                        aria-label={`Presenter notes for ${label}`}
                        defaultValue={notes}
                        maxLength={CANVAS_MAX_TEXT_LENGTH}
                        rows={2}
                        onBlur={(event) =>
                          updatePresentationNotes(frameId, event.currentTarget.value)
                        }
                        className="col-span-5 w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs"
                        placeholder="Presenter notes"
                      />
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </details>
        <button
          type="button"
          aria-label="Canvas wallpapers"
          aria-haspopup="dialog"
          aria-expanded={wallpaperPickerOpen}
          onClick={() => setWallpaperPickerOpen(true)}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Wallpaper aria-hidden size={17} />
          <span>Wallpapers</span>
        </button>
        <button
          ref={presentationTriggerRef}
          type="button"
          aria-label="Present canvas"
          disabled={document.presentationOrder.length === 0}
          onClick={startPresentation}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Play aria-hidden size={15} />
          Present
        </button>
        <label
          title="Import canvas package"
          className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Upload aria-hidden size={17} />
          <input
            aria-label="Import canvas package"
            type="file"
            accept=".json,.vibespace-canvas.json,application/json"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void importPackage(file);
            }}
          />
        </label>
        <button
          type="button"
          aria-label="Export canvas package"
          onClick={exportPackage}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Download aria-hidden size={17} />
        </button>
        <label
          title="Import Markdown document"
          className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FileUp aria-hidden size={17} />
          <input
            aria-label="Import Markdown document"
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void importMarkdown(file);
            }}
          />
        </label>
        <button
          type="button"
          aria-label="Export Markdown document"
          onClick={exportMarkdown}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FileDown aria-hidden size={17} />
        </button>
        <details className="relative">
          <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            <FileDown aria-hidden size={17} />
            <span>Visual exports</span>
          </summary>
          <div
            role="group"
            aria-label="Visual export settings"
            data-monochrome-surface="canvas-export"
            data-sakura-surface="canvas-export"
            className="absolute right-0 top-11 z-50 w-64 space-y-3 rounded-lg border border-border bg-background p-3 shadow-lg [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">Format</span>
              <select
                aria-label="Canvas visual export format"
                value={visualExportFormat}
                onChange={(event) => {
                  const format = event.currentTarget.value as CanvasVisualExportFormat;
                  setVisualExportFormat(format);
                  if (format === 'presentation-pdf') setVisualExportScope('all');
                }}
                className="w-full rounded border border-border bg-background px-2 py-1"
              >
                <option value="png">PNG image</option>
                <option value="svg">SVG document</option>
                <option value="pdf">PDF document</option>
                <option value="presentation-pdf" disabled={document.presentationOrder.length === 0}>
                  Presentation PDF
                </option>
              </select>
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">Content</span>
              <select
                aria-label="Canvas export scope"
                value={visualExportScope}
                disabled={visualExportFormat === 'presentation-pdf'}
                onChange={(event) =>
                  setVisualExportScope(event.currentTarget.value as CanvasVisualExportScope)
                }
                className="w-full rounded border border-border bg-background px-2 py-1 disabled:opacity-50"
              >
                <option value="all">Whole canvas</option>
                <option value="selection" disabled={selected.ids.length === 0}>
                  Selected objects
                </option>
                <option value="frame" disabled={!selectedBlockIsPresentationFrame}>
                  Selected presentation frame
                </option>
              </select>
            </label>
            <label className="block space-y-1 text-xs">
              <span className="text-muted-foreground">Resolution</span>
              <select
                aria-label="Canvas export scale"
                value={visualExportScale}
                disabled={visualExportFormat === 'pdf' || visualExportFormat === 'presentation-pdf'}
                onChange={(event) => setVisualExportScale(Number(event.currentTarget.value))}
                className="w-full rounded border border-border bg-background px-2 py-1 disabled:opacity-50"
              >
                <option value={1}>1280 x 720 (1x)</option>
                <option value={2}>2560 x 1440 (2x)</option>
                <option value={3}>3840 x 2160 (3x)</option>
                <option value={4}>5120 x 2880 (4x)</option>
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Uses the current canvas background color.
            </p>
            <button
              type="button"
              aria-label="Download canvas export"
              disabled={
                (visualExportFormat === 'presentation-pdf' &&
                  document.presentationOrder.length === 0) ||
                (visualExportFormat !== 'presentation-pdf' &&
                  visualExportScope === 'selection' &&
                  selected.ids.length === 0) ||
                (visualExportFormat !== 'presentation-pdf' &&
                  visualExportScope === 'frame' &&
                  !selectedBlockIsPresentationFrame)
              }
              onClick={exportVisualDocument}
              className="inline-flex w-full items-center justify-center gap-2 rounded bg-foreground px-3 py-2 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download aria-hidden size={15} />
              Download {VISUAL_EXPORT_LABELS[visualExportFormat]}
            </button>
          </div>
        </details>
        <button
          type="button"
          aria-label={outlineOpen ? 'Hide canvas outline' : 'Show canvas outline'}
          aria-expanded={outlineOpen}
          aria-controls="canvas-object-outline"
          onClick={() => {
            setOutlineOpen((current) => !current);
            setPropertiesOpen(false);
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ListTree aria-hidden size={17} />
        </button>
        <button
          type="button"
          aria-label={propertiesOpen ? 'Hide canvas properties' : 'Show canvas properties'}
          aria-expanded={propertiesOpen}
          aria-controls="canvas-properties-panel"
          onClick={() => {
            setPropertiesOpen((current) => !current);
            setOutlineOpen(false);
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Settings2 aria-hidden size={17} />
        </button>
      </header>
      {recoveryOffer ? (
        <section
          aria-label="Canvas recovery"
          className="flex items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm"
        >
          <p>Unsaved canvas recovery is available.</p>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="Restore recovered canvas"
              onClick={restoreRecovery}
              className="rounded bg-foreground px-3 py-1 text-background"
            >
              Restore
            </button>
            <button
              type="button"
              aria-label="Discard recovered canvas"
              onClick={() => void discardRecovery()}
              className="rounded border border-border px-3 py-1"
            >
              Discard
            </button>
          </div>
        </section>
      ) : null}
      <p className="sr-only" role="status" aria-live="polite">
        {packageMessage}
      </p>
      <output
        role="status"
        aria-label="Canvas zoom announcement"
        aria-live={zoomAnnouncement.politeness}
        className="sr-only"
      >
        {zoomAnnouncement.message}
      </output>
      <output
        role="status"
        aria-label="Canvas snapping status"
        aria-live="polite"
        className="sr-only"
      >
        {snapGuides.length === 0
          ? ''
          : snapGuides.some((guide) => guide.source === 'object')
            ? 'Aligned to canvas object'
            : 'Aligned to canvas grid'}
      </output>

      {presentation.status === 'presenting' ? (
        <section
          ref={presentationRegionRef}
          role="region"
          aria-label="Canvas presentation"
          tabIndex={-1}
          data-monochrome-surface="canvas-presentation"
          className="flex min-h-0 flex-1 flex-col bg-foreground p-6 text-background"
        >
          <header className="flex items-center justify-between gap-4">
            <output
              role="status"
              aria-label="Presentation progress"
              className="text-sm tabular-nums text-background/75"
            >
              Slide {activePresentationProgress.current} of {activePresentationProgress.total}
            </output>
            <div className="flex items-center gap-2">
              {activePresentationFrame?.notes ? (
                <button
                  type="button"
                  aria-label={showPresenterNotes ? 'Hide presenter notes' : 'Show presenter notes'}
                  aria-pressed={showPresenterNotes}
                  onClick={() => setShowPresenterNotes((visible) => !visible)}
                  className="rounded-md border border-background/30 px-3 py-2 text-sm hover:bg-background/10"
                >
                  Notes
                </button>
              ) : null}
              {canEnterFullscreen(presentation) ? (
                <button
                  type="button"
                  aria-label={
                    presentationFullscreen
                      ? 'Exit presentation fullscreen'
                      : 'Enter presentation fullscreen'
                  }
                  onClick={() => void togglePresentationFullscreen()}
                  className="rounded-md border border-background/30 px-3 py-2 text-sm hover:bg-background/10"
                >
                  {presentationFullscreen ? 'Windowed' : 'Fullscreen'}
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Exit presentation"
                onClick={exitPresentation}
                className="rounded-md border border-background/30 px-3 py-2 text-sm hover:bg-background/10"
              >
                Exit
              </button>
            </div>
          </header>
          <output aria-live="polite" className="sr-only">
            {presentationFullscreenMessage}
          </output>
          <div className="flex min-h-0 flex-1 items-center justify-center py-8">
            <article className="max-h-full w-full max-w-5xl overflow-auto rounded-2xl bg-background p-10 text-foreground shadow-2xl">
              {activePresentationBlock ? (
                activePresentationBlock.content.kind === 'mind-map' ? (
                  <div className="space-y-4">
                    <h2 className="text-3xl font-semibold">
                      {activePresentationMindMapRoot?.label ?? 'Untitled mind map'}
                    </h2>
                    <p className="text-muted-foreground">
                      {activePresentationMindMap?.nodes.length ?? 0} mind-map nodes
                    </p>
                  </div>
                ) : activePresentationBlock.content.kind === 'shape' ? (
                  <div
                    role="img"
                    aria-label={`Canvas shape: ${canvasBlockAccessibleLabel(activePresentationBlock)}`}
                    data-shape-kind={activePresentationBlock.content.shape.kind}
                    data-shape-fill={activePresentationBlock.content.shape.fill?.color ?? ''}
                    className="mx-auto flex min-h-80 w-full max-w-3xl items-center justify-center p-12 text-center text-3xl font-semibold"
                    style={shapeVisualStyle(activePresentationBlock.content.shape)}
                  >
                    {activePresentationBlock.content.shape.text ?? 'Unlabeled shape'}
                  </div>
                ) : activePresentationBlock.content.kind === 'code' ? (
                  <div className="space-y-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {activePresentationBlock.content.language}
                    </p>
                    <pre className="whitespace-pre-wrap font-mono text-base">
                      {activePresentationBlock.content.text}
                    </pre>
                  </div>
                ) : activePresentationBlock.content.kind === 'heading' ? (
                  <h2 className="text-4xl font-semibold">{activePresentationBlock.content.text}</h2>
                ) : (
                  <p className="whitespace-pre-wrap text-2xl leading-relaxed">
                    {activePresentationBlock.content.text}
                  </p>
                )
              ) : (
                <p className="text-muted-foreground">Presentation frame unavailable.</p>
              )}
            </article>
          </div>
          {showPresenterNotes && activePresentationFrame?.notes ? (
            <aside
              role="note"
              aria-label="Presenter notes"
              className="mx-auto mb-4 w-full max-w-5xl whitespace-pre-wrap rounded-lg border border-background/30 bg-background/10 p-4 text-sm text-background"
            >
              {activePresentationFrame.notes}
            </aside>
          ) : null}
          <footer className="flex items-center justify-center gap-3">
            <button
              type="button"
              aria-label="Previous presentation frame"
              disabled={activePresentationProgress.isFirst}
              onClick={() => setPresentation((current) => previousFrame(current))}
              className="rounded-md border border-background/30 px-4 py-2 text-sm hover:bg-background/10 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              aria-label="Next presentation frame"
              disabled={activePresentationProgress.isLast}
              onClick={() => setPresentation((current) => nextFrame(current))}
              className="rounded-md border border-background/30 px-4 py-2 text-sm hover:bg-background/10 disabled:opacity-40"
            >
              Next
            </button>
          </footer>
        </section>
      ) : null}

      <div hidden={presentation.status === 'presenting'} className="flex min-h-0 flex-1">
        <aside
          data-monochrome-surface="canvas-tool-rail"
          data-sakura-surface="canvas-tool-rail"
          className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-background py-3 [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:shadow-none"
        >
          <div
            role="toolbar"
            aria-label="Canvas tools"
            className="flex flex-col gap-2"
            data-monochrome-state={tool}
          >
            <ToolButton
              active={tool === 'select'}
              label="Select tool"
              onClick={() => setTool('select')}
            >
              <MousePointer2 aria-hidden size={17} />
            </ToolButton>
            <ToolButton
              active={tool === 'lasso'}
              label="Lasso tool"
              onClick={() => setTool('lasso')}
            >
              <LassoSelect aria-hidden size={17} />
            </ToolButton>
            <ToolButton active={tool === 'hand'} label="Hand tool" onClick={() => setTool('hand')}>
              <Hand aria-hidden size={17} />
            </ToolButton>
            <ToolButton active={tool === 'note'} label="Note tool" onClick={() => setTool('note')}>
              <StickyNote aria-hidden size={17} />
            </ToolButton>
          </div>
          <div className="my-1 h-px w-7 bg-border" />
          <button
            type="button"
            aria-label="Add note"
            onClick={addNote}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-foreground text-background hover:opacity-90"
          >
            <Plus aria-hidden size={18} />
          </button>
          <button
            type="button"
            aria-label="Add text"
            onClick={() => addBlock('text')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Type aria-hidden size={17} />
          </button>
          <button
            type="button"
            aria-label="Add heading"
            onClick={() => addBlock('heading')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Heading aria-hidden size={17} />
          </button>
          <button
            type="button"
            aria-label="Add code block"
            onClick={() => addBlock('code')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Code2 aria-hidden size={17} />
          </button>
          <button
            type="button"
            aria-label="Add mind map"
            onClick={addMindMap}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ListTree aria-hidden size={17} />
          </button>
          <button
            type="button"
            aria-label="Add shape"
            onClick={addShape}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Square aria-hidden size={17} />
          </button>
        </aside>

        <main
          ref={workspaceRef}
          role="region"
          aria-label="Canvas workspace"
          data-monochrome-surface="canvas-workspace"
          data-sakura-content="canvas-workspace"
          data-monochrome-state={`${document.layoutMode}:${selected.ids.length > 0 ? 'selected' : 'idle'}`}
          data-layout={document.layoutMode}
          data-camera-x={camera.x}
          data-camera-y={camera.y}
          data-camera-zoom={camera.zoom}
          data-background-kind={document.background.kind}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onWheel={onWheel}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSelected(clearCanvasSelection);
            }
          }}
          className="relative isolate min-h-0 flex-1 overflow-auto bg-muted/20 [html[data-theme=monochrome]_&]:border-y [html[data-theme=monochrome]_&]:border-border"
          style={{
            ...canvasBackgroundStyle(document.background),
            cursor: document.layoutMode === 'edgeless' && tool === 'hand' ? 'grab' : undefined,
            touchAction: document.layoutMode === 'edgeless' ? 'none' : undefined,
          }}
        >
          <WallpaperHost config={document.background.wallpaper} />
          {blocks.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center p-8">
              <div
                data-monochrome-surface="canvas-empty-state"
                data-sakura-surface="canvas-empty-state"
                className="max-w-sm rounded-xl border border-dashed border-border bg-background/90 p-8 text-center shadow-sm [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-solid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
              >
                <StickyNote aria-hidden className="mx-auto mb-3 text-muted-foreground" />
                <h2 className="font-medium">Start with an idea</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add a note, then arrange the same content in page or edgeless mode.
                </p>
                <button
                  type="button"
                  onClick={addNote}
                  className="mt-4 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background"
                >
                  Add first note
                </button>
              </div>
            </div>
          ) : document.layoutMode === 'page' ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-8">
              {blocks.map((block) => (
                <article
                  key={block.id}
                  ref={(element) => {
                    if (element) {
                      blockElements.current.set(block.id, element);
                    } else {
                      blockElements.current.delete(block.id);
                    }
                  }}
                  aria-label={`Canvas ${block.content.kind}`}
                  aria-description={canvasBlockAccessibleLabel(block)}
                  aria-current={selectionHas(selected, block.id) ? 'true' : undefined}
                  data-selected={selectionHas(selected, block.id)}
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelected((current) =>
                      selectCanvasBlock(
                        current,
                        block.id,
                        event.shiftKey || event.ctrlKey || event.metaKey,
                      ),
                    );
                  }}
                  className={[
                    'rounded-lg border border-border bg-background p-4 shadow-sm outline-none',
                    selectionHas(selected, block.id)
                      ? 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                      : 'focus-visible:ring-2 focus-visible:ring-ring',
                  ].join(' ')}
                >
                  {renderBlockEditor(block)}
                </article>
              ))}
            </div>
          ) : (
            <div
              className="relative min-h-full min-w-full"
              style={{
                width: CAMERA_VIEWPORT.width,
                height: CAMERA_VIEWPORT.height,
                transform: `translate(${CAMERA_VIEWPORT.width / 2 - camera.x * camera.zoom}px, ${
                  CAMERA_VIEWPORT.height / 2 - camera.y * camera.zoom
                }px) scale(${camera.zoom})`,
                transformOrigin: '0 0',
              }}
            >
              {visibleEdgelessBlocks.map((block) => {
                const placement = placementById.get(block.id);
                return (
                  <article
                    key={block.id}
                    ref={(element) => {
                      if (element) {
                        blockElements.current.set(block.id, element);
                      } else {
                        blockElements.current.delete(block.id);
                      }
                    }}
                    aria-label={`Canvas ${block.content.kind}`}
                    aria-description={canvasBlockAccessibleLabel(block)}
                    aria-current={selectionHas(selected, block.id) ? 'true' : undefined}
                    data-selected={selectionHas(selected, block.id)}
                    data-locked={placement?.locked}
                    tabIndex={0}
                    onPointerDown={(event) => onObjectPointerDown(event, block.id)}
                    onPointerMove={onObjectPointerMove}
                    onPointerUp={onObjectPointerEnd}
                    onPointerCancel={onObjectPointerEnd}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (suppressObjectClick.current) {
                        suppressObjectClick.current = false;
                        return;
                      }
                      setSelected((current) =>
                        selectCanvasBlock(
                          current,
                          block.id,
                          event.shiftKey || event.ctrlKey || event.metaKey,
                        ),
                      );
                    }}
                    className={[
                      'absolute overflow-auto rounded-lg border border-border bg-background p-4 shadow-sm outline-none',
                      selectionHas(selected, block.id)
                        ? 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                        : 'focus-visible:ring-2 focus-visible:ring-ring',
                    ].join(' ')}
                    style={{
                      left: placement?.x ?? 0,
                      top: placement?.y ?? 0,
                      width: placement?.width ?? 280,
                      height: placement?.height ?? 180,
                      transform: `rotate(${placement?.rotation ?? 0}deg)`,
                      zIndex: (placement?.z ?? 0) + 1_000_000,
                    }}
                  >
                    <fieldset disabled={placement?.locked} className="contents">
                      {renderBlockEditor(block)}
                    </fieldset>
                  </article>
                );
              })}
              {selected.ids.length === 1 &&
              selectedPlacement &&
              !selectedPlacement.locked &&
              !selectedPlacement.hidden ? (
                <div
                  ref={geometryOverlayRef}
                  data-selection-geometry
                  role="group"
                  aria-label="Selected object resize and rotation handles"
                  data-monochrome-surface="canvas-selection"
                  data-sakura-surface="canvas-selection"
                  className="pointer-events-none absolute border border-ring [html[data-theme=monochrome]_&]:border-2"
                  style={{
                    left: selectedPlacement.x,
                    top: selectedPlacement.y,
                    width: selectedPlacement.width,
                    height: selectedPlacement.height,
                    transform: `rotate(${selectedPlacement.rotation}deg)`,
                    zIndex: selectedPlacement.z + 1_500_000,
                  }}
                >
                  {CANVAS_RESIZE_HANDLES.map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      aria-label={`Resize selected object from ${handle}`}
                      title={`Drag to resize from ${handle}`}
                      onPointerDown={(event) => beginDirectResize(event, selectedPlacement, handle)}
                      onPointerMove={onDirectGeometryPointerMove}
                      onPointerUp={onDirectGeometryPointerEnd}
                      onPointerCancel={onDirectGeometryPointerEnd}
                      onKeyDown={(event) => onResizeHandleKeyDown(event, selectedPlacement, handle)}
                      className="pointer-events-auto absolute h-3 w-3 rounded-sm border border-ring bg-background shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:shadow-none"
                      style={CANVAS_RESIZE_HANDLE_STYLES[handle]}
                    />
                  ))}
                  <button
                    type="button"
                    aria-label="Rotate selected object"
                    title="Drag to rotate"
                    onPointerDown={(event) => beginDirectRotation(event, selectedPlacement)}
                    onPointerMove={onDirectGeometryPointerMove}
                    onPointerUp={onDirectGeometryPointerEnd}
                    onPointerCancel={onDirectGeometryPointerEnd}
                    onKeyDown={(event) => onRotateHandleKeyDown(event, selectedPlacement)}
                    className="pointer-events-auto absolute -top-9 left-1/2 h-4 w-4 -translate-x-1/2 rounded-full border border-ring bg-background shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:shadow-none"
                    style={{ cursor: 'grab' }}
                  />
                </div>
              ) : null}
              {snapGuides.map((guide, index) => (
                <div
                  key={`${guide.axis}-${guide.position}-${guide.source}-${guide.targetId ?? 'grid'}-${index}`}
                  data-smart-guide-axis={guide.axis}
                  data-smart-guide-source={guide.source}
                  aria-hidden
                  className="pointer-events-none absolute bg-sky-500"
                  style={
                    guide.axis === 'x'
                      ? {
                          left: guide.position,
                          top: guide.start,
                          width: 1 / camera.zoom,
                          height: Math.max(1, guide.end - guide.start),
                          zIndex: 2_000_000,
                        }
                      : {
                          left: guide.start,
                          top: guide.position,
                          width: Math.max(1, guide.end - guide.start),
                          height: 1 / camera.zoom,
                          zIndex: 2_000_000,
                        }
                  }
                />
              ))}
            </div>
          )}

          {marqueeVisual ? (
            <div
              data-selection-marquee
              aria-hidden
              className="pointer-events-none absolute border border-ring bg-ring/10"
              style={{
                left: Math.min(marqueeVisual.start.x, marqueeVisual.end.x),
                top: Math.min(marqueeVisual.start.y, marqueeVisual.end.y),
                width: Math.abs(marqueeVisual.end.x - marqueeVisual.start.x),
                height: Math.abs(marqueeVisual.end.y - marqueeVisual.start.y),
              }}
            />
          ) : null}

          {lassoVisual && lassoVisual.length > 1 ? (
            <svg
              data-selection-lasso
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-ring"
            >
              <polygon
                points={lassoVisual.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="currentColor"
                fillOpacity={0.1}
                stroke="currentColor"
                strokeWidth={1}
              />
            </svg>
          ) : null}

          {document.layoutMode === 'edgeless' ? (
            <section
              role="region"
              aria-label="Canvas minimap"
              data-monochrome-surface="canvas-minimap"
              data-sakura-surface="canvas-minimap"
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
              className="absolute bottom-4 right-4 h-28 w-44 overflow-hidden rounded-lg border border-border bg-background/95 p-2 shadow-sm [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
            >
              <div className="relative h-full w-full overflow-hidden rounded bg-muted/50">
                {minimap.placements.map((item) => (
                  <button
                    key={item.blockId}
                    type="button"
                    aria-label={`Focus ${item.blockId} from minimap`}
                    onClick={() => {
                      const placement = placementById.get(item.blockId);
                      if (placement) {
                        setCamera(fitWorldBounds(placement, CAMERA_VIEWPORT, 120));
                      }
                    }}
                    className="absolute min-h-1 min-w-1 rounded-sm bg-foreground/55 hover:bg-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    style={item.rectangle}
                  />
                ))}
                <div
                  aria-hidden
                  className="pointer-events-none absolute border border-ring bg-ring/10"
                  style={minimap.viewport}
                />
              </div>
            </section>
          ) : null}

          <div
            data-monochrome-surface="canvas-control-dock"
            data-sakura-surface="canvas-control-dock"
            className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-sm [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:shadow-none"
          >
            {document.layoutMode === 'edgeless' ? (
              <>
                <button
                  type="button"
                  aria-label="Object snapping"
                  aria-pressed={objectSnapping}
                  title="Snap dragged objects to nearby edges and centers"
                  onClick={() => setObjectSnapping((current) => !current)}
                  className={[
                    'rounded px-2 py-1.5 text-xs font-medium',
                    objectSnapping
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  ].join(' ')}
                >
                  Objects
                </button>
                <button
                  type="button"
                  aria-label="Grid snapping"
                  aria-pressed={gridSnapping}
                  title={`Snap dragged objects to the ${CANVAS_GRID_SIZE}-pixel world grid`}
                  onClick={() => setGridSnapping((current) => !current)}
                  className={[
                    'rounded px-2 py-1.5 text-xs font-medium',
                    gridSnapping
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  ].join(' ')}
                >
                  Grid
                </button>
                <span aria-hidden className="mx-1 h-5 w-px bg-border" />
              </>
            ) : null}
            <button
              type="button"
              aria-label="Undo"
              disabled={!historyRef.current.canUndo()}
              onClick={undo}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Undo2 aria-hidden size={16} />
            </button>
            <button
              type="button"
              aria-label="Redo"
              disabled={!historyRef.current.canRedo()}
              onClick={redo}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Redo2 aria-hidden size={16} />
            </button>
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            <button
              type="button"
              aria-label="Back to previous canvas location"
              disabled={!cameraNavigator.current.canGoBack()}
              onClick={goBack}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft aria-hidden size={16} />
            </button>
            <button
              type="button"
              aria-label="Forward to next canvas location"
              disabled={!cameraNavigator.current.canGoForward()}
              onClick={goForward}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight aria-hidden size={16} />
            </button>
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            <output
              role="status"
              aria-label="Current canvas tool"
              className="min-w-12 px-1 text-center text-xs text-muted-foreground"
            >
              {CANVAS_TOOL_LABELS[tool]}
            </output>
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            <output
              role="status"
              aria-label="Presentation frame count"
              className="min-w-12 px-1 text-center text-xs text-muted-foreground"
            >
              {document.presentationOrder.length}{' '}
              {document.presentationOrder.length === 1 ? 'slide' : 'slides'}
            </output>
            <span aria-hidden className="mx-1 h-5 w-px bg-border" />
            <output aria-live="polite" className="sr-only">
              {selected.ids.length === 0
                ? 'No canvas objects selected'
                : `${selected.ids.length} canvas object${selected.ids.length === 1 ? '' : 's'} selected`}
            </output>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => setZoom(0.8)}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Minus aria-hidden size={16} />
            </button>
            <output aria-label="Current zoom" className="min-w-12 text-center text-xs tabular-nums">
              {cameraZoomPercent(camera)}%
            </output>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => setZoom(1.25)}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Plus aria-hidden size={16} />
            </button>
            <button
              type="button"
              aria-label="Fit content"
              onClick={fitContent}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Maximize2 aria-hidden size={16} />
            </button>
            <button
              type="button"
              aria-label="Reset view"
              onClick={() => setCamera(resetCamera())}
              className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RotateCcw aria-hidden size={16} />
            </button>
          </div>
        </main>
        {outlineOpen ? (
          <aside
            id="canvas-object-outline"
            aria-label="Canvas outline panel"
            data-monochrome-surface="canvas-outline"
            data-sakura-surface="canvas-outline"
            className="w-72 shrink-0 overflow-auto border-l border-border bg-background [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              Canvas outline
            </div>
            <CanvasOutline
              document={document}
              selectedIds={selected.ids}
              onActivate={(blockId) => setSelected(selectCanvasBlock(selected, blockId))}
            />
          </aside>
        ) : null}
        {propertiesOpen ? (
          <aside
            id="canvas-properties-panel"
            role="region"
            aria-label="Canvas properties panel"
            data-monochrome-surface="canvas-inspector"
            data-sakura-surface="canvas-inspector"
            data-monochrome-state={
              selected.ids.length === 0
                ? 'canvas'
                : selected.ids.length === 1
                  ? 'single'
                  : 'multiple'
            }
            className="w-72 shrink-0 overflow-auto border-l border-border bg-background [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none"
          >
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              Properties
            </div>
            <div className="space-y-4 p-3">
              <section aria-label="Canvas background properties" className="space-y-3">
                <h2 className="text-sm font-medium">Canvas background</h2>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  Pattern
                  <select
                    aria-label="Canvas background pattern"
                    value={document.background.kind}
                    onChange={(event) =>
                      setBackgroundKind(event.currentTarget.value as CanvasBackgroundKind)
                    }
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                  >
                    {Object.entries(CANVAS_BACKGROUND_LABELS).map(([kind, label]) => (
                      <option key={kind} value={kind}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-xs text-muted-foreground">
                  Color
                  <input
                    aria-label="Canvas background color"
                    type="color"
                    value={document.background.color}
                    onChange={(event) => setBackgroundColor(event.currentTarget.value)}
                    className="h-9 w-full cursor-pointer rounded-md border border-border bg-background p-1"
                  />
                </label>
              </section>
              <div className="h-px bg-border" />
              {selectedBlocks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Select a canvas object to inspect its properties.
                </p>
              ) : selectedBlock ? (
                <>
                  <h2 className="text-sm font-medium">
                    {CANVAS_BLOCK_KIND_LABELS[selectedBlock.content.kind]} properties
                  </h2>
                  {selectedBlock.content.kind === 'mind-map' ? (
                    <p className="text-sm text-muted-foreground">
                      Mind-map direction, connector, and node controls are available on the object.
                    </p>
                  ) : selectedBlock.content.kind === 'shape' ? (
                    <div className="space-y-3">
                      <label className="block space-y-1 text-xs text-muted-foreground">
                        Shape
                        <select
                          aria-label="Shape kind"
                          value={selectedBlock.content.shape.kind}
                          disabled={selectedPlacement?.locked}
                          onChange={(event) =>
                            updateShape(selectedBlock.id, {
                              kind: event.currentTarget.value as CanvasShapeKind,
                            })
                          }
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                        >
                          {CANVAS_SHAPE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind.replaceAll('-', ' ')}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block space-y-1 text-xs text-muted-foreground">
                        Label
                        <textarea
                          aria-label="Shape label"
                          value={selectedBlock.content.shape.text ?? ''}
                          rows={3}
                          disabled={selectedPlacement?.locked}
                          onChange={(event) =>
                            updateShape(selectedBlock.id, { text: event.currentTarget.value })
                          }
                          className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-ring"
                        />
                      </label>
                      <label className="block space-y-1 text-xs text-muted-foreground">
                        Fill
                        <input
                          aria-label="Shape fill color"
                          type="color"
                          value={selectedBlock.content.shape.fill?.color ?? '#f2c94c'}
                          disabled={selectedPlacement?.locked}
                          onChange={(event) =>
                            updateShape(selectedBlock.id, {
                              fill: { kind: 'solid', color: event.currentTarget.value },
                            })
                          }
                          className="h-9 w-full cursor-pointer rounded-md border border-border bg-background p-1"
                        />
                      </label>
                    </div>
                  ) : (
                    <label className="block space-y-1 text-xs text-muted-foreground">
                      Content
                      <textarea
                        aria-label="Selected block text"
                        value={selectedBlock.content.text}
                        rows={5}
                        disabled={selectedPlacement?.locked}
                        spellCheck={selectedBlock.content.kind !== 'code'}
                        onChange={(event) =>
                          updateBlockText(selectedBlock.id, event.currentTarget.value)
                        }
                        className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-ring"
                      />
                    </label>
                  )}
                  {selectedBlock.content.kind === 'heading' ? (
                    <label className="block space-y-1 text-xs text-muted-foreground">
                      Heading level
                      <select
                        aria-label="Heading level"
                        value={selectedBlock.content.level}
                        disabled={selectedPlacement?.locked}
                        onChange={(event) =>
                          updateHeadingLevel(
                            selectedBlock.id,
                            Number.parseInt(event.currentTarget.value, 10),
                          )
                        }
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                      >
                        {[1, 2, 3, 4, 5, 6].map((level) => (
                          <option key={level} value={level}>
                            Heading {level}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {selectedBlock.content.kind === 'code' ? (
                    <div className="block space-y-1 text-xs text-muted-foreground">
                      Language
                      <output
                        aria-label="Code language"
                        className="block w-full rounded-md border border-border bg-muted/20 px-2 py-1.5 text-sm text-foreground"
                      >
                        {selectedBlock.content.language}
                      </output>
                    </div>
                  ) : null}
                  {document.layoutMode === 'edgeless' && selectedPlacement ? (
                    <section
                      aria-label="Selected object availability"
                      className="grid grid-cols-2 gap-2"
                    >
                      <button
                        type="button"
                        aria-label={
                          selectedPlacement.locked
                            ? 'Unlock selected object'
                            : 'Lock selected object'
                        }
                        aria-pressed={selectedPlacement.locked}
                        onClick={() => toggleSelectedPlacementState('locked')}
                        className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
                      >
                        {selectedPlacement.locked ? 'Unlock' : 'Lock'}
                      </button>
                      <button
                        type="button"
                        aria-label={
                          selectedPlacement.hidden ? 'Show selected object' : 'Hide selected object'
                        }
                        aria-pressed={selectedPlacement.hidden}
                        onClick={() => toggleSelectedPlacementState('hidden')}
                        className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
                      >
                        {selectedPlacement.hidden ? 'Show' : 'Hide'}
                      </button>
                    </section>
                  ) : null}
                  {document.layoutMode === 'edgeless' && selectedPlacement ? (
                    <section aria-label="Selected object transform" className="space-y-2">
                      <h3 className="text-xs font-medium text-muted-foreground">Transform</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {(['x', 'y', 'width', 'height', 'rotation'] as const).map((field) => (
                          <label
                            key={field}
                            className={[
                              'space-y-1 text-xs text-muted-foreground',
                              field === 'rotation' ? 'col-span-2' : '',
                            ].join(' ')}
                          >
                            {CANVAS_PLACEMENT_FIELD_LABELS[field]}
                            <input
                              type="number"
                              aria-label={CANVAS_PLACEMENT_ARIA_LABELS[field]}
                              value={selectedPlacement[field]}
                              min={
                                field === 'width' || field === 'height'
                                  ? 16
                                  : field === 'rotation'
                                    ? -360
                                    : -CANVAS_POSITION_LIMIT
                              }
                              max={
                                field === 'width' || field === 'height'
                                  ? CANVAS_SIZE_LIMIT
                                  : field === 'rotation'
                                    ? 360
                                    : CANVAS_POSITION_LIMIT
                              }
                              step={1}
                              disabled={selectedPlacement.locked}
                              onChange={(event) =>
                                updateSelectedPlacementField(field, event.currentTarget.value)
                              }
                              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                            />
                          </label>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {document.layoutMode === 'edgeless' ? (
                    <section aria-label="Selected object order" className="space-y-2">
                      <h3 className="text-xs font-medium text-muted-foreground">Object order</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {(Object.keys(CANVAS_Z_ORDER_LABELS) as CanvasZOrderCommand[]).map(
                          (command) => (
                            <button
                              key={command}
                              type="button"
                              aria-label={CANVAS_Z_ORDER_ARIA_LABELS[command]}
                              disabled={selectedPlacement?.locked}
                              onClick={() => reorderSelected(command)}
                              className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
                            >
                              {CANVAS_Z_ORDER_LABELS[command]}
                            </button>
                          ),
                        )}
                      </div>
                    </section>
                  ) : null}
                  <button
                    type="button"
                    aria-label={
                      selectedBlockIsPresentationFrame
                        ? 'Remove selected object from presentation'
                        : 'Add selected object to presentation'
                    }
                    onClick={toggleSelectedPresentationFrame}
                    className="w-full rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                  >
                    {selectedBlockIsPresentationFrame
                      ? 'Remove from presentation'
                      : 'Add to presentation'}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete selected object"
                    disabled={selectedPlacement?.locked}
                    onClick={deleteSelected}
                    className="w-full rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                  >
                    Delete object
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium">{selectedBlocks.length} objects selected</p>
                  <p className="text-sm text-muted-foreground">
                    Shared actions apply to the complete selection.
                  </p>
                  {document.layoutMode === 'edgeless' ? (
                    <section aria-label="Selected object geometry" className="space-y-3">
                      <div className="space-y-2">
                        <h3 className="text-xs font-medium text-muted-foreground">Alignment</h3>
                        <div className="grid grid-cols-2 gap-2">
                          {(Object.keys(CANVAS_ALIGNMENT_LABELS) as CanvasAlignment[]).map(
                            (alignment) => (
                              <button
                                key={alignment}
                                type="button"
                                aria-label={`Align selected objects to ${CANVAS_ALIGNMENT_LABELS[
                                  alignment
                                ].toLowerCase()}`}
                                disabled={selectedObjectsLocked}
                                onClick={() => alignSelected(alignment)}
                                className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
                              >
                                {CANVAS_ALIGNMENT_LABELS[alignment]}
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                      {selectedBlocks.length >= 3 ? (
                        <div className="space-y-2">
                          <h3 className="text-xs font-medium text-muted-foreground">
                            Distribution
                          </h3>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              aria-label="Distribute selected objects horizontally"
                              disabled={selectedObjectsLocked}
                              onClick={() => distributeSelected('horizontal')}
                              className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
                            >
                              Horizontal
                            </button>
                            <button
                              type="button"
                              aria-label="Distribute selected objects vertically"
                              disabled={selectedObjectsLocked}
                              onClick={() => distributeSelected('vertical')}
                              className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-muted"
                            >
                              Vertical
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                  <button
                    type="button"
                    aria-label="Delete selected objects"
                    disabled={selectedObjectsLocked}
                    onClick={deleteSelected}
                    className="w-full rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
                  >
                    Delete selected objects
                  </button>
                </>
              )}
            </div>
          </aside>
        ) : null}
      </div>
      <WallpaperPicker
        open={wallpaperPickerOpen}
        onClose={() => setWallpaperPickerOpen(false)}
        config={document.background.wallpaper}
        onSetWallpaper={setCanvasWallpaper}
        onConfigureWallpaper={configureCanvasWallpaper}
        persistCustomVideo
      />
    </div>
  );
}
