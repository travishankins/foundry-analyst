export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function createConversation() {
  const now = Date.now();
  return { id: newId(), title: 'New chat', threadId: null, createdAt: now, updatedAt: now, messages: [], artifacts: {} };
}

export function latestVersion(conversation, artifactId) {
  return conversation.artifacts[artifactId]?.length ?? 0;
}

function upsertToolCall(toolCalls, event) {
  const { type: _type, ...call } = event;
  const defined = Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined && v !== null));
  const index = toolCalls.findIndex((t) => t.id === call.id);
  if (index === -1) return [...toolCalls, defined];
  return toolCalls.map((t, i) => (i === index ? { ...t, ...defined } : t));
}

/** Folds one server-sent event into the conversation's assistant message. */
export function applyEvent(conversation, messageId, event) {
  let { artifacts } = conversation;
  const messages = conversation.messages.map((m) => {
    if (m.id !== messageId) return m;
    switch (event.type) {
      case 'text_delta':
        return { ...m, content: m.content + event.text };
      case 'tool_call':
        return event.id ? { ...m, toolCalls: upsertToolCall(m.toolCalls, event) } : m;
      case 'artifact': {
        const { artifact } = event;
        const versions = [...(artifacts[artifact.artifact_id] ?? []), artifact];
        artifacts = { ...artifacts, [artifact.artifact_id]: versions };
        const ref = { artifactId: artifact.artifact_id, version: versions.length, title: artifact.title, kind: artifact.kind };
        return { ...m, artifacts: [...m.artifacts, ref] };
      }
      case 'error':
        return { ...m, error: event.message };
      case 'done':
        return {
          ...m,
          pending: false,
          toolCalls: m.toolCalls.map((t) => (t.status === 'in_progress' ? { ...t, status: 'incomplete' } : t)),
        };
      default:
        return m;
    }
  });
  return { ...conversation, messages, artifacts, updatedAt: Date.now() };
}
