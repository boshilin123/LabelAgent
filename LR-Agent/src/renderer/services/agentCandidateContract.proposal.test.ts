/**
 * F1：候选引擎帧 → 真实 **KEEP-ALL / 提案落盘路径** 的写入计划等价性。
 *
 * ## 被测的真实代码
 * - `./agentChatStore.ts`      → `applyStreamEventToBlocks` 等（同 reducer 测试）
 * - `./agentProposalApply.ts`  → `collectPendingProposals`（:294）
 *                                `collectPendingChangeItems`（:248）
 *                                `collectMessageChangeItems`（:194）
 *                                `applyAllPendingProposals`（:647）
 *                                `applyProposalRefs`（:542）→ `applyFileBlock`（:445）
 *
 * ## 落盘汇（sink）
 * 不写磁盘：把 `window.electron.workspace.{writeTextFile,moveTextFile,deleteTextFile}`
 * 换成 jest.fn 并**捕获入参**——入参就是最终写入计划（rootDir / relativePath /
 * content）。`./agentChatApi`（远端 PATCH）与 `./agentFeatureFlags`（写开关）
 * 按仓库既有测试 `agentProposalApply.test.ts:14-20` 的方式 mock。
 *
 * ## 覆盖范围声明
 * `applyAnnotationProposalWithGuards`（标注提案）需要已打开的
 * `AnnotationProject` 与真实标注文档，超出本批帧范围（15 个场景均无
 * `annotation_proposal` 帧），因此只对**文件提案**驱动真实落盘路径；
 * 标注分支仅断言旧/新两侧的 `collectPendingProposals` refs 相等。
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
} from './agentChatStore';
import {
  applyAllPendingProposals,
  collectMessageChangeItems,
  collectPendingChangeItems,
  collectPendingProposals,
} from './agentProposalApply';

jest.mock('./agentChatApi', () => ({
  patchAgentMessageBlockRemote: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./agentFeatureFlags', () => ({
  isAgentDocumentWriteEnabled: jest.fn(() => true),
}));

type Frame = StreamEvent & Record<string, unknown>;

interface ScenarioFixture {
  baselineClass: string;
  old: Frame[];
  new: Frame[];
}

interface FixtureDocument {
  meta: { scenario_count: number; all_equal: boolean; failures: string[] };
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

/** 与 reducer 测试同序的驱动（仅 blocks 部分，KEEP-ALL 只关心 blocks）。 */
function reduceBlocks(frames: Frame[]): MessageBlock[] {
  let blocks: MessageBlock[] = [];
  for (const frame of frames) {
    if (frame.type === 'done' || frame.type === 'awaiting_confirmation') {
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
      blocks = finalizeSubagentBlocks(blocks, 'error');
      continue;
    }
    if (frame.type === 'context_updated') continue;
    if (frame.type === 'preparing') continue;
    if (frame.type === 'route_decided') continue;
    blocks = applyStreamEventToBlocks(blocks, frame);
  }
  return blocks;
}

const WORKSPACE_ROOT = '/w';

function messageWith(id: string, blocks: MessageBlock[]): ChatMessage {
  return {
    id,
    sessionId: 'sess-1',
    role: 'assistant',
    blocks,
    status: 'done',
    providerId: 'p1',
    model: 'm1',
    createdAt: 1,
    updatedAt: 1,
  };
}

interface WriteSink {
  writeTextFile: jest.Mock;
  moveTextFile: jest.Mock;
  deleteTextFile: jest.Mock;
}

function installWriteSink(): WriteSink {
  const sink: WriteSink = {
    writeTextFile: jest.fn().mockResolvedValue({ success: true }),
    moveTextFile: jest.fn().mockResolvedValue({ success: true }),
    deleteTextFile: jest.fn().mockResolvedValue({ success: true }),
  };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    writable: true,
    value: { workspace: { ...sink, readTextFile: jest.fn() } },
  });
  return sink;
}

function capturedPlan(sink: WriteSink) {
  const calls = [
    ...sink.writeTextFile.mock.calls.map((args) => ({
      op: 'write',
      args: args[0],
    })),
    ...sink.moveTextFile.mock.calls.map((args) => ({
      op: 'move',
      args: args[0],
    })),
    ...sink.deleteTextFile.mock.calls.map((args) => ({
      op: 'delete',
      args: args[0],
    })),
  ];
  return calls;
}

async function deriveWritePlan(frames: Frame[]) {
  const blocks = reduceBlocks(frames);
  const messages = [messageWith('msg-1', blocks)];
  const refs = collectPendingProposals(messages);
  const changeItems = collectPendingChangeItems(messages);
  const messageItems = collectMessageChangeItems(messages[0]);
  const sink = installWriteSink();
  const updateBlock = jest.fn();
  const result = await applyAllPendingProposals({
    sessionId: 'sess-1',
    messages,
    project: null,
    workspaceRoot: WORKSPACE_ROOT,
    updateBlock,
  });
  return { blocks, refs, changeItems, messageItems, result, plan: capturedPlan(sink) };
}

const proposalScenarios = scenarioNames.filter((name) =>
  reduceBlocks(fixture.scenarios[name].new).some(
    (block) => block.type === 'file_proposal' || block.type === 'document_proposal',
  ),
);

