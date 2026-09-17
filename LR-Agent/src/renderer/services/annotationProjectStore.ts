import {
  AnnotationProject,
  CreateAnnotationProjectInput,
  UpdateAnnotationProjectInput,
} from '../types/annotation';

function isAnnotationProject(value: unknown): value is AnnotationProject {
  if (!value || typeof value !== 'object') return false;
  const project = value as Record<string, unknown>;
  return (
    typeof project.id === 'string' &&
    typeof project.name === 'string' &&
    typeof project.directoryPath === 'string' &&
    (project.modality === 'text' || project.modality === 'image') &&
    typeof project.annotationType === 'string' &&
    Array.isArray(project.labels) &&
    typeof project.createdAt === 'string' &&
    typeof project.updatedAt === 'string'
  );
}

function parseProjects(raw: unknown[]): AnnotationProject[] {
  return raw.filter(isAnnotationProject);
}

async function persistProjects(projects: AnnotationProject[]): Promise<void> {
  await window.electron.annotation.saveProjects(projects);
}

async function syncProjectConfig(project: AnnotationProject): Promise<void> {
  await window.electron.annotation.writeProjectConfig(
    project.directoryPath,
    project,
  );
}

export async function loadAnnotationProjects(): Promise<AnnotationProject[]> {
  const raw = await window.electron.annotation.getProjects();
  return parseProjects(raw);
}

export async function createAnnotationProject(
  input: CreateAnnotationProjectInput,
): Promise<AnnotationProject> {
  const now = new Date().toISOString();
  const project: AnnotationProject = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    directoryPath: input.directoryPath,
    modality: input.modality,
    annotationType: input.annotationType,
    labels: input.labels,
    description: input.description?.trim() || undefined,
    workspaceMemoryEnabled: Boolean(input.workspaceMemoryEnabled),
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };

  const projects = await loadAnnotationProjects();
  projects.unshift(project);
  await persistProjects(projects);
  await syncProjectConfig(project);
  return project;
}

export async function deleteAnnotationProjectRecord(
  projectId: string,
): Promise<AnnotationProject | null> {
  const projects = await loadAnnotationProjects();
  const index = projects.findIndex((item) => item.id === projectId);
  if (index < 0) return null;

  const [removed] = projects.splice(index, 1);
  await persistProjects(projects);
  await window.electron.annotation.removeProjectConfig(removed.directoryPath);
  return removed;
}

export async function touchAnnotationProject(
  projectId: string,
): Promise<AnnotationProject | null> {
  const projects = await loadAnnotationProjects();
  const index = projects.findIndex((item) => item.id === projectId);
  if (index < 0) return null;

  const updated: AnnotationProject = {
    ...projects[index],
    lastOpenedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  projects[index] = updated;
  await persistProjects(projects);
  await syncProjectConfig(updated);
  return updated;
}

export async function updateAnnotationProject(
  projectId: string,
  input: UpdateAnnotationProjectInput,
): Promise<AnnotationProject | null> {
  const projects = await loadAnnotationProjects();
  const index = projects.findIndex((item) => item.id === projectId);
  if (index < 0) return null;

  const updated: AnnotationProject = {
    ...projects[index],
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    labels: input.labels,
    workspaceMemoryEnabled:
      input.workspaceMemoryEnabled === undefined
        ? projects[index].workspaceMemoryEnabled
        : Boolean(input.workspaceMemoryEnabled),
    updatedAt: new Date().toISOString(),
  };
  projects[index] = updated;
  await persistProjects(projects);
  await syncProjectConfig(updated);
  return updated;
}

export async function validateProjectDirectory(
  directoryPath: string,
): Promise<boolean> {
  const stats = await window.electron.fileSystem.getFileStats(directoryPath);
  return Boolean(stats?.isDirectory);
}

export function findProjectByDirectory(
  projects: AnnotationProject[],
  directoryPath: string,
): AnnotationProject | undefined {
  const normalized = directoryPath.replace(/\\/g, '/').toLowerCase();
  return projects.find(
    (project) =>
      project.directoryPath.replace(/\\/g, '/').toLowerCase() === normalized,
  );
}
