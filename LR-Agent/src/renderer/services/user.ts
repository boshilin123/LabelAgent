import { UserPublic } from '../types/auth';
import { apiFetch } from './api';

export async function getMe(): Promise<UserPublic> {
  return apiFetch<UserPublic>('/users/me');
}

export async function updateProfile(data: {
  username?: string | null;
}): Promise<UserPublic> {
  return apiFetch<UserPublic>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function uploadAvatar(file: File): Promise<UserPublic> {
  const formData = new FormData();
  formData.append('file', file);
  return apiFetch<UserPublic>('/users/me/avatar', {
    method: 'POST',
    body: formData,
  });
}

export async function deleteAvatar(): Promise<UserPublic> {
  return apiFetch<UserPublic>('/users/me/avatar', {
    method: 'DELETE',
  });
}

export async function deleteAccount(password: string): Promise<void> {
  await apiFetch<{ message: string }>('/users/me/delete-account', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}
