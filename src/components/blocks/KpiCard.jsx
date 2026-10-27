import { ArrowDown12Filled, ArrowUp12Filled, Subtract12Filled } from '@fluentui/react-icons';

const ARROWS = { up: <ArrowUp12Filled />, down: <ArrowDown12Filled />, flat: <Subtract12Filled /> };

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
