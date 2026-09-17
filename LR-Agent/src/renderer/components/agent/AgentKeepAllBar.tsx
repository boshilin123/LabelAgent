import { useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { useApp } from '../../context/AppContext';
import FileTypeIcon from '../FileTypeIcon';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import { basename } from '../../types/file';
import { collectPendingChangeItems } from '../../services/agentProposalApply';
import { computeFileProposalDiffStats } from '../../utils/workspaceFileRead';
import { useOpenAgentChange } from './useOpenAgentChange';
import './AgentKeepAllBar.css';

type ItemStats = Record<string, { additions?: number; deletions?: number }>;

export default function AgentKeepAllBar() {
  const {
    pendingProposalCount,
    applyAllPendingChanges,
    applyingAllPending,
    dismissAllPendingChanges,
    dismissingAllPending,
    isSessionStreaming,
    activeSessionId,
    preparingContext,
    getSessionMessages,
  } = useAgentChat();
  const { activeProject } = useAnnotation();
  const { clearAgentPreview } = useAnnotationWorkspace();
  const { rootPath } = useApp();
  const { openChangeItem } = useOpenAgentChange();

  const [expanded, setExpanded] = useState(false);
  const [itemStats, setItemStats] = useState<ItemStats>({});

  const messages = useMemo(
    () => (activeSessionId ? getSessionMessages(activeSessionId) : []),
    [activeSessionId, getSessionMessages],
  );

  const changeItems = useMemo(() => {
    if (!activeSessionId || pendingProposalCount <= 0) return [];
    return collectPendingChangeItems(messages);
  }, [activeSessionId, messages, pendingProposalCount]);

  const changeItemsKey = useMemo(
    () => changeItems.map((item) => item.id).join(','),
    [changeItems],
  );

  useEffect(() => {
    if (changeItems.length === 0) {
      setItemStats({});
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      const next: ItemStats = {};
      await Promise.all(
        changeItems.map(async (item) => {
          if (item.kind === 'file') {
            const stats = await computeFileProposalDiffStats({
              project: activeProject ?? null,
              workspaceRoot: rootPath,
              relativePath: item.path,
              newContent: item.newContent ?? '',
              operation:
                item.operation === 'delete'
                  ? 'delete'
                  : item.operation === 'rename'
                    ? 'rename'
                    : 'write',
            });
            next[item.id] = stats;
          }
        }),
      );
      if (!cancelled) {
        setItemStats(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject, changeItems, changeItemsKey, rootPath]);

  const streaming =
    activeSessionId != null && isSessionStreaming(activeSessionId);
  // awaiting_confirmation 时由消息尾部的内联 Keep All / Undo 接管，避免双按钮
  const hasAwaitingMessage = messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.status === 'awaiting_confirmation',
  );
  // 文件提案在 file_proposal_start 就会变 pending；流式结束 / HITL 暂停后再出示 Keep All
  if (pendingProposalCount <= 0 || streaming || hasAwaitingMessage) {
    return null;
  }

  const busy = applyingAllPending || dismissingAllPending || preparingContext;

  const fileCount = changeItems.length;
  const headerLabel = fileCount === 1 ? '1 个文件' : `${fileCount} 个文件`;

  const handleItemClick = (item: (typeof changeItems)[number]) => {
    openChangeItem(item, messages);
  };

  return (
    <div className="agent-keep-all-bar">
      <div className="agent-keep-all-bar__header">
        <button
          type="button"
          className="agent-keep-all-bar__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <VscodeIcon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={14}
          />
          <span className="agent-keep-all-bar__title">{headerLabel}</span>
        </button>
        <div className="agent-keep-all-bar__actions">
          <VscodeButton
            secondary
            icon="discard"
            type="button"
            disabled={busy}
            onClick={() => {
              dismissAllPendingChanges()
                .then(() => {
                  clearAgentPreview();
                })
                .catch(() => undefined);
            }}
          >
            {dismissingAllPending ? '撤销中…' : 'Undo'}
          </VscodeButton>
          <VscodeButton
            icon="check"
            type="button"
            disabled={busy}
            onClick={() => {
              applyAllPendingChanges().catch(() => undefined);
            }}
          >
            {applyingAllPending ? '应用中…' : 'Keep All'}
          </VscodeButton>
        </div>
      </div>
      {expanded && changeItems.length > 0 ? (
        <OverlayVerticalScrollArea maxHeight="200px">
          <ul className="agent-keep-all-bar__list">
            {changeItems.map((item) => {
              const stats = itemStats[item.id];
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="agent-keep-all-bar__item"
                    onClick={() => {
                      handleItemClick(item);
                    }}
                  >
                    {item.kind === 'file' || item.kind === 'annotation' ? (
                      <FileTypeIcon path={item.path} size={14} />
                    ) : (
                      <VscodeIcon name="code" size={14} />
                    )}
                    <span
                      className="agent-keep-all-bar__path"
                      title={item.path}
                    >
                      {item.kind === 'file' || item.kind === 'annotation'
                        ? basename(item.path)
                        : item.path}
                    </span>
                    <span className="agent-keep-all-bar__meta">
                      {stats?.additions != null && stats.additions > 0 ? (
                        <span className="agent-keep-all-bar__stat-add">
                          +{stats.additions}
                        </span>
                      ) : null}
                      {stats?.deletions != null && stats.deletions > 0 ? (
                        <span className="agent-keep-all-bar__stat-del">
                          -{stats.deletions}
                        </span>
                      ) : null}
                      {item.kind !== 'file' || stats == null ? (
                        <span
                          className={`agent-keep-all-bar__summary${
                            item.destructive
                              ? ' agent-keep-all-bar__summary--delete'
                              : ''
                          }`}
                        >
                          {item.summary}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </OverlayVerticalScrollArea>
      ) : null}
    </div>
  );
}
