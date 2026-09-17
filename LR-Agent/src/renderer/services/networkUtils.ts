export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return true;
  }

  if (err instanceof TypeError) {
    const message = err.message.toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('load failed') ||
      message.includes('networkerror')
    );
  }

  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return (
      message.includes('failed to fetch') ||
      message.includes('network') ||
      message.includes('network_unavailable')
    );
  }

  return false;
}

export function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}
