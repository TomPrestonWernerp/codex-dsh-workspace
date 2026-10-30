# Codex DSH Workspace

[简体中文](README.md)

One local DSH plugin for Codex-led task execution, workspace grouping, and chat portability. Codex plans and verifies; DeepSeek Harness implements and tests with its independently configured model.

## Install

Requires Node 24+, a configured DSH installation, and a local MCP-capable Codex client. The current host adaptation targets DSH 0.2.1-rc.5.

```sh
git clone https://github.com/TomPrestonWernerp/codex-dsh-workspace.git
cd codex-dsh-workspace
node bin/cli.mjs install --profile desktop
```

Use `--dsh-command <launcher>` and `--node <node-binary>` for a desktop installation whose CLI is not on PATH. `--dry-run` prints the plan without mutations. Restart DSH once and start a new Codex chat.

The installer preserves existing configuration and writes backups. It refuses an unmanaged `dsh_delegate` entry rather than overwriting another bridge. Remove only the backed-up old bridge entry before migrating; do not load both original plugins alongside this combined package.

## Workflow

Open the actual project directory in Codex. Send a complete task, write scope, and acceptance criteria to DSH; reuse the same DSH session for related fixes. Review real changes and test evidence before accepting the result.

Sessions attach to projects by their actual absolute working directory, including distinct Git worktree paths. A `--projects <catalog.json>` file can provide display names:

```json
{"schemaVersion":1,"projects":[{"title":"My project","path":"/absolute/project/path"}]}
```

The Codex-facing MCP exposes only six tools: start, continue, wait, cancel, bounded transcript read, and status. Large replies are saved locally and return an evidence path. A wait timeout does not stop DSH.

## Chat portability

The sidebar provides per-project Codex imports and exports into new Codex conversation copies. Incremental import can append supported new history. This is **not concurrent bidirectional editing of one shared live conversation**.

Automatic bulk import, skill/instruction/config injection, and MCP mirroring are off by default. Export relies on version-sensitive Codex history/index formats and must be revalidated when Codex changes. Execution and workspace grouping do not require exporting history.

## Verify and contribute

```sh
node bin/cli.mjs doctor
npm ci
npm run check
```

Keep runtime state, credentials, real transcripts and backups outside the repository. State lives in `~/.dsh/codex-dsh-workspace` and `~/.codex/codex-dsh-workspace`. Do not claim fixed token savings: planning, reading returned context, execution and review still consume their respective model budgets.

MIT; adapted source and original licenses are retained in [NOTICE](NOTICE) and [third_party/licenses](third_party/licenses). Independent community project, not affiliated with OpenAI or DeepSeek.

## Windows and uninstall

Use `--pwsh <absolute-executable>` during installation if DSH inherits another application's private PowerShell binary. This changes only the executable, not confinement. Node 24 supports `node --test --test-isolation=none <test-file>` if its child test process is blocked with `spawn EPERM`. Report unresolved sandbox/ACL errors rather than escalating permissions.

Run `node bin/cli.mjs uninstall --profile desktop` (and `--dsh-command` if needed) to remove this plugin and managed configuration while retaining history, evidence and backups. See [verification](docs/verification.md) for the tested scope and remaining desktop export limitation.
