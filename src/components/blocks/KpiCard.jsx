const ARROWS = { up: '▲', down: '▼', flat: '▬' };

export default function KpiCard({ block }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{block.label}</div>
      <div className="kpi-value">{block.value}</div>
      {block.delta && (
        <div className={`kpi-delta trend-${block.trend ?? 'flat'}`}>
          {block.trend && <span aria-hidden="true">{ARROWS[block.trend]} </span>}
          {block.delta}
        </div>
      )}
    </div>
  );
}
