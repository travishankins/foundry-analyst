export default function ArtifactCard({ refInfo, active, onOpen }) {
  return (
    <button className={`artifact-card${active ? ' active' : ''}`} onClick={onOpen}>
      <span className="artifact-card-icon" aria-hidden="true">{refInfo.kind === 'report' ? '📄' : '📊'}</span>
      <span className="artifact-card-text">
        <span className="artifact-card-title">{refInfo.title}</span>
        <span className="artifact-card-meta">
          {refInfo.kind === 'report' ? 'Report' : 'Dashboard'} · v{refInfo.version} · Click to open
        </span>
      </span>
    </button>
  );
}
