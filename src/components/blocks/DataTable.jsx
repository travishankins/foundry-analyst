import { useMemo, useState } from 'react';

const formatCell = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
};

export default function DataTable({ block }) {
  const [sort, setSort] = useState({ index: null, dir: 1 });

  const rows = useMemo(() => {
    if (sort.index === null) return block.rows;
    return [...block.rows].sort((a, b) => {
      const x = a[sort.index];
      const y = b[sort.index];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * sort.dir;
    });
  }, [block.rows, sort]);

  const toggle = (index) => setSort((s) => ({ index, dir: s.index === index ? -s.dir : 1 }));

  return (
    <div className="table-block">
      {block.title && <div className="block-title">{block.title}</div>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {block.columns.map((col, i) => (
                <th key={col + i} aria-sort={sort.index === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => toggle(i)}>
                    {col}
                    {sort.index === i && <span aria-hidden="true">{sort.dir === 1 ? ' ↑' : ' ↓'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {block.columns.map((_, c) => (
                  <td key={c} className={typeof row[c] === 'number' ? 'num' : undefined}>
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
