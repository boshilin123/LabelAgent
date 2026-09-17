import { ReactNode } from 'react';
import './Sidebar.css';

interface SidebarProps {
  side: 'left' | 'right';
  width: number;
  collapsed: boolean;
  isResizing?: boolean;
  title?: string;
  showHeader?: boolean;
  children: ReactNode;
}

export default function Sidebar({
  side,
  width,
  collapsed,
  isResizing = false,
  title,
  showHeader = true,
  children,
}: SidebarProps) {
  return (
    <aside
      className={`sidebar sidebar-${side}${collapsed ? ' collapsed' : ''}${isResizing ? ' is-resizing' : ''}${!showHeader ? ' sidebar-no-header' : ''}`}
      style={{ width: collapsed ? 0 : width }}
    >
      <div className="sidebar-inner">
        {showHeader && title != null && (
          <header className="sidebar-panel-header">{title}</header>
        )}
        <div className="sidebar-body">{children}</div>
      </div>
    </aside>
  );
}
