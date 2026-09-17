/**
 * 工具名分类（渲染层）。
 *
 * 聊天时间线把「工作过程」折叠进 Worked for。判定采用排除式：只有少数几个工具
 * 无论何时都不折叠，其余工具在调用正常结束后都会折叠——MCP 动态发现出来的工具
 * 名字任意（tavily_search、listModels…），白名单方式覆盖不了它们。
 *
 * 交付物卡片（文件提案 / 标注提案 / 标注流水线）不是工具行，是否折叠由
 * workHistoryUtils 的结算状态判定：待确认的必须留在主时间线供审阅。
 */

/**
 * 绝不折叠的工具。
 *
 * explore_readonly：正常以 subagent 行呈现（含打开子代理 transcript 的入口），
 * 折进历史后历史消息里就点不开了，故永久保留在主时间线。
 */
export const NEVER_FOLD_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'explore_readonly',
]);

/** 产出文件提案的工具，与后端 tool_registry_meta 中 PROPOSAL runner 对齐 */
export const PROPOSAL_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'move_workspace_file',
]);

/** 会生成标注 pipeline 卡的客户端工具 */
export const CLIENT_PIPELINE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'auto_annotate',
  'mutate_annotation',
]);

/** 该工具名是否可折叠（不含状态判断，状态判断见 workHistoryUtils） */
export function isFoldableToolName(name: string): boolean {
  return !NEVER_FOLD_TOOL_NAMES.has(name);
}

/**
 * 折叠区内可合并成一行摘要的「检索类」工具。
 *
 * 合并只为压缩大量同质的读取/搜索调用；写文件、终端、MCP 等工具即便已折叠，
 * 也在折叠区里各占一行以保留可读标签（否则「改了哪个文件」会被压成 "1 call"）。
 * 这份清单只影响摘要行的合并，不影响折叠与否。
 */
export const MERGEABLE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'read_workspace_file',
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
  'read_document_file',
  'read_image_for_vision',
  'read_file_annotation',
]);

export function isMergeableToolName(name: string): boolean {
  return MERGEABLE_TOOL_NAMES.has(name);
}
