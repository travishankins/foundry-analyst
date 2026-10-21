export async function createThread() {
  const res = await fetch('/api/threads', { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to create thread (${res.status})`);
  return (await res.json()).thread_id;
}

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
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, artifact_context: artifactContext ?? null }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

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
