import type { AnnotationProject, AnnotationType } from '../../types/annotation';

const BASE_PROMPTS: Partial<Record<AnnotationType, string>> = {
  caption: '请为当前图片生成内容描述，涵盖主要对象、场景与关键细节。',
  classification: '请根据当前图片内容，从项目标签集中选择最合适的整图分类。',
  instruction:
    '请基于当前文本内容，生成一条高质量的 instruction-output 指令数据。',
  cot: '请基于当前文本内容，生成思维链（CoT）问答数据，包含推理步骤与最终答案。',
  conversation: '请基于当前文本内容，生成多轮对话数据。',
  preference: '请基于当前文本内容，生成偏好对比数据（chosen 与 rejected）。',
  bbox: '请检测当前图片中的所有目标，并将检测框映射到项目标签。',
  rotated_bbox: '请检测当前图片中的旋转目标，并将旋转框映射到项目标签。',
  polygon: '请检测并分割当前图片中的目标，生成多边形并映射到项目标签。',
  keypoint: '请检测当前图片中的关键点骨架实例，并映射到项目标签。',
  span_ner: '请识别当前文本中的所有命名实体，使用项目标签集标注。',
  text_classification: '请为当前文本选择所有适用的分类标签。',
};

export function buildQuickInferencePrompt(
  annotationType: AnnotationType,
  project: AnnotationProject,
): string {
  const base = BASE_PROMPTS[annotationType];
  if (!base) {
    return `请为当前文件生成 ${annotationType} 类型的标注内容。`;
  }
  const description = project.description?.trim();
  if (!description) return base;
  return `${base}\n\n项目说明：${description}`;
}
