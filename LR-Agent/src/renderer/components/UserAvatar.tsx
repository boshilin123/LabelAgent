import { useEffect, useState } from 'react';
import { UserPublic } from '../types/auth';
import { getAvatarDisplayUrl, getAvatarSrcSet } from '../utils/avatarUrl';
import './UserAvatar.css';

export type UserAvatarSize = 'sm' | 'md';

interface UserAvatarProps {
  user: Pick<UserPublic, 'email' | 'username' | 'avatar_url'>;
  size?: UserAvatarSize;
  className?: string;
  alt?: string;
}

function getInitials(user: Pick<UserPublic, 'email' | 'username'>): string {
  return (user.username || user.email).charAt(0).toUpperCase();
}

export default function UserAvatar({
  user,
  size = 'md',
  className = '',
  alt = '用户头像',
}: UserAvatarProps) {
  const [avatarSrc, setAvatarSrc] = useState<string | null>(() =>
    user.avatar_url ? getAvatarDisplayUrl(user.avatar_url) : null,
  );

  useEffect(() => {
    setAvatarSrc(user.avatar_url ? getAvatarDisplayUrl(user.avatar_url) : null);
  }, [user.avatar_url]);

  const handleError = () => {
    if (user.avatar_url && avatarSrc !== user.avatar_url) {
      setAvatarSrc(user.avatar_url);
    }
  };

  const sizeClass = `user-avatar-${size}`;
  const classes = ['user-avatar', sizeClass, className]
    .filter(Boolean)
    .join(' ');

  if (avatarSrc) {
    return (
      <img
        src={avatarSrc}
        srcSet={user.avatar_url ? getAvatarSrcSet(user.avatar_url) : undefined}
        sizes={size === 'sm' ? '32px' : '72px'}
        width={size === 'sm' ? 32 : 72}
        height={size === 'sm' ? 32 : 72}
        alt={alt}
        className={classes}
        onError={handleError}
      />
    );
  }

  return (
    <div
      className={`${classes} user-avatar-placeholder`}
      aria-hidden={alt === ''}
    >
      {getInitials(user)}
    </div>
  );
}

export { getInitials };
