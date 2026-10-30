import { mkdir, readFile, writeFile, readdir, open, unlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const finished = new Set(['completed', 'failed', 'cancelled', 'blocked'])
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value
export function unwrap(result) {
  if (result?.isError) throw new Error(result.content?.map(c => c.text || '').join('\n') || 'DSH tool failed')
  if (result?.structuredContent) return result.structuredContent
  try { return JSON.parse(result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n')) }
  catch { throw new Error('DSH returned no structured task receipt') }
}

export function stepReceipt(text, id) {
  const line = String(text || '').trim().split('\n').at(-1)
  if (!line?.startsWith('DSH_STEP_RESULT:')) return undefined
  try {
    const result = JSON.parse(line.slice('DSH_STEP_RESULT:'.length))
    if (result.stepId !== id || !['passed', 'failed', 'blocked'].includes(result.outcome)) return undefined
    if (result.outcome === 'passed' && (!Array.isArray(result.checks) || !result.checks.length || !result.checks.every(c => c.passed === true))) return undefined
    return result
  } catch { return undefined }
}

// This process owns waiting and step dispatch. It never calls a language model.
// Receipts survive stdio restarts; an orphaned lock is not assumed to mean an
// orphaned DSH task. Only a verified terminal outcome releases a workspace.
export function createDelegationRunner({ backend, stateDir, now = Date.now, sleep = delay }) {
  const jobsDir = join(stateDir, 'jobs')
  const locksDir = join(jobsDir, 'locks')
  const jobPath = id => join(jobsDir, `${id}.json`)
  const lockPath = cwd => join(locksDir, `${createHash('sha256').update(pathKey(cwd)).digest('hex')}.json`)
  const initialize = () => mkdir(locksDir, { recursive: true })
  async function save(job) {
    // A cancellation can arrive through another stdio client while this one
    // holds a long wait. Never overwrite that decision with an older snapshot.
    try { if ((await read(job.jobId)).cancelRequested) job.cancelRequested = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    job.updatedAt = new Date(now()).toISOString()
    const temp = `${jobPath(job.jobId)}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(job, null, 2), { mode: 0o600 })
    await rename(temp, jobPath(job.jobId))
  }
  async function read(id) { return JSON.parse(await readFile(jobPath(id), 'utf8')) }
  async function list() {
    await initialize()
    const jobs = []
    for (const name of await readdir(jobsDir)) {
      if (!/^[\da-f-]+\.json$/.test(name)) continue
      jobs.push(await read(name.slice(0, -5)))
    }
    return jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async function find(sessionId, jobId) {
    if (jobId) {
      if (!/^[\da-f-]{36}$/.test(jobId)) throw new Error('Invalid jobId')
      const job = await read(jobId)
      if (sessionId && job.sessionId !== sessionId) throw new Error('jobId does not belong to sessionId')
      return job
    }
    return (await list()).find(j => j.sessionId === sessionId)
  }
  async function locked(cwd) {
    try { return await read(JSON.parse(await readFile(lockPath(cwd), 'utf8')).jobId) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  async function release(job) {
    try {
      const lock = JSON.parse(await readFile(lockPath(job.cwd), 'utf8'))
      if (lock.jobId === job.jobId) await unlink(lockPath(job.cwd))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  function summary(job) {
    const active = !finished.has(job.status)
    return {
      jobId: job.jobId, sessionId: job.sessionId, requestId: job.requestId,
      status: job.status, running: active, terminal: !active,
      nextAction: active ? (job.sessionId ? 'dsh_wait_session' : 'inspect_admission') : job.status === 'completed' ? 'review_evidence' : 'report_blocker',
      localImplementationAllowed: false,
      note: active ? 'DSH owns this task. Resume this job; do not repeat the prompt, implement locally, or ask the user to trigger normal next steps.' : undefined,
      step: job.steps.length ? { index: job.stepIndex + 1, total: job.steps.length, id: job.steps[job.stepIndex]?.id } : undefined,
      completedSteps: job.results.map(r => ({ id: r.id, outcome: r.receipt?.outcome, summary: r.receipt?.summary })),
      text: job.steps.length && job.results.length ? job.results.at(-1).receipt.summary : job.finalText || '', blocker: job.blocker,
      evidenceFile: jobPath(job.jobId), cursor: job.cursor,
    }
  }
  function promptFor(job) {
    if (!job.steps.length) return job.prompt
    const step = job.steps[job.stepIndex]
    return `${job.prompt}\n\nExecute plan step ${job.stepIndex + 1}/${job.steps.length} (${step.id}):\n${step.prompt}\n\nOnly execute this step. Verify its acceptance criteria with actual tools. Do not wait for the user to trigger the next ordinary step; the bridge dispatches it. End with exactly one final line:\nDSH_STEP_RESULT: {"stepId":${JSON.stringify(step.id)},"outcome":"passed|failed|blocked","summary":"brief evidence","checks":[{"name":"actual check","passed":true}]}\nUse passed only when all required checks actually ran and passed. Otherwise failed or blocked; never bypass permissions.`
  }
  async function admit(job, signal) {
    if (job.cancelRequested) { job.status = 'cancelled'; await save(job); await release(job); return }
    // An admission claim is durable, unlike the waiting process. If two clients
    // recover the same plan, exactly one may dispatch this particular step.
    const claim = join(jobsDir, `${job.jobId}-step-${job.stepIndex}.admitted`)
    try { const handle = await open(claim, 'wx', 0o600); await handle.close() }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      throw new Error(`This plan step was already submitted or admission is in progress. Resume existing job ${job.jobId}; never repeat its prompt.`)
    }
    job.status = 'submitting'; job.cursor = undefined
    await save(job) // Before sending: transport ambiguity must never auto-resubmit.
    let response
    try {
      response = unwrap(await backend(job.sessionId ? 'dsh_continue_session' : 'dsh_run_prompt', {
        ...(job.sessionId ? { sessionId: job.sessionId } : { cwd: job.cwd }),
        prompt: promptFor(job), permissionPreset: job.permissionPreset,
        ...(!job.sessionId && job.model ? { model: job.model } : {}),
        ...(!job.sessionId && job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
        wait: false,
      }, signal))
    } catch (error) {
      job.status = 'admission_unknown'; job.blocker = `Admission could not be confirmed: ${error.message}. Inspect the existing DSH task; never automatically send the prompt again.`
      await save(job); return
    }
    job.sessionId = response.sessionId || job.sessionId
    job.requestId = response.requestId
    job.cursor = response.cursor
    job.status = 'running'; job.blocker = undefined
    if (!job.sessionId || !Number.isInteger(job.cursor?.afterSeq)) {
      job.status = 'admission_unknown'
      job.blocker = 'DSH did not return an admission cursor. Restart the updated DSH plugin; inspect this existing task before resubmitting.'
    }
    await save(job)
  }
  async function settle(job, response) {
    job.finalText = response.text || ''
    if (response.turnEndReason !== 'completed' || response.running === true) {
      if (['aborted', 'cancelled'].includes(response.turnEndReason) || response.status === 'cancelled') job.status = 'cancelled'
      else if (response.turnEndReason === 'error' || response.status === 'error') job.status = 'failed'
      else return false // Missing terminal evidence is never success.
    } else if (!job.finalText.trim()) {
      job.status = 'blocked'; job.blocker = 'DSH ended without a final response. Request a report in the same session; do not reimplement the task.'
    } else if (job.steps.length) {
      const step = job.steps[job.stepIndex]
      const receipt = stepReceipt(job.finalText, step.id)
      if (!receipt) {
        job.status = 'blocked'; job.blocker = 'The step ended without a valid evidence receipt; later steps have not been dispatched.'
      } else {
        job.results.push({ id: step.id, receipt, text: job.finalText, requestId: job.requestId, cursor: job.cursor })
        job.status = receipt.outcome === 'passed' ? 'completed' : receipt.outcome === 'failed' ? 'failed' : 'blocked'
        if (receipt.outcome !== 'passed') job.blocker = receipt.summary
      }
    } else job.status = 'completed'
    await save(job)
    if (job.cancelRequested) { job.status = 'cancelled'; await save(job) }
    return true
  }
  async function wait(job, timeoutMs, signal) {
    if (finished.has(job.status) || job.status === 'admission_unknown') return summary(job)
    const deadline = now() + timeoutMs
    while (!signal?.aborted && now() < deadline) {
      if (job.status === 'ready') {
        Object.assign(job, await read(job.jobId))
        await admit(job, signal)
        if (finished.has(job.status)) return summary(job)
        if (job.status === 'admission_unknown') break
      }
      let response
      try {
        response = unwrap(await backend('dsh_wait_session', {
          sessionId: job.sessionId, afterSeq: job.cursor.afterSeq,
          ...(Number.isInteger(job.cursor.skipTurnEndThrough) ? { skipTurnEndThrough: job.cursor.skipTurnEndThrough } : {}),
          timeoutMs: Math.max(1000, deadline - now()),
        }, signal))
        if (response.pending?.count > 0) {
          job.status = 'running'; job.blocker = 'DSH is waiting for a user decision; resolve it in DSH, then resume this job.'
          await save(job); break
        }
        if (await settle(job, response)) {
          if (job.status === 'completed' && job.steps.length && job.stepIndex + 1 < job.steps.length) {
            job.stepIndex++; job.status = 'ready'; job.finalText = ''; await save(job)
            continue // Next approved step, with no new Codex model invocation.
          }
          await release(job); return summary(job)
        }
        job.blocker = response.note
      } catch (error) { job.blocker = `Waiting connection interrupted: ${error.message}` }
      job.status = 'running'; await save(job)
      // Local reconnect, not a model-visible status-poll loop.
      if (!signal?.aborted && now() < deadline) {
        try { await sleep(Math.min(1000, deadline - now()), undefined, { signal }) } catch { break }
      }
    }
    await save(job)
    return summary(job)
  }
  async function start(name, args, signal) {
    await initialize()
    let previous
    if (name === 'dsh_continue_session') {
      previous = await find(args.sessionId)
      if (previous && !finished.has(previous.status)) return summary(previous)
      if (!previous) throw new Error('No local receipt for this session; inspect its state before continuing through this bridge.')
    }
    const cwd = args.cwd || previous.cwd
    const existing = await locked(cwd)
    if (existing) return { ...summary(existing), duplicatePrevented: true }
    const job = {
      schemaVersion: 1, jobId: randomUUID(), cwd, prompt: args.prompt,
      permissionPreset: args.permissionPreset, model: args.model, reasoningEffort: args.reasoningEffort,
      sessionId: args.sessionId, steps: args.steps || [], stepIndex: 0,
      results: [], status: 'submitting', createdAt: new Date(now()).toISOString(),
    }
    // Save first, so a concurrent process that sees the lock can resolve it.
    await save(job)
    try {
      const handle = await open(lockPath(cwd), 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ jobId: job.jobId })) } finally { await handle.close() }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await unlink(jobPath(job.jobId))
      return { ...summary(await locked(cwd)), duplicatePrevented: true }
    }
    await admit(job, signal)
    return args.wait === false ? summary(job) : wait(job, args.timeoutMs, signal)
  }
  const busy = new Set()
  return {
    list: async () => (await list()).filter(j => !finished.has(j.status)).map(summary),
    async execute(name, args, signal) {
      if (name === 'dsh_wait_session') {
        const job = await find(args.sessionId, args.jobId)
        if (!job) throw new Error('No local receipt; this bridge cannot safely identify which task to wait for.')
        if (busy.has(job.jobId)) return { ...summary(job), alreadyWaiting: true }
        busy.add(job.jobId)
        try { return await wait(job, args.timeoutMs, signal) } finally { busy.delete(job.jobId) }
      }
      return start(name, args, signal)
    },
    async cancel(sessionId, signal) {
      const job = await find(sessionId)
      if (job && !finished.has(job.status)) { job.cancelRequested = true; await save(job) }
      const response = unwrap(await backend('dsh_cancel_session', { sessionId, clearQueued: true }, signal))
      return { ...response, jobId: job?.jobId, nextAction: 'dsh_wait_session', localImplementationAllowed: false }
    },
  }
}
