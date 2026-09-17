import type {
  AnnotationType,
  ImageAnnotationType,
} from '../renderer/types/annotation';

export type ExportFormatId =
  | 'yolo'
  | 'coco'
  | 'voc'
  | 'labelme'
  | 'csv'
  | 'yolo_seg'
  | 'yolo_obb'
  | 'dota'
  | 'yolo_pose'
  | 'lr_agent'
  | 'jsonl'
  | 'caption_jsonl'
  | 'classification_csv';

export type ExportCoordinateMode = 'pixel' | 'normalized';

export interface ExportFormatOption {
  id: ExportFormatId;
  label: string;
  description: string;
  extension?: string;
}

export interface AnnotationExportOptions {
  format: ExportFormatId;
  outputDir: string;
  coordinateMode: ExportCoordinateMode;
  /** Include indexed files with zero annotations in index */
  includeEmptyImages: boolean;
  /** Copy source images/text into export bundle (training formats), default true */
  includeSourceMedia: boolean;
  /** lr_agent backup: include .lr-agent/annotations tree, default true */
  includeLrAgentAnnotations: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: Pick<
  AnnotationExportOptions,
  'includeSourceMedia' | 'includeLrAgentAnnotations'
> = {
  includeSourceMedia: true,
  includeLrAgentAnnotations: true,
};

export interface KeypointTemplateExportMeta {
  id: string;
  name: string;
  keypoints: { name: string }[];
}

export interface AnnotationExportRequest {
  project: {
    id: string;
    name: string;
    directoryPath: string;
    modality: 'text' | 'image';
    annotationType: AnnotationType;
    labels: { id: string; name: string; color: string }[];
  };
  options: AnnotationExportOptions;
  keypointTemplates?: KeypointTemplateExportMeta[];
}

export interface AnnotationExportResult {
  success: boolean;
  outputDir: string;
  filesWritten: number;
  imageCount: number;
  annotationCount: number;
  skippedUnlabeledCount?: number;
  unknownLabelCount?: number;
  warnings?: string[];
  skippedFiles?: string[];
  message: string;
  error?: string;
}

const LR_AGENT_FORMAT: ExportFormatOption = {
  id: 'lr_agent',
  label: 'LR-Agent 原生 JSON',
  description: '完整保留 annotations 结构并可选拷贝源文件',
};

const TEXT_FORMATS: ExportFormatOption[] = [
  {
    id: 'jsonl',
    label: 'JSONL 训练集',
    description: '按任务类型导出 Alpaca/ShareGPT/DPO 等兼容 JSONL',
  },
  LR_AGENT_FORMAT,
];

const IMAGE_BBOX_FORMATS: ExportFormatOption[] = [
  {
    id: 'yolo',
    label: 'YOLO Detection',
    description: 'labels/*.txt + images/ + data.yaml',
  },
  {
    id: 'coco',
    label: 'COCO JSON',
    description: 'instances.json + images/',
  },
  {
    id: 'voc',
    label: 'Pascal VOC XML',
    description: 'Annotations/*.xml + images/',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: 'labelme/*.json + images/',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: '扁平 CSV：image, class, x, y, w, h',
  },
  LR_AGENT_FORMAT,
];

const IMAGE_POLYGON_FORMATS: ExportFormatOption[] = [
  {
    id: 'coco',
    label: 'COCO JSON (分割)',
    description: 'segmentation 多边形 + images/',
  },
  {
    id: 'yolo_seg',
    label: 'YOLO Segmentation',
    description: 'labels/*.txt + images/',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: 'polygon labelme + images/',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: '每行一个顶点',
  },
  LR_AGENT_FORMAT,
];

const IMAGE_KEYPOINT_FORMATS: ExportFormatOption[] = [
  {
    id: 'coco',
    label: 'COCO Keypoints JSON',
    description: 'keypoints.json + images/',
  },
  {
    id: 'yolo_pose',
    label: 'YOLO Pose',
    description: 'labels/*.txt + images/',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: '点/pose labelme + images/',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: 'image, class, kpt_index, x, y, visibility',
  },
  LR_AGENT_FORMAT,
];

const IMAGE_ROTATED_BBOX_FORMATS: ExportFormatOption[] = [
  {
    id: 'yolo_obb',
    label: 'YOLO OBB',
    description: 'labels/*.txt + images/',
  },
  {
    id: 'dota',
    label: 'DOTA',
    description: 'labelTxt/*.txt + images/',
  },
  {
    id: 'labelme',
    label: 'LabelMe JSON',
    description: '旋转框 labelme + images/',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    description: 'image, class, cx, cy, w, h, angle_deg',
  },
  LR_AGENT_FORMAT,
];

const CAPTION_FORMATS: ExportFormatOption[] = [
  {
    id: 'caption_jsonl',
    label: 'Caption JSONL',
    description: '每行 image + text，含 images/',
  },
  LR_AGENT_FORMAT,
];

const CLASSIFICATION_FORMATS: ExportFormatOption[] = [
  {
    id: 'classification_csv',
    label: 'Classification CSV',
    description: 'image, label 多标签 CSV + images/',
  },
  LR_AGENT_FORMAT,
];

export function getExportFormatsForType(
  annotationType: AnnotationType,
): ExportFormatOption[] {
  switch (annotationType) {
    case 'bbox':
      return IMAGE_BBOX_FORMATS;
    case 'polygon':
      return IMAGE_POLYGON_FORMATS;
    case 'keypoint':
      return IMAGE_KEYPOINT_FORMATS;
    case 'rotated_bbox':
      return IMAGE_ROTATED_BBOX_FORMATS;
    case 'caption':
      return CAPTION_FORMATS;
    case 'classification':
      return CLASSIFICATION_FORMATS;
    case 'span_ner':
    case 'text_classification':
    case 'instruction':
    case 'preference':
    case 'conversation':
    case 'cot':
      return TEXT_FORMATS;
    default:
      return [LR_AGENT_FORMAT];
  }
}

export function isImageAnnotationType(
  value: AnnotationType,
): value is ImageAnnotationType {
  return (
    value === 'bbox' ||
    value === 'polygon' ||
    value === 'keypoint' ||
    value === 'rotated_bbox' ||
    value === 'caption' ||
    value === 'classification'
  );
}

export function defaultExportFormat(
  annotationType: AnnotationType,
): ExportFormatId {
  const formats = getExportFormatsForType(annotationType);
  return formats[0]?.id ?? 'lr_agent';
}
