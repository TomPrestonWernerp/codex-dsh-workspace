import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'

const pathIdentity = value => process.platform === 'win32' ? value.toLowerCase() : value

// A local installation catalogue supplies project metadata only. Workspace
// membership is changed through the Host service, never by editing its store.
export async function syncProjectCatalog(ctx, catalogPath, logger = () => {}) {
  if (!catalogPath) return undefined
  const registry = ctx.get('workspaceRegistry')
  if (!registry?.resolveByPath || !registry?.create) return undefined
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.projects)) throw new Error('Invalid local project catalogue')
  const report = { at: new Date().toISOString(), projects: [], skipped: [], errors: [] }
  for (const project of catalog.projects) {
    try {
      const cwd = await realpath(project.path)
      if (!(await stat(cwd)).isDirectory()) throw new Error('Project directory is missing')
      if (cwd.toLowerCase() === parse(cwd).root.toLowerCase()) {
        report.skipped.push({ path: cwd, reason: 'Drive roots are not execution projects' })
        continue
      }
      let workspace = await registry.resolveByPath(cwd)
      const created = !workspace
      if (!workspace) workspace = await registry.create(cwd, project.title)
      let attached = 0
      for (const sessionId of project.sessionIds ?? []) {
        const snapshot = await ctx.get('sessionQuery')?.readSession(sessionId)
        const recorded = snapshot?.session?.cwd ?? snapshot?.header?.cwd
        if (!recorded || pathIdentity(await realpath(recorded)) !== pathIdentity(cwd)) {
          throw new Error(`Refused mismatched session workspace: ${sessionId}`)
        }
        await workspace.attachSession(sessionId)
        attached += 1
      }
      report.projects.push({ path: workspace.path, title: workspace.title, created, attached })
    } catch (error) { report.errors.push({ path: project.path, message: error.message }) }
  }
  await writeFile(join(dirname(catalogPath), 'project-grouping.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  logger('info', 'Codex project catalogue synchronized', { projects: report.projects.length, errors: report.errors.length })
  return report
}
