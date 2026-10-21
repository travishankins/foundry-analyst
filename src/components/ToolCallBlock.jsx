import { useState } from 'react';

const LABELS = {
  fabric_data: 'Queried Fabric data agent',
  docs_mcp: 'Searched Microsoft Learn',
  report_builder: 'Built artifact',
  fabric_dataagent: 'Fabric data agent',
};

const pretty = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

export default function ToolCallBlock({ call }) {
  const [open, setOpen] = useState(false);
  const args = pretty(call.arguments);
  const output = pretty(call.output);
  const label = LABELS[call.name] ?? `Used ${call.name}`;
  const running = call.status === 'in_progress';

  return (
    <div className={`tool-call status-${call.status}`}>
      <button className="tool-call-header" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="tool-status" aria-hidden="true">
          {running ? <span className="spinner" /> : call.status === 'completed' ? '✓' : '!'}
        </span>
        <span className="tool-label">{label}</span>
        <span className="tool-kind">{call.kind === 'connected_agent' ? `agent · ${call.name}` : call.kind}</span>
        <span className="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-call-body">
          {args && (
            <>
              <div className="tool-section">Request</div>
              <pre>{args}</pre>
            </>
          )}
          {output && (
            <>
              <div className="tool-section">Response</div>
              <pre>{output.length > 6000 ? `${output.slice(0, 6000)}\n…` : output}</pre>
            </>
          )}
          {!args && !output && <div className="tool-section">{running ? 'Running…' : 'No details'}</div>}
        </div>
      )}
    </div>
  );
}
