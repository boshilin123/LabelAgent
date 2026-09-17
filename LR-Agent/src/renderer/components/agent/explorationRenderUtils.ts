import type { MessageBlock } from '../../types/agent';
import { isMergeableToolName } from '../../../shared/agentToolKinds';
import { buildExplorationSummary } from '../../services/toolDisplayUtils';
import { isWorkProcessBlock, type ToolCallBlock } from './workHistoryUtils';

export type { ToolCallBlock } from './workHistoryUtils';

export type AssistantRenderSegment =
  | {
      kind: 'exploration';
      key: string;
      tools: ToolCallBlock[];
      summary: string;
    }
  | {
      kind: 'block';
      block: MessageBlock;
      index: number;
    };

/**
 * 合并进「探索」摘要行的块：既要是可折叠的工作过程，又要是检索类工具。
 * 写文件/终端/MCP 等工具虽然也折叠，但在折叠区内逐行显示以保留可读标签。
 */
function isVisibleExplorationTool(block: MessageBlock): block is ToolCallBlock {
  return (
    block.type === 'tool_call' &&
    isWorkProcessBlock(block) &&
    isMergeableToolName(block.name)
  );
}

export function buildAssistantRenderSegments(
  blocks: MessageBlock[],
  indexOrder?: number[],
): AssistantRenderSegment[] {
  const order = indexOrder ?? blocks.map((_, index) => index);
  const segments: AssistantRenderSegment[] = [];
  let cursor = 0;

  while (cursor < order.length) {
    const index = order[cursor];
    const block = blocks[index];
    if (!block) {
      cursor += 1;
      continue;
    }

    if (isVisibleExplorationTool(block)) {
      const group: ToolCallBlock[] = [];
      while (cursor < order.length) {
        const currentIndex = order[cursor];
        const current = blocks[currentIndex];
        if (!current || !isVisibleExplorationTool(current)) {
          break;
        }
        group.push(current);
        cursor += 1;
      }
      segments.push({
        kind: 'exploration',
        key: `exploration-${group[0]?.id ?? index}`,
        tools: group,
        summary: buildExplorationSummary(group),
      });
      continue;
    }

    segments.push({ kind: 'block', block, index });
    cursor += 1;
  }

  return segments;
}
