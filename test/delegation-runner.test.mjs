import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDelegationRunner, stepReceipt } from '../lib/delegation/runner.mjs'

const result = data => ({ structuredContent: data })
const end = text => result({ status: 'completed', running: false, turnEndReason: 'completed', text })
const receipt = (id, outcome = 'passed') => `DSH_STEP_RESULT: ${JSON.stringify({ stepId: id, outcome, summary: id + ' checked', checks: [{ name: 'actual test', passed: outcome === 'passed' }] })}`
async function fixture(backend) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-runner-'))
  let clock = 0
  const options = { stateDir, backend: async (...args) => { clock += 10; return backend(...args) }, now: () => clock, sleep: async ms => { clock += ms } }
  return { runner: createDelegationRunner(options), options, stateDir, args: { cwd: stateDir, prompt: 'bounded task', permissionPreset: 'workspace-write', timeoutMs: 3000 } }
}

test('a local reconnect waits on the original admission and never repeats the prompt', async () => {
  let admissions = 0, waits = 0
  const f = await fixture(async (name, args) => {
    if (name === 'dsh_run_prompt') { admissions++; assert.equal(args.wait, false); return result({ sessionId: 's1', requestId: 'r1', cursor: { afterSeq: 10 } }) }
    assert.equal(name, 'dsh_wait_session'); assert.equal(args.afterSeq, 10); waits++
    if (waits === 1) throw new Error('connection reset')
    return end('real final response')
  })
  const r = await f.runner.execute('dsh_run_prompt', f.args)
  assert.equal(r.status, 'completed'); assert.equal(r.text, 'real final response')
  assert.equal(admissions, 1); assert.equal(waits, 2)
})

test('false completed without turn/end remains running, with durable recovery after process restart', async () => {
  let admissions = 0
  const f = await fixture(async name => {
    if (name === 'dsh_run_prompt') { admissions++; return result({ sessionId: 's2', cursor: { afterSeq: -1 } }) }
    return result({ status: 'completed', text: '' }) // Exact production regression.
  })
  const first = await f.runner.execute('dsh_run_prompt', f.args)
  assert.equal(first.status, 'running'); assert.equal(first.localImplementationAllowed, false)
  const duplicate = await createDelegationRunner(f.options).execute('dsh_run_prompt', f.args)
  assert.equal(duplicate.duplicatePrevented, true); assert.equal(admissions, 1)
  const recovered = createDelegationRunner({ ...f.options, backend: async (name, args) => {
    assert.equal(name, 'dsh_wait_session'); assert.equal(args.afterSeq, -1); return end('recovered final response')
  } })
  const final = await recovered.execute('dsh_wait_session', { sessionId: 's2', jobId: first.jobId, timeoutMs: 3000 })
  assert.equal(final.status, 'completed'); assert.equal(final.text, 'recovered final response')
  const cached = await recovered.execute('dsh_wait_session', { sessionId: 's2', timeoutMs: 3000 })
  assert.equal(cached.text, final.text)
})

test('an approved plan advances steps automatically in one DSH session without model-side polling', async () => {
  const trace = []; let step = 0
  const f = await fixture(async (name, args) => {
    trace.push(name)
    if (name !== 'dsh_wait_session') {
      assert.equal(args.wait, false)
      if (step) assert.equal(args.sessionId, 'plan-session')
      step++; return result({ sessionId: 'plan-session', cursor: { afterSeq: step * 10 } })
    }
    return end(receipt('step' + step))
  })
  const r = await f.runner.execute('dsh_run_prompt', { ...f.args, steps: [{ id: 'step1', prompt: 'implement with check' }, { id: 'step2', prompt: 'test and fix' }] })
  assert.equal(r.status, 'completed'); assert.equal(r.completedSteps.length, 2)
  assert.deepEqual(trace, ['dsh_run_prompt', 'dsh_wait_session', 'dsh_continue_session', 'dsh_wait_session'])
  assert.equal(JSON.parse(await readFile(r.evidenceFile, 'utf8')).results.length, 2)
})

test('missing evidence, blocked checks, or native cancellation never dispatch a later step', async () => {
  for (const final of [end('looks fine'), end(receipt('one', 'blocked')), result({ status: 'cancelled', turnEndReason: 'aborted', text: 'stopped' })]) {
    let sends = 0
    const f = await fixture(async name => {
      if (name === 'dsh_wait_session') return final
      sends++; return result({ sessionId: 's', cursor: { afterSeq: 1 } })
    })
    const r = await f.runner.execute('dsh_run_prompt', { ...f.args, steps: [{ id: 'one', prompt: 'first' }, { id: 'two', prompt: 'must not start' }] })
    assert.ok(['blocked', 'cancelled'].includes(r.status)); assert.equal(sends, 1)
  }
  assert.equal(stepReceipt(receipt('wrong'), 'wanted'), undefined)
  assert.equal(stepReceipt('DSH_STEP_RESULT: {"stepId":"one","outcome":"passed","checks":[]}', 'one'), undefined)
})

test('lost admission response is recorded as unknown and is not retried', async () => {
  let sends = 0
  const f = await fixture(async () => { sends++; throw new Error('reply lost after submit') })
  const first = await f.runner.execute('dsh_run_prompt', f.args)
  assert.equal(first.status, 'admission_unknown')
  const second = await f.runner.execute('dsh_run_prompt', f.args)
  assert.equal(second.jobId, first.jobId); assert.equal(sends, 1)
})
