import { useCallback, useRef, useState } from 'react';
import { createThread, streamMessage } from '../lib/api';
import { applyEvent, newId } from '../lib/conversation';

export function useAgentStream({ create, update, onArtifact }) {
  const [streamingId, setStreamingId] = useState(null);
  const abortRef = useRef(null);

  const send = useCallback(
    async (conversation, content, artifactContext) => {
      const conv = conversation ?? create();
      const userMsg = { id: newId(), role: 'user', content, editing: artifactContext?.title ?? null };
      const assistantId = newId();
      const assistantMsg = { id: assistantId, role: 'assistant', content: '', toolCalls: [], artifacts: [], pending: true };

      update(conv.id, (c) => ({
        ...c,
        title: c.messages.length === 0 ? content.slice(0, 60) : c.title,
        messages: [...c.messages, userMsg, assistantMsg],
        updatedAt: Date.now(),
      }));

      const apply = (event) => update(conv.id, (c) => applyEvent(c, assistantId, event));
      const controller = new AbortController();
      abortRef.current = controller;
      setStreamingId(conv.id);

      try {
        const stream = (id) =>
          streamMessage({
            threadId: id,
            content,
            artifactContext,
            signal: controller.signal,
            onEvent: (event) => {
              apply(event);
              if (event.type === 'artifact') onArtifact?.(event.artifact.artifact_id);
            },
          });
        let threadId = conv.threadId;
        if (!threadId) {
          threadId = await createThread();
          update(conv.id, (c) => ({ ...c, threadId }));
        }
        try {
          await stream(threadId);
        } catch (err) {
          // The saved thread no longer exists server-side (e.g. the server restarted): start a fresh one once
          if (err.status !== 404 || !conv.threadId) throw err;
          threadId = await createThread();
          update(conv.id, (c) => ({ ...c, threadId }));
          await stream(threadId);
        }
      } catch (err) {
        if (err.name !== 'AbortError') apply({ type: 'error', message: err.message });
      } finally {
        apply({ type: 'done' });
        abortRef.current = null;
        setStreamingId(null);
      }
    },
    [create, update, onArtifact],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { send, stop, streamingId };
}
