import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useEnvironment } from '../context/EnvironmentContext';
import * as userService from '../services/user';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';
import { readFileAsDataUrl } from '../utils/cropImage';
import AvatarCropModal from './AvatarCropModal';
import DeleteAccountModal from './DeleteAccountModal';
import UserAvatar from './UserAvatar';
import './SettingsPanel.css';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export default function SettingsPanel() {
  const navigate = useNavigate();
  const { user, setUser, logout, refreshUser, isOfflineMode } = useAuth();
  const { showToast } = useToast();
  const { openWizard } = useEnvironment();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  useEffect(() => {
    if (user) {
      setUsername(user.username ?? '');
    }
  }, [user]);

  useEffect(() => {
    const onFocus = () => {
      if (isOfflineMode) {
        return;
      }
      refreshUser().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshUser, isOfflineMode]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        editButtonRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  if (!user) {
    return null;
  }

  const handleSaveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const updated = await userService.updateProfile({
        username: username.trim() || null,
      });
      setUser(updated);
      showToast('资料已保存', { type: 'success' });
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      showToast(translateError(detail), { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const openCropWithFile = async (file: File) => {
    if (file.size > MAX_AVATAR_BYTES) {
      showToast(translateError('file_too_large'), { type: 'error' });
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setCropImageSrc(dataUrl);
    } catch {
      showToast('无法读取图片', { type: 'error' });
    }
  };

  const handleAvatarSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    closeMenu();
    await openCropWithFile(file);
  };

  const handleCropConfirm = async (file: File) => {
    setCropImageSrc(null);
    setAvatarLoading(true);
    try {
      const updated = await userService.uploadAvatar(file);
      setUser(updated);
      showToast('头像已更新', { type: 'success' });
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      showToast(translateError(detail), { type: 'error' });
    } finally {
      setAvatarLoading(false);
    }
  };

  const handleDeleteAvatar = async () => {
    closeMenu();
    if (!user.avatar_url) return;
    setAvatarLoading(true);
    try {
      const updated = await userService.deleteAvatar();
      setUser(updated);
      showToast('头像已删除', { type: 'success' });
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      showToast(translateError(detail), { type: 'error' });
    } finally {
      setAvatarLoading(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/auth');
  };

  const handleDeleteAccount = async (password: string) => {
    try {
      await userService.deleteAccount(password);
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : 'request_failed';
      throw new Error(translateError(detail));
    }
    setDeleteModalOpen(false);
    await logout();
    showToast('账号已注销', { type: 'success' });
    navigate('/auth');
  };

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <h3 className="settings-section-title">账户</h3>
        <div className="settings-avatar-row">
          <div className="settings-avatar-wrapper">
            <UserAvatar user={user} size="md" />
            <button
              ref={editButtonRef}
              type="button"
              className="settings-avatar-edit-btn"
              aria-label="编辑头像"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              disabled={avatarLoading}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <VscodeIcon name="edit" size={14} />
            </button>
            {menuOpen && (
              <div ref={menuRef} className="settings-avatar-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="settings-avatar-menu-item"
                  onClick={() => {
                    closeMenu();
                    fileInputRef.current?.click();
                  }}
                >
                  <VscodeIcon name="edit" size={14} />
                  更换头像
                </button>
                {user.avatar_url && (
                  <button
                    type="button"
                    role="menuitem"
                    className="settings-avatar-menu-item settings-avatar-menu-item-danger"
                    onClick={handleDeleteAvatar}
                  >
                    <VscodeIcon name="trash" size={14} />
                    删除头像
                  </button>
                )}
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="settings-hidden-input"
            onChange={handleAvatarSelect}
          />
        </div>

        <div className="settings-field">
          <span className="settings-field-label">邮箱</span>
          <div className="settings-readonly">{user.email}</div>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">验证状态</span>
          <span
            className={`settings-badge ${
              user.email_verified
                ? 'settings-badge-verified'
                : 'settings-badge-unverified'
            }`}
          >
            {user.email_verified ? '已验证' : '未验证'}
          </span>
        </div>
      </section>

      <form className="settings-section" onSubmit={handleSaveProfile}>
        <h3 className="settings-section-title">个人资料</h3>

        <div className="settings-field">
          <label className="settings-field-label" htmlFor="settings-username">
            用户名
          </label>
          <input
            id="settings-username"
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="alice"
            maxLength={32}
          />
          <span className="settings-field-hint">
            3–32 位字母、数字或下划线，全局唯一
          </span>
        </div>

        <div className="settings-actions">
          <VscodeButton icon="save" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存资料'}
          </VscodeButton>
        </div>
      </form>

      <section className="settings-section">
        <h3 className="settings-section-title">环境</h3>
        <span className="settings-field-hint">
          检测本机 Agent 编排 / 推理服务的 Python 环境与后端连通性，
          缺失时支持一键安装到内置运行时。
        </span>
        <div className="settings-actions">
          <VscodeButton
            secondary
            icon="tools"
            type="button"
            onClick={openWizard}
          >
            环境检测与安装
          </VscodeButton>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">账户操作</h3>
        <div className="settings-actions">
          <VscodeButton
            secondary
            icon="sign-out"
            type="button"
            onClick={handleLogout}
          >
            退出登录
          </VscodeButton>
          <VscodeButton
            secondary
            icon="trash"
            type="button"
            className="vscode-btn-danger"
            onClick={() => setDeleteModalOpen(true)}
          >
            注销账号
          </VscodeButton>
        </div>
      </section>

      {deleteModalOpen && (
        <DeleteAccountModal
          onCancel={() => setDeleteModalOpen(false)}
          onConfirm={handleDeleteAccount}
        />
      )}

      {cropImageSrc && (
        <AvatarCropModal
          imageSrc={cropImageSrc}
          onCancel={() => setCropImageSrc(null)}
          onConfirm={handleCropConfirm}
        />
      )}
    </div>
  );
}
