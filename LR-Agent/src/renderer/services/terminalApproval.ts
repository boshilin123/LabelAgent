/**
 * 终端命令的聊天内批准桥。
 *
 * agentJobRegistry 的 runClientTool 在执行 start_terminal_command 前挂起
 * 等待用户决定；AgentToolCallBlock 检测到 awaitingApproval 块后渲染
 * 批准/拒绝按钮，经 resolveTerminalApproval 回填结果。
 * 等待发生在 loop 已暂停的 ASYNC pending 阶段，不需要新的 job 状态。
 */

const pendingApprovals = new Map<string, (approved: boolean) => void>();

/** 挂起等待用户批准；job 取消/换会话时由调用方 cancel */
export function requestTerminalApproval(toolCallId: string): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(toolCallId, resolve);
  });
}

/** 用户点击批准/拒绝；无挂起等待时返回 false */
export function resolveTerminalApproval(
  toolCallId: string,
  approved: boolean,
): boolean {
  const resolve = pendingApprovals.get(toolCallId);
  if (!resolve) return false;
  pendingApprovals.delete(toolCallId);
  resolve(approved);
  return true;
}

/** job 取消时强制以"拒绝"收口，防止 promise 泄漏 */
export function cancelTerminalApproval(toolCallId: string): void {
  resolveTerminalApproval(toolCallId, false);
}
