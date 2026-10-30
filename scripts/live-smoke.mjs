import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = join(homedir(), '.codex', 'codex-dsh-workspace');
const child = spawn(process.execPath, [join(root, 'bin', 'delegate-mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(); let seq = 0; let stderr = '';
child.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
const lines = createInterface({ input: child.stdout });
lines.on('line', l => { const m = JSON.parse(l); const p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Bridge exited ${code}: ${stderr}`)); } pending.clear(); });
function rpc(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Request timed out: ${method}`)); }, 590_000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
function value(result) {
  if (result.isError) throw new Error(result.content?.map(c => c.text).join('\n'));
  return result.structuredContent ?? result;
}
async function call(name, args) { return value(await rpc('tools/call', { name, arguments: args })); }
const report = { at: new Date().toISOString(), node: process.version, checks: [] };
try {
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-dsh-delegate', version: '1.0.0' } });
  const catalog = await rpc('tools/list'); assert.equal(catalog.tools.length, 6);
  report.instructionsChars = init.instructions.length; report.catalogChars = JSON.stringify(catalog.tools).length;
  report.checks.push('MCP initialize and six-tool catalogue');
  const refused = await rpc('tools/call', { name: 'dsh_run_command', arguments: {} }); assert.equal(refused.isError, true);
  const unsafe = await rpc('tools/call', { name: 'dsh_run_prompt', arguments: { prompt: 'test', cwd: 'C:\\', permissionPreset: 'workspace-write' } }); assert.equal(unsafe.isError, true);
  report.checks.push('Unadvertised tools and drive-root workspaces refused before execution');
  const status = await call('dsh_status', {}); assert.equal(status.selfDelegation, false); assert.equal(status.workSync, false);
  report.model = status.model; report.checks.push('Live DSH connectivity and slim host configuration');
  console.log(JSON.stringify({ phase: 'protocol-pass', toolCount: 6, instructionsChars: report.instructionsChars, catalogChars: report.catalogChars, model: report.model }));
  if (process.argv.includes('--smoke')) {
    const workspace = process.argv[process.argv.indexOf('--smoke') + 1]; if (!workspace) throw new Error('Pass a new acceptance workspace.');
    await mkdir(workspace, { recursive: true }); assert.deepEqual(await readdir(workspace), [], 'Smoke workspace must be empty.');
    report.workspace = workspace;
    const task = `Only work inside this dedicated acceptance workspace: ${workspace}. Create normalize.cjs exporting { normalizeName }. normalizeName(null or undefined) returns ''. Other values become strings, trim leading/trailing whitespace, collapse consecutive whitespace into a single hyphen, and lowercase Latin letters. Create normalize.test.cjs using node:test + node:assert/strict, covering '  Foo   Bar  ' => 'foo-bar', null => '', undefined => '', and Chinese '张 三' => '张-三'. Run ${process.execPath} --test --test-isolation=none normalize.test.cjs. Use no external dependencies or network; do not touch other projects. Allowed files: normalize.cjs and normalize.test.cjs. Actually create both files and run the tests, then report results.`;
    console.log(JSON.stringify({ phase: 'delegating-initial-task', workspace }));
    const first = await call('dsh_run_prompt', { cwd: workspace, prompt: task, timeoutMs: 480000 });
    report.initial = first; assert.equal(first.status, 'completed'); assert.ok(first.sessionId); report.sessionId = first.sessionId;
    const check = () => { const r = spawnSync(process.execPath, ['--test', 'normalize.test.cjs'], { cwd: workspace, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; };
    report.initialIndependentTest = check();
    console.log(JSON.stringify({ phase: 'initial-task-pass', sessionId: first.sessionId }));
    const followup = `Continue the same two-file task. Add Unicode NFKC normalization before trimming/replacing/lowercasing, so fullwidth '  ＡＢＣ　１２３  ' becomes 'abc-123'. Add that regression test to normalize.test.cjs and run all tests with ${process.execPath} --test --test-isolation=none normalize.test.cjs. Keep the previous requirements passing. Do not change any other files.`;
    const second = await call('dsh_continue_session', { sessionId: first.sessionId, prompt: followup, timeoutMs: 480000 });
    report.followup = second; assert.equal(second.status, 'completed'); assert.equal(second.sessionId, first.sessionId);
    report.followupIndependentTest = check();
    const require = createRequire(join(workspace, 'verify-independent.cjs'));
    const { normalizeName } = require(join(workspace, 'normalize.cjs'));
    assert.equal(normalizeName('  ＡＢＣ　１２３  '), 'abc-123'); assert.equal(normalizeName('A\t B\n C'), 'a-b-c'); assert.equal(normalizeName('张 三'), '张-三');
    assert.deepEqual((await readdir(workspace)).sort(), ['normalize.cjs', 'normalize.test.cjs']);
    const nativeCheck = spawnSync(process.execPath, [join(root, 'scripts', 'verify-existing.mjs'), workspace, first.sessionId], { encoding: 'utf8', windowsHide: true });
    assert.equal(nativeCheck.status, 0, 'Native DSH command evidence verification failed: ' + nativeCheck.stdout + nativeCheck.stderr);
    report.checks.push('DSH created real files and native tool evidence confirms five passing tests', 'Codex independently reran tests', 'Same-session repair implemented NFKC normalization', 'Independent extra assertions and exact file-scope check');
    console.log(JSON.stringify({ phase: 'same-session-and-independent-acceptance-pass', sessionId: first.sessionId }));
  }
  report.success = true;
} catch (e) { report.success = false; report.error = e.stack || String(e); process.exitCode = 1; console.error(e.stack || String(e)); }
finally {
  await mkdir(reportDir, { recursive: true });
  const target = join(reportDir, process.argv.includes('--smoke') ? 'acceptance.json' : 'doctor.json');
  await writeFile(target, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: target, success: report.success, checks: report.checks }));
  child.stdin.end();
}
