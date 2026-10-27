import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import ArtifactRenderer from './components/ArtifactRenderer';
import { parseSseChunk } from './lib/api';
import { applyEvent, createConversation } from './lib/conversation';

vi.mock('./lib/exportArtifact', () => ({
  exportPdf: vi.fn(),
  exportPng: vi.fn(),
  pdfBase64: vi.fn(async () => 'JVBERi0='),
}));

const ARTIFACT = {
  artifact_id: 'sales-dash',
  title: 'Sales Dashboard',
  kind: 'dashboard',
  blocks: [
    { type: 'grid', columns: 2, blocks: [{ type: 'kpi', label: 'Revenue', value: '$1.4M', delta: '+8%', trend: 'up' }] },
    { type: 'chart', title: 'By region', chart_type: 'bar', x_key: 'm', series: [{ key: 'v' }], data: [{ m: 'Jul', v: 1 }] },
    { type: 'table', title: 'Categories', columns: ['Category', 'Revenue'], rows: [['Bikes', 612400], ['Clothing', 98700]] },
    { type: 'markdown', content: '**Bold** note' },
    { type: 'script', src: 'x' },
  ],
};

const PERMISSIONS = {
  Viewer: ['library_read'],
  Analyst: ['library_read', 'chat', 'publish', 'share', 'incident_create', 'operations_read'],
  Approver: ['library_read', 'operations_read', 'decide', 'audit_read'],
};

function sessionFor(id) {
  const people = {
    alice: { id: 'alice', name: 'Alice Analyst', roles: ['Analyst'] },
    victor: { id: 'victor', name: 'Victor Viewer', roles: ['Viewer'] },
    ada: { id: 'ada', name: 'Ada Approver', roles: ['Approver'] },
  };
  const user = { ...people[id], permissions: [...new Set(people[id].roles.flatMap((r) => PERMISSIONS[r]))] };
  return {
    user,
    can: (p) => user.permissions.includes(p),
    mode: 'mock',
    personas: Object.values(people),
    switchUser: vi.fn(),
    signOut: vi.fn(),
  };
}

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseSseChunk', () => {
  test('returns complete frames and keeps the partial remainder', () => {
    const { events, rest } = parseSseChunk('data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"ty');
    expect(events.map((e) => e.type)).toEqual(['a', 'b']);
    expect(rest).toBe('data: {"ty');
  });

  test('skips malformed frames', () => {
    expect(parseSseChunk('data: nope\n\ndata: {"type":"ok"}\n\n').events).toEqual([{ type: 'ok' }]);
  });
});

describe('applyEvent', () => {
  const setup = () => {
    const c = createConversation();
    c.messages = [{ id: 'm1', role: 'assistant', content: '', toolCalls: [], artifacts: [], pending: true }];
    return c;
  };

  test('upserts tool calls without losing earlier fields', () => {
    let c = setup();
    c = applyEvent(c, 'm1', { type: 'tool_call', id: 't1', name: 'fabric_data', status: 'in_progress' });
    c = applyEvent(c, 'm1', { type: 'tool_call', id: 't1', status: 'completed', output: 'rows', arguments: null });
    expect(c.messages[0].toolCalls).toEqual([{ id: 't1', name: 'fabric_data', status: 'completed', output: 'rows' }]);
  });

  test('versions artifacts with the same id', () => {
    let c = setup();
    c = applyEvent(c, 'm1', { type: 'artifact', artifact: ARTIFACT });
    c = applyEvent(c, 'm1', { type: 'artifact', artifact: { ...ARTIFACT, title: 'Sales v2' } });
    expect(c.artifacts['sales-dash']).toHaveLength(2);
    expect(c.messages[0].artifacts.map((a) => a.version)).toEqual([1, 2]);
  });

  test('done marks dangling tool calls incomplete', () => {
    let c = setup();
    c = applyEvent(c, 'm1', { type: 'tool_call', id: 't1', name: 'x', status: 'in_progress' });
    c = applyEvent(c, 'm1', { type: 'done' });
    expect(c.messages[0].pending).toBe(false);
    expect(c.messages[0].toolCalls[0].status).toBe('incomplete');
  });
});

