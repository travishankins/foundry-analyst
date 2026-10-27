import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads data on mount and re-polls; `reload()` refreshes on demand. */
export function usePolled(fn, intervalMs = 0, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const data = await fnRef.current();
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (err) {
      if (alive.current) setState((s) => ({ ...s, error: err.message, loading: false }));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    reload();
    const timer = intervalMs ? setInterval(reload, intervalMs) : null;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, intervalMs, ...deps]);

  return { ...state, reload };
}

export const formatTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
