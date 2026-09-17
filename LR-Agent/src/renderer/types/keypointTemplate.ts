import type { LabelDefinition } from './annotation';
import { LABEL_COLOR_PRESETS } from './annotation';
import personJson from '../assets/keypointTemplates/person.json';
import handJson from '../assets/keypointTemplates/hand.json';
import faceJson from '../assets/keypointTemplates/face.json';

export interface KeypointTemplateKeypoint {
  name: string;
  color: string;
  defaultPos: [number, number];
}

export interface KeypointTemplate {
  id: string;
  name: string;
  /** Default class name — matched against project labels (case-insensitive) */
  defaultLabel: string;
  description?: string;
  kptShape: [number, number];
  keypoints: KeypointTemplateKeypoint[];
  connections: [number, number][];
}

interface RawTemplateJson {
  name: string;
  label: string;
  description?: string;
  kpt_shape: [number, number];
  keypoints: { name: string; color: string; default_pos: [number, number] }[];
  connections: [number, number][];
}

function slugId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function normalizeTemplate(raw: RawTemplateJson): KeypointTemplate {
  const keypoints = raw.keypoints.map((kp) => ({
    name: kp.name,
    color: kp.color,
    defaultPos: [...kp.default_pos] as [number, number],
  }));

  if (keypoints.length > 0) {
    const xs = keypoints.map((k) => k.defaultPos[0]);
    const ys = keypoints.map((k) => k.defaultPos[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const targetMinX = 0.144;
    const targetMaxX = 0.856;
    const targetMinY = 0.096;
    const targetMaxY = 0.904;
    const targetSpanX = targetMaxX - targetMinX;
    const targetSpanY = targetMaxY - targetMinY;

    keypoints.forEach((kp) => {
      const [x, y] = kp.defaultPos;
      kp.defaultPos = [
        spanX > 0
          ? Math.round(
              (targetMinX + ((x - minX) / spanX) * targetSpanX) * 100000,
            ) / 100000
          : 0.5,
        spanY > 0
          ? Math.round(
              (targetMinY + ((y - minY) / spanY) * targetSpanY) * 100000,
            ) / 100000
          : 0.5,
      ];
    });
  }

  return {
    id: slugId(raw.name),
    name: raw.name,
    defaultLabel: raw.label,
    description: raw.description,
    kptShape: raw.kpt_shape,
    keypoints,
    connections: raw.connections.map(([a, b]) => [a, b] as [number, number]),
  };
}

const RAW_TEMPLATES: RawTemplateJson[] = [
  personJson as RawTemplateJson,
  handJson as RawTemplateJson,
  faceJson as RawTemplateJson,
];

export const KEYPOINT_TEMPLATES: KeypointTemplate[] =
  RAW_TEMPLATES.map(normalizeTemplate);

export const DEFAULT_KEYPOINT_TEMPLATE_ID =
  KEYPOINT_TEMPLATES[0]?.id ?? 'person_coco';

export function getKeypointTemplate(id: string): KeypointTemplate | undefined {
  return KEYPOINT_TEMPLATES.find((t) => t.id === id);
}

export function resolveLabelIdForTemplate(
  template: KeypointTemplate,
  labels: LabelDefinition[],
): string | null {
  const target = template.defaultLabel.trim().toLowerCase();
  if (!target) return null;
  const match = labels.find((l) => l.name.trim().toLowerCase() === target);
  return match?.id ?? null;
}

/** Templates whose defaultLabel equals the given project label name */
export function findTemplatesByDefaultLabel(
  labelName: string,
): KeypointTemplate[] {
  const key = labelName.trim().toLowerCase();
  if (!key) return [];
  return KEYPOINT_TEMPLATES.filter(
    (t) => t.defaultLabel.trim().toLowerCase() === key,
  );
}

export function formatKeypointLabelRenameWarning(
  oldName: string,
  newName: string,
  templates: KeypointTemplate[],
): string {
  const templateNames = templates.map((t) => t.name).join('、');
  return `将「${oldName}」改名为「${newName}」后，${templateNames} 骨架模板将无法自动匹配该标签，放置骨架可能失败。确定继续吗？`;
}

/** Default labels for all built-in skeleton templates (person / hand / face) */
export function buildDefaultKeypointLabels(): LabelDefinition[] {
  const seen = new Set<string>();
  const result: LabelDefinition[] = [];

  KEYPOINT_TEMPLATES.forEach((t, index) => {
    const name = t.defaultLabel.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    result.push({
      id: crypto.randomUUID(),
      name,
      color: LABEL_COLOR_PRESETS[index % LABEL_COLOR_PRESETS.length],
    });
  });

  return result;
}

/** Initial pose bbox size as fraction of natural image dimensions */
export const DEFAULT_POSE_WIDTH_RATIO = 0.15;
export const DEFAULT_POSE_HEIGHT_RATIO = 0.22;

/** Ultralytics-style tight bbox padding = max(2% image height, 10px) */
export function computeTightPosePadding(imageHeight: number): number {
  return Math.max(imageHeight * 0.02, 10);
}
