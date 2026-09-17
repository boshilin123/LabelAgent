import { useEffect, useRef, useState } from 'react';
import type { AgentInteractionMode } from '../../../shared/agentTypes';
import PopoverMotion from '../../motion/PopoverMotion';
import './AgentModePicker.css';

interface ModeOption {
  id: AgentInteractionMode;
  label: string;
  description: string;
  icon: 'ask' | 'agent';
}

function modeOptions(workMode: 'editor' | 'annotation'): ModeOption[] {
  if (workMode === 'editor') {
    return [
      {
        id: 'chat',
        label: 'Ask',
        description: '问答与分析，不修改文件',
        icon: 'ask',
      },
      {
        id: 'annotation',
        label: 'Agent',
        description: '可改代码/文档，不能标注',
        icon: 'agent',
      },
    ];
  }
  return [
    {
      id: 'chat',
      label: 'Ask',
      description: '问答与分析，不写入标注或文件',
      icon: 'ask',
    },
    {
      id: 'annotation',
      label: 'Agent',
      description: '批量标注、变更、分析与报告',
      icon: 'agent',
    },
  ];
}

function ModeIcon({ kind }: { kind: ModeOption['icon'] }) {
  if (kind === 'agent') {
    return (
      <span className="agent-mode-picker-symbol" aria-hidden>
        ∞
      </span>
    );
  }
  return (
    <span
      className="codicon codicon-comment-discussion agent-mode-picker-codicon"
      aria-hidden
    />
  );
}

interface AgentModePickerProps {
  mode: AgentInteractionMode;
  workMode?: 'editor' | 'annotation';
  disabled?: boolean;
  onSelect: (mode: AgentInteractionMode) => void;
}

export default function AgentModePicker({
  mode,
  workMode = 'annotation',
  disabled = false,
  onSelect,
}: AgentModePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const options = modeOptions(workMode);

  const active = options.find((item) => item.id === mode) ?? options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="agent-mode-picker" ref={rootRef}>
      <button
        type="button"
        className={`agent-mode-picker-trigger${
          active.id === 'chat' ? ' agent-mode-picker-trigger--ask' : ''
        }${active.id === 'annotation' ? ' agent-mode-picker-trigger--agent' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`交互模式：${active.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ModeIcon kind={active.icon} />
        <span className="agent-mode-picker-label">{active.label}</span>
        <span className="codicon codicon-chevron-down agent-mode-picker-chevron" />
      </button>

      <PopoverMotion
        open={open}
        className="agent-mode-picker-menu"
        origin="bottom"
        role="listbox"
      >
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={option.id === mode}
            className={`agent-mode-picker-option${
              option.id === mode ? ' agent-mode-picker-option--active' : ''
            }${option.id === 'chat' ? ' agent-mode-picker-option--ask' : ''}${
              option.id === 'annotation'
                ? ' agent-mode-picker-option--agent'
                : ''
            }`}
            onClick={() => {
              onSelect(option.id);
              setOpen(false);
            }}
          >
            <span className="agent-mode-picker-option-leading">
              <ModeIcon kind={option.icon} />
              <span className="agent-mode-picker-option-name">
                {option.label}
              </span>
            </span>
            <span className="agent-mode-picker-option-desc">
              {option.description}
            </span>
          </button>
        ))}
      </PopoverMotion>
    </div>
  );
}
