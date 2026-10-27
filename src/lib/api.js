import { authHeaders } from './auth';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const detailOf = (body) =>
  typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail) ? body.detail[0]?.msg : null;

async function send(path, { method = 'GET', body, signal } = {}) {
  const headers = { ...(await authHeaders()) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) window.dispatchEvent(new Event('auth-expired'));
  return res;
}

async function request(path, options, fallback = 'Request failed') {
  const res = await send(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(detailOf(body) ?? `${fallback} (${res.status})`, res.status);
  return body;
}

export const getAuthConfig = () => fetch('/api/auth/config').then((r) => r.json());
export const getMe = () => request('/api/me');

export async function createThread() {
  return (await request('/api/threads', { method: 'POST' }, 'Failed to create thread')).thread_id;
}

export const getShareChannels = () => request('/api/share/channels', {}, 'Could not load share options');
export const shareArtifact = (payload) => request('/api/share', { method: 'POST', body: payload }, 'Share failed');

export const listLibrary = () => request('/api/library').then((b) => b.items);
export const getLibraryItem = (id) => request(`/api/library/${encodeURIComponent(id)}`);
export const publishArtifact = (artifact, note = '') => request('/api/library', { method: 'POST', body: { artifact, note } }, 'Publish failed');
export const unpublishArtifact = (id) => request(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listApprovals = () => request('/api/approvals').then((b) => b.items);
export const decideApproval = (id, decision, comment) =>
  request(`/api/approvals/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { decision, comment: comment || null } });

export const listIncidents = () => request('/api/incidents').then((b) => b.items);
export const getIncident = (id) => request(`/api/incidents/${encodeURIComponent(id)}`);
export const simulateAnomaly = (event) => request('/api/events/anomaly', { method: 'POST', body: event }, 'Could not raise the event');

export const listAudit = (type) => request(`/api/audit${type ? `?type=${encodeURIComponent(type)}` : ''}`).then((b) => b.items);
export const getMetrics = () => request('/api/metrics');

export function parseSseChunk(buffer) {
  const events = [];
  const frames = buffer.split('\n\n');
  const rest = frames.pop();
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Ignore malformed frames rather than aborting the whole stream
    }
  }
  return { events, rest };
}

export async function streamMessage({ threadId, content, artifactContext, signal, onEvent }) {
  const res = await send(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: { content, artifact_context: artifactContext ?? null },
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().then(detailOf, () => null);
    throw new ApiError(detail ? `${detail} (${res.status})` : `Request failed (${res.status})`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    events.forEach(onEvent);
  }
}
