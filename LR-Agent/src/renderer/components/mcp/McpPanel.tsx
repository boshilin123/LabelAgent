import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  VscodeButton,
  VscodeIcon,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import VscodeScrollHost from '../VscodeScrollHost';
import ModalMotion from '../../motion/ModalMotion';
import {
  MCP_AUTO_ALLOWLIST_THRESHOLD,
  type McpPreset,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerInput,
} from '../../../shared/mcpTypes';
import {
  deleteMcpServer,
  listMcpConfig,
  listMcpPresets,
  probeMcpServer,
  setMcpServerEnabled,
  setMcpServerTools,
  upsertMcpServer,
} from '../../services/mcpConfigApi';
import McpBrandIcon from './McpBrandIcon';
import McpServerFormModal from './McpServerFormModal';
import McpServerMenuPortal from './McpServerMenuPortal';
import McpTransportBadge from './McpTransportBadge';
import './McpPanel.css';

type ProbeStatus = 'idle' | 'probing' | 'ok' | 'error';

export default function McpPanel() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [formPreset, setFormPreset] = useState<McpPreset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServerConfig | null>(
    null,
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [probeStatus, setProbeStatus] = useState<Record<string, ProbeStatus>>(
    {},
  );
  const [probeResults, setProbeResults] = useState<
    Record<string, McpProbeResult>
  >({});
  const [menuServerId, setMenuServerId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const probingRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [config, presetList] = await Promise.all([
        listMcpConfig(),
        listMcpPresets(),
      ]);
      setServers(
        Object.values(config.mcpServers).sort(
          (a, b) => a.createdAt - b.createdAt,
        ),
      );
      setPresets(presetList);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runProbe = useCallback(async (server: McpServerConfig) => {
    if (probingRef.current.has(server.id)) return;
    probingRef.current.add(server.id);
    setProbeStatus((prev) => ({ ...prev, [server.id]: 'probing' }));
    try {
      const result = await probeMcpServer(server);
      setProbeResults((prev) => ({ ...prev, [server.id]: result }));
      if (result.ok && result.tools) {
        setProbeStatus((prev) => ({ ...prev, [server.id]: 'ok' }));
        setServers((prev) =>
          prev.map((item) =>
            item.id === server.id
              ? { ...item, lastTools: result.tools ?? [] }
              : item,
          ),
        );
        await setMcpServerTools(server.id, { lastTools: result.tools });
      } else {
        setProbeStatus((prev) => ({ ...prev, [server.id]: 'error' }));
      }
    } finally {
      probingRef.current.delete(server.id);
    }
  }, []);

  useEffect(() => {
    const enabled = servers.filter((server) => server.enabled);
    enabled.forEach((server) => {
      if (
        probeStatus[server.id] === 'probing' ||
        probeStatus[server.id] === 'ok'
      ) {
        return;
      }
      if (probingRef.current.has(server.id)) return;
      void runProbe(server);
    });
    // 仅在 servers 身份/启用变化时后台探测，避免 probeStatus 循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers.map((s) => `${s.id}:${s.enabled}`).join('|')]);

  const openCreate = () => {
    setEditing(null);
    setFormPreset(null);
    setFormOpen(true);
  };

  const openFromPreset = (preset: McpPreset) => {
    setEditing(null);
    setFormPreset(preset);
    setFormOpen(true);
  };

  const openEdit = (server: McpServerConfig) => {
    setEditing(server);
    setFormPreset(presets.find((item) => item.id === server.preset) ?? null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setFormPreset(null);
  };

  const handleSave = async (input: McpServerInput) => {
    const saved = await upsertMcpServer(input);
    if (!saved) {
      throw new Error('保存失败：请检查 URL 与协议是否合法');
    }
    await refresh();
  };

  const handleToggleEnabled = async (server: McpServerConfig) => {
    setServers((prev) =>
      prev.map((item) =>
        item.id === server.id ? { ...item, enabled: !item.enabled } : item,
      ),
    );
    await setMcpServerEnabled(server.id, !server.enabled).catch(() =>
      refresh(),
    );
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteMcpServer(deleteTarget.id);
    setDeleteTarget(null);
    await refresh();
  };

  const handleToggleTool = async (
    server: McpServerConfig,
    toolName: string,
  ) => {
    const disabled = new Set(server.disabledTools);
    if (disabled.has(toolName)) disabled.delete(toolName);
    else disabled.add(toolName);
    const nextDisabled = [...disabled];
    setServers((prev) =>
      prev.map((item) =>
        item.id === server.id ? { ...item, disabledTools: nextDisabled } : item,
      ),
    );
    await setMcpServerTools(server.id, { disabledTools: nextDisabled }).catch(
      () => refresh(),
    );
  };

  /** 批量开关：关闭时把当前全部工具名写进 disabledTools，开启时清空。 */
  const handleSetAllTools = async (
    server: McpServerConfig,
    enabled: boolean,
  ) => {
    const nextDisabled = enabled ? [] : [...server.lastTools];
    setServers((prev) =>
      prev.map((item) =>
        item.id === server.id ? { ...item, disabledTools: nextDisabled } : item,
      ),
    );
    await setMcpServerTools(server.id, { disabledTools: nextDisabled }).catch(
      () => refresh(),
    );
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openDocs = (url: string | undefined) => {
    if (!url) return;
    if (window.electron?.window?.openExternal) {
      void window.electron.window.openExternal(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  };

  const menuServer = menuServerId
    ? (servers.find((item) => item.id === menuServerId) ?? null)
    : null;

  const closeMenu = () => setMenuOpen(false);
  const finalizeMenuClose = () => {
    setMenuOpen(false);
    setMenuServerId(null);
    menuAnchorRef.current = null;
  };

  const toggleMenu = (serverId: string, anchor: HTMLButtonElement) => {
    if (menuServerId === serverId && menuOpen) {
      closeMenu();
      return;
    }
    setMenuServerId(serverId);
    menuAnchorRef.current = anchor;
    setMenuOpen(true);
  };

  const enabledCount = servers.filter((server) => server.enabled).length;
  const addedPresetIds = useMemo(
    () =>
      new Set(
        servers
          .map((server) => server.preset)
          .filter((id): id is string => Boolean(id)),
      ),
    [servers],
  );

  return (
    <div className="mcp-panel">
      <VscodeToolbarContainer className="mcp-panel-toolbar">
        <VscodeClickableToolbarButton
          icon="add"
          label="添加自定义 MCP"
          onClick={openCreate}
        />
        <VscodeClickableToolbarButton
          icon="refresh"
          label="刷新"
          onClick={() => refresh()}
        />
      </VscodeToolbarContainer>

      <VscodeScrollHost
        className="mcp-panel-scroll-host"
        scrollableClassName="mcp-panel-scrollable"
      >
        <section className="mcp-section">
          <h4 className="mcp-section-title">
            已连接 {loading ? '…' : enabledCount}
          </h4>
          {loading ? (
            <div className="mcp-empty">加载 MCP 配置…</div>
          ) : servers.length === 0 ? (
            <div className="mcp-empty">
              尚未配置远程 MCP。从下方广场添加，或点击 + 自定义。
            </div>
          ) : (
            <ul className="mcp-server-list">
              {servers.map((server) => {
                const tools = server.lastTools;
                const enabledToolCount = tools.filter(
                  (name) => !server.disabledTools.includes(name),
                ).length;
                const expanded = expandedIds.has(server.id);
                const status = probeStatus[server.id] ?? 'idle';
                const probe = probeResults[server.id];
                const statusKind = !server.enabled
                  ? 'off'
                  : status === 'error'
                    ? 'error'
                    : status === 'probing'
                      ? 'probing'
                      : tools.length > 0 || status === 'ok'
                        ? 'ok'
                        : 'idle';

                return (
                  <li key={server.id} className="mcp-server-item">
                    <div className="mcp-server-row">
                      <McpBrandIcon presetId={server.preset} size={22} />
                      <div className="mcp-server-main">
                        <div className="mcp-server-head">
                          <span className="mcp-server-name">{server.name}</span>
                          <span className="mcp-source-badge">
                            {server.preset ? '广场' : '自定义'}
                          </span>
                          <McpTransportBadge transport={server.transport} />
                        </div>
                        {server.enabled ? (
                          <button
                            type="button"
                            className="mcp-server-status"
                            onClick={() => toggleExpanded(server.id)}
                            disabled={tools.length === 0}
                          >
                            <span
                              className={`mcp-status-dot mcp-status-dot--${statusKind}`}
                            />
                            <span>
                              {status === 'probing'
                                ? '正在连接…'
                                : status === 'error'
                                  ? probe?.error || '连接失败'
                                  : tools.length === 0
                                    ? '尚未发现工具'
                                    : `${enabledToolCount} 个工具已启用`}
                            </span>
                            {tools.length > 0 ? (
                              <VscodeIcon
                                name={
                                  expanded ? 'chevron-down' : 'chevron-right'
                                }
                                size={12}
                              />
                            ) : null}
                          </button>
                        ) : (
                          <div className="mcp-server-status mcp-server-status--static">
                            <span className="mcp-status-dot mcp-status-dot--off" />
                            <span>已停用</span>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="mcp-server-menu-trigger"
                        aria-label="更多操作"
                        onClick={(event) =>
                          toggleMenu(server.id, event.currentTarget)
                        }
                      >
                        <VscodeIcon name="ellipsis" size={16} />
                      </button>
                    </div>
                    {server.enabled && expanded && tools.length > 0 ? (
                      <>
                        {tools.length > MCP_AUTO_ALLOWLIST_THRESHOLD ? (
                          <div className="mcp-tool-hint">
                            <span>
                              该服务提供 {tools.length} 个工具，新工具默认关闭，
                              请按需开启（已启用 {enabledToolCount} 个）。
                            </span>
                            <div className="mcp-tool-hint-actions">
                              <button
                                type="button"
                                onClick={() => handleSetAllTools(server, true)}
                              >
                                全部开启
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSetAllTools(server, false)}
                              >
                                全部关闭
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <ul className="mcp-tool-list">
                          {tools.map((toolName) => {
                            const on = !server.disabledTools.includes(toolName);
                            return (
                              <li key={toolName} className="mcp-tool-row">
                                <span className="mcp-tool-name">
                                  {toolName}
                                </span>
                                <button
                                  type="button"
                                  className="mcp-tool-toggle"
                                  role="switch"
                                  aria-checked={on}
                                  aria-label={`${on ? '停用' : '启用'} ${toolName}`}
                                  onClick={() =>
                                    handleToggleTool(server, toolName)
                                  }
                                >
                                  <span className="mcp-tool-toggle-knob" />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mcp-section">
          <h4 className="mcp-section-title">MCP 广场</h4>
          <ul className="mcp-preset-list">
            {presets.map((preset) => {
              const added = addedPresetIds.has(preset.id);
              return (
                <li key={preset.id} className="mcp-preset-item">
                  <McpBrandIcon presetId={preset.icon ?? preset.id} size={28} />
                  <div className="mcp-preset-body">
                    <div className="mcp-preset-head">
                      <span className="mcp-preset-name">{preset.name}</span>
                      <McpTransportBadge transport={preset.transport} />
                    </div>
                    <p className="mcp-preset-desc">{preset.description}</p>
                    <div className="mcp-preset-actions">
                      {added ? (
                        <span className="mcp-preset-added">已添加</span>
                      ) : (
                        <button
                          type="button"
                          className="mcp-server-action"
                          onClick={() => openFromPreset(preset)}
                        >
                          添加
                        </button>
                      )}
                      {preset.docsUrl ? (
                        <button
                          type="button"
                          className="mcp-server-action"
                          onClick={() => openDocs(preset.docsUrl)}
                        >
                          文档
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </VscodeScrollHost>

      {formOpen && (
        <McpServerFormModal
          open
          initial={editing}
          preset={formPreset}
          onClose={closeForm}
          onSave={handleSave}
        />
      )}

      {deleteTarget && (
        <ModalMotion
          open
          onClose={() => setDeleteTarget(null)}
          closeOnBackdropClick={false}
          dialogClassName="mcp-delete-dialog"
          labelledBy="mcp-delete-title"
        >
          <h3 id="mcp-delete-title">删除 MCP 服务</h3>
          <p>
            确定删除「{deleteTarget.name}」吗？删除后 Assist 将不再注入其工具。
          </p>
          <div className="mcp-delete-actions">
            <VscodeButton secondary onClick={() => setDeleteTarget(null)}>
              取消
            </VscodeButton>
            <VscodeButton onClick={handleDelete}>删除</VscodeButton>
          </div>
        </ModalMotion>
      )}

      {menuOpen && menuServer && menuAnchorRef.current && (
        <McpServerMenuPortal
          open
          anchorEl={menuAnchorRef.current}
          enabled={menuServer.enabled}
          probing={probeStatus[menuServer.id] === 'probing'}
          onClose={closeMenu}
          onExitComplete={finalizeMenuClose}
          onProbe={() => {
            closeMenu();
            void runProbe(menuServer);
          }}
          onToggleEnabled={() => {
            closeMenu();
            void handleToggleEnabled(menuServer);
          }}
          onEdit={() => {
            closeMenu();
            openEdit(menuServer);
          }}
          onDelete={() => {
            closeMenu();
            setDeleteTarget(menuServer);
          }}
        />
      )}
    </div>
  );
}
