/**
 * F1：候选引擎（official `create_agent`）SSE 帧 → **真实渲染层 reducer** 状态等价性。
 *
 * ## 被测的真实代码（不是替身）
 * - `./agentChatStore.ts`  → `applyStreamEventToBlocks`（:730）
 *                            `finalizeSubagentBlocks`（:238）
 *                            `finalizeAnnotationPipelineBlock`（:268）
 * - `./turnToolHistory.ts` → `TurnToolHistoryAccumulator`（agentJobRegistry.ts:853
 *                            `turnHistory.apply(event)` 的同一实现）
 * - `./agentJobRegistry.ts`→ `toolResultHasPendingProposal`（:145，AwaitingConfirm 判定）
 * - `../../shared/agentTypes.ts` → `CLIENT_TOOL_NAME_SET`（:385）
 *
 * ## 帧来源
 * `.venvs/_logs/agent_contract_frames.json`，由
 * `experiments/dump_agent_contract_frames.py` 生成；两侧都真实经过
 * `app.api.v1.agent._stream_local_chat`（HTTP/SSE 层）。
 *
 * ## 驱动顺序
 * 严格按 `AgentChatContext.tsx` 的 `subscribeJobEvents` 回调复刻：
 *   :982-1052 done / awaiting_confirmation → 终态 + finalize
 *   :1055-1085 error                       → 终态 + finalize
 *   :1120-1147 context_updated             → 仅会话元数据，不动 blocks
 *   :1149-1157 preparing                   → 仅 streamPhase，不动 blocks
 *   :1159-1161 route_decided               → no-op
 *   :1163-1169 其余                        → applyStreamEventToBlocks
 *
 * ## 非空洞性（本测试的关键）
 * 若候选帧的字段名不被 reducer 识别，两侧会**同样**得到空/残缺状态而"相等"。
 * 因此每条场景都额外断言由帧自身推出的结构不变量（文本拼接、tool_start→块、
 * tool_result→终态），并对照关键场景做显式期望。
 */

import fs from 'fs';
import path from 'path';
import type {
  ChatMessage,
  MessageBlock,
  StreamEvent,
} from '../../shared/agentTypes';
import { CLIENT_TOOL_NAME_SET } from '../../shared/agentTypes';
import {
  applyStreamEventToBlocks,
  finalizeAnnotationPipelineBlock,
  finalizeSubagentBlocks,
  resolveFileProposalPath,
} from './agentChatStore';
import { toolResultHasPendingProposal } from './agentJobRegistry';
import { TurnToolHistoryAccumulator } from './turnToolHistory';

// ── 帧装置 ────────────────────────────────────────────────────────────

type Frame = StreamEvent & Record<string, unknown>;

interface ScenarioFixture {
  baselineClass: string;
  old: Frame[];
  new: Frame[];
}

interface FixtureDocument {
  meta: {
    scenario_count: number;
    all_equal: boolean;
    failures: string[];
    testset_fingerprint: { files: number; digest: string };
  };
  scenarios: Record<string, ScenarioFixture>;
}

const FIXTURE_CANDIDATES = [
  path.resolve(__dirname, '../../../../.venvs/_logs/agent_contract_frames.json'),
  path.resolve(__dirname, '../../.venvs/_logs/agent_contract_frames.json'),
];

function loadFixture(): FixtureDocument {
  const found = FIXTURE_CANDIDATES.find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!found) {
    throw new Error(
      `未找到帧装置 JSON，请先运行 experiments/dump_agent_contract_frames.py。\n查找过：\n${FIXTURE_CANDIDATES.join('\n')}`,
    );
  }
  return JSON.parse(fs.readFileSync(found, 'utf8')) as FixtureDocument;
}

const fixture = loadFixture();
const scenarioNames = Object.keys(fixture.scenarios).sort();

// ── 渲染层状态驱动 ────────────────────────────────────────────────────

interface DrivenState {
  blocks: MessageBlock[];
  messageStatus: 'streaming' | 'done' | 'awaiting_confirmation' | 'error';
  streamPhase: 'waiting-model' | null;
  turnHistory: ReturnType<TurnToolHistoryAccumulator['snapshot']>;
  /** agentJobRegistry.ts:145 对每个 tool_result 帧的 AwaitingConfirm 判定 */
  pendingProposalDecisions: boolean[];
}

