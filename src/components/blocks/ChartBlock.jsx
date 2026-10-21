import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export const PALETTE = ['#c96442', '#4f7cac', '#7a9e7e', '#d4a24c', '#8b6fae', '#5aa5a5', '#b5555e'];

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const formatTick = (v) => (typeof v === 'number' ? compact.format(v) : v);

const CARTESIAN = { line: [LineChart, Line], bar: [BarChart, Bar], area: [AreaChart, Area] };

export default function ChartBlock({ block }) {
  const { chart_type: type, data, x_key: xKey, series } = block;
  let chart;

  if (type === 'pie') {
    const key = series[0].key;
    chart = (
      <PieChart>
        <Pie data={data} dataKey={key} nameKey={xKey} innerRadius="45%" outerRadius="80%" paddingAngle={2} isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip formatter={formatTick} />
        <Legend />
      </PieChart>
    );
  } else {
    const [Chart, Series] = CARTESIAN[type] ?? CARTESIAN.bar;
    chart = (
      <Chart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey={xKey} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} />
        <YAxis tickFormatter={formatTick} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} width={56} />
        <Tooltip formatter={formatTick} />
        {series.length > 1 && <Legend />}
        {series.map((s, i) => {
          const color = PALETTE[i % PALETTE.length];
          return (
            <Series
              key={s.key}
              dataKey={s.key}
              name={s.label ?? s.key}
              stroke={color}
              fill={color}
              fillOpacity={type === 'area' ? 0.25 : 1}
              strokeWidth={2}
              isAnimationActive={false}
            />
          );
        })}
      </Chart>
    );
  }

  return (
    <figure className="chart-block">
      <figcaption>{block.title}</figcaption>
      <div className="chart-canvas">
        <ResponsiveContainer width="100%" height="100%">
          {chart}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