describe('提案帧 → KEEP-ALL 写入计划：OLD 与 NEW 深度相等', () => {
  it('至少覆盖 3 个含文件提案的场景（否则本文件没有验证力）', () => {
    expect(proposalScenarios.length).toBeGreaterThanOrEqual(3);
  });

  it.each(proposalScenarios)('%s', async (name) => {
    const scenario = fixture.scenarios[name];
    const oldPlan = await deriveWritePlan(scenario.old);
    const newPlan = await deriveWritePlan(scenario.new);

    expect(newPlan.blocks).toEqual(oldPlan.blocks);
    expect(newPlan.refs).toEqual(oldPlan.refs);
    expect(newPlan.changeItems).toEqual(oldPlan.changeItems);
    expect(newPlan.messageItems).toEqual(oldPlan.messageItems);
    expect(newPlan.result).toEqual(oldPlan.result);
    // 真正落盘的入参就是"写入计划"
    expect(newPlan.plan).toEqual(oldPlan.plan);
  });
});

describe('KEEP-ALL 契约（行为断言，非空洞）', () => {
  it('annotation_before_report：start+delta 得到一个待确认写入计划 report.md', async () => {
    const plan = await deriveWritePlan(
      fixture.scenarios.annotation_before_report.new,
    );
    expect(plan.refs).toHaveLength(1);
    expect(plan.plan).toEqual([
      {
        op: 'write',
        args: {
          rootDir: WORKSPACE_ROOT,
          relativePath: 'report.md',
          content: 'report',
        },
      },
    ]);
    expect(plan.result.applied).toBe(1);
    expect(plan.result.errors).toEqual([]);
  });

  it('phase_blocked_write_then_read：write 被后端拦截，但提案内容仍可 Keep All', async () => {
    const plan = await deriveWritePlan(
      fixture.scenarios.phase_blocked_write_then_read.new,
    );
    expect(plan.refs).toHaveLength(1);
    expect(plan.plan).toEqual([
      {
        op: 'write',
        args: {
          rootDir: WORKSPACE_ROOT,
          relativePath: 'r.md',
          content: 'x',
        },
      },
    ]);
    expect(plan.result.applied).toBe(1);
  });

  it('failed_edit_emits_dismissed：dismissed 提案不进 Keep All，且不产生任何写入', async () => {
    const plan = await deriveWritePlan(
      fixture.scenarios.failed_edit_emits_dismissed.new,
    );
    expect(plan.refs).toEqual([]);
    expect(plan.plan).toEqual([]);
    expect(plan.result.applied).toBe(0);
    expect(plan.result.errors).toEqual([]);
  });

  it('dismiss_allows_replanning / 无提案场景：不产生写入计划', async () => {
    const withoutProposal = scenarioNames.filter(
      (name) => !proposalScenarios.includes(name),
    );
    expect(withoutProposal.length).toBeGreaterThan(0);
    const plans = await Promise.all(
      withoutProposal.map((name) => deriveWritePlan(fixture.scenarios[name].new)),
    );
    plans.forEach((plan) => {
      expect(plan.refs).toEqual([]);
      expect(plan.plan).toEqual([]);
      expect(plan.result.applied).toBe(0);
    });
  });
});

describe('静态契约：apply 路径读取的字段，候选帧全部携带', () => {
  it('file_proposal_start 帧携带 suggestedRelativePath / title / operation', () => {
    const starts = scenarioNames.flatMap((name) =>
      fixture.scenarios[name].new.filter(
        (frame) => frame.type === 'file_proposal_start',
      ),
    );
    expect(starts.length).toBeGreaterThan(0);
    starts.forEach((frame) => {
      expect(typeof frame.suggestedRelativePath).toBe('string');
      expect(typeof frame.title).toBe('string');
    });
  });

  it('file_proposal 终帧携带 suggestedRelativePath / content / status', () => {
    const finals = scenarioNames.flatMap((name) =>
      fixture.scenarios[name].new.filter(
        (frame) => frame.type === 'file_proposal',
      ),
    );
    expect(finals.length).toBeGreaterThan(0);
    finals.forEach((frame) => {
      expect(typeof frame.suggestedRelativePath).toBe('string');
      expect(typeof frame.content).toBe('string');
      expect(typeof frame.status).toBe('string');
    });
  });

  it('file_edit_delta 帧携带 oldDelta / newDelta（渲染层据此累积 oldString/newString）', () => {
    const edits = scenarioNames.flatMap((name) =>
      fixture.scenarios[name].new.filter(
        (frame) => frame.type === 'file_edit_delta',
      ),
    );
    expect(edits.length).toBeGreaterThan(0);
    edits.forEach((frame) => {
      expect(typeof frame.oldDelta).toBe('string');
      expect(typeof frame.newDelta).toBe('string');
    });
  });

  it('tool_pending 帧同时携带 toolCalls 与 clientToolCalls（旧/新两套字段名）', () => {
    const pendings = scenarioNames.flatMap((name) =>
      fixture.scenarios[name].new.filter(
        (frame) => frame.type === 'tool_pending',
      ),
    );
    expect(pendings.length).toBeGreaterThan(0);
    pendings.forEach((frame) => {
      expect(Array.isArray(frame.toolCalls)).toBe(true);
      expect(Array.isArray(frame.clientToolCalls)).toBe(true);
      expect(frame.clientToolCalls).toEqual(frame.toolCalls);
      (frame.toolCalls as unknown as Array<Record<string, unknown>>).forEach(
        (call) => {
          expect(typeof call.toolCallId).toBe('string');
          expect(typeof call.name).toBe('string');
          expect(typeof call.arguments).toBe('object');
        },
      );
    });
  });
});
