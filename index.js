import { homedir } from 'node:os'
import { join } from 'node:path'
import * as execution from './lib/execution/index.js'
import * as history from './lib/history/index.js'

export const name = 'codex-dsh-workspace'
export const inject = ['webServer', 'systemPrompt', 'commands']

export function apply(ctx, config = {}) {
  const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const state = join(home, 'codex-dsh-workspace')
  execution.apply(ctx, {
    preset: 'strict', exposeToDsh: false, exposeToDshPage: false,
    groupSessions: true, createGroups: true, answerApprovals: false, answerQuestions: false,
    maxConcurrentTurns: 2, turnTimeoutMs: 600000,
    ...config.execution,
    path: '/codex-dsh-workspace/mcp', endpointFile: join(state, 'endpoint.json'),
    projectCatalog: config.projectCatalog,
  })
  history.apply(ctx, {
    enableImport: true, autoImport: false, enableSkills: false,
    enableInstructions: false, enableConfig: false, mcpMirror: false,
    ...config.history,
    // The merged package has its own slim execution bridge. Mirroring tools
    // back into DSH would create a loop and defeat bounded-context execution.
    mcpMirror: false, mcpServers: {}, allowMcpMirror: false,
  })
}
export default { name, inject, apply }
