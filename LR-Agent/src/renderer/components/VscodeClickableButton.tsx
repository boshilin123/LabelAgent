import { VscodeToolbarButton } from '@vscode-elements/react-elements';
import { useEffect, useRef, type ComponentRef } from 'react';

interface VscodeClickableToolbarButtonProps {
  icon: string;
  label: string;
  /** 悬浮提示；默认用 label */
  title?: string;
  onClick: () => void;
}

/** VscodeToolbarButton 需通过原生 click 监听，React onClick 在 WC 上不可靠 */
export default function VscodeClickableToolbarButton({
  icon,
  label,
  title,
  onClick,
}: VscodeClickableToolbarButtonProps) {
  const ref = useRef<ComponentRef<typeof VscodeToolbarButton>>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    el.setAttribute('title', title ?? label);
    const handler = () => onClick();
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [label, onClick, title]);

  return (
    <VscodeToolbarButton
      ref={ref}
      icon={icon}
      label={label}
      title={title ?? label}
    />
  );
}
