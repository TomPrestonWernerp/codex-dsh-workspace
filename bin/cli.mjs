#!/usr/bin/env node
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const command = args.shift() || 'help'
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const dshHome = resolve(option('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const codexHome = resolve(option('--codex-home', process.env.CODEX_HOME || join(homedir(), '.codex')))
const profile = option('--profile', 'desktop')
const node = resolve(option('--node', process.execPath))

export function managedMcpBlock(nodePath, bridgePath) {
  return `# BEGIN codex-dsh-workspace\n[mcp_servers.dsh_delegate]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(bridgePath)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 600\nenabled_tools = ["dsh_run_prompt", "dsh_continue_session", "dsh_wait_session", "dsh_cancel_session", "dsh_read_session", "dsh_status"]\ndefault_tools_approval_mode = "approve"\n# END codex-dsh-workspace\n`
}

export function managedRulesBlock() {
  return '# BEGIN codex-dsh-workspace\nIf the user explicitly asks Codex to do a task itself, Codex must implement and test it directly without DSH delegation; this override has priority. Otherwise reserve Codex/GPT tokens for planning, architecture, design and focused acceptance; delegate concrete implementation, debugging and most tests to DSH. For multi-step local implementation, briefly plan and proactively send the approved ordered steps through dsh_run_prompt.steps in the actual absolute project/worktree directory. The bridge advances passing steps automatically; do not wait for user messages between routine steps. DSH owns implementation and tests. Use 480000ms waits. Running, wait timeout, disconnect, empty response, or activeTurns=0 never authorizes local reimplementation: use dsh_wait_session with the existing sessionId/jobId to recover the original task. Do not send duplicate prompts or continue a running task. On explicit failure, return targeted repairs to the same DSH session; on missing information, permission blocks or scope changes report the blocker. Codex reviews concise evidence and actual diffs after verified completion, avoiding duplicate implementation and unnecessary full test reruns. Only take over implementation when the user explicitly requests it and DSH is confirmed stopped. Never recurse into Codex from DSH or widen deployment/credential authority. Handle short questions directly and report unavailable tools honestly.\n# END codex-dsh-workspace\n'
}

function runDsh(dsh, argv) {
  let binary = dsh, params = argv
  if (process.platform === 'win32' && /\.cmd$/i.test(dsh)) {
    for (const value of [dsh, ...argv]) if (/["%\r\n&|<>^]/.test(value)) throw new Error('Unsafe command characters in the DSH launcher or arguments')
    binary = process.env.COMSPEC || 'cmd.exe'
    params = ['/d', '/s', '/c', `"${[dsh, ...argv].map(a => `"${a}"`).join(' ')}"`]
  }
  const result = spawnSync(binary, params, { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' && /\.cmd$/i.test(dsh), env: { ...process.env, DSH_HOME: dshHome } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`DSH installer exited ${result.status}`)
}

async function install() {
  const dsh = option('--dsh-command', 'dsh')
  const bridge = join(root, 'bin', 'delegate-mcp.mjs')
  const configPath = join(codexHome, 'config.toml')
  const original = await readFile(configPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e })
  if (/^\[mcp_servers\.dsh_delegate(?:\.|\])/m.test(original) && !original.includes('# BEGIN codex-dsh-workspace')) {
    throw new Error('An unmanaged dsh_delegate entry exists. Back it up and remove only that entry before installing; unrelated settings must remain unchanged.')
  }
  const next = original.replace(/# BEGIN codex-dsh-workspace\n[\s\S]*?# END codex-dsh-workspace\n?/g, '').trimEnd() + '\n\n' + managedMcpBlock(node, bridge)
  const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  const pwsh = option('--pwsh')
  if (pwsh) await access(resolve(pwsh))
  const originalPatch = await readFile(patchPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e })
  const patch = `# BEGIN codex-dsh-workspace\n- id: codex-dsh-workspace\n  config:\n    projectCatalog: ${JSON.stringify(join(dshHome, 'codex-dsh-workspace', 'projects.json'))}\n# END codex-dsh-workspace\n`
  const shellPatch = pwsh ? `- id: pwsh-sandbox\n  config:\n    pwshPath: ${JSON.stringify(resolve(pwsh))}\n` : ''
  const nextPatch = originalPatch.replace(/# BEGIN codex-dsh-workspace\n[\s\S]*?# END codex-dsh-workspace\n?/g, '').trimEnd() + '\n\n' + patch.replace('# END codex-dsh-workspace', shellPatch + '# END codex-dsh-workspace')
  const rulesPath = join(codexHome, 'AGENTS.md')
  const originalRules = await readFile(rulesPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e })
  const nextRules = originalRules.replace(/# BEGIN codex-dsh-workspace\n[\s\S]*?# END codex-dsh-workspace\n?/g, '').trimEnd() + '\n\n' + managedRulesBlock()
  if (args.includes('--dry-run')) { console.log(JSON.stringify({ command: 'install', source: root, dsh, profile, configPath, patchPath, toolCount: 6, writes: false }, null, 2)); return }
  const backup = join(codexHome, 'codex-dsh-workspace', 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(backup, { recursive: true }); await mkdir(dirname(configPath), { recursive: true }); await mkdir(dirname(patchPath), { recursive: true })
  await writeFile(join(backup, 'config.toml'), original, { mode: 0o600 }); await writeFile(join(backup, 'cordis.patch.yml'), originalPatch, { mode: 0o600 })
  await writeFile(join(backup, 'AGENTS.md'), originalRules, { mode: 0o600 })
  const state = join(dshHome, 'codex-dsh-workspace'); await mkdir(state, { recursive: true })
  const settingsPath = join(state, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}'))
  const previousSettings = JSON.stringify(settings)
  await writeFile(join(backup, 'settings.json'), previousSettings, { mode: 0o600 })
  Object.assign(settings, { enableImport: true, autoImport: false, enableSkills: false, enableInstructions: false, enableConfig: false, mcpMirror: false })
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
  const projectsPath = join(state, 'projects.json')
  const provided = option('--projects')
  if (provided) {
    const catalog = JSON.parse(await readFile(resolve(provided), 'utf8'))
    if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.projects)) throw new Error('Invalid --projects catalogue')
    await writeFile(projectsPath, JSON.stringify(catalog, null, 2), { mode: 0o600 })
  } else { try { await access(projectsPath) } catch { await writeFile(projectsPath, '{"schemaVersion":1,"projects":[]}\n', { mode: 0o600 }) } }
  await writeFile(patchPath, nextPatch)
  try { runDsh(dsh, ['plugin', '--profile', profile, 'add', root]); await writeFile(configPath, next, { mode: 0o600 }); await writeFile(rulesPath, nextRules) }
  catch (error) { await writeFile(patchPath, originalPatch); await writeFile(settingsPath, previousSettings, { mode: 0o600 }); await writeFile(configPath, original, { mode: 0o600 }); await writeFile(rulesPath, originalRules); throw error }
  const installation = { source: root, profile, dshHome, codexHome, node, backup, installedAt: new Date().toISOString() }
  await writeFile(join(state, 'installation.json'), JSON.stringify(installation, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ installed: true, ...installation, next: 'Restart DSH once and open a new Codex chat.' }, null, 2))
}

async function uninstall() {
  const dsh = option('--dsh-command', 'dsh')
  const files = [join(codexHome, 'config.toml'), join(codexHome, 'AGENTS.md'), join(dshHome, 'profiles', profile, 'cordis.patch.yml')]
  if (args.includes('--dry-run')) { console.log(JSON.stringify({ command: 'uninstall', files, writes: false }, null, 2)); return }
  runDsh(dsh, ['plugin', '--profile', profile, 'remove', 'codex-dsh-workspace'])
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (text !== null) await writeFile(file, text.replace(/# BEGIN codex-dsh-workspace\n[\s\S]*?# END codex-dsh-workspace\n?/g, ''))
  }
  console.log('Managed configuration removed; chat history, project metadata, evidence and backups retained.')
}

async function doctor() {
  const ep = join(dshHome, 'codex-dsh-workspace', 'endpoint.json')
  let endpoint
  try { endpoint = JSON.parse(await readFile(ep, 'utf8')) } catch { throw new Error('No live endpoint. Load the merged DSH plugin, then retry.') }
  const u = new URL(endpoint.url)
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('Endpoint must use loopback HTTP')
  const response = await fetch(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-dsh-workspace-doctor', version: '0.2.0' } } }), signal: AbortSignal.timeout(10000) })
  const reply = await response.json(); if (!response.ok || reply.error) throw new Error(reply.error?.message || `HTTP ${response.status}`)
  console.log(JSON.stringify({ healthy: true, node: process.version, endpoint: endpoint.url, server: reply.result.serverInfo }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (command === 'install') await install()
    else if (command === 'uninstall') await uninstall()
    else if (command === 'doctor') await doctor()
    else console.log('codex-dsh-workspace install|uninstall [--profile desktop] [--dsh-command path] [--node path] [--projects catalog.json] [--pwsh executable] [--dry-run]\ncodex-dsh-workspace doctor [--dsh-home path]')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
