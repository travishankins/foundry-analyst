import { useState } from 'react';
import { getMetrics, listAudit } from '../lib/api';
import { formatTime, usePolled } from '../hooks/usePolled';

const TYPES = ['agent_run', 'share', 'publish', 'unpublish', 'event_received', 'incident_analyzed', 'approval_requested',
  'approval_decided', 'access_denied', 'incident_failed'];

const seconds = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : '—');

function Stat({ label, value, tone }) {
  return (
    <div className={`stat${tone ? ` tone-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export default function GovernanceView() {
  const [type, setType] = useState('');
  const { data, error, reload } = usePolled(() => Promise.all([getMetrics(), listAudit(type || undefined)]), 8000, [type]);
  const [metrics, audit] = data ?? [null, []];

  return (
    <main className="page">
      <header className="page-header">
        <h1>Governance &amp; monitoring</h1>
        <p>Who ran what, what the agents did, what was approved, and what was blocked.</p>
      </header>
      {error && <div className="message-error" role="alert">{error}</div>}
      {metrics && (
        <>
          <div className="stat-grid">
            <Stat label="Agent runs (24h)" value={metrics.runs_24h} />
            <Stat label="Failed runs (24h)" value={metrics.run_errors_24h} tone={metrics.run_errors_24h ? 'bad' : undefined} />
            <Stat label="Avg / p95 latency" value={`${seconds(metrics.avg_run_ms)} / ${seconds(metrics.p95_run_ms)}`} />
            <Stat label="Artifacts created (24h)" value={metrics.artifacts_24h} />
            <Stat label="Pending approvals" value={metrics.approvals.pending} tone={metrics.approvals.pending ? 'warn' : undefined} />
            <Stat label="Approved / rejected" value={`${metrics.approvals.approved} / ${metrics.approvals.rejected}`} />
            <Stat label="Open incidents" value={metrics.incidents_open} />
            <Stat label="Blocked attempts" value={metrics.access_denied_total} tone={metrics.access_denied_total ? 'warn' : undefined} />
          </div>
          {Object.keys(metrics.tool_usage_24h).length > 0 && (
            <div className="tool-usage">
              <span className="field-hint">Tool usage (24h):</span>
              {Object.entries(metrics.tool_usage_24h).map(([name, count]) => (
                <span key={name} className="role-pill">{name} × {count}</span>
              ))}
            </div>
          )}
        </>
      )}

      <section>
        <div className="audit-toolbar">
          <h2>Audit log</h2>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter audit log">
            <option value="">All events</option>
            {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
          <button className="link-btn" onClick={reload}>Refresh</button>
        </div>
        <div className="table-scroll">
          <table className="audit-table">
            <thead>
              <tr><th>Time</th><th>Who</th><th>Event</th><th>Details</th></tr>
            </thead>
            <tbody>
              {audit.length === 0 && <tr><td colSpan={4} className="empty-cell">No activity recorded yet.</td></tr>}
              {audit.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{formatTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td><span className={`status-chip t-${e.type}`}>{e.type.replace(/_/g, ' ')}</span></td>
                  <td>
                    {e.summary}
                    {e.type === 'agent_run' && (
                      <span className="incident-meta"> · {e.detail.status} · {seconds(e.detail.duration_ms)}
                        {e.detail.tools?.length ? ` · ${e.detail.tools.join(', ')}` : ''}</span>
                    )}
                    {e.type === 'agent_run' && e.detail.prompt && <div className="incident-meta">“{e.detail.prompt}”</div>}
                    {e.type === 'approval_decided' && e.detail.comment && <div className="incident-meta">“{e.detail.comment}”</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
