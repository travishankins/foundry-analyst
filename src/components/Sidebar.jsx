import { useState } from 'react';

export default function Sidebar({ conversations, activeId, onNew, onSelect, onRename, onDelete, collapsed, onToggle }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');

  const commit = () => {
    if (draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Conversations">
      <div className="sidebar-top">
        <button className="icon-btn" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          ☰
        </button>
        {!collapsed && <span className="brand">Foundry Analyst</span>}
      </div>
      <button className="new-chat" onClick={onNew}>
        <span aria-hidden="true">＋</span>
        {!collapsed && <span>New chat</span>}
      </button>
      {!collapsed && (
        <>
          <div className="sidebar-section">Recents</div>
          <ul className="conversation-list">
            {conversations.map((c) => (
              <li key={c.id} className={c.id === activeId ? 'active' : undefined}>
                {editingId === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    aria-label="Conversation title"
                    maxLength={120}
                  />
                ) : (
                  <>
                    <button className="conversation-title" onClick={() => onSelect(c.id)} title={c.title}>
                      {c.title}
                    </button>
                    <span className="row-actions">
                      <button
                        onClick={() => {
                          setEditingId(c.id);
                          setDraft(c.title);
                        }}
                        aria-label={`Rename ${c.title}`}
                      >
                        ✎
                      </button>
                      <button onClick={() => onDelete(c.id)} aria-label={`Delete ${c.title}`}>
                        🗑
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