test('ArtifactRenderer renders whitelisted blocks and a placeholder for unknown ones', () => {
  render(<ArtifactRenderer artifact={ARTIFACT} />);
  screen.getByText('$1.4M');
  screen.getByText('612,400');
  screen.getByText('Bold');
  screen.getByText('Unsupported block: script');
  expect(document.querySelector('script')).toBeNull();
});

test('a malformed block is contained instead of crashing the artifact', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const broken = { ...ARTIFACT, blocks: [{ type: 'table', columns: ['A'], rows: null }, { type: 'markdown', content: 'still here' }] };
  render(<ArtifactRenderer artifact={broken} />);
  screen.getByText('This block could not be rendered.');
  screen.getByText('still here');
  spy.mockRestore();
});

function sseResponse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      events.forEach((e) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`)));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, json: async () => ({}) };
}

test('sending a suggestion streams tool calls and opens the artifact panel', async () => {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/threads') return { ok: true, json: async () => ({ thread_id: 'thread_abc' }) };
    return sseResponse([
      { type: 'tool_call', id: 'c1', kind: 'connected_agent', name: 'fabric_data', status: 'completed', output: '| a |' },
      { type: 'artifact', artifact: ARTIFACT },
      { type: 'text_delta', text: 'Created the dashboard.' },
      { type: 'done' },
    ]);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App session={sessionFor('alice')} />);
  fireEvent.click(screen.getByText(/build a sales dashboard/i));

  await screen.findByText('Created the dashboard.');
  screen.getByText('Queried Fabric data agent');
  await waitFor(() => screen.getByRole('complementary', { name: 'Artifact' }));
  screen.getByText('Editing: Sales Dashboard');

  const [, init] = fetchMock.mock.calls[1];
  expect(fetchMock.mock.calls[1][0]).toBe('/api/threads/thread_abc/messages');
  expect(JSON.parse(init.body).artifact_context).toBeNull();

  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'make it a line chart' } });
  fireEvent.click(screen.getByLabelText('Send'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).artifact_context.artifact_id).toBe('sales-dash');
  await waitFor(() => screen.getByRole('option', { name: 'v2 (latest)' }));
});

test('sharing an artifact by email sends the PDF and shows the result', async () => {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/threads') return { ok: true, json: async () => ({ thread_id: 'thread_abc' }) };
    if (url === '/api/share/channels') return { ok: true, json: async () => ({ mode: 'mock', channels: ['teams', 'email'] }) };
    if (url === '/api/share') {
      return { ok: true, json: async () => ({ summary: 'Emailed to a@contoso.com', simulated: true, url: null }) };
    }
    return sseResponse([{ type: 'artifact', artifact: ARTIFACT }, { type: 'done' }]);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App session={sessionFor('alice')} />);
  fireEvent.click(screen.getByText(/build a sales dashboard/i));
  await waitFor(() => screen.getByRole('complementary', { name: 'Artifact' }));

  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  await screen.findByText('Demo mode · delivery is simulated');

  fireEvent.click(screen.getByRole('radio', { name: /Email/ }));
  const submit = screen.getAllByRole('button', { name: 'Share' }).at(-1);
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText(/name@company.com/), { target: { value: 'a@contoso.com, b@contoso.com' } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);

  await screen.findByText(/Emailed to a@contoso.com/);
  screen.getByText(/nothing was actually sent/);
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/share');
  expect(JSON.parse(call[1].body)).toMatchObject({
    channel: 'email',
    recipients: ['a@contoso.com', 'b@contoso.com'],
    pdf_base64: 'JVBERi0=',
  });
});

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('a viewer only sees the shared library and cannot chat, share or publish', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (url === '/api/library') {
        return json({ items: [{ id: 'lib_1', title: 'Q3 Sales', kind: 'dashboard', version: 2, note: 'Final',
          owner: { id: 'alice', name: 'Alice Analyst' }, published_at: '2026-10-21T10:00:00+00:00' }] });
      }
      if (url === '/api/library/lib_1') return json({ id: 'lib_1', artifact: ARTIFACT, owner: { id: 'alice' } });
      return json({}, 404);
    }),
  );

  render(<App session={sessionFor('victor')} />);
  expect(screen.getByRole('tab', { name: /Library/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('tab', { name: /Chat/ })).toBeNull();
  expect(screen.queryByRole('tab', { name: /Operations/ })).toBeNull();
  expect(screen.queryByRole('tab', { name: /Governance/ })).toBeNull();
  expect(screen.queryByText('New chat')).toBeNull();

  fireEvent.click(await screen.findByText('Q3 Sales'));
  await screen.findByRole('complementary', { name: 'Artifact' });
  expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Unpublish/ })).toBeNull();
});

test('an approver reviews a proposed work order and approves it', async () => {
  const approval = {
    id: 'apr_1', kind: 'work_order', title: 'Investigate Vendor spend anomaly (Plant 4)', status: 'pending',
    summary: 'Vendor spend rose 38%', details: { priority: 'medium' }, requested_by: { id: 'system', name: 'Automated monitor' },
    created_at: '2026-10-21T10:00:00+00:00', expires_at: '2026-10-21T11:00:00+00:00',
  };
  const fetchMock = vi.fn(async (url, init) => {
    if (url === '/api/approvals/apr_1/decision') return json({ ...approval, status: 'approved' });
    if (url === '/api/approvals') return json({ items: [approval] });
    if (url === '/api/incidents') return json({ items: [] });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App session={sessionFor('ada')} />);
  fireEvent.click(screen.getByRole('tab', { name: /Operations/ }));
  await screen.findByText('Investigate Vendor spend anomaly (Plant 4)');
  expect(screen.queryByText('Simulate anomaly')).toBeNull(); // approvers cannot raise events

  fireEvent.change(screen.getByLabelText('Decision comment'), { target: { value: 'Looks right' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/approvals/apr_1/decision')).toBe(true));
  const call = fetchMock.mock.calls.find(([u]) => u === '/api/approvals/apr_1/decision');
  expect(call[1].method).toBe('POST');
  expect(JSON.parse(call[1].body)).toEqual({ decision: 'approve', comment: 'Looks right' });
});

test('an analyst sees the request-approval wording when sharing needs sign-off', async () => {
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/threads') return json({ thread_id: 'thread_abc' });
    if (url === '/api/share/channels') return json({ mode: 'graph', channels: ['teams'], requires_approval: true });
    if (url === '/api/share') {
      return json({ status: 'pending_approval', approval_id: 'apr_9', summary: 'Sent for approval. It will be shared once an approver signs off.' });
    }
    return sseResponse([{ type: 'artifact', artifact: ARTIFACT }, { type: 'done' }]);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App session={sessionFor('alice')} />);
  fireEvent.click(screen.getByText(/build a sales dashboard/i));
  await waitFor(() => screen.getByRole('complementary', { name: 'Artifact' }));
  fireEvent.click(screen.getByRole('button', { name: 'Share' }));
  await screen.findByText(/an approver must sign off before it is sent/);
  fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
  await screen.findByText('Awaiting approval · see Operations');
});

test('a thread that no longer exists on the server is recreated transparently', async () => {
  let posts = 0;
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/threads') return json({ thread_id: `thread_${++posts}` });
    if (url === '/api/threads/thread_1/messages') {
      return posts === 1 && fetchMock.mock.calls.filter(([u]) => u === '/api/threads/thread_1/messages').length > 1
        ? json({ detail: 'Conversation not found' }, 404)
        : sseResponse([{ type: 'text_delta', text: 'first' }, { type: 'done' }]);
    }
    return sseResponse([{ type: 'text_delta', text: 'recovered' }, { type: 'done' }]);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<App session={sessionFor('alice')} />);
  fireEvent.click(screen.getByText(/which region had the highest revenue/i));
  await screen.findByText('first');
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'and the lowest?' } });
  fireEvent.click(screen.getByLabelText('Send'));
  await screen.findByText('recovered');
  expect(fetchMock.mock.calls.filter(([u]) => u === '/api/threads')).toHaveLength(2);
});
