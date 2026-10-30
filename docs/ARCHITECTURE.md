# Architecture

The package owns one DSH loader row and one browser bundle. `index.js` composes execution and history modules in that lifecycle; consumers do not install the two upstream plugins separately.

`lib/execution` publishes a loopback MCP endpoint and uses DSH public session/workspace services. Its local additions handle completed opening snapshots and optionally register a project catalogue through the workspace registry.

`lib/history` provides the import/export picker and conversion code. Its persistent settings are namespaced to this package. MCP mirroring is disabled by the composition root.

`bin/delegate-mcp.mjs` is the small Codex-side stdio adapter: a six-tool catalogue, concise instructions, directory validation, and local spill files for large results. It discovers the endpoint at runtime, so loopback port changes and token rotation do not require embedding credentials in Codex config. Explicit HTTP wait budgets avoid Node fetch's shorter default header deadline.

`bin/cli.mjs` installs the DSH bundle and adds a marked Codex MCP block while preserving unrelated settings. Runtime state and backups live in user data directories. Package allowlisting and source scans guard the distributable.

Project identity is a real directory path, not a display name. Workspace membership is changed through DSH's service, never by rewriting its live workspace JSON store. Existing user-defined titles are retained. Historical conversation export is a version-sensitive conversion into a new copy, not a live shared-writer protocol.
