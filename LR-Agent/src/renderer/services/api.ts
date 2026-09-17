import { authFetchPath, parseApiError } from './authenticatedFetch';

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: FormData | string | null;
  auth?: boolean;
}

// eslint-disable-next-line import/prefer-default-export
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { auth = true, headers, ...rest } = options;

  const response = await authFetchPath(path, {
    ...rest,
    headers,
    auth,
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
