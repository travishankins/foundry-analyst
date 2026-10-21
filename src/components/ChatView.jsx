import { useEffect, useRef } from 'react';
import Composer from './Composer';
import Message from './Message';

export const SUGGESTIONS = [
  'Build a sales dashboard for last quarter by region and category',
  'Which region had the highest revenue last quarter?',
  'How do I connect a Fabric data agent to Azure AI Foundry?',
  'Write a one-page executive report with Fabric best-practice links',
];

export default function ChatView({ conversation, streaming, onSend, onStop, openArtifact, onOpenArtifact, editing, onCancelEdit }) {
  const endRef = useRef(null);
  const messages = conversation?.messages ?? [];
  const lastContent = messages.at(-1)?.content;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, lastContent]);

  const composer = (
    <Composer onSend={onSend} onStop={onStop} streaming={streaming} editing={editing} onCancelEdit={onCancelEdit} autoFocus />
  );

  if (messages.length === 0) {
    return (
      <main className="chat empty">
        <div className="welcome">
          <div className="welcome-mark" aria-hidden="true">✳</div>
          <h1>What would you like to explore?</h1>
          {composer}
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => onSend(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="chat">
      <div className="chat-header">{conversation.title}</div>
      <div className="messages">
        <div className="messages-inner">
          {messages.map((m) => (
            <Message key={m.id} message={m} openArtifact={openArtifact} onOpenArtifact={onOpenArtifact} />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer-dock">{composer}</div>
    </main>
  );
}
