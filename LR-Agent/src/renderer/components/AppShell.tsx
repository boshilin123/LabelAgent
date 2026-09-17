import { ReactNode } from 'react';
import TitleBar from './TitleBar';
import './AppShell.css';

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app-shell-body">{children}</div>
    </div>
  );
}
