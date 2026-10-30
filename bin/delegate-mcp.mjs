import { readFile, writeFile, mkdir, appendFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute, parse, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createDelegationRunner } from '../lib/delegation/runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = process.env.DSH_DELEGATE_STATE_DIR || join(homedir(), '.codex', 'codex-dsh-workspace');
const endpointFile = process.env.DSH_DELEGATE_ENDPOINT_FILE || join(homedir(), '.dsh', 'codex-dsh-workspace', 'endpoint.json');
const instructions = 'Explicit user requests for Codex-only execution override delegation. Otherwise Codex designs/plans/reviews and DSH implements/tests. Plan once, proactively dispatch steps with dsh_run_prompt.steps; the local bridge advances passed steps without user messages or Codex model calls. DSH owns implementation. Use 480000ms waits; running/disconnected is NOT failure or permission to implement locally. Resume the same job with dsh_wait_session; never resend the task or queue a continuation while running. After completion review concise evidence; send repairs to the same session. Report blockers. No recursion.';
const definitions = [
  ['dsh_run_prompt', 'Execute a bounded implementation/test task in a NEW DSH session.', {
    prompt: { type: 'string' }, cwd: { type: 'string' }, permissionPreset: { type: 'string', enum: ['read-only', 'workspace-write'] },
    model: { type: 'string' }, reasoningEffort: { type: 'string' }, wait: { type: 'boolean' }, timeoutMs: { type: 'integer' },
    steps: { type: 'array', minItems: 1, maxItems: 20, description: 'Ordered approved steps, each including scope and acceptance checks. The bridge dispatches the next step only after an explicit passing evidence receipt.', items: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' } }, required: ['id', 'prompt'], additionalProperties: false } },
  }, ['prompt', 'cwd']],
  ['dsh_continue_session', 'Continue a DSH session for a related fix; preserve its context.', {
    sessionId: { type: 'string' }, prompt: { type: 'string' }, permissionPreset: { type: 'string', enum: ['read-only', 'workspace-write'] },
    wait: { type: 'boolean' }, timeoutMs: { type: 'integer' },
  }, ['sessionId', 'prompt']],
  ['dsh_wait_session', 'Wait for completion without starting another turn. A wait timeout does not stop DSH.', {
    sessionId: { type: 'string' }, jobId: { type: 'string' }, timeoutMs: { type: 'integer' },
  }, ['sessionId']],
  ['dsh_cancel_session', 'Request cancellation of a DSH turn. Check status if confirmation is needed.', {
    sessionId: { type: 'string' },
  }, ['sessionId']],
  ['dsh_read_session', 'Read a small transcript window only when final evidence is insufficient.', {
    sessionId: { type: 'string' }, mode: { type: 'string', enum: ['tail', 'head', 'outline'] }, limit: { type: 'integer' },
    maxChars: { type: 'integer' }, afterSeq: { type: 'integer' }, roles: { type: 'array', items: { type: 'string', enum: ['user', 'assistant'] } },
  }, ['sessionId']],
  ['dsh_status', 'Check connectivity, model and recent delegated sessions. Pass sessionId to inspect pending approvals/questions.', {
    sessionId: { type: 'string' },
  }, []],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
const allowed = new Set(definitions.map(t => t.name));
const contract = '\n\nExecution contract: perform this task yourself using DSH tools; do not invoke Codex, another harness, or delegate it back. Stay inside the approved project scope; do not commit, push, deploy, or change credentials unless the task explicitly authorizes it. Never change sandbox/approval presets, request danger-full-access, repair ACLs, or change system permissions. If a command is blocked by confinement, stop that check and report its command/error for Codex to verify; do not work around the restriction. Run relevant checks and report real exit results. Save verbose logs in workspace files if needed. Final reply: concise summary, changed files, checks with outcomes, blockers, evidence paths. Keep it within 1200 Chinese characters or 600 English words. Do not report unrun checks as passed.';
const runner = createDelegationRunner({ stateDir, backend: (name, args, signal) => backend('tools/call', { name, arguments: args }, signal) });

function redact(s) { return String(s).replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'); }
async function backend(method, params = {}, signal) {
  const e = JSON.parse(await readFile(endpointFile, 'utf8'));
  const u = new URL(e.url);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('DSH endpoint must be local loopback HTTP.');
  const wire = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params });
  const headers = {
    'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${e.token}`, 'x-dsh-mcp-client': 'codex-dsh-delegate',
    'content-length': Buffer.byteLength(wire),
  };
  // Node fetch has its own five-minute header deadline. Use an explicit HTTP
  // request budget so a legitimate long DSH turn can use the advertised wait.
  const reply = await new Promise((resolveReply, rejectReply) => {
    const req = request(u, { method: 'POST', headers, signal }, response => {
      if (response.statusCode !== 200) { response.resume(); rejectReply(new Error(`DSH endpoint returned HTTP ${response.statusCode}`)); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) req.destroy(new Error('DSH reply exceeds the transport budget')); else chunks.push(chunk); });
      response.on('error', rejectReply);
      response.on('end', () => { try { resolveReply(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { rejectReply(error); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('DSH transport wait timed out')), 590_000);
    req.on('close', () => clearTimeout(timer)); req.on('error', rejectReply); req.end(wire);
  });
  if (reply.error) throw new Error(reply.error.message || 'DSH RPC failed');
  return reply.result;
}

function payload(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

async function validateWorkspace(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('cwd must be an existing absolute project directory.');
  const actual = await realpath(cwd);
  if (!(await stat(actual)).isDirectory()) throw new Error('cwd is not a directory.');
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (same(actual, parse(actual).root) || same(actual, homedir())) throw new Error('Choose a specific project directory, not a drive root or your home directory.');
  const control = join(homedir(), '.codex');
  const rel = relative(control, actual);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Codex control/configuration directories are handled by Codex directly.');
  return actual;
}

async function prepare(name, input) {
  const a = { ...input };
  const schema = definitions.find(t => t.name === name)?.inputSchema;
  if (!schema) throw new Error('Tool is not enabled.');
  for (const key of Object.keys(a)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument: ${key}`);
  for (const key of schema.required) if (a[key] === undefined || a[key] === '') throw new Error(`Missing required argument: ${key}`);
  if (name === 'dsh_run_prompt') a.cwd = await validateWorkspace(a.cwd);
  if (a.steps !== undefined) {
    if (!Array.isArray(a.steps) || !a.steps.length || a.steps.length > 20) throw new Error('steps must contain 1-20 ordered steps.');
    const ids = new Set();
    for (const step of a.steps) {
      if (!step || Object.keys(step).some(k => !['id', 'prompt'].includes(k)) || typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(step.id) || ids.has(step.id) || typeof step.prompt !== 'string' || !step.prompt.trim() || step.prompt.length > 12000) throw new Error('Each step needs a unique id and a bounded prompt with acceptance criteria.');
      ids.add(step.id);
    }
  }
  if (name === 'dsh_run_prompt' || name === 'dsh_continue_session') {
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) throw new Error('prompt must be nonempty text.');
    if (a.prompt.length > 60_000) throw new Error('Put large inputs in project files and send their paths.');
    if (a.permissionPreset && !['read-only', 'workspace-write'].includes(a.permissionPreset)) throw new Error('Only read-only/workspace-write delegation is enabled.');
    a.permissionPreset ||= 'workspace-write';
    a.prompt += contract;
    a.wait ??= true;
  }
  if (['dsh_run_prompt', 'dsh_continue_session', 'dsh_wait_session'].includes(name)) {
    a.timeoutMs = Number.isFinite(a.timeoutMs) ? Math.max(1000, Math.min(480_000, a.timeoutMs)) : 480_000;
  }
  if (name === 'dsh_read_session') {
    a.limit = Math.max(1, Math.min(20, a.limit ?? 3));
    a.maxChars = Math.max(100, Math.min(4000, a.maxChars || 1600));
  }
  return a;
}

async function compact(result, name, args) {
  let value = payload(result);
  await mkdir(stateDir, { recursive: true });
  if (name === 'dsh_status') {
    const recent = await readFile(join(stateDir, 'runs.jsonl'), 'utf8').catch(() => '');
    value = { server: value.server, activeTurns: value.activeTurns, hostRunningSessions: value.hostRunningSessions, activeJobs: await runner.list(), model: value.defaultModel,
      permissions: value.defaultPermissionPreset, selfDelegation: value.dshTools?.enabled, workSync: value.sync?.enabled ?? false,
      recentRuns: recent.trim().split('\n').filter(Boolean).slice(-8).map(l => JSON.parse(l)),
      ...(value.pending ? { pending: value.pending } : {}) };
  }
  let detailsFile;
  if (JSON.stringify(value).length > 6500) {
    const folder = join(stateDir, 'results'); await mkdir(folder, { recursive: true });
    detailsFile = join(folder, `${Date.now()}-${randomUUID()}.json`);
    await writeFile(detailsFile, JSON.stringify(result, null, 2), { mode: 0o600 });
    const text = typeof value.text === 'string' ? value.text : JSON.stringify(value);
    value = { sessionId: value.sessionId ?? args.sessionId, jobId: value.jobId, status: value.status, turnEndReason: value.turnEndReason,
      running: value.running, terminal: value.terminal, nextAction: value.nextAction, localImplementationAllowed: value.localImplementationAllowed,
      step: value.step, completedSteps: value.completedSteps, evidenceFile: value.evidenceFile,
      pending: value.pending, outputTruncated: true, detailsFile,
      text: text.slice(0, 4000) + '\n[abridged; full result in detailsFile]\n' + text.slice(-1200) };
  }
  if (name !== 'dsh_status' && name !== 'dsh_read_session') {
    const entry = { at: new Date().toISOString(), tool: name, sessionId: value.sessionId ?? args.sessionId,
      cwd: args.cwd, status: value.status, isError: Boolean(result?.isError), ...(detailsFile ? { detailsFile } : {}) };
    await appendFile(join(stateDir, 'runs.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(result?.isError ? { isError: true } : {}) };
}

const inflight = new Map();
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
async function handle(m) {
  if (m.method === 'notifications/cancelled') { inflight.get(m.params?.requestId)?.abort(); return; }
  if (m.id === undefined) return;
  const signal = new AbortController(); inflight.set(m.id, signal);
  try {
    let result;
    if (m.method === 'initialize') {
      const upstream = await backend('initialize', m.params, signal.signal);
      result = { protocolVersion: upstream.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codex-dsh-delegate', version: '0.2.0' }, instructions };
    } else if (m.method === 'ping') result = {};
    else if (m.method === 'tools/list') result = { tools: definitions };
    else if (m.method === 'tools/call') {
      const name = m.params?.name;
      if (!allowed.has(name)) throw new Error('This tool is not enabled in the slim delegation bridge.');
      const a = await prepare(name, m.params.arguments || {});
      const upstream = ['dsh_run_prompt', 'dsh_continue_session', 'dsh_wait_session'].includes(name)
        ? { structuredContent: await runner.execute(name, a, signal.signal) }
        : name === 'dsh_cancel_session' ? { structuredContent: await runner.cancel(a.sessionId, signal.signal) }
        : await backend('tools/call', { name, arguments: name === 'dsh_status' ? {} : a }, signal.signal);
      if (name === 'dsh_status' && a.sessionId) {
        const pending = await backend('tools/call', { name: 'dsh_list_requests', arguments: { sessionId: a.sessionId, limit: 1 } }, signal.signal);
        const v = payload(upstream); v.pending = payload(pending); upstream.structuredContent = v;
      }
      result = await compact(upstream, name, a);
    } else { send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not supported.' } }); return; }
    send({ jsonrpc: '2.0', id: m.id, result });
  } catch (e) {
    const message = redact(e.message || e);
    if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: message }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } });
  } finally { inflight.delete(m.id); }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => { try { void handle(JSON.parse(line)); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); } });
input.on('close', () => { for (const c of inflight.values()) c.abort(); });
