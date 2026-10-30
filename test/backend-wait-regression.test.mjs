/**
 * Backend wait/completion invariants, exercised against a fake Host.
 *
 * The real failure this pins down: `sessionController.follow()` can end its
 * async iterator normally when its AbortSignal fires, so an EOF is not a
 * `turn/end`. A completed status is only allowed after observing a matching
 * `turn/end` whose reason is `completed`. Cursor waits must recover a task's
 * persisted result after the Host has gone idle, without returning an older or
 * unrelated turn, and must keep every assistant message after the submitted
 * cursor when the wait resumes mid-task.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createDshCapabilities } from '../lib/execution/lib/dsh-capabilities.js'

test('cancel removes only pending MCP prompts and preserves human messages', async () => {
  const inbox = { nextTurn: [
    { id: 'mcp-item', source: { kind: 'user', rpcId: 'mcp-task' } },
    { id: 'human-item', source: { kind: 'user', rpcId: 'browser-task' } },
  ], nextStep: [] }
  const removed = []; let cancelled = false
  const services = {
    agents: { get: () => ({ inbox }) },
    sessionController: {
      cancel: () => { cancelled = true },
      updateQueue: async args => { removed.push(args.itemId) },
    },
  }
  const caps = createDshCapabilities({ get: key => services[key] }, {})
  const result = await caps.callTool('dsh_cancel_session', { sessionId: 's', clearQueued: true }, {})
  assert.equal(result.isError, undefined)
  assert.equal(cancelled, true); assert.deepEqual(removed, ['mcp-item'])
  assert.equal(result.structuredContent.removedQueued, 1)
})

const SESSION = 's1'

/** One durable Host event in the observed wire shape. */
function ev(type, seq, { turn = 1, text = '', reason = 'completed', source = 'user' } = {}) {
  if (type === 'turn/start') return { type, seq, data: { turn } }
  if (type === 'turn/end') return { type, seq, data: { turn, reason: { kind: reason } } }
  if (type === 'assistant/message') {
    return { type, seq, data: { turn, message: { content: [{ type: 'text', text }] } } }
  }
  if (type === 'user/message') {
    return { type, seq, data: { turn, source: { kind: source }, content: [{ type: 'text', text }] } }
  }
  return { type, seq, data: { turn } }
}

/**
 * A fake Harness with one session and no model.
 *
 * `follow` defaults to throwing, so a test that expects a persisted result to
 * be recovered while idle also proves no follow was opened.
 */
function createHost({ events = [], running = false, prompt, follow } = {}) {
  const state = {
    events: [...events],
    running,
    prompts: 0,
    follows: 0,
    readFailure: false,
    listFailure: false,
  }

  const services = {
    agents: {
      get: () => ({
        status: state.running ? 'running' : 'idle',
        steer() {},
        followup() {},
      }),
    },
    sessions: {
      get: (id) => (id === SESSION ? { id, header: { id, cwd: '/tmp' } } : undefined),
    },
    sessionController: {
      list: async () => {
        if (state.listFailure) throw new Error('host list unavailable')
        return { items: [{ sessionId: SESSION, running: state.running, cwd: '/tmp' }] }
      },
      prompt: async () => {
        state.prompts += 1
        if (prompt) prompt(state)
      },
      follow: (_request, signal) => {
        state.follows += 1
        if (follow) return follow(state, signal)
        throw new Error('follow was not expected in this test')
      },
      resolveAgent: async (id) => ({
        agent: { id, session: { header: { id } }, steer() {}, followup() {} },
      }),
    },
    sessionQuery: {
      readSession: async () => {
        if (state.readFailure) throw new Error('journal unavailable')
        return { events: state.events, session: { cwd: '/tmp' } }
      },
    },
    workspaceRegistry: { archivedSessionIds: () => [] },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  }

  const ctx = {
    get: (name) => services[name],
    on: () => () => {},
    logger: () => ({ info() {}, warn() {}, debug() {} }),
  }

  return {
    state,
    call: async (name, args, context = {}) => {
      const result = await createDshCapabilities(ctx, {}).callTool(name, args, context)
      assert.equal(result.isError, undefined, result.content?.map(c => c.text).join('\n'))
      return result.structuredContent
    },
  }
}

