import type {
  AgentInteractionMode,
  AgentSkillEntry,
  ClientContextPayload,
  ProposalStateEntry,
} from '../../shared/agentTypes';
import type { McpRemoteServerPayload } from '../../shared/mcpTypes';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import type { AnnotationProject } from '../types/annotation';
import { getRelativeProjectPath } from '../utils/projectPaths';
import { getAnnotationWorkspaceAgentSnapshot } from './annotationAgentBridge';
import { buildAnnotationProjectSnapshot } from './buildProjectSnapshot';

export function buildClientContextPayload(options: {
  rootPath: string | null;
  activeFilePath: string | null;
  activeProject: AnnotationProject | null;
  agentMode: AgentInteractionMode;
  workMode: 'editor' | 'annotation';
  detectionModels: PretrainedModelConfig[];
  selectedAnnotationId?: string | null;
  selectedAnnotationIds?: string[];
  mcpServerUrl?: string | null;
  /** 本地 MCP Server 访问 token（禁止打日志） */
  mcpServerToken?: string | null;
  /** 用户启用的远程 MCP Server（含 headers，禁止打日志） */
  mcpServers?: McpRemoteServerPayload[] | null;
  /** 项目级指令（.lragent/INSTRUCTIONS.md 内容） */
  projectInstructions?: string | null;
  /** 工作区记忆索引（MEMORY.md 截断内容） */
  memoryIndex?: string | null;
  /** 当前标注任务是否启用工作区记忆 */
  workspaceMemoryEnabled?: boolean;
  /** 全局 Agent Skills catalog（~/.agents/skills 扫描结果） */
  skillsCatalog?: AgentSkillEntry[] | null;
  /** 未 Keep All 的提案台账 */
  proposalLedger?: string | null;
  /** 提案结构化状态（供后端任务阶段机推导门禁） */
  proposalStates?: ProposalStateEntry[] | null;
}): ClientContextPayload {
  const activeRelativePath =
    options.activeProject && options.activeFilePath
      ? getRelativeProjectPath(
          options.activeProject.directoryPath,
          options.activeFilePath,
        )
      : null;

  const isEditorMode = options.workMode === 'editor';

  const base: ClientContextPayload = {
    workspaceRoot: options.rootPath,
    activeFilePath: options.activeFilePath,
    activeRelativePath,
    projectDirectoryPath: isEditorMode
      ? null
      : (options.activeProject?.directoryPath ?? null),
    activeAnnotationProjectId: isEditorMode
      ? null
      : (options.activeProject?.id ?? null),
    annotationProjectModality: isEditorMode
      ? null
      : (options.activeProject?.modality ?? null),
    annotationProjectType: isEditorMode
      ? null
      : (options.activeProject?.annotationType ?? null),
    agentMode: options.agentMode,
    workMode: options.workMode,
    selectedAnnotationId: isEditorMode
      ? null
      : (options.selectedAnnotationId ?? null),
    selectedAnnotationIds: isEditorMode
      ? []
      : (options.selectedAnnotationIds ?? []),
    mcpServerUrl: options.mcpServerUrl ?? null,
    mcpServerToken: options.mcpServerToken ?? null,
    mcpServers: options.mcpServers ?? null,
    projectInstructions: options.projectInstructions ?? null,
    memoryIndex: isEditorMode ? null : (options.memoryIndex ?? null),
    workspaceMemoryEnabled: isEditorMode
      ? false
      : Boolean(options.workspaceMemoryEnabled),
    skillsCatalog: options.skillsCatalog ?? null,
    proposalLedger: options.proposalLedger ?? null,
    proposalStates: options.proposalStates ?? null,
  };

  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  if (
    !isEditorMode &&
    wsSnap.selectedAnnotationId &&
    !base.selectedAnnotationId &&
    wsSnap.workspaceProjectId === options.activeProject?.id
  ) {
    base.selectedAnnotationId = wsSnap.selectedAnnotationId;
    base.selectedAnnotationIds = wsSnap.selectedAnnotationIds.length
      ? wsSnap.selectedAnnotationIds
      : [wsSnap.selectedAnnotationId];
  }

  if (isEditorMode || !options.activeProject) return base;

  const snap = buildAnnotationProjectSnapshot(
    options.activeProject,
    options.detectionModels,
  );
  return {
    ...base,
    annotationProjectSnapshot: {
      projectId: snap.projectId,
      name: snap.name,
      directoryPath: snap.directoryPath,
      modality: snap.modality,
      annotationType: snap.annotationType,
      annotationTypeLabel: snap.annotationTypeLabel,
      labels: snap.labels,
      detectionModels: snap.detectionModels ?? [],
      keypointTemplateId: snap.keypointTemplateId,
    },
  };
}
