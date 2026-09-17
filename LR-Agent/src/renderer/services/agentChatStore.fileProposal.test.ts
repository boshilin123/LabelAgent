import {
  applyStreamEventToBlocks,
  resolveFileProposalOperation,
  resolveFileProposalPath,
  resolveFileProposalTitle,
} from './agentChatStore';
import type { MessageBlock, StreamEvent } from '../../shared/agentTypes';

describe('resolveFileProposalPath', () => {
  it('prefers suggestedRelativePath then image_path', () => {
    expect(
      resolveFileProposalPath({
        suggestedRelativePath: 'a.md',
        image_path: 'b.md',
      }),
    ).toBe('a.md');
    expect(resolveFileProposalPath({ image_path: 'notes/readme.md' })).toBe(
      'notes/readme.md',
    );
  });
});

describe('applyStreamEventToBlocks file_proposal', () => {
  it('maps snake_case SSE fields to file_proposal block', () => {
    const fromSnake = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '# Hello',
      image_path: 'docs/readme.md',
      summary: 'Readme',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);

    expect(fromSnake).toHaveLength(1);
    expect(fromSnake[0]).toMatchObject({
      type: 'file_proposal',
      suggestedRelativePath: 'docs/readme.md',
      title: 'Readme',
      content: '# Hello',
    });
  });

  it('preserves path from prior block when final event omits path', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      title: 'Notes',
      suggestedRelativePath: 'notes/todo.md',
      detail: '0',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'body',
      image_path: 'notes/todo.md',
      summary: 'Notes',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      suggestedRelativePath: 'notes/todo.md',
      content: 'body',
    });
  });

  it('resolveFileProposalTitle uses summary fallback', () => {
    expect(resolveFileProposalTitle({ summary: 'My Doc' })).toBe('My Doc');
    expect(resolveFileProposalTitle({})).toBe('文件');
  });

  it('drops file_proposal events targeting .lr-agent', () => {
    const start = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      suggestedRelativePath: '.lr-agent/annotations/files/abc.json',
      title: 'Annotation',
      detail: '0',
    });
    expect(start).toHaveLength(0);

    const final = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '{"annotations":[]}',
      image_path: '.lr-agent/annotations/files/abc.json',
      summary: 'Annotation',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    expect(final).toHaveLength(0);
  });

  it('places file_proposal after the matching tool and keeps later text behind it', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 't-write',
      name: 'write_workspace_file',
      arguments: JSON.stringify({ relative_path: 'doc.md', content: 'hi' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'hi',
      image_path: 'doc.md',
      summary: 'Doc',
    } as unknown as StreamEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '已写好。',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'tool_call',
      'file_proposal',
      'text',
    ]);
  });
});

describe('resolveFileProposalOperation', () => {
  it('uses SSE operation or mode=delete', () => {
    expect(resolveFileProposalOperation({ operation: 'delete' })).toBe(
      'delete',
    );
    expect(resolveFileProposalOperation({ mode: 'delete' })).toBe('delete');
    expect(resolveFileProposalOperation({ mode: 'write' })).toBe('write');
  });

  it('infers delete from a matching delete_workspace_file tool', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'tool_call',
        id: 't-del',
        name: 'delete_workspace_file',
        arguments: JSON.stringify({ relative_path: 'notes.md' }),
        status: 'done',
        collapsed: true,
      },
    ];
    expect(
      resolveFileProposalOperation(
        { image_path: 'notes.md', content: '', summary: 'notes.md' },
        blocks,
      ),
    ).toBe('delete');
  });

  it('infers delete from an empty payload titled as a deletion', () => {
    expect(
      resolveFileProposalOperation({
        summary: '删除 notes.md',
        content: '',
        image_path: 'notes.md',
      }),
    ).toBe('delete');
    expect(
      resolveFileProposalOperation({
        summary: 'delete-me.md',
        content: '',
        image_path: 'delete-me.md',
      }),
    ).toBe('write');
  });

  it('stores delete operation from SSE onto the file_proposal block', () => {
    const blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '',
      image_path: 'notes.md',
      summary: '删除 notes.md',
      mode: 'delete',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      operation: 'delete',
      suggestedRelativePath: 'notes.md',
    });
  });

  it('infers delete onto the block when a matching delete tool already exists', () => {
    let blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 't-del',
      name: 'delete_workspace_file',
      arguments: JSON.stringify({ relative_path: 'notes.md' }),
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: '',
      image_path: 'notes.md',
      summary: 'notes.md',
    } as unknown as StreamEvent);
    expect(blocks.map((b) => b.type)).toEqual(['tool_call', 'file_proposal']);
    expect(blocks[1]).toMatchObject({ operation: 'delete' });
  });

  it('re-streaming the same file resets applied status so the new round can be applied again', () => {
    // 回归：同一文件 Keep All 之后，新一轮修改提案（新的 start）必须回到
    // pending，否则 Keep All 不再收集它，落盘静默失效。
    let blocks: MessageBlock[] = [
      {
        type: 'file_proposal',
        title: 'Doc',
        content: 'kept',
        suggestedRelativePath: 'doc.md',
        status: 'applied',
        hasCheckpoint: true,
      },
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_start',
      title: 'Doc',
      suggestedRelativePath: 'doc.md',
      detail: '0',
    });
    // 新一轮提案回到 pending，仅沿用上一轮的 hasCheckpoint 供 Undo 展示
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      status: 'pending',
      hasCheckpoint: true,
      content: '',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'newer',
      image_path: 'doc.md',
      summary: 'Doc',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      status: 'pending',
      hasCheckpoint: true,
      content: 'newer',
    });
  });

  it('keeps applied status when a late final event replays without a new start', () => {
    // 同一提案生命周期内的迟到重复 SSE 不得把已应用状态冲回 pending
    let blocks: MessageBlock[] = [
      {
        type: 'file_proposal',
        title: 'Doc',
        content: 'kept',
        suggestedRelativePath: 'doc.md',
        status: 'applied',
        hasCheckpoint: true,
      },
    ];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'kept',
      image_path: 'doc.md',
      summary: 'Doc',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      status: 'applied',
      hasCheckpoint: true,
    });
  });

  it('merges proposal blocks whose paths only differ in spelling', () => {
    // 回归：流式事件的原始路径与定稿事件的归一化路径（反斜杠、./ 前缀）
    // 不应裂成两张卡片。
    let blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      title: 'Doc',
      suggestedRelativePath: './docs\\a.md',
      detail: '0',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_delta',
      content: 'hello',
      suggestedRelativePath: 'docs\\a.md',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'hello world',
      image_path: 'docs/a.md',
      summary: 'Doc',
    } as unknown as StreamEvent);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      suggestedRelativePath: 'docs/a.md',
      content: 'hello world',
    });
  });

  it('drops deltas appended after the full content event without a new start', () => {
    // 回归：流式拦截器跨轮状态错乱时，会把另一文件的内容 delta 错标到
    // 本路径上；全量事件已定稿的 block 不能再被追加，否则 Keep All 会把
    // 串写的内容原样落盘。
    let blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      title: 'Union Find',
      suggestedRelativePath: 'algorithm/union_find.h',
      detail: '0',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_delta',
      content: '#ifndef UNION_FIND_H\n',
      suggestedRelativePath: 'algorithm/union_find.h',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: '#ifndef UNION_FIND_H\n#endif\n',
      image_path: 'algorithm/union_find.h',
      summary: 'Union Find',
    } as unknown as StreamEvent);

    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_delta',
      content: 'int main() { /* 来自 test.cpp 的串写内容 */ }',
      suggestedRelativePath: 'algorithm/union_find.h',
    });

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      content: '#ifndef UNION_FIND_H\n#endif\n',
    });
  });

  it('re-streaming the same file resets content so new deltas append cleanly', () => {
    // 合法场景：新一轮推理重写同一文件，start 重置后 delta 应正常累积。
    let blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal_start',
      title: 'Doc',
      suggestedRelativePath: 'doc.md',
      detail: '0',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'old full content',
      image_path: 'doc.md',
      summary: 'Doc',
    } as unknown as StreamEvent);

    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_start',
      title: 'Doc',
      suggestedRelativePath: 'doc.md',
      detail: '0',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_delta',
      content: 'new ',
      suggestedRelativePath: 'doc.md',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal_delta',
      content: 'content',
      suggestedRelativePath: 'doc.md',
    });

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      content: 'new content',
      contentFinalized: false,
    });
  });
});

