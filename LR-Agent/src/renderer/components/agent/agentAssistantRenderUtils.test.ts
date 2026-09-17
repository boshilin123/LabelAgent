import type { MessageBlock } from '../../../shared/agentTypes';
import {
  shouldHideToolCallInChat,
  shouldSkipRedundantFileText,
} from './agentAssistantRenderUtils';

describe('shouldHideToolCallInChat', () => {
  it('keeps write_workspace_file visible when file_proposal exists', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        id: 'tc-1',
        name: 'write_workspace_file',
        arguments: '{}',
        status: 'done',
        collapsed: true,
      },
      {
        type: 'file_proposal',
        title: '代码',
        content: 'int main() {}',
        suggestedRelativePath: 'main.cpp',
        status: 'pending',
      },
    ];
    const tool = blocks[0] as Extract<MessageBlock, { type: 'tool_call' }>;
    expect(shouldHideToolCallInChat(tool, blocks)).toBe(false);
  });

  it('keeps unrelated sync tools visible', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        id: 'tc-2',
        name: 'read_workspace_file',
        arguments: '{"relative_path":"a.txt"}',
        status: 'done',
        collapsed: true,
      },
    ];
    const tool = blocks[0] as Extract<MessageBlock, { type: 'tool_call' }>;
    expect(shouldHideToolCallInChat(tool, blocks)).toBe(false);
  });

  it('keeps mutate_annotation visible when an annotation_proposal exists', () => {
    const tool: Extract<MessageBlock, { type: 'tool_call' }> = {
      type: 'tool_call',
      id: 'tc-mut',
      name: 'mutate_annotation',
      arguments: '{}',
      status: 'done',
      collapsed: true,
    };
    const blocks: MessageBlock[] = [
      tool,
      {
        type: 'annotation_proposal',
        status: 'pending',
        proposal: {
          id: 'p1',
          projectId: 'proj',
          summary: '删除',
          changes: [],
          stats: {
            kind: 'generic',
            processed: 0,
            succeeded: 0,
            skipped: 0,
          },
          createdAt: 1,
        },
      },
    ];
    expect(shouldHideToolCallInChat(tool, blocks)).toBe(false);
  });
});

describe('shouldSkipRedundantFileText', () => {
  it('skips text that duplicates file proposal content', () => {
    const code = '#include <bits/stdc++.h>\nint main() { return 0; }';
    const blocks: MessageBlock[] = [
      {
        type: 'file_proposal',
        title: 'main',
        content: code,
        suggestedRelativePath: 'main.cpp',
        status: 'pending',
      },
    ];
    expect(shouldSkipRedundantFileText(code, blocks)).toBe(true);
  });
});
