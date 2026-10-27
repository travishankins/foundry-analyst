import { useCallback, useEffect, useState } from 'react';
import { Bot24Regular } from '@fluentui/react-icons';
import { getAuthConfig, getMe } from '../lib/api';
import { createEntraSession, demoProvider, getStoredDemoUser, setAuthProvider, storeDemoUser } from '../lib/auth';

export const ROLE_BLURB = {
  Viewer: 'Browse the shared library',
  Analyst: 'Create, publish and share artifacts',
  Approver: 'Approve or reject requested actions',
  Admin: 'Everything, plus governance',
};

function Splash({ children }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="welcome-mark" aria-hidden="true"><Bot24Regular /></div>
        <h1>Foundry Analyst</h1>
        {children}
      </div>
    </div>
  );
}

/** Resolves who is signed in, then renders children(session). */
export default function AuthGate({ children }) {
  const [phase, setPhase] = useState({ status: 'loading' });

  const start = useCallback(async () => {
    setPhase({ status: 'loading' });
    try {
      const config = await getAuthConfig();
      if (config.mode === 'mock') {
        const id = getStoredDemoUser();
        setAuthProvider(demoProvider(id));
        const persona = config.personas.find((p) => p.id === id);
        if (!persona) return setPhase({ status: 'pick', config });
        return setPhase({ status: 'ready', config, user: await getMe(), entra: null });
      }
      const entra = await createEntraSession(config);
      setAuthProvider(entra.provider);
      if (!entra.signedIn) return setPhase({ status: 'signin', config, entra });
      return setPhase({ status: 'ready', config, user: await getMe(), entra });
    } catch (err) {
      return setPhase({ status: 'error', message: err.message });
    }
  }, []);

  useEffect(() => {
    start();
    // A 401 from any API call means the sign-in expired; go back to the start
    const expired = () => {
      storeDemoUser(null);
      start();
    };
    window.addEventListener('auth-expired', expired);
    return () => window.removeEventListener('auth-expired', expired);
  }, [start]);

  if (phase.status === 'loading') return <Splash><p className="auth-sub">Loading…</p></Splash>;

  if (phase.status === 'error') {
    return (
      <Splash>
        <div className="message-error" role="alert">{phase.message}</div>
        <button className="primary-btn" onClick={start}>Try again</button>
      </Splash>
    );
  }

  if (phase.status === 'pick') {
    return (
      <Splash>
        <p className="auth-sub">Demo sign-in. Pick a persona to see how roles change what you can do.</p>
        <div className="persona-list">
          {phase.config.personas.map((p) => (
            <button
              key={p.id}
              className="persona"
              onClick={() => {
                storeDemoUser(p.id);
                start();
              }}
            >
              <strong>{p.name}</strong>
              <span>{p.roles.map((r) => `${r}: ${ROLE_BLURB[r]}`).join(' · ')}</span>
            </button>
          ))}
        </div>
        <p className="auth-note">Demo mode only. Production uses Microsoft Entra ID.</p>
      </Splash>
    );
  }

  if (phase.status === 'signin') {
    return (
      <Splash>
        <p className="auth-sub">Sign in with your work account to continue.</p>
        <button className="primary-btn" onClick={() => phase.entra.signIn()}>Sign in with Microsoft</button>
      </Splash>
    );
  }

  const { user, config, entra } = phase;
  const session = {
    user,
    can: (permission) => user.permissions.includes(permission),
    mode: config.mode,
    personas: config.personas ?? [],
    switchUser: (id) => {
      storeDemoUser(id);
      start();
    },
    signOut: () => {
      if (entra) return entra.signOut();
      storeDemoUser(null);
      return start();
    },
  };
  return children(session);
}
