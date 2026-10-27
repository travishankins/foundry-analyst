import { useState } from 'react';
import { CheckmarkCircle16Filled, ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';
import { decideApproval, getIncident, listApprovals, listIncidents, simulateAnomaly } from '../lib/api';
import { formatTime, usePolled } from '../hooks/usePolled';
import ArtifactRenderer from './ArtifactRenderer';

const STATUS_LABEL = {
  analyzing: 'Analyzing…',
  awaiting_approval: 'Awaiting approval',
  resolved: 'Work order created',
  dismissed: 'Dismissed',
  failed: 'Analysis failed',
  action_failed: 'Action failed',
};

function Incident({ incident, approval }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !detail) {
      try {
        setDetail(await getIncident(incident.id));
      } catch (err) {
        setError(err.message);
      }
    }
  };

  const { event } = incident;
  return (
    <div className="incident">
      <button className="incident-head" onClick={toggle} aria-expanded={open}>
        <span className={`status-chip s-${incident.status}`}>{STATUS_LABEL[incident.status] ?? incident.status}</span>
        <span className="incident-title">
          {event.metric} {event.change_pct > 0 ? '+' : ''}{event.change_pct}%{event.scope ? ` · ${event.scope}` : ''}
        </span>
        <span className="incident-meta">{event.source === 'manual' ? incident.actor : `via ${event.source}`} · {formatTime(incident.created_at)}</span>
        <span className="chevron" aria-hidden="true">{open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}</span>
      </button>
      {open && (
        <div className="incident-body">
          {error && <div className="message-error" role="alert">{error}</div>}
          {incident.status === 'analyzing' && <div className="thinking">Agents are investigating<span className="dots" /></div>}
          {detail?.summary && <p className="incident-summary">{detail.summary}</p>}
          {detail?.error && <div className="message-error">{detail.error}</div>}
          {detail?.work_order && (
            <div className="share-success">
              <CheckmarkCircle16Filled aria-hidden="true" /> {detail.work_order.summary ?? `Work order ${detail.work_order.id}`} · {detail.work_order.id}
              {detail.work_order.simulated && <span className="demo-badge">Demo mode · no real work order</span>}
            </div>
          )}
          {approval?.status === 'pending' && <div className="field-hint">The proposed work order is waiting in “Awaiting approval” above.</div>}
          {detail?.artifact && (
            <div className="artifact-canvas inline-artifact">
              <ArtifactRenderer artifact={detail.artifact} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ approval, session, onDone }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mine = approval.requested_by.id === session.user.id;

  const decide = async (decision) => {
    setBusy(true);
    setError(null);
    try {
      await decideApproval(approval.id, decision, comment);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval">
      <div className="approval-head">
        <span className="kind-chip">{approval.kind === 'work_order' ? 'Work order' : 'Share'}</span>
        <strong>{approval.title}</strong>
        {approval.details.priority && <span className={`status-chip p-${approval.details.priority}`}>{approval.details.priority} priority</span>}
      </div>
      <p className="approval-summary">{approval.summary}</p>
      <div className="incident-meta">
        Requested by {approval.requested_by.name} · {formatTime(approval.created_at)} · expires {formatTime(approval.expires_at)}
      </div>
      {session.can('decide') ? (
        <>
          <input
            className="approval-comment"
            placeholder="Comment (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={500}
            aria-label="Decision comment"
          />
          {mine && <div className="field-hint">You requested this, so a different approver normally has to sign off.</div>}
          {error && <div className="message-error" role="alert">{error}</div>}
          <div className="modal-actions">
            <button onClick={() => decide('reject')} disabled={busy}>Reject</button>
            <button className="primary" onClick={() => decide('approve')} disabled={busy}>Approve</button>
          </div>
        </>
      ) : (
        <div className="field-hint">Waiting for an approver. Your role can view but not decide.</div>
      )}
    </div>
  );
}

function RaiseEvent({ onRaised }) {
  const [form, setForm] = useState({ metric: 'Vendor spend', scope: 'Plant 4', change_pct: '38.5' });
  const [state, setState] = useState({ status: 'idle' });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const valid = form.metric.trim() && Number.isFinite(Number(form.change_pct)) && form.change_pct !== '';

  const submit = async () => {
    setState({ status: 'sending' });
    try {
      await simulateAnomaly({ source: 'manual', metric: form.metric.trim(), scope: form.scope.trim(), change_pct: Number(form.change_pct) });
      setState({ status: 'idle' });
      onRaised();
    } catch (err) {
      setState({ status: 'error', message: err.message });
    }
  };

  return (
    <section className="panel-card">
      <h2>Raise an anomaly event</h2>
      <p className="field-hint">
        In production a Fabric Activator rule or Event Grid subscription calls <code>POST /api/events/anomaly</code>. This form does the same by hand.
      </p>
      <div className="form-row">
        <label className="field"><span>Metric</span><input value={form.metric} onChange={set('metric')} maxLength={120} /></label>
        <label className="field"><span>Scope</span><input value={form.scope} onChange={set('scope')} maxLength={200} /></label>
        <label className="field narrow"><span>Change %</span><input value={form.change_pct} onChange={set('change_pct')} inputMode="decimal" /></label>
        <button className="primary-btn" onClick={submit} disabled={!valid || state.status === 'sending'}>
          {state.status === 'sending' ? 'Raising…' : 'Simulate anomaly'}
        </button>
      </div>
      {state.status === 'error' && <div className="message-error" role="alert">{state.message}</div>}
    </section>
  );
}

export default function OperationsView({ session }) {
  const { data, error, reload } = usePolled(() => Promise.all([listApprovals(), listIncidents()]), 3000);
  const [approvals, incidents] = data ?? [[], []];
  const pending = approvals.filter((a) => a.status === 'pending');
  const decided = approvals.filter((a) => a.status !== 'pending').slice(0, 8);
  const byId = Object.fromEntries(approvals.map((a) => [a.id, a]));

  return (
    <main className="page">
      <header className="page-header">
        <h1>Operations</h1>
        <p>Agents act on events, but a person approves anything that changes the outside world.</p>
      </header>
      {error && <div className="message-error" role="alert">{error}</div>}
      {session.can('incident_create') && <RaiseEvent onRaised={reload} />}

      <section>
        <h2>Awaiting approval <span className="count">{pending.length}</span></h2>
        {pending.length === 0 && <div className="empty-state">Nothing is waiting for approval.</div>}
        <div className="stack">
          {pending.map((a) => <ApprovalCard key={a.id} approval={a} session={session} onDone={reload} />)}
        </div>
      </section>

      <section>
        <h2>Incidents <span className="count">{incidents.length}</span></h2>
        {incidents.length === 0 && <div className="empty-state">No events yet. Raise one above to watch the agents investigate.</div>}
        <div className="stack">
          {incidents.map((i) => <Incident key={i.id} incident={i} approval={byId[i.approval_id]} />)}
        </div>
      </section>

      {decided.length > 0 && (
        <section>
          <h2>Recent decisions</h2>
          <ul className="decision-list">
            {decided.map((a) => (
              <li key={a.id}>
                <span className={`status-chip s-${a.status}`}>{a.status}</span>
                <span>{a.title}</span>
                <span className="incident-meta">
                  {a.decided_by ? `${a.decided_by.name} · ${formatTime(a.decided_at)}` : formatTime(a.expires_at)}
                  {a.comment ? ` · “${a.comment}”` : ''}{a.error ? ` · ${a.error}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
