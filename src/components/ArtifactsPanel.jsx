import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownload16Regular,
  DataBarVertical20Regular,
  Dismiss20Regular,
  Document20Regular,
  Share16Regular,
} from '@fluentui/react-icons';
import ArtifactRenderer from './ArtifactRenderer';
import ShareDialog from './ShareDialog';
import { exportPdf, exportPng, pdfBase64 } from '../lib/exportArtifact';

export default function ArtifactsPanel({ versions, version, onSelectVersion, onClose, width, onResize, canShare = true, onPublish }) {
  const [view, setView] = useState('preview');
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [publish, setPublish] = useState({ state: 'idle' });
  const [notice, setNotice] = useState(null);
  const docRef = useRef(null);

  const current = versions[version - 1];

  useEffect(() => setView('preview'), [current?.artifact_id]);

  const flash = (message) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 3000);
  };

  const runExport = async (fn) => {
    setMenuOpen(false);
    setView('preview');
    setBusy(true);
    try {
      // Wait a frame so the preview is mounted before capture
      await new Promise((r) => requestAnimationFrame(r));
      await fn(docRef.current, current.title);
    } catch (err) {
      console.error('Export failed', err);
      flash('Export failed');
    } finally {
      setBusy(false);
    }
  };

  const doPublish = async () => {
    setPublish({ state: 'busy' });
    try {
      const entry = await onPublish(current);
      setPublish({ state: 'done', version: entry.version });
      setTimeout(() => setPublish({ state: 'idle' }), 3000);
    } catch (err) {
      setPublish({ state: 'idle' });
      flash(err.message);
    }
  };

  const getPdf = async () => {
    setView('preview');
    // Let the preview mount before capturing it
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return pdfBase64(docRef.current);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      flash('Copy failed');
    }
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
          <span className="artifact-icon" aria-hidden="true">{current.kind === 'report' ? <Document20Regular /> : <DataBarVertical20Regular />}</span>
          <span className="title-text">{current.title}</span>
          {versions.length > 1 && (
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
          )}
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
          {onPublish && (
            <button className="icon-btn publish-btn" onClick={doPublish} disabled={publish.state === 'busy'}>
              {publish.state === 'done' ? `Published v${publish.version}` : publish.state === 'busy' ? 'Publishing…' : 'Publish'}
            </button>
          )}
          {canShare && (
            <button className="share-btn" onClick={() => setSharing(true)}>
              <Share16Regular aria-hidden="true" />
              Share
            </button>
          )}
          <div className="menu">
            <button className="icon-btn" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy}>
              <ArrowDownload16Regular aria-hidden="true" />
              {busy ? 'Exporting…' : 'Export'}
            </button>
            {menuOpen && (
              <div className="menu-list" role="menu">
                <button role="menuitem" onClick={() => runExport(exportPng)}>Download PNG</button>
                <button role="menuitem" onClick={() => runExport(exportPdf)}>Download PDF</button>
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close artifact">
            <Dismiss20Regular />
          </button>
        </div>
      </header>
      {notice && <div className="message-error" role="alert">{notice}</div>}
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
      {sharing && canShare && <ShareDialog key={`${current.artifact_id}-${version}`} artifact={current} getPdf={getPdf} onClose={() => setSharing(false)} />}
    </aside>
  );
}
