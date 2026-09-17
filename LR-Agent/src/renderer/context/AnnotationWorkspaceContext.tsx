import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useApp } from './AppContext';
import { useAnnotation } from './AnnotationContext';
import { useWorkMode } from './WorkModeContext';
import {
  parseFileAnnotationDocument,
  FILE_ANNOTATION_SCHEMA_VERSION,
  type AnnotationInstance,
  type BboxAnnotation,
  type CaptionAnnotation,
  type ClassificationAnnotation,
  type FileAnnotationDocument,
  type ImagePointAnnotation,
  type PolygonAnnotation,
  type PoseAnnotation,
  type RotatedBboxAnnotation,
  type SpanAnnotation,
  type TextClassificationAnnotation,
  type InstructionAnnotation,
  type PreferenceAnnotation,
  type ConversationAnnotation,
  type CotAnnotation,
} from '../types/annotationDocument';
import {
  DEFAULT_KEYPOINT_TEMPLATE_ID,
  getKeypointTemplate,
  resolveLabelIdForTemplate,
  type KeypointTemplate,
} from '../types/keypointTemplate';
import {
  buildInitialPoseSceneGeometry,
  sceneGeometryToPoseAnn,
  type ScenePoint,
} from '../components/annotation/fabric/fabricKeypointCoords';
import {
  readFileAnnotationDoc,
  writeFileAnnotationDoc,
} from '../services/annotationDataService';
import { mergeProposalChangesIntoDoc } from '../services/annotationMutationApply';
import { decideCanvasAfterExternalApply } from '../services/annotationCanvasSync';
import type {
  AnnotationBatchChange,
  AnnotationBatchProposal,
} from '../../shared/annotationAgentTypes';
import { buildFileChangesFromProposal } from '../components/agent/agentAnnotationPreview';
import { updateAnnotationWorkspaceAgentSnapshot } from '../services/annotationAgentBridge';
import { syncWorkspaceFactMemory } from '../services/workspaceFactMemory';
import {
  bumpLabelUsage,
  loadLabelUsage,
  pruneLabelUsage,
  saveLabelUsage,
  type LabelUsageMap,
} from '../utils/annotationLabelUsage';
import { getRelativeProjectPath, normalizeFsPath } from '../utils/projectPaths';
import {
  AnnotationHistory,
  type AnnotationHistorySnapshot,
} from '../utils/annotationHistory';

const DEBOUNCE_MS = 450;

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

const TEXT_EXT = new Set(['txt', 'md', 'json', 'jsonl']);

