import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import ArtifactRenderer from './components/ArtifactRenderer';
import { parseSseChunk } from './lib/api';
import { applyEvent, createConversation } from './lib/conversation';

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

  render(<App />);
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
