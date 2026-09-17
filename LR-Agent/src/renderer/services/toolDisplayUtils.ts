/** 工具参数在聊天 UI 中的展示摘要（避免把整文件内容塞进 tool_call 块）。 */

import { isFoldableToolName } from '../../shared/agentToolKinds';

const WRITE_WORKSPACE_FILE = 'write_workspace_file';
const READ_WORKSPACE_FILE = 'read_workspace_file';
const GREP_WORKSPACE = 'grep_workspace';
const GLOB_WORKSPACE = 'glob_workspace';
const LIST_WORKSPACE_DIRECTORY = 'list_workspace_directory';
const READ_DOCUMENT_FILE = 'read_document_file';
const READ_IMAGE_FOR_VISION = 'read_image_for_vision';
const READ_FILE_ANNOTATION = 'read_file_annotation';

/** 该工具名是否属于「工作过程」（可折叠进 Worked for）；清单与判定见 shared/agentToolKinds */
export const isFoldableTool = isFoldableToolName;

function parseArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pathFromArgs(args: Record<string, unknown>): string {
  return String(
    args.relative_path ??
      args.relativePath ??
      args.path ??
      args.relative_dir ??
      args.relativeDir ??
      '',
  ).trim();
}

export function formatToolCallLabel(name: string, argsJson: string): string {
  const args = parseArgs(argsJson);

  if (name === READ_WORKSPACE_FILE) {
    if (!args) return 'Read';
    const p = pathFromArgs(args) || '当前文件';
    const start = args.start_line ?? args.startLine;
    const end = args.end_line ?? args.endLine;
    if (start != null || end != null) {
      const s = start ?? 1;
      const e = end ?? start ?? 1;
      return `Read ${p} L${s}-${e}`;
    }
    return `Read ${p}`;
  }

  if (name === GREP_WORKSPACE) {
    if (!args) return 'Grepped';
    const pattern = String(args.pattern ?? '').trim() || '?';
    const scope = pathFromArgs(args) || 'workspace';
    return `Grepped ${pattern} in ${scope}`;
  }

  if (name === LIST_WORKSPACE_DIRECTORY) {
    if (!args) return 'Listed';
    const dir = pathFromArgs(args) || '.';
    return `Listed ${dir}`;
  }

  if (name === 'glob_workspace') {
    if (!args) return 'Glob';
    const pattern = String(
      args.glob_pattern ?? args.globPattern ?? args.pattern ?? '',
    ).trim();
    return pattern ? `Glob ${pattern}` : 'Glob';
  }

  if (name === 'read_document_file') {
    if (!args) return '文档';
    const p = pathFromArgs(args) || '当前文件';
    return `文档 ${p}`;
  }

  if (name === 'read_file_annotation') {
    if (!args) return '标注';
    return `标注 ${pathFromArgs(args) || '当前文件'}`;
  }

  if (name === 'auto_annotate' || name === 'mutate_annotation') {
    const base = name === 'auto_annotate' ? '自动标注' : '修改标注';
    const req =
      typeof args?.user_request === 'string' ? args.user_request.trim() : '';
    if (!req) return base;
    const short = req.length > 24 ? `${req.slice(0, 24)}…` : req;
    return `${base}：${short}`;
  }

  if (name === 'run_agent_skill_script') {
    if (!args) return '运行 Skill 脚本';
    const skill = String(args.skill_name ?? '').trim();
    const script = String(args.script ?? '').trim() || '?';
    return `运行脚本 ${skill ? `${skill}/` : ''}${script}`;
  }

  if (name === 'start_terminal_command') {
    if (!args) return '终端命令';
    const cmd = String(args.command ?? '').trim();
    const cmdArgs = Array.isArray(args.args) ? args.args.join(' ') : '';
    const label = `终端 ${cmd}${cmdArgs ? ` ${cmdArgs}` : ''}`.trim();
    return label.length > 80 ? `${label.slice(0, 80)}…` : label || '终端命令';
  }

  if (name === 'read_terminal_output') {
    return '读取终端输出';
  }

  if (name === 'kill_terminal_job') {
    return '终止终端任务';
  }

  return name;
}

export function summarizeToolArgumentsForDisplay(
  name: string,
  argsJson: string,
): string {
  if (name === WRITE_WORKSPACE_FILE) {
    try {
      const args = parseArgs(argsJson);
      if (!args) {
        return argsJson;
      }
      const relativePath = pathFromArgs(args);
      const content = typeof args.content === 'string' ? args.content : '';
      const lineCount = content ? content.split('\n').length : 0;
      return JSON.stringify(
        {
          relative_path: relativePath,
          content: `[${content.length} 字符, ${lineCount} 行]`,
        },
        null,
        2,
      );
    } catch {
      if (argsJson.length <= 400) {
        return argsJson;
      }
      return `${argsJson.slice(0, 400)}…`;
    }
  }

  if (name === READ_WORKSPACE_FILE || name === GREP_WORKSPACE) {
    const args = parseArgs(argsJson);
    if (!args) {
      return argsJson;
    }
    return JSON.stringify(args, null, 2);
  }

  if (name === LIST_WORKSPACE_DIRECTORY) {
    const args = parseArgs(argsJson);
    if (!args) {
      return argsJson;
    }
    return JSON.stringify(args, null, 2);
  }

  return argsJson;
}

const MAX_TOOL_RESULT_CHARS = 1200;

export function summarizeToolResultForDisplay(
  name: string,
  result: string,
): string {
  if (!result) {
    return result;
  }

  if (
    name === GREP_WORKSPACE ||
    name === READ_WORKSPACE_FILE ||
    name === LIST_WORKSPACE_DIRECTORY ||
    name === 'run_agent_skill_script' ||
    name === 'read_terminal_output'
  ) {
    if (result.length <= MAX_TOOL_RESULT_CHARS) {
      return result;
    }
    const lineCount = result.split('\n').length;
    return `${result.slice(0, MAX_TOOL_RESULT_CHARS)}…\n[共 ${lineCount} 行, ${result.length} 字符]`;
  }

  return result;
}

export function buildExplorationSummary(tools: { name: string }[]): string {
  let reads = 0;
  let greps = 0;
  let lists = 0;
  let others = 0;

  for (const tool of tools) {
    if (
      tool.name === READ_WORKSPACE_FILE ||
      tool.name === GLOB_WORKSPACE ||
      tool.name === READ_DOCUMENT_FILE ||
      tool.name === READ_IMAGE_FOR_VISION ||
      tool.name === READ_FILE_ANNOTATION
    ) {
      reads += 1;
    } else if (tool.name === GREP_WORKSPACE) greps += 1;
    else if (tool.name === LIST_WORKSPACE_DIRECTORY) lists += 1;
    else others += 1;
  }

  const parts: string[] = [];
  if (reads > 0) {
    parts.push(`${reads} file${reads === 1 ? '' : 's'}`);
  }
  if (greps > 0) {
    parts.push(`${greps} search${greps === 1 ? '' : 'es'}`);
  }
  if (lists > 0) {
    parts.push(`${lists} listing${lists === 1 ? '' : 's'}`);
  }
  // 兜底：合并清单里出现未登记的检索工具时，别谎报成 0
  if (others > 0) {
    parts.push(`${others} call${others === 1 ? '' : 's'}`);
  }

  if (parts.length === 0) {
    return 'Explored workspace';
  }
  return `Explored ${parts.join(', ')}`;
}