function assistantMessage(id: string, blocks: MessageBlock[]): ChatMessage {
  return {
    id,
    sessionId: 'sess-1',
    role: 'assistant',
    blocks,
    status: 'streaming',
    providerId: 'p1',
    model: 'm1',
    createdAt: 1,
    updatedAt: 1,
  };
}

function driveRenderer(frames: Frame[], messageId: string): DrivenState {
  const message = assistantMessage(messageId, []);
  let blocks = message.blocks;
  let messageStatus: DrivenState['messageStatus'] = 'streaming';
  let streamPhase: DrivenState['streamPhase'] = null;

  const turnHistory = new TurnToolHistoryAccumulator();
  const pendingProposalDecisions: boolean[] = [];

  for (const frame of frames) {
    // agentJobRegistry.ts:853 —— 与 emitJobEvent 同序
    turnHistory.apply(frame);

    if (frame.type === 'done' || frame.type === 'awaiting_confirmation') {
      // AgentChatContext.tsx:982-1052
      messageStatus =
        frame.type === 'awaiting_confirmation'
          ? 'awaiting_confirmation'
          : 'done';
      blocks = finalizeSubagentBlocks(
        blocks.map((block) => {
          if (block.type === 'annotation_pipeline') {
            return finalizeAnnotationPipelineBlock(block, 'done');
          }
          if (block.type === 'tool_call') {
            const settle =
              CLIENT_TOOL_NAME_SET.has(block.name) &&
              (block.status === 'queued' || block.status === 'running');
            return settle
              ? { ...block, collapsed: true, status: 'done' as const }
              : { ...block, collapsed: true };
          }
          if (block.type === 'reasoning') {
            return { ...block, collapsed: true };
          }
          return block;
        }),
        'error',
      );
      continue;
    }

    if (frame.type === 'error') {
      // AgentChatContext.tsx:1055-1085
      messageStatus = 'error';
      blocks = finalizeSubagentBlocks(
        blocks.map((block) =>
          block.type === 'annotation_pipeline'
            ? {
                ...block,
                collapsed: true,
                steps: block.steps.map((step) =>
                  step.status === 'running'
                    ? { ...step, status: 'error' as const }
                    : step,
                ),
              }
            : block,
        ),
        'error',
      );
      continue;
    }

    if (frame.type === 'context_updated') continue; // :1120
    if (frame.type === 'preparing') {
      streamPhase = 'waiting-model'; // :1149
      continue;
    }
    if (frame.type === 'route_decided') continue; // :1159

    // agentJobRegistry.ts:964 的 HITL 判定（真实函数）
    if (frame.type === 'tool_result') {
      pendingProposalDecisions.push(
        toolResultHasPendingProposal(String(frame.result ?? '')),
      );
    }

    blocks = applyStreamEventToBlocks(blocks, frame); // :1163-1169
  }

  return {
    blocks,
    messageStatus,
    streamPhase,
    turnHistory: turnHistory.snapshot(),
    pendingProposalDecisions,
  };
}

/** 去掉时间戳，用于比较结构（本批帧不含 subagent，正常不会出现差异）。 */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    Object.keys(value as Record<string, unknown>)
      .sort()
      .forEach((key) => {
        if (/At$/.test(key)) return;
        out[key] = stripVolatile((value as Record<string, unknown>)[key]);
      });
    return out;
  }
  return value;
}

function textOf(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { type: 'text' }> =>
      block.type === 'text',
    )
    .map((block) => block.content)
    .join('');
}

function frameText(frames: Frame[]): string {
  return frames
    .filter((frame) => frame.type === 'text_delta')
    .map((frame) => String(frame.content ?? ''))
    .join('');
}

function toolStarts(frames: Frame[]): Array<{ id: string; name: string }> {
  return frames
    .filter((frame) => frame.type === 'tool_start')
    .map((frame) => ({
      id: String(frame.toolCallId ?? ''),
      name: String(frame.name ?? ''),
    }));
}

describe('候选帧装置（fixture）元数据', () => {
  it('场景集与装置自述一致，且不少于 15 个场景，OLD/NEW 逐帧相等', () => {
    // 不断言硬编码 15：`experiments/compare_agent_contract.py` 的场景集
    // 仍在增长（另有并发任务在加场景），只要求"自述一致 + 至少 15 条"。
    expect(fixture.meta.scenario_count).toBe(scenarioNames.length);
    expect(fixture.meta.scenario_count).toBeGreaterThanOrEqual(15);
    expect(fixture.meta.failures).toEqual([]);
    expect(fixture.meta.all_equal).toBe(true);
  });

  it('每个场景都携带非空 OLD 与 NEW 帧列表', () => {
    scenarioNames.forEach((name) => {
      const scenario = fixture.scenarios[name];
      expect(scenario.old.length).toBeGreaterThan(0);
      expect(scenario.new.length).toBeGreaterThan(0);
      expect(scenario.new).toEqual(scenario.old);
    });
  });
});

