import { useState } from 'react';
import {
  Add20Regular,
  Chat20Regular,
  Delete16Regular,
  Edit16Regular,
  Flash20Regular,
  Library20Regular,
  Navigation20Regular,
  ShieldCheckmark20Regular,
} from '@fluentui/react-icons';

const NAV = [
  { id: 'chat', label: 'Chat', Icon: Chat20Regular, permission: 'chat' },
  { id: 'library', label: 'Library', Icon: Library20Regular, permission: 'library_read' },
  { id: 'operations', label: 'Operations', Icon: Flash20Regular, permission: 'operations_read' },
  { id: 'governance', label: 'Governance', Icon: ShieldCheckmark20Regular, permission: 'audit_read' },
];

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');

export default function Sidebar({
  conversations, activeId, onNew, onSelect, onRename, onDelete, collapsed, onToggle, view, onView, session,
}) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const canChat = session.can('chat');

  const commit = () => {
    if (draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  return (
    <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Main">
      <div className="sidebar-top">
        <button className="icon-btn" onClick={onToggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Navigation20Regular />
        </button>
        {!collapsed && <span className="brand">Foundry Analyst</span>}
      </div>
      {canChat && (
        <button className="new-chat" onClick={onNew}>
          <Add20Regular aria-hidden="true" />
          {!collapsed && <span>New chat</span>}
        </button>
      )}
      <div className="nav-list" role="tablist" aria-label="Sections">
        {NAV.filter((n) => session.can(n.permission)).map((n) => (
          <button
            key={n.id}
            role="tab"
            aria-selected={view === n.id}
            className={`nav-item${view === n.id ? ' active' : ''}`}
            onClick={() => onView(n.id)}
            title={n.label}
          >
            <n.Icon aria-hidden="true" />
            {!collapsed && <span>{n.label}</span>}
          </button>
        ))}
      </div>
      {!collapsed && view === 'chat' && canChat && (
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
                        <Edit16Regular />
                      </button>
                      <button onClick={() => onDelete(c.id)} aria-label={`Delete ${c.title}`}>
                        <Delete16Regular />
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="sidebar-spacer" />
      {!collapsed && (
        <div className="user-chip">
          <div className="user-row">
            <span className="user-avatar" aria-hidden="true">{initials(session.user.name)}</span>
            <div className="user-name">{session.user.name}</div>
          </div>
          <div className="role-pills">
            {session.user.roles.map((r) => (
              <span key={r} className="role-pill">{r}</span>
            ))}
          </div>
          {session.mode === 'mock' ? (
            <label className="switch-user">
              <span>Switch demo user</span>
              <select value={session.user.id} onChange={(e) => session.switchUser(e.target.value)} aria-label="Switch demo user">
                {session.personas.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <button className="link-btn" onClick={session.signOut}>Sign out</button>
          )}
        </div>
      )}
    </nav>
  );
}
