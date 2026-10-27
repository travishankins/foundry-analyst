import { DataBarVertical20Regular, Document20Regular } from '@fluentui/react-icons';

export default function ArtifactCard({ refInfo, active, onOpen }) {
  const Icon = refInfo.kind === 'report' ? Document20Regular : DataBarVertical20Regular;
  return (
    <button className={`artifact-card${active ? ' active' : ''}`} onClick={onOpen}>
      <span className="artifact-card-icon" aria-hidden="true"><Icon /></span>
      <span className="artifact-card-text">
        <span className="artifact-card-title">{refInfo.title}</span>
        <span className="artifact-card-meta">
          {refInfo.kind === 'report' ? 'Report' : 'Dashboard'} · v{refInfo.version} · Click to open
        </span>
      </span>
    </button>
  );
}
