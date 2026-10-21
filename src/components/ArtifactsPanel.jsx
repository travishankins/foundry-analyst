import { useEffect, useRef, useState } from 'react';
import ArtifactRenderer from './ArtifactRenderer';
import { exportPdf, exportPng } from '../lib/exportArtifact';

export default function ArtifactsPanel({ versions, version, onSelectVersion, onClose, width, onResize }) {
  const [view, setView] = useState('preview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const docRef = useRef(null);

  const current = versions[version - 1];

  useEffect(() => setView('preview'), [current?.artifact_id]);

  const runExport = async (fn) => {
    setMenuOpen(false);
    setView('preview');
    setBusy(true);
    try {
      // Wait a frame so the preview is mounted before capture
      await new Promise((r) => requestAnimationFrame(r));
      await fn(docRef.current, current.title);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev) => onResize(Math.min(Math.max(startW - (ev.clientX - startX), 360), window.innerWidth * 0.75));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!current) return null;

  return (
    <aside className="artifacts-panel" style={{ width }} aria-label="Artifact">
      <div className="resize-handle" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
      <header className="panel-header">
        <div className="panel-title">
          <span className="artifact-icon" aria-hidden="true">{current.kind === 'report' ? '📄' : '📊'}</span>
          <span className="title-text">{current.title}</span>
          <select
            aria-label="Version"
            value={version}
            onChange={(e) => onSelectVersion(Number(e.target.value))}
            className="version-select"
          >
            {versions.map((_, i) => (
              <option key={i} value={i + 1}>
                v{i + 1}
                {i === versions.length - 1 ? ' (latest)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="panel-actions">
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')}>
              Preview
            </button>
            <button role="tab" aria-selected={view === 'source'} onClick={() => setView('source')}>
              Source
            </button>
          </div>
          <div className="menu">
            <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy}>
              {busy ? 'Exporting…' : 'Export ▾'}
            </button>
            {menuOpen && (
              <div className="menu-list" role="menu">
                <button role="menuitem" onClick={() => runExport(exportPng)}>Download PNG</button>
                <button role="menuitem" onClick={() => runExport(exportPdf)}>Download PDF</button>
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close artifact">
            ✕
          </button>
        </div>
      </header>
      <div className="panel-body">
        {view === 'preview' ? (
          <div ref={docRef} className="artifact-canvas">
            <ArtifactRenderer artifact={current} />
          </div>
        ) : (
          <div className="source-view">
            <button className="copy-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            <pre>
              <code>{JSON.stringify(current, null, 2)}</code>
            </pre>
          </div>
        )}
      </div>
    </aside>
  );
}