test('a normal iterator EOF on the abort timeout is not completion', async () => {
  const host = createHost({
    running: true,
    events: [ev('turn/start', 1)],
    // The observed Host shape: when the caller's signal aborts, follow() just
    // returns from its iterator instead of throwing.
    follow: (_state, signal) => (async function* stream() {
      yield { type: 'snapshot', records: [] }
      await new Promise((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', resolve, { once: true })
      })
    })(),
  })

  const waited = await host.call('dsh_wait_session', { sessionId: SESSION, timeoutMs: 1000 })

  assert.notEqual(waited.status, 'completed', 'an EOF after the ceiling must never be completion')
  assert.equal(waited.status, 'timedOut')
  assert.equal(waited.interrupted, true)
  assert.equal(waited.running, true)
})

test('a stream EOF without turn/end is not completion', async () => {
  const host = createHost({
    running: true,
    events: [ev('turn/start', 1)],
    follow: () => (async function* stream() {
      yield {
        type: 'snapshot',
        records: [ev('assistant/message', 2, { turn: 1, text: 'partial answer' })],
      }
      // Normal EOF with no terminal event: the turn is incomplete.
    })(),
  })

  const waited = await host.call('dsh_wait_session', { sessionId: SESSION, timeoutMs: 5000 })

  assert.notEqual(waited.status, 'completed')
  assert.equal(waited.status, 'disconnected')
  assert.equal(waited.interrupted, true)
  assert.equal(waited.text, 'partial answer')
})

test('a completed cursor result is recoverable after the Host is idle', async () => {
  const host = createHost({
    running: false,
    events: [
      ev('turn/start', 1, { turn: 1 }),
      ev('user/message', 2, { turn: 1, text: 'old task' }),
      ev('assistant/message', 3, { turn: 1, text: 'old answer' }),
      ev('turn/end', 4, { turn: 1 }),
      ev('turn/start', 5, { turn: 2 }),
      ev('user/message', 6, { turn: 2, text: 'submitted task' }),
      ev('assistant/message', 7, { turn: 2, text: 'recovered answer' }),
      // A replayed durable event must not duplicate the answer.
      ev('assistant/message', 7, { turn: 2, text: 'recovered answer' }),
      ev('turn/end', 8, { turn: 2 }),
    ],
  })

  const waited = await host.call('dsh_wait_session', { sessionId: SESSION, afterSeq: 4, timeoutMs: 5000 })

  assert.equal(waited.status, 'completed')
  assert.equal(waited.text, 'recovered answer')
  assert.deepEqual(waited.cursor, { afterSeq: 4 })
  assert.equal(host.state.follows, 0, 'a persisted terminal result needs no follow')
})

test('a cursor wait excludes the turn that was already running when a prompt was queued', async () => {
  const host = createHost({
    running: false,
    events: [
      ev('turn/start', 1, { turn: 1 }),
      ev('user/message', 2, { turn: 1, text: 'old prompt' }),
      ev('assistant/message', 3, { turn: 1, text: 'old turn text' }),
      ev('turn/end', 4, { turn: 1 }),
      ev('turn/start', 5, { turn: 2 }),
      ev('user/message', 6, { turn: 2, text: 'queued prompt' }),
      ev('assistant/message', 7, { turn: 2, text: 'queued answer' }),
      ev('turn/end', 8, { turn: 2 }),
    ],
  })

  const waited = await host.call('dsh_wait_session', {
    sessionId: SESSION,
    afterSeq: 1,
    skipTurnEndThrough: 1,
    timeoutMs: 5000,
  })

  assert.equal(waited.status, 'completed')
  assert.equal(waited.text, 'queued answer')
  assert.doesNotMatch(waited.text, /old turn text/, 'the pre-admission turn is not this task answer')
  assert.deepEqual(waited.cursor, { afterSeq: 1, skipTurnEndThrough: 1 })
  assert.equal(host.state.follows, 0)
})

test('an aborted turn/end remains cancelled, including from a cursor recovery', async () => {
  const live = createHost({
    running: false,
    events: [ev('turn/start', 1)],
    follow: () => (async function* stream() {
      yield { type: 'event', event: ev('assistant/message', 2, { turn: 1, text: 'stopped part' }) }
      yield { type: 'event', event: ev('turn/end', 3, { turn: 1, reason: 'aborted' }) }
    })(),
  })
  const prompted = await live.call('dsh_continue_session', {
    sessionId: SESSION,
    prompt: 'stop me',
    wait: true,
    timeoutMs: 5000,
  })

  assert.notEqual(prompted.status, 'completed')
  assert.equal(prompted.status, 'cancelled')
  assert.equal(prompted.turnEndReason, 'aborted')

  const idle = createHost({
    running: false,
    events: [
      ev('turn/start', 1),
      ev('assistant/message', 2, { turn: 1, text: 'stopped part' }),
      ev('turn/end', 3, { turn: 1, reason: 'aborted' }),
    ],
  })
  const recovered = await idle.call('dsh_wait_session', { sessionId: SESSION, afterSeq: 1, timeoutMs: 5000 })

  assert.notEqual(recovered.status, 'completed')
  assert.equal(recovered.status, 'cancelled')
  assert.equal(recovered.turnEndReason, 'aborted')
})

