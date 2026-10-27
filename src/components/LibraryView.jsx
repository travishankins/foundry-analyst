import { useState } from 'react';
import { DataBarVertical24Regular, Document24Regular } from '@fluentui/react-icons';
import { getLibraryItem, listLibrary, unpublishArtifact } from '../lib/api';
import { formatTime, usePolled } from '../hooks/usePolled';
import ArtifactsPanel from './ArtifactsPanel';

export default function LibraryView({ session }) {
  const { data: items, error, loading, reload } = usePolled(listLibrary, 15000);
  const [open, setOpen] = useState(null);
  const [problem, setProblem] = useState(null);
  const [width, setWidth] = useState(() => Math.round(window.innerWidth * 0.5));

  const openItem = async (id) => {
    setProblem(null);
    try {
      setOpen(await getLibraryItem(id));
    } catch (err) {
      setProblem(err.message);
    }
  };

  const remove = async (item) => {
    setProblem(null);
    try {
      await unpublishArtifact(item.id);
      if (open?.id === item.id) setOpen(null);
      reload();
    } catch (err) {
      setProblem(err.message);
    }
  };

  const mayRemove = (item) => item.owner.id === session.user.id || session.user.roles.includes('Admin');

  return (
    <>
      <main className="page">
        <header className="page-header">
          <h1>Shared library</h1>
          <p>Dashboards and reports published by your colleagues. Everyone who can sign in can view them.</p>
        </header>
        {(error || problem) && <div className="message-error" role="alert">{error || problem}</div>}
        {!loading && items?.length === 0 && (
          <div className="empty-state">Nothing is published yet. Open an artifact in Chat and click <strong>Publish</strong>.</div>
        )}
        <div className="card-grid">
          {(items ?? []).map((item) => (
            <div key={item.id} className={`lib-card${open?.id === item.id ? ' active' : ''}`}>
              <button className="lib-card-main" onClick={() => openItem(item.id)}>
                <span className="lib-icon" aria-hidden="true">{item.kind === 'report' ? <Document24Regular /> : <DataBarVertical24Regular />}</span>
                <span className="lib-title">{item.title}</span>
                <span className="lib-meta">
                  {item.kind === 'report' ? 'Report' : 'Dashboard'} · v{item.version} · {item.owner.name}
                </span>
                <span className="lib-meta">{formatTime(item.published_at)}</span>
                {item.note && <span className="lib-note">{item.note}</span>}
              </button>
              {mayRemove(item) && (
                <button className="link-btn danger" onClick={() => remove(item)} aria-label={`Unpublish ${item.title}`}>
                  Unpublish
                </button>
              )}
            </div>
          ))}
        </div>
      </main>
      {open && (
        <ArtifactsPanel
          versions={[open.artifact]}
          version={1}
          onSelectVersion={() => {}}
          onClose={() => setOpen(null)}
          width={width}
          onResize={setWidth}
          canShare={session.can('share')}
        />
      )}
    </>
  );
}
