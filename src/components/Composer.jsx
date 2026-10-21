import { useEffect, useRef, useState } from 'react';

export default function Composer({ onSend, onStop, streaming, editing, onCancelEdit, autoFocus }) {
  const [value, setValue] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue('');
  };

  return (
    <div className="composer">
      {editing && (
        <div className="edit-chip">
          <span>Editing: {editing}</span>
          <button onClick={onCancelEdit} aria-label="Stop editing artifact">✕</button>
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        placeholder={editing ? 'Describe a change to the artifact…' : 'Ask about your data, docs, or request a dashboard…'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        aria-label="Message"
        maxLength={8000}
      />
      <div className="composer-footer">
        <span className="hint">Orchestrator · Fabric data · Microsoft Learn MCP · Report builder</span>
        {streaming ? (
          <button className="send-btn stop" onClick={onStop} aria-label="Stop">■</button>
        ) : (
          <button className="send-btn" onClick={submit} disabled={!value.trim()} aria-label="Send">↑</button>
        )}
      </div>
    </div>
  );
}
