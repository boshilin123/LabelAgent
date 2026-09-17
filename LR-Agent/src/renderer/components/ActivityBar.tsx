import { VscodeIcon } from '@vscode-elements/react-elements';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useWorkMode } from '../context/WorkModeContext';
import UserAvatar from './UserAvatar';
import { MoonIcon, SunIcon } from './ThemeToggleIcons';
import ActivityIcon from './ActivityIcon';
import './ActivityBar.css';

export type LeftPanel =
  | 'explorer'
  | 'annotations'
  | 'models'
  | 'llmProviders'
  | 'mcp'
  | 'skills'
  | 'settings';
export type RightPanel = 'agent' | 'annotation' | 'quality' | 'quickInference';

interface ActivityBarProps {
  activePanel: LeftPanel | null;
  onExplorerClick?: () => void;
  onAnnotationsClick?: () => void;
  onModelsClick?: () => void;
  onLlmProvidersClick?: () => void;
  onMcpClick?: () => void;
  onSkillsClick?: () => void;
  onSettingsClick?: () => void;
}

function WorkModeToggleButton() {
  const { workMode, toggleWorkMode } = useWorkMode();
  const isEditor = workMode === 'editor';
  const label = isEditor
    ? '编辑器模式（点击切换到标注模式）'
    : '标注模式（点击切换到编辑器模式）';

  return (
    <button
      type="button"
      className={`activity-work-mode-toggle${isEditor ? '' : ' activity-work-mode-toggle--active'}`}
      aria-label={label}
      title={label}
      onClick={toggleWorkMode}
    >
      <span className="activity-work-mode-toggle-icon" key={workMode}>
        <VscodeIcon
          name={isEditor ? 'edit-sparkle' : 'inspect'}
          size={24}
          label={label}
        />
      </span>
    </button>
  );
}

function ThemeToggleButton({ onClick }: { onClick: () => void }) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const label = isDark ? '切换到浅色主题' : '切换到深色主题';

  return (
    <button
      type="button"
      className="activity-theme-toggle"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {isDark ? (
        <SunIcon className="activity-theme-toggle-icon" />
      ) : (
        <MoonIcon className="activity-theme-toggle-icon" />
      )}
    </button>
  );
}

function AccountAvatarButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const { user, isOfflineMode } = useAuth();
  const onlineLabel = '账户设置';
  const offlineLabel =
    '离线模式。文件编辑、标注任务、本地对话可用；云端 Agent、标注分析暂不可用。恢复网络后将自动重连。';
  const label = isOfflineMode ? offlineLabel : onlineLabel;

  return (
    <button
      type="button"
      className={`activity-avatar-btn ${active ? 'activity-icon-active' : ''}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {user ? (
        <UserAvatar user={user} size="sm" alt="" />
      ) : (
        <span className="activity-avatar-fallback codicon codicon-account" />
      )}
      {isOfflineMode ? (
        <span className="activity-offline-dot" aria-hidden />
      ) : null}
    </button>
  );
}

export default function ActivityBar({
  activePanel,
  onExplorerClick,
  onAnnotationsClick,
  onModelsClick,
  onLlmProvidersClick,
  onMcpClick,
  onSkillsClick,
  onSettingsClick,
}: ActivityBarProps) {
  const { toggleDarkLight } = useTheme();

  return (
    <nav className="activity-bar activity-bar-left" aria-label="主活动栏">
      <div className="activity-bar-top">
        <ActivityIcon
          name="files"
          label="资源管理器"
          active={activePanel === 'explorer'}
          onClick={onExplorerClick ?? (() => undefined)}
        />
        <ActivityIcon
          name="list-unordered"
          label="标注任务"
          active={activePanel === 'annotations'}
          onClick={onAnnotationsClick ?? (() => undefined)}
        />
        <ActivityIcon
          name="layers"
          label="预训练模型"
          active={activePanel === 'models'}
          onClick={onModelsClick ?? (() => undefined)}
        />
        <ActivityIcon
          name="copilot"
          label="大模型配置"
          active={activePanel === 'llmProviders'}
          onClick={onLlmProvidersClick ?? (() => undefined)}
        />
        <ActivityIcon
          name="plug"
          label="MCP 工具"
          active={activePanel === 'mcp'}
          onClick={onMcpClick ?? (() => undefined)}
        />
        <ActivityIcon
          name="lightbulb"
          label="Agent Skills"
          active={activePanel === 'skills'}
          onClick={onSkillsClick ?? (() => undefined)}
        />
      </div>
      <div className="activity-bar-bottom">
        <WorkModeToggleButton />
        <ThemeToggleButton onClick={toggleDarkLight} />
        <AccountAvatarButton
          active={activePanel === 'settings'}
          onClick={onSettingsClick ?? (() => undefined)}
        />
      </div>
    </nav>
  );
}