describe('applyStreamEventToBlocks file_edit_delta', () => {
  const startEvent = {
    type: 'file_proposal_start',
    title: 'Doc',
    suggestedRelativePath: 'doc.md',
    detail: '0',
    mode: 'edit',
  } as unknown as Parameters<typeof applyStreamEventToBlocks>[1];

  it('accumulates oldString/newString from edit deltas', () => {
    let blocks = applyStreamEventToBlocks([], startEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_edit_delta',
      oldDelta: 'print(1)',
      suggestedRelativePath: 'doc.md',
    } as unknown as StreamEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_edit_delta',
      newDelta: 'print(',
      oldDelta: undefined,
      suggestedRelativePath: 'doc.md',
    } as unknown as StreamEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_edit_delta',
      newDelta: '2)',
      suggestedRelativePath: 'doc.md',
    } as unknown as StreamEvent);

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      oldString: 'print(1)',
      newString: 'print(2)',
      content: '',
      contentFinalized: false,
    });
  });

  it('drops late edit deltas after finalization and clears streaming fields', () => {
    let blocks = applyStreamEventToBlocks([], startEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_edit_delta',
      oldDelta: 'old',
      newDelta: 'new',
      suggestedRelativePath: 'doc.md',
    } as unknown as StreamEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: 'full new content',
      image_path: 'doc.md',
      summary: 'Doc',
      mode: 'edit',
    } as unknown as StreamEvent);

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      content: 'full new content',
      contentFinalized: true,
    });
    expect(blocks[0]).not.toHaveProperty('oldString');
    expect(blocks[0]).not.toHaveProperty('newString');

    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_edit_delta',
      oldDelta: 'stray',
      newDelta: 'stray',
      suggestedRelativePath: 'doc.md',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({ content: 'full new content' });
  });

  it('stores rename operation and oldPath from the final event', () => {
    const blocks = applyStreamEventToBlocks([], {
      type: 'file_proposal',
      content: '',
      image_path: 'docs/renamed.md',
      old_path: 'docs/old-name.md',
      summary: '移动 notes',
      mode: 'rename',
    } as unknown as StreamEvent);

    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      operation: 'rename',
      suggestedRelativePath: 'docs/renamed.md',
      oldPath: 'docs/old-name.md',
    });
  });

  it('stores dismissed status from an error-cleanup final event', () => {
    let blocks = applyStreamEventToBlocks([], startEvent);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'file_proposal',
      content: '',
      image_path: 'doc.md',
      summary: 'Doc',
      mode: 'edit',
      status: 'dismissed',
    } as unknown as StreamEvent);
    expect(blocks[0]).toMatchObject({
      type: 'file_proposal',
      status: 'dismissed',
    });
  });
});
