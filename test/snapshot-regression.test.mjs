import assert from 'node:assert/strict';
import test from 'node:test';
import { createDshCapabilities } from '../lib/execution/lib/dsh-capabilities.js';

test('a completed turn in the opening snapshot resolves without waiting for another live event', async () => {
  const old = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }];
  const services = {
    agents: { get: () => ({ status: 'running', followup() {} }) },
    sessionController: {
      list: async () => ({ items: [{ sessionId: 's1', running: true, cwd: '/tmp' }] }),
      prompt: async () => {},
      follow: () => (async function* () {
        yield { type: 'snapshot', records: [
          { event: { type: 'assistant/message', seq: 2, data: { turn: 1, message: { content: [{ type: 'text', text: 'old answer' }] } } } },
          { event: { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', seq: 5, data: { turn: 2, message: { content: [{ type: 'text', text: 'new answer' }] } } } },
          { event: { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'completed' } } } },
        ] };
        throw new Error('Must finish from the persisted end, without requesting another frame');
      })(),
    },
    sessionQuery: { readSession: async () => ({ events: old, session: { cwd: '/tmp' } }) },
    workspaceRegistry: { archivedSessionIds: () => [] },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  };
  const ctx = { get: n => services[n], on: () => () => {}, logger: () => ({ info() {}, warn() {}, debug() {} }) };
  const result = await createDshCapabilities(ctx, {}).callTool('dsh_continue_session', { sessionId: 's1', prompt: 'next', mode: 'queue', wait: true, timeoutMs: 1000 }, {});
  assert.equal(result.structuredContent.status, 'completed');
  assert.equal(result.structuredContent.text, 'new answer');
});
