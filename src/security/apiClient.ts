// Phase 2: every same-origin /api call carries the session cookie and, for state-changing methods,
// the CSRF token and a JSON content type (the server refuses anything else).
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function installApiFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const sameOriginApi = url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
    if (!sameOriginApi) return original(input, init);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    if (method !== 'GET' && method !== 'HEAD') {
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
    }
    const res = await original(input, { ...init, headers, credentials: 'same-origin' });
    if (res.status === 401 && !url.includes('/api/auth/')) {
      window.dispatchEvent(new Event('tb-auth-required'));
    }
    return res;
  };
}