test('a queued prompt uses the turn captured before admission even when the prompt advances the journal', async () => {
  const host = createHost({
    running: true,
    events: [ev('turn/start', 1, { turn: 1 })],
    // Simulate a prompt delivery that appends a new turn/start before follow()
    // opens. The boundary must still be the turn that was running at admission.
    prompt: (state) => {
      state.events.push(ev('turn/start', 2, { turn: 2 }))
    },
    follow: () => (async function* stream() {
      yield { type: 'event', event: ev('assistant/message', 3, { turn: 1, text: 'old turn text' }) }
      yield { type: 'event', event: ev('turn/end', 4, { turn: 1 }) }
      yield { type: 'event', event: ev('turn/start', 5, { turn: 2 }) }
      yield { type: 'event', event: ev('assistant/message', 6, { turn: 2, text: 'queued answer' }) }
      yield { type: 'event', event: ev('turn/end', 7, { turn: 2 }) }
    })(),
  })

  const result = await host.call('dsh_continue_session', {
    sessionId: SESSION,
    prompt: 'queued prompt',
    mode: 'queue',
    wait: true,
    timeoutMs: 5000,
  })

  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'queued answer')
  assert.deepEqual(result.cursor, { afterSeq: 1, skipTurnEndThrough: 1 })
})

test('every result variant, including wait:false, carries a submission cursor', async () => {
  const host = createHost({
    running: false,
    events: [ev('turn/start', 1)],
  })

  const started = await host.call('dsh_continue_session', {
    sessionId: SESSION,
    prompt: 'start without waiting',
    wait: false,
  })

  assert.equal(started.status, 'started')
  assert.deepEqual(started.cursor, { afterSeq: 1 })
})

test('a cursor wait that resumes mid-task keeps all text after the submitted cursor', async () => {
  const host = createHost({
    running: true,
    events: [
      ev('turn/start', 1),
      ev('assistant/message', 2, { turn: 1, text: 'first part' }),
    ],
    // The follow stream may omit persisted text; the cursor fold must not.
    follow: () => (async function* stream() {
      yield { type: 'snapshot', records: [] }
      yield { type: 'event', event: ev('assistant/message', 3, { turn: 1, text: 'second part' }) }
      yield { type: 'event', event: ev('turn/end', 4, { turn: 1 }) }
    })(),
  })

  const waited = await host.call('dsh_wait_session', { sessionId: SESSION, afterSeq: 1, timeoutMs: 5000 })

  assert.equal(waited.status, 'completed')
  assert.match(waited.text, /first part/)
  assert.match(waited.text, /second part/)
  assert.deepEqual(waited.cursor, { afterSeq: 1 })
})

test('a failed cursor read or Host lookup never implies completion', async () => {
  const unreadable = createHost({
    running: false,
    events: [ev('turn/start', 1), ev('assistant/message', 2, { turn: 1, text: 'unknown' })],
  })
  unreadable.state.readFailure = true
  const readFailed = await unreadable.call('dsh_wait_session', { sessionId: SESSION, afterSeq: 1, timeoutMs: 5000 })

  assert.notEqual(readFailed.status, 'completed')
  assert.equal(readFailed.status, 'disconnected')
  assert.equal(readFailed.interrupted, true)

  const unlisted = createHost({
    running: false,
    events: [ev('turn/start', 1), ev('assistant/message', 2, { turn: 1, text: 'unknown' })],
  })
  unlisted.state.listFailure = true
  const listFailed = await unlisted.call('dsh_wait_session', { sessionId: SESSION, afterSeq: 1, timeoutMs: 5000 })

  assert.notEqual(listFailed.status, 'completed')
  assert.equal(listFailed.status, 'disconnected')
  assert.equal(listFailed.running, null, 'an unknown Host state is reported explicitly, not as idle or complete')
})
