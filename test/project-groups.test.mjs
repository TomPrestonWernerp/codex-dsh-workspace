import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncProjectCatalog } from '../lib/execution/lib/project-catalog.js'

test('project registration is idempotent, keeps custom titles, and refuses foreign session cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-groups-'))
  const project = join(root, 'project'); await mkdir(project)
  const catalog = join(root, 'projects.json')
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, projects: [{ path: project, title: 'Codex project', sessionIds: ['same'] }] }))
  const workspaces = new Map(); let creates = 0; const members = new Set()
  const registry = { resolveByPath: async p => workspaces.get(p), create: async (p, title) => { creates++; const w = { path: p, title, attachSession: async id => members.add(id) }; workspaces.set(p, w); return w } }
  const services = { workspaceRegistry: registry, sessionQuery: { readSession: async id => ({ session: { cwd: id === 'same' ? project : root } }) } }
  const ctx = { get: name => services[name] }
  assert.equal((await syncProjectCatalog(ctx, catalog)).errors.length, 0)
  workspaces.get(project).title = 'User custom title'
  await syncProjectCatalog(ctx, catalog); assert.equal(creates, 1); assert.equal(workspaces.get(project).title, 'User custom title'); assert.deepEqual([...members], ['same'])
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, projects: [{ path: project, title: 'ignored', sessionIds: ['foreign'] }] }))
  assert.equal((await syncProjectCatalog(ctx, catalog)).errors.length, 1)
  assert.equal(members.has('foreign'), false)
})

test('case-sensitive hosts do not attach a session from a differently cased directory', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-case-'))
  const project = join(root, 'project'); const other = join(root, 'Project')
  await mkdir(project); await mkdir(other)
  const catalog = join(root, 'projects.json')
  await writeFile(catalog, JSON.stringify({ schemaVersion: 1, projects: [{ path: project, sessionIds: ['other'] }] }))
  let attached = false
  const workspace = { path: project, attachSession: async () => { attached = true } }
  const services = { workspaceRegistry: { resolveByPath: async () => workspace, create: async () => workspace }, sessionQuery: { readSession: async () => ({ session: { cwd: other } }) } }
  const report = await syncProjectCatalog({ get: key => services[key] }, catalog)
  assert.equal(report.errors.length, 1); assert.equal(attached, false)
})