describe('候选帧 → 真实渲染层 reducer：OLD 与 NEW 状态深度相等', () => {
  it.each(scenarioNames)('%s', (name) => {
    const scenario = fixture.scenarios[name];
    const oldState = driveRenderer(scenario.old, 'msg-old');
    const newState = driveRenderer(scenario.new, 'msg-new');

    // 1) 逐字段深度相等（blocks 是 UI 的全部真相）
    expect(stripVolatile(newState.blocks)).toEqual(
      stripVolatile(oldState.blocks),
    );
    expect(newState.blocks).toEqual(oldState.blocks);
    expect(newState.messageStatus).toBe(oldState.messageStatus);
    expect(newState.streamPhase).toBe(oldState.streamPhase);
    expect(newState.turnHistory).toEqual(oldState.turnHistory);
    expect(newState.pendingProposalDecisions).toEqual(
      oldState.pendingProposalDecisions,
    );
  });
});

describe('非空洞性：帧真的被 reducer 消费', () => {
  it.each(scenarioNames)('%s 的帧产生了非空且可对账的块状态', (name) => {
    const frames = fixture.scenarios[name].new;
    const state = driveRenderer(frames, 'msg-new');

    // 每条场景都至少产出一个块（否则"相等"毫无意义）
    expect(state.blocks.length).toBeGreaterThan(0);

    // 文本帧的全部内容都进了 text 块（未被丢弃/截断）
    expect(textOf(state.blocks)).toBe(frameText(frames));

    // 每个 tool_start 都落成了同名同 id 的 tool_call 块
    const starts = toolStarts(frames);
    starts.forEach((start) => {
      const block = state.blocks.find(
        (item) => item.type === 'tool_call' && item.id === start.id,
      );
      expect(block).toBeDefined();
      expect(block && block.type === 'tool_call' && block.name).toBe(start.name);
    });

    // 每个 tool_result 都让对应块收终（不是永远 running/queued）
    frames
      .filter((frame) => frame.type === 'tool_result')
      .forEach((frame) => {
        const block = state.blocks.find(
          (item) =>
            item.type === 'tool_call' && item.id === String(frame.toolCallId),
        );
        expect(block).toBeDefined();
        if (block && block.type === 'tool_call') {
          expect(['done', 'queued']).toContain(block.status);
        }
      });

    // 帧以 done 结尾 → 消息收敛到终态
    if (frames[frames.length - 1].type === 'done') {
      expect(state.messageStatus).toBe('done');
      expect(state.blocks.length).toBeGreaterThan(0);
    }
  });

  it('mixed_sync_async：客户端异步工具先 queued，turn 结束被收成 done', () => {
    const frames = fixture.scenarios.mixed_sync_async.new;
    const state = driveRenderer(frames, 'msg-new');
    const annotate = state.blocks.find(
      (block) => block.type === 'tool_call' && block.name === 'auto_annotate',
    );
    expect(annotate).toBeDefined();
    expect(annotate && annotate.type === 'tool_call' && annotate.status).toBe(
      'done',
    );
    expect(
      state.blocks.some(
        (block) => block.type === 'tool_call' && block.name === 'read_workspace_file',
      ),
    ).toBe(true);
  });

  it('failed_edit_emits_dismissed：终帧落下 dismissed + contentFinalized=true', () => {
    const frames = fixture.scenarios.failed_edit_emits_dismissed.new;
    const start = frames.find(
      (frame) => frame.type === 'file_proposal_start',
    );
    // 帧上带的是 edit,渲染层 resolveFileProposalOperation 只认
    // write/delete/rename,edit 归一到 write（agentChatStore.ts:588-599）
    expect(start?.operation).toBe('edit');

    const state = driveRenderer(frames, 'msg-new');
    const proposal = state.blocks.find(
      (block) => block.type === 'file_proposal',
    );
    expect(proposal).toBeDefined();
    if (proposal && proposal.type === 'file_proposal') {
      expect(proposal.status).toBe('dismissed');
      expect(proposal.contentFinalized).toBe(true);
      expect(proposal.suggestedRelativePath).toBe('a.py');
      expect(proposal.operation).toBe('write');
    }
  });

  /**
   * ⚠️ 既有渲染层行为（**不是**本次迁移引入的差异；OLD/NEW 完全一致）：
   * 1) `file_edit_delta` 帧的路径字段是 `imagePath`，而
   *    `agentChatStore.ts:490-499 resolveFileProposalPath` 只读
   *    `suggestedRelativePath / image_path / relative_path / relativePath`
   *    ——**不读 `imagePath`**，因此该帧的路径匹配失效，退化为"最后一个未
   *    定稿的 file_proposal 块"。单提案场景无可见影响；并发 str_replace
   *    提案会串台。
   * 2) 累积出的 `oldString / newString` 会在终帧 `file_proposal` 处被丢弃：
   *    `agentChatStore.ts:1305-1325` 重建块时没有展开这两个字段。
   */
  it('file_edit_delta 的 oldDelta/newDelta 确实被累积，但终帧 file_proposal 会丢弃 oldString/newString', () => {
    const frames = fixture.scenarios.failed_edit_emits_dismissed.new;
    const types = frames.map((frame) => frame.type);
    const editIndex = types.indexOf('file_edit_delta');
    const finalIndex = types.lastIndexOf('file_proposal');
    expect(editIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeGreaterThan(editIndex);

    // 累积阶段：oldString/newString 真实存在
    const afterEdit = driveRenderer(
      frames.slice(0, editIndex + 1),
      'msg-new',
    ).blocks.find((block) => block.type === 'file_proposal');
    expect(afterEdit && afterEdit.type === 'file_proposal' && afterEdit.oldString).toBe(
      'x',
    );
    expect(afterEdit && afterEdit.type === 'file_proposal' && afterEdit.newString).toBe(
      'y',
    );

    // 定稿阶段：被终帧覆盖掉
    const afterFinal = driveRenderer(
      frames.slice(0, finalIndex + 1),
      'msg-new',
    ).blocks.find((block) => block.type === 'file_proposal');
    expect(
      afterFinal && afterFinal.type === 'file_proposal' && afterFinal.contentFinalized,
    ).toBe(true);
    expect(
      afterFinal && afterFinal.type === 'file_proposal' && afterFinal.oldString,
    ).toBeUndefined();
    expect(
      afterFinal && afterFinal.type === 'file_proposal' && afterFinal.newString,
    ).toBeUndefined();
  });

  it('file_edit_delta 帧发的是 imagePath，渲染层 resolveFileProposalPath 读不到（字段名不匹配）', () => {
    const edit = fixture.scenarios.failed_edit_emits_dismissed.new.find(
      (frame) => frame.type === 'file_edit_delta',
    );
    expect(edit).toBeDefined();
    // 后端 app/schemas/agent.py:199-203：非 proposal 类事件把 image_path 序列化成 imagePath
    expect(edit?.imagePath).toBe('a.py');
    expect(edit?.suggestedRelativePath).toBeUndefined();
    // 渲染层真实函数读不到 imagePath → 返回空串
    expect(resolveFileProposalPath(edit as Record<string, unknown>)).toBe('');
  });

  it('file_proposal_delta 帧走 suggestedRelativePath，路径匹配正常（对照）', () => {
    const delta = fixture.scenarios.annotation_before_report.new.find(
      (frame) => frame.type === 'file_proposal_delta',
    );
    expect(delta).toBeDefined();
    expect(delta?.suggestedRelativePath).toBe('report.md');
    expect(resolveFileProposalPath(delta as Record<string, unknown>)).toBe(
      'report.md',
    );
  });

  it('annotation_before_report：file_proposal_start/delta 累积出待确认内容', () => {
    const frames = fixture.scenarios.annotation_before_report.new;
    const state = driveRenderer(frames, 'msg-new');
    const proposal = state.blocks.find(
      (block) => block.type === 'file_proposal',
    );
    expect(proposal).toBeDefined();
    if (proposal && proposal.type === 'file_proposal') {
      expect(proposal.suggestedRelativePath).toBe('report.md');
      expect(proposal.content).toBe('report');
      expect(proposal.contentFinalized).toBe(false);
      expect(proposal.status).toBe('pending');
    }
  });
});
