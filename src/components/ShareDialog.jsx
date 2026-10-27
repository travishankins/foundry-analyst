import { useEffect, useState } from 'react';
import {
  Chat20Regular,
  CheckmarkCircle20Filled,
  Cloud20Regular,
  Dismiss20Regular,
  Folder20Regular,
  Mail20Regular,
} from '@fluentui/react-icons';
import { getShareChannels, shareArtifact } from '../lib/api';

const CHANNELS = {
  teams: { label: 'Teams', Icon: Chat20Regular, hint: 'Post a summary card to the configured channel' },
  email: { label: 'Email', Icon: Mail20Regular, hint: 'Send with the PDF attached' },
  sharepoint: { label: 'SharePoint', Icon: Folder20Regular, hint: 'Save the PDF to the team document library' },
  onedrive: { label: 'OneDrive', Icon: Cloud20Regular, hint: 'Save the PDF to your OneDrive' },
};

export default function ShareDialog({ artifact, getPdf, onClose }) {
  const [options, setOptions] = useState(null);
  const [channel, setChannel] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [message, setMessage] = useState('');
  const [state, setState] = useState({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    getShareChannels()
      .then((o) => {
        if (cancelled) return;
        setOptions(o);
        setChannel(o.channels[0] ?? null);
      })
      .catch((err) => !cancelled && setState({ status: 'error', message: err.message }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needsRecipients = channel === 'email';
  const list = recipients.split(/[\s,;]+/).filter(Boolean);
  const canSend = channel && state.status !== 'sending' && (!needsRecipients || list.length > 0);

  const send = async () => {
    setState({ status: 'sending' });
    try {
      const pdf_base64 = channel === 'teams' ? null : await getPdf();
      const result = await shareArtifact({ artifact, channel, recipients: needsRecipients ? list : [], message, pdf_base64 });
      setState({ status: 'done', result });
    } catch (err) {
      setState({ status: 'error', message: err.message });
    }
  };

  const { result } = state;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Share artifact">
        <div className="modal-header">
          <strong>Share “{artifact.title}”</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close share dialog"><Dismiss20Regular /></button>
        </div>

        {state.status === 'done' ? (
          <div className="modal-body">
            <div className="share-success" role="status">
              <span className="share-success-line">
                <CheckmarkCircle20Filled aria-hidden="true" /> {result.summary}
              </span>
              {result.status === 'pending_approval' && <span className="demo-badge">Awaiting approval · see Operations</span>}
              {result.simulated && <span className="demo-badge">Demo mode · nothing was actually sent</span>}
            </div>
            {result.url &&
              (result.simulated ? (
                <code className="share-link">{result.url}</code>
              ) : (
                <a href={result.url} target="_blank" rel="noopener noreferrer" className="share-link">{result.url}</a>
              ))}
            <div className="modal-actions">
              <button className="primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            {options && options.channels.length === 0 && (
              <div className="message-error" role="alert">No sharing channels are configured on the server.</div>
            )}
            {options?.mode === 'mock' && <div className="demo-badge">Demo mode · delivery is simulated</div>}
            {options?.requires_approval && (
              <div className="demo-badge">Requires approval · an approver must sign off before it is sent</div>
            )}
            <div className="channel-grid" role="radiogroup" aria-label="Share to">
              {(options?.channels ?? []).map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={channel === c}
                  className={`channel${channel === c ? ' selected' : ''}`}
                  onClick={() => setChannel(c)}
                  title={CHANNELS[c].hint}
                >
                  {(() => {
                    const { Icon } = CHANNELS[c];
                    return <Icon aria-hidden="true" />;
                  })()}
                  {CHANNELS[c].label}
                </button>
              ))}
            </div>
            {channel && <div className="field-hint">{CHANNELS[channel].hint}</div>}
            {needsRecipients && (
              <label className="field">
                <span>To</span>
                <input
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="name@company.com, other@company.com"
                  autoFocus
                />
              </label>
            )}
            {channel !== 'sharepoint' && channel !== 'onedrive' && (
              <label className="field">
                <span>Message (optional)</span>
                <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
              </label>
            )}
            {state.status === 'error' && <div className="message-error" role="alert">{state.message}</div>}
            <div className="modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" onClick={send} disabled={!canSend}>
                {state.status === 'sending' ? 'Sharing…' : options?.requires_approval ? 'Request approval' : 'Share'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