function getExtensionLower(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function workspacesMatch(rootPath: string | null, projectDir: string): boolean {
  if (!rootPath) return false;
  return (
    normalizeFsPath(rootPath).toLowerCase() ===
    normalizeFsPath(projectDir).toLowerCase()
  );
}

function isBBoxInstance(a: AnnotationInstance): a is BboxAnnotation {
  return a.kind === 'bbox';
}

function isRotatedBBoxInstance(
  a: AnnotationInstance,
): a is RotatedBboxAnnotation {
  return a.kind === 'rotated_bbox';
}

function isPolygonInstance(a: AnnotationInstance): a is PolygonAnnotation {
  return a.kind === 'polygon';
}

function isPoseInstance(a: AnnotationInstance): a is PoseAnnotation {
  return a.kind === 'pose';
}

function isImagePointInstance(
  a: AnnotationInstance,
): a is ImagePointAnnotation {
  return a.kind === 'point';
}

function isCaptionInstance(a: AnnotationInstance): a is CaptionAnnotation {
  return a.kind === 'caption';
}

function isClassificationInstance(
  a: AnnotationInstance,
): a is ClassificationAnnotation {
  return a.kind === 'classification';
}

function isSpanInstance(a: AnnotationInstance): a is SpanAnnotation {
  return a.kind === 'span_ner';
}

function isTextClassificationInstance(
  a: AnnotationInstance,
): a is TextClassificationAnnotation {
  return a.kind === 'text_classification';
}

function isInstructionInstance(
  a: AnnotationInstance,
): a is InstructionAnnotation {
  return a.kind === 'instruction';
}

function isPreferenceInstance(
  a: AnnotationInstance,
): a is PreferenceAnnotation {
  return a.kind === 'preference';
}

function isConversationInstance(
  a: AnnotationInstance,
): a is ConversationAnnotation {
  return a.kind === 'conversation';
}

function isCotInstance(a: AnnotationInstance): a is CotAnnotation {
  return a.kind === 'cot';
}

type DocMeta = Omit<FileAnnotationDocument, 'annotations'>;

export type AgentPreviewSession = {
  relativePath: string;
  annotations: AnnotationInstance[];
  proposalAnchorId?: string;
};

export type PendingAgentNavigation = {
  relativePath: string;
  annotationId: string;
  proposalAnchorId?: string;
  pendingChanges?: AnnotationBatchChange[];
  mode: 'preview' | 'select';
};

export type ImmediateAnnotationPreviewParams = {
  relativePath: string;
  annotationId: string;
  proposal: AnnotationBatchProposal;
  proposalAnchorId?: string;
};

function isSyntheticAnnotationRelativePath(path: string): boolean {
  return path.replace(/^[/\\]+/, '').startsWith('_synthetic_/');
}

function isAgentPreviewPathMatch(
  sessionRelativePath: string,
  workspaceRelativePath: string | null,
): boolean {
  if (sessionRelativePath === workspaceRelativePath) return true;
  if (
    !workspaceRelativePath &&
    isSyntheticAnnotationRelativePath(sessionRelativePath)
  ) {
    return true;
  }
  return false;
}

function shouldUseSelectToolForProject(
  project: { modality: string; annotationType: string } | null | undefined,
): boolean {
  if (!project || project.modality !== 'image') return false;
  return (
    project.annotationType === 'bbox' ||
    project.annotationType === 'rotated_bbox' ||
    project.annotationType === 'polygon' ||
    project.annotationType === 'keypoint'
  );
}

export type ImageCanvasTool =
  | 'draw'
  | 'select'
  | 'polygon'
  | 'place_pose'
  | 'place_point'
  | 'preannot_sam_box'
  | 'preannot_roi_box'
  | 'caption_edit'
  | 'classify_select';

export interface AnnotationWorkspaceContextValue {
  workspaceEnabled: boolean;
  annotationPanelVisible: boolean;
  projectRootMatched: boolean;
  relativeFilePath: string | null;
  annotations: AnnotationInstance[];
  bboxAnnotations: BboxAnnotation[];
  rotatedBboxAnnotations: RotatedBboxAnnotation[];
  polygonAnnotations: PolygonAnnotation[];
  poseAnnotations: PoseAnnotation[];
  pointAnnotations: ImagePointAnnotation[];
  captionAnnotations: CaptionAnnotation[];
  classificationAnnotations: ClassificationAnnotation[];
  // 文本标注过滤器
  spanAnnotations: SpanAnnotation[];
  textClassificationAnnotations: TextClassificationAnnotation[];
  instructionAnnotations: InstructionAnnotation[];
  preferenceAnnotations: PreferenceAnnotation[];
  conversationAnnotations: ConversationAnnotation[];
  cotAnnotations: CotAnnotation[];
  imageAnnotationType:
    | 'bbox'
    | 'rotated_bbox'
    | 'polygon'
    | 'keypoint'
    | 'caption'
    | 'classification'
    | null;
  textAnnotationType:
    | 'span_ner'
    | 'text_classification'
    | 'instruction'
    | 'preference'
    | 'conversation'
    | 'cot'
    | null;
  /** 当前文本文件的完整内容，供 NER 等编辑器使用 */
  textContent: string | null;
  /** 文本内容是否正在加载 */
  textContentLoading: boolean;
  /** LLM 类型在无文件选中时是否处于自由标注模式 */
  freeformMode: boolean;
  activeTemplateId: string;
  setActiveTemplateId: (id: string) => void;
  activeTemplate: KeypointTemplate;
  selectedAnnotationId: string | null;
  tool: ImageCanvasTool;
  setTool: (tool: ImageCanvasTool) => void;
  activeLabelId: string | null;
  setActiveLabelId: (id: string | null) => void;
  labelUsage: LabelUsageMap;
  selectAnnotation: (id: string | null) => void;
  agentPreviewSession: AgentPreviewSession | null;
  agentPreviewReadOnly: boolean;
  enterAgentPreview: (session: AgentPreviewSession) => void;
  clearAgentPreview: () => void;
  schedulePendingAgentNavigation: (nav: PendingAgentNavigation) => void;
  applyImmediateAnnotationPreview: (
    params: ImmediateAnnotationPreviewParams,
  ) => boolean;
  loadSyntheticAnnotationForView: (
    relativePath: string,
    annotationId: string,
  ) => Promise<void>;
  // 文本标注操作方法
  /** NER: 在文本上新增 span 标注 */
  addSpanAnnotation: (
    start: number,
    end: number,
    labelId: string,
  ) => string | null;
  /** NER: 更新 span 区间 */
  updateSpanAnnotation: (id: string, start: number, end: number) => void;
  /** 文本分类: 新增一个分类标注（支持多标签） */
  addTextClassificationAnnotation: (
    labelId: string,
    note?: string,
  ) => string | null;
  /** 文本分类: 更新分类标签 */
  updateTextClassificationAnnotation: (
    id: string,
    labelId: string,
    note?: string,
  ) => void;
  /** 指令: 新增指令数据 */
  addInstructionAnnotation: (params: {
    instruction: string;
    input?: string;
    output: string;
    labelId?: string | null;
  }) => string | null;
  /** 指令: 更新指令数据 */
  updateInstructionAnnotation: (
    id: string,
    params: {
      instruction?: string;
      input?: string;
      output?: string;
    },
  ) => void;
  /** 偏好: 新增偏好数据 */
  addPreferenceAnnotation: (params: {
    prompt: string;
    chosen: string;
    rejected: string;
    preferenceNote?: string;
    labelId?: string | null;
  }) => string | null;
  /** 偏好: 更新偏好数据 */
  updatePreferenceAnnotation: (
    id: string,
    params: {
      prompt?: string;
      chosen?: string;
      rejected?: string;
      preferenceNote?: string;
    },
  ) => void;
  /** 对话: 新增对话数据 */
  addConversationAnnotation: (params: {
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
    labelId?: string | null;
  }) => string | null;
  /** 对话: 更新对话数据（替换全部 turns） */
  updateConversationAnnotation: (
    id: string,
    turns: Array<{
      role: 'user' | 'assistant';
      content: string;
    }>,
  ) => void;
  /** CoT: 新增思维链数据 */
  addCotAnnotation: (params: {
    instruction?: string;
    input?: string;
    steps: Array<{ description: string; conclusion: string }>;
    answer: string;
    labelId?: string | null;
  }) => string | null;
  /** CoT: 更新思维链数据 */
  updateCotAnnotation: (
    id: string,
    params: {
      instruction?: string;
      input?: string;
      steps?: Array<{ description: string; conclusion: string }>;
      answer?: string;
    },
  ) => void;
  // 图片标注操作方法（保留不变）
  addBboxAnnotation: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => boolean;
  addRotatedBboxAnnotation: (rect: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    angle: number;
  }) => boolean;
  addPolygonAnnotation: (points: { x: number; y: number }[]) => boolean;
  addPoseAnnotation: (
    templateId: string,
    centerScene: ScenePoint,
    naturalWidth: number,
    naturalHeight: number,
  ) => string | null;
  addPointAnnotation: (x: number, y: number, labelId: string) => string | null;
  addCaptionAnnotation: (params: {
    text: string;
    granularity: 'brief' | 'detailed' | 'dense';
    language?: string;
    labelId?: string | null;
  }) => string | null;
  updateCaptionAnnotation: (
    id: string,
    params: {
      text: string;
      granularity?: 'brief' | 'detailed' | 'dense';
      language?: string;
    },
  ) => void;
  addClassificationAnnotation: (labelId: string) => string | null;
  updateClassificationAnnotation: (id: string, labelId: string) => void;
  addPreAnnotBboxes: (
    items: Array<{
      labelId?: string | null;
      x: number;
      y: number;
      width: number;
      height: number;
    }>,
  ) => number;
  addPreAnnotRotatedBboxes: (
    items: Array<{
      labelId?: string | null;
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
    }>,
  ) => number;
  addPreAnnotPolygon: (
    points: { x: number; y: number }[],
    labelId?: string,
  ) => boolean;
  addPreAnnotPoses: (
    items: Array<{
      labelId: string;
      templateId: string;
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
      keypoints: { x: number; y: number; visibility: 0 | 1 | 2 }[];
    }>,
  ) => number;
  clearPreAnnots: () => number;
  updatePoseGeometry: (id: string, ann: PoseAnnotation) => void;
  updatePointGeometry: (id: string, x: number, y: number) => void;
  updateKeypointVisibility: (
    poseId: string,
    index: number,
    visibility: 0 | 1 | 2,
  ) => void;
  updateBboxGeometry: (
    id: string,
    patch: Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'>,
  ) => void;
  updateRotatedBboxGeometry: (
    id: string,
    patch: Pick<
      RotatedBboxAnnotation,
      'cx' | 'cy' | 'width' | 'height' | 'angle'
    >,
  ) => void;
  updatePolygonGeometry: (
    id: string,
    points: { x: number; y: number }[],
  ) => void;
  deleteAnnotation: (id: string) => void;
  updateAnnotationLabel: (id: string, labelId: string) => void;
  reportImageNaturalSize: (width: number, height: number) => void;
  dirty: boolean;
  saving: boolean;
  loadError: string | null;
  sourceStale: boolean;
  saveNow: () => Promise<void>;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  beginHistoryBatch: () => void;
  endHistoryBatch: () => void;
  /** Polygon draft undo runs before workspace undo (Ctrl+Z). */
  setLocalUndoHandler: (handler: (() => boolean) | null) => void;
}

const AnnotationWorkspaceContext =
  createContext<AnnotationWorkspaceContextValue | null>(null);

function emptyDocMeta(
  proj: {
    id: string;
    modality: FileAnnotationDocument['modality'];
    annotationType: FileAnnotationDocument['annotationType'];
  },
  relPath: string,
  stats: { mtimeMs: number; size: number } | null | undefined,
): DocMeta {
  const now = new Date().toISOString();
  return {
    schemaVersion: FILE_ANNOTATION_SCHEMA_VERSION,
    projectId: proj.id,
    filePath: relPath,
    modality: proj.modality,
    annotationType: proj.annotationType,
    source:
      stats && stats.size !== undefined
        ? {
            width: 1,
            height: 1,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
          }
        : { width: 1, height: 1 },
    updatedAt: now,
  };
}

async function statsForPath(
  filePath: string | null | undefined,
): Promise<{ mtimeMs: number; size: number } | null> {
  if (!filePath) return null;
  const s = await window.electron.fileSystem?.getFileStats(filePath);
  if (!s || s.isDirectory) return null;
  return { mtimeMs: s.mtime.getTime(), size: s.size };
}

