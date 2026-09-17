import type { ClientContextPayload } from '../../shared/agentTypes';

export function buildApiClientContext(
  clientContext: ClientContextPayload,
): Record<string, unknown> {
  const snap = clientContext.annotationProjectSnapshot;
  return {
    workspace_root: clientContext.workspaceRoot ?? null,
    active_file_path: clientContext.activeFilePath ?? null,
    active_relative_path: clientContext.activeRelativePath ?? null,
    project_directory_path:
      clientContext.projectDirectoryPath ?? snap?.directoryPath ?? null,
    active_annotation_project_id:
      clientContext.activeAnnotationProjectId ?? null,
    annotation_project_modality:
      clientContext.annotationProjectModality ?? null,
    annotation_project_type: clientContext.annotationProjectType ?? null,
    agent_mode: clientContext.agentMode ?? null,
    work_mode: clientContext.workMode ?? null,
    selected_annotation_id: clientContext.selectedAnnotationId ?? null,
    selected_annotation_ids: clientContext.selectedAnnotationIds ?? [],
    annotation_project_snapshot: snap
      ? {
          project_id: snap.projectId,
          name: snap.name,
          modality: snap.modality,
          annotation_type: snap.annotationType,
          labels: snap.labels,
          detection_models: snap.detectionModels,
          project_directory_path: snap.directoryPath ?? null,
        }
      : null,
    mcp_server_url: clientContext.mcpServerUrl ?? null,
    mcp_server_token: clientContext.mcpServerToken ?? null,
    mcp_servers: (clientContext.mcpServers ?? []).map((server) => ({
      id: server.id,
      url: server.url,
      transport: server.transport,
      headers: server.headers ?? {},
      disabled_tools: server.disabledTools ?? [],
    })),
    project_instructions: clientContext.projectInstructions ?? null,
    memory_index: clientContext.memoryIndex ?? null,
    workspace_memory_enabled: Boolean(clientContext.workspaceMemoryEnabled),
    skills_catalog: (clientContext.skillsCatalog ?? []).map(
      ({ name, description }) => ({ name, description }),
    ),
    proposal_ledger: clientContext.proposalLedger ?? null,
    proposal_states: (clientContext.proposalStates ?? []).map((state) => ({
      path: state.path,
      kind: state.kind,
      status: state.status,
      operation: state.operation ?? null,
      annotation_ids: state.annotationIds ?? [],
    })),
  };
}
