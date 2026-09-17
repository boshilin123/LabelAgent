import { type ComponentPropsWithoutRef, type ReactNode } from 'react';
import OverlayHorizontalScrollArea from '../OverlayHorizontalScrollArea';
import './AgentScrollablePre.css';

interface AgentScrollablePreProps extends ComponentPropsWithoutRef<'pre'> {
  observeKey?: unknown;
  children?: ReactNode;
}

export default function AgentScrollablePre({
  className,
  children,
  observeKey,
  ...props
}: AgentScrollablePreProps) {
  return (
    <OverlayHorizontalScrollArea
      className="agent-scrollable-pre"
      viewportClassName={['agent-scrollable-pre__viewport', className]
        .filter(Boolean)
        .join(' ')}
      observeKey={observeKey ?? children}
    >
      <pre className="agent-scrollable-pre__code" {...props}>
        {children}
      </pre>
    </OverlayHorizontalScrollArea>
  );
}
