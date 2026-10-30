import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { once } from 'node:events'

test('slim stdio bridge authenticates locally, restricts tools and saves oversized evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-dsh-bridge-'))
  let toolCalls = 0
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer unit-fixture')
    const body = []; for await (const c of req) body.push(c)
    const m = JSON.parse(Buffer.concat(body)); let result
    if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture' }, instructions: 'verbose'.repeat(1000) }
    else { toolCalls++; result = { structuredContent: m.params?.name === 'dsh_run_prompt'
      ? { sessionId: 'fixture-session', status: 'started', cursor: { afterSeq: -1 } }
      : { sessionId: 'fixture-session', status: 'completed', running: false, turnEndReason: 'completed', text: 'evidence '.repeat(2000) }, content: [] } }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const endpoint = join(home, 'endpoint.json')
  await writeFile(endpoint, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp`, token: 'unit-fixture' }))
  const child = spawn(process.execPath, ['bin/delegate-mcp.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DSH_DELEGATE_ENDPOINT_FILE: endpoint, DSH_DELEGATE_STATE_DIR: home } })
  const lines = createInterface({ input: child.stdout }); const waiters = new Map(); let seq = 0
  lines.on('line', l => { const m = JSON.parse(l); waiters.get(m.id)?.(m); waiters.delete(m.id) })
  const call = (method, params = {}) => new Promise(resolve => { const id = ++seq; waiters.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  try {
    const init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.ok(init.result.instructions.length < 800)
    assert.equal((await call('tools/list')).result.tools.length, 6)
    assert.equal((await call('tools/call', { name: 'dsh_run_command', arguments: {} })).result.isError, true)
    assert.equal((await call('tools/call', { name: 'dsh_run_prompt', arguments: { cwd: parse(home).root, prompt: 'rejected' } })).result.isError, true)
    assert.equal(toolCalls, 0, 'rejected calls must not reach the execution backend')
    const reply = (await call('tools/call', { name: 'dsh_run_prompt', arguments: { cwd: home, prompt: 'do work' } })).result.structuredContent
    assert.equal(reply.outputTruncated, true); assert.equal(reply.sessionId, 'fixture-session')
    assert.ok(reply.text.length < 6000)
    assert.equal(JSON.parse(await readFile(reply.detailsFile, 'utf8')).structuredContent.text, 'evidence '.repeat(2000))
  } finally { child.stdin.end(); await once(child, 'exit'); server.closeAllConnections(); await new Promise(r => server.close(r)) }
})
