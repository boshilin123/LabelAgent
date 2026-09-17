import { useEffect, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import { basename } from '../../types/file';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { computeLineDiff, proposalAnchorId } from '../../utils/fileDiffStats';
import { readWorkspaceTextFile } from '../../utils/workspaceFileRead';
import MonacoDiffView from '../editor/MonacoDiffView';
import './AgentReasoningBlock.css';
import './AgentFileChangeBlock.css';

interface AgentFileChangeBlockProps {
  messageId: string;
  blockIndex: number;
  relativePath: string;
  newContent: string;
  operation?: 'write' | 'delete' | 'rename';
  /** rename 提案的原路径 */
  oldPath?: string;
  /** str_replace 流式期间累积的 old_string / new_string */
  editOld?: string;
  editNew?: string;
  /** 提案尚未定稿（流式中） */
  streaming?: boolean;
}

export default function AgentFileChangeBlock({
  messageId,
  blockIndex,
  relativePath,
  newContent,
  operation = 'write',
  oldPath,
  editOld,
  editNew,
  streaming = false,
}: AgentFileChangeBlockProps) {
  const { activeProject } = useAnnotation();
  const { rootPath } = useApp();
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapseUnchanged, setCollapseUnchanged] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // 展开过一次后保持 DiffEditor 挂载（收起只隐藏），再次展开零开销
  const [hasExpanded, setHasExpanded] = useState(false);
  const isDelete = operation === 'delete';
  const isRename = operation === 'rename';
  // 流式中的 str_replace：直接用 old_string → new_string 作为 diff 输入，
  // 不依赖磁盘原文；定稿后由磁盘原文计算完整 diff。
  const isStreamingEdit = Boolean(
    streaming && !isDelete && (editOld !== undefined || editNew !== undefined),
  );

  const anchorId = proposalAnchorId(messageId, blockIndex);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void readWorkspaceTextFile({
      project: activeProject ?? null,
      workspaceRoot: rootPath,
      relativePath,
    }).then((result) => {
      if (cancelled) return;
      setOldContent(result.exists ? result.content : '');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeProject, rootPath, relativePath]);

  // diff 只用于 +/- 统计与占位判断；渲染交给 MonacoDiffView
  const diffResult = useMemo(() => {
    if (isStreamingEdit) {
      return computeLineDiff(editOld ?? '', editNew ?? '');
    }
    if (oldContent === null) return null;
    return computeLineDiff(oldContent, isDelete ? '' : newContent);
  }, [editNew, editOld, isDelete, isStreamingEdit, newContent, oldContent]);

  const safeRelativePath = relativePath ?? '';
  const fileName = basename(safeRelativePath) || '未命名文件';
  // 未变更区域折叠按钮：流式编辑只展示变更区域，不需要切换
  const canToggleCollapse = !isStreamingEdit && !isDelete && !isRename;

  return (
    <div className="agent-tool-block" data-proposal-id={anchorId}>
      <button
        type="button"
        className="agent-block-toggle"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((open) => !open);
          setHasExpanded(true);
        }}
      >
        <VscodeIcon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
        />
        <span>
          {isDelete ? 'Deleted' : isRename ? 'Renamed' : 'Edited'}{' '}
          {isRename && oldPath
            ? `${basename(oldPath) || oldPath} → ${fileName}`
            : fileName}
          {isStreamingEdit ? ' …' : ''}
        </span>
        {diffResult &&
        (diffResult.additions > 0 || diffResult.deletions > 0) ? (
          <span className="agent-edit-stats">
            {diffResult.additions > 0 ? (
              <span className="agent-edit-stats__add">
                +{diffResult.additions}
              </span>
            ) : null}
            {diffResult.deletions > 0 ? (
              <span className="agent-edit-stats__del">
                -{diffResult.deletions}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>

      {expanded || hasExpanded ? (
        <div
          className={`agent-tool-body agent-file-change-block__body${
            expanded ? '' : ' agent-file-change-block__body--hidden'
          }`}
        >
          {isDelete ? (
            <div className="agent-file-change-block__delete-note">
              将删除此文件
            </div>
          ) : isRename ? (
            <div className="agent-file-change-block__delete-note">
              将移动/重命名为 {safeRelativePath}（确认后执行）
            </div>
          ) : loading && !isStreamingEdit ? (
            <div className="agent-file-change-block__loading">加载 diff…</div>
          ) : isStreamingEdit && diffResult?.lines.length === 0 ? (
            <div className="agent-file-change-block__loading">正在编辑…</div>
          ) : (
            <div className="agent-change-block__body-wrap agent-file-change-block__diff-wrap">
              <MonacoDiffView
                relativePath={safeRelativePath}
                oldContent={
                  isStreamingEdit ? (editOld ?? '') : (oldContent ?? '')
                }
                newContent={isStreamingEdit ? (editNew ?? '') : newContent}
                collapseUnchanged={collapseUnchanged}
                revealFirstChange={!isStreamingEdit}
              />
              {canToggleCollapse ? (
                <button
                  type="button"
                  className="agent-change-block__expand"
                  aria-expanded={!collapseUnchanged}
                  aria-label={collapseUnchanged ? '展开全部变更' : '收起变更'}
                  title={collapseUnchanged ? '展开全部变更' : '收起'}
                  onClick={() => setCollapseUnchanged((full) => !full)}
                >
                  <VscodeIcon
                    name={collapseUnchanged ? 'chevron-down' : 'chevron-up'}
                    size={14}
                  />
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
