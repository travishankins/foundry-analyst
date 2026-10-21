import { useCallback, useEffect, useState } from 'react';
import { createConversation } from '../lib/conversation';

const STORAGE_KEY = 'foundry-demo.conversations.v1';

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved?.conversations)) {
      // A reload interrupts any in-flight stream, so clear stale pending flags
      const conversations = saved.conversations.map((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
      }));
      return { conversations, activeId: saved.activeId ?? null };
    }
  } catch {
    // Corrupt storage falls through to an empty state
  }
  return { conversations: [], activeId: null };
}

export function useConversations() {
  const [state, setState] = useState(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Quota exceeded: keep working in memory
    }
  }, [state]);

  const create = useCallback(() => {
    const conversation = createConversation();
    setState((s) => ({ conversations: [conversation, ...s.conversations], activeId: conversation.id }));
    return conversation;
  }, []);

  const select = useCallback((id) => setState((s) => ({ ...s, activeId: id })), []);

  const startNew = useCallback(() => setState((s) => ({ ...s, activeId: null })), []);

  const update = useCallback((id, fn) => {
    setState((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) }));
  }, []);

  const rename = useCallback((id, title) => update(id, (c) => ({ ...c, title })), [update]);

  const remove = useCallback((id) => {
    setState((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  }, []);

  const active = state.conversations.find((c) => c.id === state.activeId) ?? null;
  const sorted = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  return { conversations: sorted, active, create, select, startNew, update, rename, remove };
}
