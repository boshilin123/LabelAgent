import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';

const REGISTRY_VERSION = 1;
const PROJECT_CONFIG_DIR = '.lr-agent';
const PROJECT_CONFIG_FILE = 'project.json';

interface RegistryFile {
  version: number;
  projects: unknown[];
}

function getRegistryPath(): string {
  return path.join(app.getPath('userData'), 'annotation-projects.json');
}

function getProjectConfigPath(directoryPath: string): string {
  return path.join(directoryPath, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
}

async function readRegistry(): Promise<RegistryFile> {
  const registryPath = getRegistryPath();
  try {
    if (!(await fs.pathExists(registryPath))) {
      return { version: REGISTRY_VERSION, projects: [] };
    }
    const data = await fs.readJson(registryPath);
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
      return { version: REGISTRY_VERSION, projects: [] };
    }
    return {
      version: REGISTRY_VERSION,
      projects: data.projects,
    };
  } catch {
    return { version: REGISTRY_VERSION, projects: [] };
  }
}

async function writeRegistry(projects: unknown[]): Promise<void> {
  const registryPath = getRegistryPath();
  await fs.ensureDir(path.dirname(registryPath));
  await fs.writeJson(
    registryPath,
    { version: REGISTRY_VERSION, projects },
    { spaces: 2 },
  );
}

export async function getAnnotationProjects(): Promise<unknown[]> {
  const registry = await readRegistry();
  return registry.projects;
}

export async function saveAnnotationProjects(
  projects: unknown[],
): Promise<void> {
  await writeRegistry(projects);
}

export async function writeProjectDirConfig(
  directoryPath: string,
  project: unknown,
): Promise<void> {
  const configPath = getProjectConfigPath(directoryPath);
  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJson(configPath, project, { spaces: 2 });
}

export async function removeProjectDirConfig(
  directoryPath: string,
): Promise<void> {
  const configPath = getProjectConfigPath(directoryPath);
  if (await fs.pathExists(configPath)) {
    await fs.remove(configPath);
  }
}
