import test from 'node:test'
import assert from 'node:assert/strict'
import { managedMcpBlock } from '../bin/cli.mjs'
test('managed MCP config uses portable TOML escaping and only six tools', () => {
  const block = managedMcpBlock('C:\\Program Files\\node\\node.exe', 'C:\\My Project\\bin\\delegate-mcp.mjs')
  assert.ok(block.includes('C:\\\\Program Files\\\\node\\\\node.exe'))
  assert.equal(block.match(/"dsh_[a-z_]+"/g).length, 6)
  assert.ok(block.startsWith('# BEGIN codex-dsh-workspace'))
})