export function AnnotationWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { activeFilePath, rootPath } = useApp();
  const { activeProject } = useAnnotation();
  const { workMode } = useWorkMode();
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const annotationPanelVisible = Boolean(
    workMode === 'annotation' && activeProject,
  );

  const projectRootMatched = useMemo(() => {
    if (!activeProject || !annotationPanelVisible) return false;
    return workspacesMatch(rootPath, activeProject.directoryPath);
  }, [activeProject, annotationPanelVisible, rootPath]);

  const imageAnnotationType =
    activeProject?.modality === 'image' &&
    (activeProject.annotationType === 'bbox' ||
      activeProject.annotationType === 'rotated_bbox' ||
      activeProject.annotationType === 'polygon' ||
      activeProject.annotationType === 'keypoint' ||
      activeProject.annotationType === 'caption' ||
      activeProject.annotationType === 'classification')
      ? activeProject.annotationType
      : null;

  const textAnnotationType =
    activeProject?.modality === 'text' &&
    (activeProject.annotationType === 'span_ner' ||
      activeProject.annotationType === 'text_classification' ||
      activeProject.annotationType === 'instruction' ||
      activeProject.annotationType === 'preference' ||
      activeProject.annotationType === 'conversation' ||
      activeProject.annotationType === 'cot')
      ? activeProject.annotationType
      : null;

  const isTextLLMType = Boolean(
    textAnnotationType &&
    (textAnnotationType === 'instruction' ||
      textAnnotationType === 'preference' ||
      textAnnotationType === 'conversation' ||
      textAnnotationType === 'cot'),
  );

  const workspaceEnabled = Boolean(
    projectRootMatched &&
    activeProject &&
    ((imageAnnotationType &&
      activeFilePath &&
      IMAGE_EXT.has(getExtensionLower(activeFilePath))) ||
      (textAnnotationType &&
        (isTextLLMType ||
          (activeFilePath &&
            TEXT_EXT.has(getExtensionLower(activeFilePath)))))),
  );

  /** LLM 类型在无文件选中时也可以工作 */
  const freeformMode = Boolean(
    workspaceEnabled && isTextLLMType && !activeFilePath,
  );

  const relativeFilePath = useMemo(() => {
    if (
      !workspaceEnabled ||
      !activeProject ||
      !activeFilePath ||
      !projectRootMatched
    ) {
      return null;
    }
    return getRelativeProjectPath(activeProject.directoryPath, activeFilePath);
  }, [workspaceEnabled, activeProject, activeFilePath, projectRootMatched]);

  const [annotations, setAnnotations] = useState<AnnotationInstance[]>([]);
  const [loadedDocMeta, setLoadedDocMeta] = useState<DocMeta | null>(null);
  const [agentPreviewSession, setAgentPreviewSession] =
    useState<AgentPreviewSession | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<
    string | null
  >(null);
  const [tool, setToolState] = useState<ImageCanvasTool>('draw');
  const [activeTemplateId, setActiveTemplateIdState] = useState(
    DEFAULT_KEYPOINT_TEMPLATE_ID,
  );
  const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
  const [labelUsage, setLabelUsage] = useState<LabelUsageMap>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceStale, setSourceStale] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textContentLoading, setTextContentLoading] = useState(false);

  const annotationsRef = useRef(annotations);
  const dirtyRef = useRef(dirty);
  const loadedMetaRef = useRef<DocMeta | null>(null);
  const selectedIdRef = useRef(selectedAnnotationId);
  const agentPreviewSessionRef = useRef<AgentPreviewSession | null>(null);
  const pendingAgentNavigationRef = useRef<PendingAgentNavigation | null>(null);
  const historyRef = useRef(new AnnotationHistory());
  const isApplyingHistoryRef = useRef(false);
  const localUndoHandlerRef = useRef<(() => boolean) | null>(null);

  annotationsRef.current = annotations;
  dirtyRef.current = dirty;
  updateAnnotationWorkspaceAgentSnapshot({
    workspaceDirty: dirty,
    workspaceRelativePath: relativeFilePath,
    workspaceProjectId: activeProject?.id ?? null,
  });
  loadedMetaRef.current = loadedDocMeta;
  selectedIdRef.current = selectedAnnotationId;
  agentPreviewSessionRef.current = agentPreviewSession;

  const isAgentPreviewForCurrentView = useMemo(() => {
    if (!agentPreviewSession) return false;
    return isAgentPreviewPathMatch(
      agentPreviewSession.relativePath,
      relativeFilePath,
    );
  }, [agentPreviewSession, relativeFilePath]);

  const effectiveAnnotations = useMemo(() => {
    if (isAgentPreviewForCurrentView && agentPreviewSession) {
      return agentPreviewSession.annotations;
    }
    return annotations;
  }, [isAgentPreviewForCurrentView, agentPreviewSession, annotations]);

  const agentPreviewReadOnly = isAgentPreviewForCurrentView;

  const setEditableAnnotations = useCallback(
    (updater: SetStateAction<AnnotationInstance[]>) => {
      if (agentPreviewSessionRef.current) return;
      setAnnotations(updater);
    },
    [],
  );

  const clearAgentPreview = useCallback(() => {
    agentPreviewSessionRef.current = null;
    setAgentPreviewSession(null);
  }, []);

  const enterAgentPreview = useCallback((session: AgentPreviewSession) => {
    agentPreviewSessionRef.current = session;
    setAgentPreviewSession(session);
  }, []);

  const schedulePendingAgentNavigation = useCallback(
    (nav: PendingAgentNavigation) => {
      pendingAgentNavigationRef.current = nav;
    },
    [],
  );

  const applyPendingAgentNavigation = useCallback(
    (
      rel: string,
      parsed: FileAnnotationDocument | null,
      stats: { mtimeMs: number; size: number } | null,
    ) => {
      const pending = pendingAgentNavigationRef.current;
      if (!pending || pending.relativePath !== rel) {
        setSelectedAnnotationId(null);
        return;
      }

      pendingAgentNavigationRef.current = null;
      const proj = activeProjectRef.current;

      if (
        pending.mode === 'preview' &&
        pending.pendingChanges?.length &&
        proj
      ) {
        const merged = mergeProposalChangesIntoDoc(
          parsed,
          pending.pendingChanges,
          proj,
          stats ?? {},
        );
        enterAgentPreview({
          relativePath: rel,
          annotations: merged.annotations,
          proposalAnchorId: pending.proposalAnchorId,
        });
      } else {
        clearAgentPreview();
      }

      setSelectedAnnotationId(pending.annotationId);
      if (shouldUseSelectToolForProject(proj)) {
        setToolState('select');
      }
    },
    [clearAgentPreview, enterAgentPreview],
  );

  const applyImmediateAnnotationPreview = useCallback(
    (params: ImmediateAnnotationPreviewParams): boolean => {
      const proj = activeProjectRef.current;
      const currentRel = currentPairRef.current.rel;
      if (!proj || !currentRel || params.relativePath !== currentRel) {
        return false;
      }

      const fileChanges = buildFileChangesFromProposal(
        params.proposal,
        params.relativePath,
      );
      if (fileChanges.length === 0) {
        return false;
      }

      const meta = loadedMetaRef.current;
      const parsed = meta
        ? {
            ...meta,
            annotations: structuredClone(annotationsRef.current),
          }
        : null;

      const merged = mergeProposalChangesIntoDoc(
        parsed,
        fileChanges,
        proj,
        meta?.source ?? {},
      );

      enterAgentPreview({
        relativePath: params.relativePath,
        annotations: merged.annotations,
        proposalAnchorId: params.proposalAnchorId,
      });
      setSelectedAnnotationId(params.annotationId);
      if (shouldUseSelectToolForProject(proj)) {
        setToolState('select');
      }
      return true;
    },
    [enterAgentPreview],
  );

  /** Tracks file identity for flush-before-navigation */
  const currentPairRef = useRef<{ rel: string | null; abs: string | null }>({
    rel: null,
    abs: null,
  });

  const saveTimerRef = useRef<number | undefined>(undefined);
  const factMemorySyncTimerRef = useRef<number | undefined>(undefined);
  const labelUsageSaveTimerRef = useRef<number | undefined>(undefined);
  const labelUsageRef = useRef(labelUsage);
  labelUsageRef.current = labelUsage;

  const activeProjectDirectory = activeProject?.directoryPath;
  const activeProjectDirectoryRef = useRef(activeProjectDirectory);
  activeProjectDirectoryRef.current = activeProjectDirectory;

  const persistFromRefs = useCallback(
    async (opts?: { statsPathOverride?: string | null; force?: boolean }) => {
      if (!dirtyRef.current && !opts?.force) return;

      const dir = activeProjectDirectoryRef.current;
      if (!dir || !currentPairRef.current.rel || !loadedMetaRef.current) return;

      const relPath = currentPairRef.current.rel;

      const ann = annotationsRef.current;
      let meta = loadedMetaRef.current;

      setSaving(true);
      try {
        const hintPath = opts?.statsPathOverride ?? currentPairRef.current.abs;
        const hint = await statsForPath(hintPath);

        const now = new Date().toISOString();
        const mergedSource =
          hint && meta.source
            ? { ...meta.source, mtimeMs: hint.mtimeMs, size: hint.size }
            : meta.source;

        meta = { ...meta, source: mergedSource, updatedAt: now };
        const doc: FileAnnotationDocument = {
          ...meta,
          annotations: ann,
          updatedAt: now,
        };

        loadedMetaRef.current = meta;
        await writeFileAnnotationDoc(dir, relPath, doc, hint ?? undefined);
        setLoadedDocMeta(meta);
        setDirty(false);
        const projectForFacts = activeProjectRef.current;
        if (factMemorySyncTimerRef.current) {
          window.clearTimeout(factMemorySyncTimerRef.current);
        }
        factMemorySyncTimerRef.current = window.setTimeout(() => {
          void syncWorkspaceFactMemory(projectForFacts);
        }, 400);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const bboxAnnotations = useMemo(
    () => effectiveAnnotations.filter(isBBoxInstance),
    [effectiveAnnotations],
  );

  const rotatedBboxAnnotations = useMemo(
    () => effectiveAnnotations.filter(isRotatedBBoxInstance),
    [effectiveAnnotations],
  );

  const polygonAnnotations = useMemo(
    () => effectiveAnnotations.filter(isPolygonInstance),
    [effectiveAnnotations],
  );

  const poseAnnotations = useMemo(
    () => effectiveAnnotations.filter(isPoseInstance),
    [effectiveAnnotations],
  );

  const pointAnnotations = useMemo(
    () => effectiveAnnotations.filter(isImagePointInstance),
    [effectiveAnnotations],
  );

  const captionAnnotations = useMemo(
    () => effectiveAnnotations.filter(isCaptionInstance),
    [effectiveAnnotations],
  );

  const classificationAnnotations = useMemo(
    () => effectiveAnnotations.filter(isClassificationInstance),
    [effectiveAnnotations],
  );

  const spanAnnotations = useMemo(
    () => effectiveAnnotations.filter(isSpanInstance),
    [effectiveAnnotations],
  );

  const textClassificationAnnotations = useMemo(
    () => effectiveAnnotations.filter(isTextClassificationInstance),
    [effectiveAnnotations],
  );

  const instructionAnnotations = useMemo(
    () => effectiveAnnotations.filter(isInstructionInstance),
    [effectiveAnnotations],
  );

  const preferenceAnnotations = useMemo(
    () => effectiveAnnotations.filter(isPreferenceInstance),
    [effectiveAnnotations],
  );

  const conversationAnnotations = useMemo(
    () => effectiveAnnotations.filter(isConversationInstance),
    [effectiveAnnotations],
  );

  const cotAnnotations = useMemo(
    () => effectiveAnnotations.filter(isCotInstance),
    [effectiveAnnotations],
  );

  const activeTemplate = useMemo(() => {
    return (
      getKeypointTemplate(activeTemplateId) ??
      getKeypointTemplate(DEFAULT_KEYPOINT_TEMPLATE_ID)!
    );
  }, [activeTemplateId]);

  useEffect(() => {
    if (!activeProject?.labels.length) {
      setActiveLabelId(null);
      return;
    }
    setActiveLabelId((prev) => {
      if (prev && activeProject.labels.some((l) => l.id === prev)) return prev;
      return activeProject.labels[0]?.id ?? null;
    });
  }, [activeProject?.id, activeProject?.labels]);

  useEffect(() => {
    if (!activeProject?.id) {
      setLabelUsage({});
      return;
    }
    const validIds = new Set(activeProject.labels.map((l) => l.id));
    const loaded = loadLabelUsage(activeProject.id);
    setLabelUsage(pruneLabelUsage(loaded, validIds));
  }, [activeProject?.id, activeProject?.labels]);

  const scheduleLabelUsageSave = useCallback((projectId: string) => {
    if (labelUsageSaveTimerRef.current) {
      window.clearTimeout(labelUsageSaveTimerRef.current);
    }
    labelUsageSaveTimerRef.current = window.setTimeout(() => {
      labelUsageSaveTimerRef.current = undefined;
      saveLabelUsage(projectId, labelUsageRef.current);
    }, 300);
  }, []);

  const recordLabelUsage = useCallback(
    (labelId: string) => {
      const projectId = activeProjectRef.current?.id;
      if (!projectId) return;
      const validIds = activeProjectRef.current?.labels.map((l) => l.id) ?? [];
      if (!validIds.includes(labelId)) return;

      setLabelUsage((prev) => {
        const next = bumpLabelUsage(prev, labelId);
        scheduleLabelUsageSave(projectId);
        return next;
      });
    },
    [scheduleLabelUsageSave],
  );

  useEffect(() => {
    if (activeProject?.annotationType === 'polygon') {
      setToolState((prev) => (prev === 'draw' ? 'polygon' : prev));
    } else if (
      activeProject?.annotationType === 'bbox' ||
      activeProject?.annotationType === 'rotated_bbox'
    ) {
      setToolState((prev) =>
        prev === 'polygon' || prev === 'place_pose' || prev === 'place_point'
          ? 'draw'
          : prev,
      );
    } else if (activeProject?.annotationType === 'keypoint') {
      setToolState((prev) =>
        prev === 'draw' || prev === 'polygon' ? 'place_pose' : prev,
      );
    } else if (activeProject?.annotationType === 'caption') {
      setToolState('caption_edit');
    } else if (activeProject?.annotationType === 'classification') {
      setToolState('classify_select');
    }
  }, [activeProject?.annotationType]);

  // ── 加载当前文本文件内容（供 NER / 分类 / LLM 源文件预览使用） ──
  useEffect(() => {
    if (!workspaceEnabled || !textAnnotationType) {
      setTextContent(null);
      setTextContentLoading(false);
      return;
    }
    if (!activeFilePath) {
      setTextContent(null);
      setTextContentLoading(false);
      return;
    }
    let cancelled = false;
    setTextContentLoading(true);
    window.electron.fileSystem
      ?.readFile(activeFilePath)
      .then((text) => {
        if (!cancelled) setTextContent(text ?? '');
      })
      .catch(() => {
        if (!cancelled) setTextContent(null);
      })
      .finally(() => {
        if (!cancelled) setTextContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceEnabled, activeFilePath, textAnnotationType]);

  const setActiveTemplateId = useCallback((id: string) => {
    setActiveTemplateIdState(id);
  }, []);

  const saveNow = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    await persistFromRefs({ force: true });
  }, [persistFromRefs]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      persistFromRefs().catch(() => undefined);
    }, DEBOUNCE_MS);
  }, [persistFromRefs]);

  const touchDirty = useCallback(() => {
    if (agentPreviewSessionRef.current) return;
    setDirty(true);
    scheduleSave();
  }, [scheduleSave]);

  const bumpHistory = useCallback(() => {
    setHistoryTick((t) => t + 1);
  }, []);

  const captureHistorySnapshot = useCallback((): AnnotationHistorySnapshot => {
    return {
      annotations: structuredClone(annotationsRef.current),
      selectedAnnotationId: selectedIdRef.current,
    };
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current.clear();
    bumpHistory();
  }, [bumpHistory]);

  const loadSyntheticAnnotationForView = useCallback(
    async (relativePath: string, annotationId: string) => {
      const proj = activeProjectRef.current;
      if (!proj) return;

      clearAgentPreview();
      try {
        const raw = await readFileAnnotationDoc(
          proj.directoryPath,
          relativePath,
        );
        const parsed = raw ? parseFileAnnotationDocument(raw) : null;
        if (!parsed) {
          setSelectedAnnotationId(annotationId);
          return;
        }
        const { annotations: ann, ...meta } = parsed;
        setLoadedDocMeta(meta);
        setAnnotations(ann);
        clearHistory();
        setDirty(false);
        setSourceStale(false);
        currentPairRef.current = { rel: relativePath, abs: null };
        setSelectedAnnotationId(annotationId);
      } catch {
        setSelectedAnnotationId(annotationId);
      }
    },
    [clearAgentPreview, clearHistory],
  );

  const recordHistory = useCallback(() => {
    if (isApplyingHistoryRef.current) return;
    if (agentPreviewSessionRef.current) return;
    historyRef.current.record(captureHistorySnapshot());
    bumpHistory();
  }, [captureHistorySnapshot, bumpHistory]);

  const applyHistorySnapshot = useCallback(
    (snapshot: AnnotationHistorySnapshot) => {
      isApplyingHistoryRef.current = true;
      setAnnotations(snapshot.annotations);
      setSelectedAnnotationId(snapshot.selectedAnnotationId);
      isApplyingHistoryRef.current = false;
      touchDirty();
    },
    [touchDirty],
  );

  const beginHistoryBatch = useCallback(() => {
    historyRef.current.beginBatch(captureHistorySnapshot());
  }, [captureHistorySnapshot]);

  const endHistoryBatch = useCallback(() => {
    historyRef.current.endBatch();
    bumpHistory();
  }, [bumpHistory]);

  const undo = useCallback((): boolean => {
    if (agentPreviewSessionRef.current) return false;
    const restored = historyRef.current.undo(captureHistorySnapshot());
    if (!restored) return false;
    applyHistorySnapshot(restored);
    bumpHistory();
    return true;
  }, [captureHistorySnapshot, applyHistorySnapshot, bumpHistory]);

  const redo = useCallback((): boolean => {
    if (agentPreviewSessionRef.current) return false;
    const restored = historyRef.current.redo(captureHistorySnapshot());
    if (!restored) return false;
    applyHistorySnapshot(restored);
    bumpHistory();
    return true;
  }, [captureHistorySnapshot, applyHistorySnapshot, bumpHistory]);

  const setLocalUndoHandler = useCallback((handler: (() => boolean) | null) => {
    localUndoHandlerRef.current = handler;
  }, []);

  const canUndo = useMemo(() => historyRef.current.canUndo(), [historyTick]);
  const canRedo = useMemo(() => historyRef.current.canRedo(), [historyTick]);

  useEffect(() => {
    if (!annotationPanelVisible) return undefined;

    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(ev.ctrlKey || ev.metaKey)) return;

      const isUndo = !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z');
      const isRedo =
        (ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')) ||
        ev.key === 'y' ||
        ev.key === 'Y';

      if (isUndo) {
        if (localUndoHandlerRef.current?.()) {
          ev.preventDefault();
          return;
        }
        if (undo()) ev.preventDefault();
        return;
      }

      if (isRedo) {
        if (redo()) ev.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [annotationPanelVisible, undo, redo]);

  useEffect(() => {
    if (
      !annotationPanelVisible ||
      !projectRootMatched ||
      !activeProject?.directoryPath
    ) {
      currentPairRef.current = { rel: null, abs: null };
      setAnnotations([]);
      setLoadedDocMeta(null);
      setSelectedAnnotationId(null);
      setLoadError(null);
      setDirty(false);
      setSourceStale(false);
      historyRef.current.clear();
      setHistoryTick(0);
      return undefined;
    }

    if (
      (activeProject.modality !== 'image' &&
        activeProject.modality !== 'text') ||
      (activeProject.modality === 'image' &&
        activeProject.annotationType !== 'bbox' &&
        activeProject.annotationType !== 'rotated_bbox' &&
        activeProject.annotationType !== 'polygon' &&
        activeProject.annotationType !== 'keypoint' &&
        activeProject.annotationType !== 'caption' &&
        activeProject.annotationType !== 'classification') ||
      (!relativeFilePath && !isTextLLMType)
    ) {
      currentPairRef.current = { rel: null, abs: null };
      setAnnotations([]);
      setLoadedDocMeta(null);
      setSelectedAnnotationId(null);
      setLoadError(null);
      setDirty(false);
      setSourceStale(false);
      historyRef.current.clear();
      setHistoryTick(0);
      return undefined;
    }

    const rel = relativeFilePath;
    if (!rel) {
      const previewSession = agentPreviewSessionRef.current;
      const loadedSyntheticRel = currentPairRef.current.rel;
      const hasSyntheticPreview =
        previewSession &&
        isSyntheticAnnotationRelativePath(previewSession.relativePath);
      const hasSyntheticLoadedDoc =
        loadedSyntheticRel &&
        isSyntheticAnnotationRelativePath(loadedSyntheticRel) &&
        loadedMetaRef.current;

      if (hasSyntheticPreview || hasSyntheticLoadedDoc) {
        currentPairRef.current = {
          rel: loadedSyntheticRel,
          abs: activeFilePath,
        };
        return undefined;
      }

      // Freeform mode: no file selected, start with empty annotations
      setLoadedDocMeta(null);
      setAnnotations([]);
      clearHistory();
      setDirty(false);
      setSourceStale(false);
      setSelectedAnnotationId(null);
      currentPairRef.current = { rel: null, abs: activeFilePath };
      return undefined;
    }
    const projDir = activeProject.directoryPath;
    let cancelled = false;

    const runLoadPipeline = async () => {
      setLoadError(null);

      const prev = currentPairRef.current;
      if (
        dirtyRef.current &&
        prev.rel &&
        prev.rel !== rel &&
        loadedMetaRef.current
      ) {
        await persistFromRefs({
          statsPathOverride: prev.abs,
          force: true,
        }).catch(() => undefined);
      }

      if (cancelled) return;

      const projForMeta = activeProjectRef.current;
      if (!projForMeta) return;

      try {
        const raw = await readFileAnnotationDoc(projDir, rel);
        if (cancelled) return;
        const parsed = raw ? parseFileAnnotationDocument(raw) : null;
        const stats = await statsForPath(activeFilePath);
        if (cancelled) return;

        if (parsed) {
          const { annotations: ann, ...meta } = parsed;

          let stale = false;
          if (
            meta.source?.mtimeMs !== undefined &&
            stats &&
            stats.mtimeMs !== meta.source.mtimeMs
          )
            stale = true;
          if (
            meta.source?.size !== undefined &&
            stats &&
            stats.size !== meta.source.size
          )
            stale = true;

          setLoadedDocMeta(meta);
          setAnnotations(ann);
          clearHistory();
          setDirty(false);
          setSourceStale(stale);
          currentPairRef.current = { rel, abs: activeFilePath };
          applyPendingAgentNavigation(rel, parsed, stats);
        } else {
          const meta = emptyDocMeta(projForMeta, rel, stats);
          setLoadedDocMeta(meta);
          setAnnotations([]);
          clearHistory();
          setDirty(false);
          setSourceStale(false);
          currentPairRef.current = { rel, abs: activeFilePath };
          applyPendingAgentNavigation(rel, null, stats);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : '加载标注失败');
          setAnnotations([]);
          setLoadedDocMeta(null);
          clearHistory();
          currentPairRef.current = { rel, abs: activeFilePath };
          setDirty(false);
        }
      }
    };

    runLoadPipeline().catch(() => undefined);

    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      if (dirtyRef.current) {
        persistFromRefs({ force: true }).catch(() => undefined);
      }
    };
  }, [
    annotationPanelVisible,
    projectRootMatched,
    activeProject?.id,
    activeProject?.directoryPath,
    activeProject?.modality,
    activeProject?.annotationType,
    activeFilePath,
    relativeFilePath,
    persistFromRefs,
    clearHistory,
    applyPendingAgentNavigation,
  ]);

  useEffect(() => {
    if (!annotationPanelVisible || !projectRootMatched) return undefined;

    const onBatchApplied = (event: Event) => {
      const { detail } = event as CustomEvent<{
        projectId?: string;
        relativePaths?: string[];
        force?: boolean;
      }>;
      const proj = activeProjectRef.current;
      if (!proj || detail?.projectId !== proj.id) return;
      const rel = relativeFilePath;
      if (!rel) return;
      if (
        detail?.relativePaths?.length &&
        !detail.relativePaths.includes(rel)
      ) {
        return;
      }
      const force = Boolean(detail?.force);
      void readFileAnnotationDoc(proj.directoryPath, rel)
        .then((raw) => {
          const parsed = raw ? parseFileAnnotationDocument(raw) : null;
          const decision = decideCanvasAfterExternalApply({
            parsed,
            dirty: dirtyRef.current,
            force,
          });
          if (decision.action === 'skip') return;
          if (decision.action === 'clear') {
            setLoadedDocMeta(emptyDocMeta(proj, rel, null));
            setAnnotations([]);
            setDirty(false);
            clearHistory();
            clearAgentPreview();
            return;
          }
          const { annotations: ann, ...meta } = parsed!;
          setLoadedDocMeta(meta);
          setAnnotations(ann);
          setDirty(false);
          clearHistory();
          clearAgentPreview();
        })
        .catch(() => undefined);
    };

    const onMutationsApplied = onBatchApplied;

    window.addEventListener(
      'lr-agent:annotation-mutations-applied',
      onMutationsApplied,
    );
    window.addEventListener(
      'lr-agent:annotation-batch-applied',
      onBatchApplied,
    );
    return () => {
      window.removeEventListener(
        'lr-agent:annotation-mutations-applied',
        onMutationsApplied,
      );
      window.removeEventListener(
        'lr-agent:annotation-batch-applied',
        onBatchApplied,
      );
    };
  }, [
    annotationPanelVisible,
    projectRootMatched,
    relativeFilePath,
    clearHistory,
    clearAgentPreview,
  ]);

  useEffect(() => {
    if (!annotationPanelVisible) {
      pendingAgentNavigationRef.current = null;
      clearAgentPreview();
      return;
    }

    setAgentPreviewSession((session) => {
      if (!session) return null;
      if (isAgentPreviewPathMatch(session.relativePath, relativeFilePath)) {
        return session;
      }
      agentPreviewSessionRef.current = null;
      return null;
    });
  }, [annotationPanelVisible, relativeFilePath, clearAgentPreview]);

  useEffect(() => {
    updateAnnotationWorkspaceAgentSnapshot({
      selectedAnnotationId,
      selectedAnnotationIds: selectedAnnotationId ? [selectedAnnotationId] : [],
      workspaceDirty: dirty,
      workspaceRelativePath: relativeFilePath,
      workspaceProjectId: activeProject?.id ?? null,
      keypointTemplateId: activeTemplateId ?? null,
    });
  }, [
    selectedAnnotationId,
    dirty,
    relativeFilePath,
    activeProject?.id,
    activeTemplateId,
  ]);

  const selectAnnotation = useCallback((id: string | null) => {
    setSelectedAnnotationId(id);
  }, []);

  const setTool = useCallback((next: ImageCanvasTool) => {
    setToolState(next);
  }, []);

  const addBboxAnnotation = useCallback(
    (rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): boolean => {
      if (!activeLabelId) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: BboxAnnotation = {
        id: crypto.randomUUID(),
        kind: 'bbox',
        labelId: activeLabelId,
        createdAt: now,
        updatedAt: now,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };

      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPolygonAnnotation = useCallback(
    (points: { x: number; y: number }[]): boolean => {
      if (!activeLabelId || points.length < 3) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: PolygonAnnotation = {
        id: crypto.randomUUID(),
        kind: 'polygon',
        labelId: activeLabelId,
        createdAt: now,
        updatedAt: now,
        points,
      };

      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addRotatedBboxAnnotation = useCallback(
    (rect: {
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
    }): boolean => {
      if (!activeLabelId) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: RotatedBboxAnnotation = {
        id: crypto.randomUUID(),
        kind: 'rotated_bbox',
        labelId: activeLabelId,
        createdAt: now,
        updatedAt: now,
        cx: rect.cx,
        cy: rect.cy,
        width: rect.width,
        height: rect.height,
        angle: rect.angle,
      };

      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateRotatedBboxGeometry = useCallback(
    (
      id: string,
      patch: Pick<
        RotatedBboxAnnotation,
        'cx' | 'cy' | 'width' | 'height' | 'angle'
      >,
    ) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'rotated_bbox' && item.id === id
            ? {
                ...item,
                ...patch,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updateBboxGeometry = useCallback(
    (
      id: string,
      patch: Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'>,
    ) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'bbox' && item.id === id
            ? {
                ...item,
                ...patch,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updatePolygonGeometry = useCallback(
    (id: string, points: { x: number; y: number }[]) => {
      if (points.length < 3) return;
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'polygon' && item.id === id
            ? {
                ...item,
                points,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const addPoseAnnotation = useCallback(
    (
      templateId: string,
      centerScene: ScenePoint,
      naturalWidth: number,
      naturalHeight: number,
    ): string | null => {
      if (!loadedDocMeta) return null;
      const template = getKeypointTemplate(templateId);
      if (!template) return null;
      const labels = activeProjectRef.current?.labels ?? [];
      const labelId = resolveLabelIdForTemplate(template, labels);
      if (!labelId) return null;

      const scene = buildInitialPoseSceneGeometry(
        template,
        centerScene,
        naturalWidth,
        naturalHeight,
      );
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next = sceneGeometryToPoseAnn(scene, naturalWidth, naturalHeight, {
        id,
        labelId,
        templateId,
        createdAt: now,
      });

      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPointAnnotation = useCallback(
    (x: number, y: number, labelId: string): string | null => {
      if (!loadedDocMeta || !labelId) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: ImagePointAnnotation = {
        id,
        kind: 'point',
        labelId,
        createdAt: now,
        updatedAt: now,
        x,
        y,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addCaptionAnnotation = useCallback(
    (params: {
      text: string;
      granularity: 'brief' | 'detailed' | 'dense';
      language?: string;
      labelId?: string | null;
    }): string | null => {
      if (!loadedDocMeta || !params.text.trim()) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: CaptionAnnotation = {
        id,
        kind: 'caption',
        labelId: params.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        text: params.text.trim(),
        granularity: params.granularity,
        language: params.language,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      if (params.labelId) recordLabelUsage(params.labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateCaptionAnnotation = useCallback(
    (
      id: string,
      params: {
        text: string;
        granularity?: 'brief' | 'detailed' | 'dense';
        language?: string;
      },
    ) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'caption') return item;
          return {
            ...item,
            text: params.text.trim(),
            ...(params.granularity !== undefined && {
              granularity: params.granularity,
            }),
            ...(params.language !== undefined && { language: params.language }),
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const addClassificationAnnotation = useCallback(
    (labelId: string): string | null => {
      if (!loadedDocMeta || !labelId) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: ClassificationAnnotation = {
        id,
        kind: 'classification',
        labelId,
        createdAt: now,
        updatedAt: now,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateClassificationAnnotation = useCallback(
    (id: string, labelId: string) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'classification') return item;
          return {
            ...item,
            labelId,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
      recordLabelUsage(labelId);
    },
    [touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotBboxes = useCallback(
    (
      items: Array<{
        labelId?: string | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }>,
    ): number => {
      if (!loadedDocMeta || items.length === 0) return 0;
      const now = new Date().toISOString();
      const nextItems: BboxAnnotation[] = items.map((item) => ({
        id: crypto.randomUUID(),
        kind: 'bbox',
        labelId: item.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      }));

      recordHistory();
      setEditableAnnotations((prev) => [...prev, ...nextItems]);
      touchDirty();
      nextItems.forEach((ann) => {
        if (ann.labelId) recordLabelUsage(ann.labelId);
      });
      return nextItems.length;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotRotatedBboxes = useCallback(
    (
      items: Array<{
        labelId?: string | null;
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
      }>,
    ): number => {
      if (!loadedDocMeta || items.length === 0) return 0;
      const now = new Date().toISOString();
      const nextItems: RotatedBboxAnnotation[] = items.map((item) => ({
        id: crypto.randomUUID(),
        kind: 'rotated_bbox',
        labelId: item.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        cx: item.cx,
        cy: item.cy,
        width: item.width,
        height: item.height,
        angle: item.angle,
      }));

      recordHistory();
      setEditableAnnotations((prev) => [...prev, ...nextItems]);
      touchDirty();
      nextItems.forEach((ann) => {
        if (ann.labelId) recordLabelUsage(ann.labelId);
      });
      return nextItems.length;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotPolygon = useCallback(
    (points: { x: number; y: number }[], labelId?: string): boolean => {
      const resolvedLabelId = labelId ?? activeLabelId;
      if (!resolvedLabelId || points.length < 3) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: PolygonAnnotation = {
        id: crypto.randomUUID(),
        kind: 'polygon',
        labelId: resolvedLabelId,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        points,
      };

      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(resolvedLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotPoses = useCallback(
    (
      items: Array<{
        labelId: string;
        templateId: string;
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
        keypoints: { x: number; y: number; visibility: 0 | 1 | 2 }[];
      }>,
    ): number => {
      if (!loadedDocMeta || items.length === 0) return 0;
      const now = new Date().toISOString();
      const nextItems: PoseAnnotation[] = items.map((item) => ({
        id: crypto.randomUUID(),
        kind: 'pose',
        labelId: item.labelId,
        templateId: item.templateId,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        cx: item.cx,
        cy: item.cy,
        width: item.width,
        height: item.height,
        angle: item.angle,
        keypoints: item.keypoints,
      }));

      recordHistory();
      setEditableAnnotations((prev) => [...prev, ...nextItems]);
      touchDirty();
      nextItems.forEach((ann) => {
        if (ann.labelId) recordLabelUsage(ann.labelId);
      });
      return nextItems.length;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const clearPreAnnots = useCallback((): number => {
    let removed = 0;
    setEditableAnnotations((prev) => {
      const next = prev.filter((item) => item.source !== 'preannot');
      removed = prev.length - next.length;
      return next;
    });
    if (removed > 0) {
      recordHistory();
      touchDirty();
      setSelectedAnnotationId(null);
    }
    return removed;
  }, [touchDirty, recordHistory]);

  // ── 文本标注操作方法 ──

  const addSpanAnnotation = useCallback(
    (start: number, end: number, labelId: string): string | null => {
      if (!loadedDocMeta || !labelId || start >= end) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: SpanAnnotation = {
        id,
        kind: 'span_ner',
        labelId,
        createdAt: now,
        updatedAt: now,
        start,
        end,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateSpanAnnotation = useCallback(
    (id: string, start: number, end: number) => {
      if (start >= end) return;
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'span_ner' && item.id === id
            ? { ...item, start, end, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const addTextClassificationAnnotation = useCallback(
    (labelId: string, note?: string): string | null => {
      if (!loadedDocMeta || !labelId) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: TextClassificationAnnotation = {
        id,
        kind: 'text_classification',
        labelId,
        createdAt: now,
        updatedAt: now,
        note,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateTextClassificationAnnotation = useCallback(
    (id: string, labelId: string, note?: string) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'text_classification')
            return item;
          return {
            ...item,
            labelId,
            ...(note !== undefined && { note }),
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
      recordLabelUsage(labelId);
    },
    [touchDirty, recordLabelUsage, recordHistory],
  );

  const addInstructionAnnotation = useCallback(
    (params: {
      instruction: string;
      input?: string;
      output: string;
      labelId?: string | null;
    }): string | null => {
      if (!loadedDocMeta || !params.instruction || !params.output) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: InstructionAnnotation = {
        id,
        kind: 'instruction',
        labelId: params.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        instruction: params.instruction,
        input: params.input,
        output: params.output,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      if (params.labelId) recordLabelUsage(params.labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateInstructionAnnotation = useCallback(
    (
      id: string,
      params: {
        instruction?: string;
        input?: string;
        output?: string;
      },
    ) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'instruction') return item;
          return {
            ...item,
            ...(params.instruction !== undefined && {
              instruction: params.instruction,
            }),
            ...(params.input !== undefined && { input: params.input }),
            ...(params.output !== undefined && { output: params.output }),
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const addPreferenceAnnotation = useCallback(
    (params: {
      prompt: string;
      chosen: string;
      rejected: string;
      preferenceNote?: string;
      labelId?: string | null;
    }): string | null => {
      if (
        !loadedDocMeta ||
        !params.prompt ||
        !params.chosen ||
        !params.rejected
      )
        return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: PreferenceAnnotation = {
        id,
        kind: 'preference',
        labelId: params.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        prompt: params.prompt,
        chosen: params.chosen,
        rejected: params.rejected,
        preferenceNote: params.preferenceNote,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      if (params.labelId) recordLabelUsage(params.labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updatePreferenceAnnotation = useCallback(
    (
      id: string,
      params: {
        prompt?: string;
        chosen?: string;
        rejected?: string;
        preferenceNote?: string;
      },
    ) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'preference') return item;
          return {
            ...item,
            ...(params.prompt !== undefined && { prompt: params.prompt }),
            ...(params.chosen !== undefined && { chosen: params.chosen }),
            ...(params.rejected !== undefined && { rejected: params.rejected }),
            ...(params.preferenceNote !== undefined && {
              preferenceNote: params.preferenceNote,
            }),
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const addConversationAnnotation = useCallback(
    (params: {
      turns: Array<{ role: 'user' | 'assistant'; content: string }>;
      labelId?: string | null;
    }): string | null => {
      if (!loadedDocMeta || params.turns.length === 0) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: ConversationAnnotation = {
        id,
        kind: 'conversation',
        labelId: params.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        turns: params.turns,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      if (params.labelId) recordLabelUsage(params.labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateConversationAnnotation = useCallback(
    (
      id: string,
      turns: Array<{ role: 'user' | 'assistant'; content: string }>,
    ) => {
      if (turns.length === 0) return;
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'conversation') return item;
          return { ...item, turns, updatedAt: new Date().toISOString() };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const addCotAnnotation = useCallback(
    (params: {
      instruction?: string;
      input?: string;
      steps: Array<{ description: string; conclusion: string }>;
      answer: string;
      labelId?: string | null;
    }): string | null => {
      if (!loadedDocMeta || params.steps.length === 0 || !params.answer)
        return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: CotAnnotation = {
        id,
        kind: 'cot',
        labelId: params.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        instruction: params.instruction,
        input: params.input,
        steps: params.steps,
        answer: params.answer,
      };
      recordHistory();
      setEditableAnnotations((prev) => [...prev, next]);
      touchDirty();
      if (params.labelId) recordLabelUsage(params.labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateCotAnnotation = useCallback(
    (
      id: string,
      params: {
        instruction?: string;
        input?: string;
        steps?: Array<{ description: string; conclusion: string }>;
        answer?: string;
      },
    ) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.id !== id || item.kind !== 'cot') return item;
          return {
            ...item,
            ...(params.instruction !== undefined && {
              instruction: params.instruction,
            }),
            ...(params.input !== undefined && { input: params.input }),
            ...(params.steps !== undefined && { steps: params.steps }),
            ...(params.answer !== undefined && { answer: params.answer }),
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updatePoseGeometry = useCallback(
    (id: string, ann: PoseAnnotation) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'pose' && item.id === id ? ann : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updatePointGeometry = useCallback(
    (id: string, x: number, y: number) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'point' && item.id === id
            ? { ...item, x, y, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updateKeypointVisibility = useCallback(
    (poseId: string, index: number, visibility: 0 | 1 | 2) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) => {
          if (item.kind !== 'pose' || item.id !== poseId) return item;
          const keypoints = item.keypoints.map((kp, i) =>
            i === index ? { ...kp, visibility } : kp,
          );
          return {
            ...item,
            keypoints,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const deleteAnnotation = useCallback(
    (id: string) => {
      recordHistory();
      setEditableAnnotations((prev) => prev.filter((a) => a.id !== id));
      setSelectedAnnotationId((sid) => (sid === id ? null : sid));
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updateAnnotationLabel = useCallback(
    (id: string, labelId: string) => {
      recordHistory();
      setEditableAnnotations((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, labelId, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
      touchDirty();
      recordLabelUsage(labelId);
    },
    [touchDirty, recordLabelUsage, recordHistory],
  );

  const reportImageNaturalSize = useCallback(
    (width: number, height: number) => {
      const meta = loadedMetaRef.current;
      if (
        width <= 0 ||
        height <= 0 ||
        !meta?.source ||
        (meta.source.width === width && meta.source.height === height)
      )
        return;

      const updated: DocMeta = {
        ...meta,
        source: { ...meta.source, width, height },
        updatedAt: new Date().toISOString(),
      };
      loadedMetaRef.current = updated;
      setLoadedDocMeta(updated);
      touchDirty();
    },
    [touchDirty],
  );

  const value = useMemo<AnnotationWorkspaceContextValue>(() => {
    return {
      workspaceEnabled,
      annotationPanelVisible,
      projectRootMatched,
      relativeFilePath,
      annotations: effectiveAnnotations,
      bboxAnnotations,
      rotatedBboxAnnotations,
      polygonAnnotations,
      poseAnnotations,
      pointAnnotations,
      captionAnnotations,
      classificationAnnotations,
      spanAnnotations,
      textClassificationAnnotations,
      instructionAnnotations,
      preferenceAnnotations,
      conversationAnnotations,
      cotAnnotations,
      imageAnnotationType,
      textAnnotationType,
      textContent,
      textContentLoading,
      freeformMode,
      activeTemplateId,
      setActiveTemplateId,
      activeTemplate,
      selectedAnnotationId,
      tool,
      setTool,
      activeLabelId,
      setActiveLabelId,
      labelUsage,
      selectAnnotation,
      agentPreviewSession,
      agentPreviewReadOnly,
      enterAgentPreview,
      clearAgentPreview,
      schedulePendingAgentNavigation,
      applyImmediateAnnotationPreview,
      loadSyntheticAnnotationForView,
      // 文本标注方法
      addSpanAnnotation,
      updateSpanAnnotation,
      addTextClassificationAnnotation,
      updateTextClassificationAnnotation,
      addInstructionAnnotation,
      updateInstructionAnnotation,
      addPreferenceAnnotation,
      updatePreferenceAnnotation,
      addConversationAnnotation,
      updateConversationAnnotation,
      addCotAnnotation,
      updateCotAnnotation,
      // 图片标注方法
      addBboxAnnotation,
      addRotatedBboxAnnotation,
      addPolygonAnnotation,
      addPoseAnnotation,
      addPointAnnotation,
      addCaptionAnnotation,
      updateCaptionAnnotation,
      addClassificationAnnotation,
      updateClassificationAnnotation,
      addPreAnnotBboxes,
      addPreAnnotRotatedBboxes,
      addPreAnnotPolygon,
      addPreAnnotPoses,
      clearPreAnnots,
      updateBboxGeometry,
      updateRotatedBboxGeometry,
      updatePolygonGeometry,
      updatePoseGeometry,
      updatePointGeometry,
      updateKeypointVisibility,
      deleteAnnotation,
      updateAnnotationLabel,
      reportImageNaturalSize,
      dirty,
      saving,
      loadError,
      sourceStale,
      saveNow,
      undo,
      redo,
      canUndo,
      canRedo,
      beginHistoryBatch,
      endHistoryBatch,
      setLocalUndoHandler,
    };
  }, [
    workspaceEnabled,
    annotationPanelVisible,
    projectRootMatched,
    relativeFilePath,
    effectiveAnnotations,
    bboxAnnotations,
    rotatedBboxAnnotations,
    polygonAnnotations,
    poseAnnotations,
    pointAnnotations,
    captionAnnotations,
    classificationAnnotations,
    spanAnnotations,
    textClassificationAnnotations,
    instructionAnnotations,
    preferenceAnnotations,
    conversationAnnotations,
    cotAnnotations,
    imageAnnotationType,
    textAnnotationType,
    textContent,
    textContentLoading,
    freeformMode,
    activeTemplateId,
    activeTemplate,
    selectedAnnotationId,
    tool,
    setTool,
    activeLabelId,
    labelUsage,
    selectAnnotation,
    agentPreviewSession,
    agentPreviewReadOnly,
    enterAgentPreview,
    clearAgentPreview,
    schedulePendingAgentNavigation,
    loadSyntheticAnnotationForView,
    addSpanAnnotation,
    updateSpanAnnotation,
    addTextClassificationAnnotation,
    updateTextClassificationAnnotation,
    addInstructionAnnotation,
    updateInstructionAnnotation,
    addPreferenceAnnotation,
    updatePreferenceAnnotation,
    addConversationAnnotation,
    updateConversationAnnotation,
    addCotAnnotation,
    updateCotAnnotation,
    addBboxAnnotation,
    addRotatedBboxAnnotation,
    addPolygonAnnotation,
    addPoseAnnotation,
    addPointAnnotation,
    addCaptionAnnotation,
    updateCaptionAnnotation,
    addClassificationAnnotation,
    updateClassificationAnnotation,
    addPreAnnotBboxes,
    addPreAnnotRotatedBboxes,
    addPreAnnotPolygon,
    addPreAnnotPoses,
    clearPreAnnots,
    updateBboxGeometry,
    updateRotatedBboxGeometry,
    updatePolygonGeometry,
    updatePoseGeometry,
    updatePointGeometry,
    updateKeypointVisibility,
    deleteAnnotation,
    updateAnnotationLabel,
    reportImageNaturalSize,
    dirty,
    saving,
    loadError,
    sourceStale,
    saveNow,
    undo,
    redo,
    canUndo,
    canRedo,
    beginHistoryBatch,
    endHistoryBatch,
    setLocalUndoHandler,
  ]);

  return (
    <AnnotationWorkspaceContext.Provider value={value}>
      {children}
    </AnnotationWorkspaceContext.Provider>
  );
}

export function useAnnotationWorkspace(): AnnotationWorkspaceContextValue {
  const ctx = useContext(AnnotationWorkspaceContext);
  if (!ctx) {
    throw new Error(
      'useAnnotationWorkspace must be used within AnnotationWorkspaceProvider',
    );
  }
  return ctx;
}
