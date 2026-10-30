# Contributing

This is one local, MIT-licensed bridge package: Codex plans and reviews, DeepSeek
Harness (DSH) executes, and optional history import/export stays on the DSH side.
It is an independent community project, not an official OpenAI or DeepSeek
integration. Keep changes inside that scope and prefer small, reviewable diffs.

## Requirements

- **Node.js 24 or newer** (`engines: ">=24"`; CI and the recorded acceptance run
  use Node 24). A DSH-bundled Node 24 is fine; no newer system Node is required.
- **npm** with the committed `package-lock.json`.
- **DSH 0.2.1-rc.5** only for live verification. Offline checks need no DSH
  installation, no model access, and no network.
- A local MCP-capable Codex client only when verifying end-to-end delegation.

## Set up and check

```sh
npm ci
npm run check
```

Use `npm ci`, not `npm install`, so the lockfile stays authoritative. Do not
commit `node_modules/`.

`npm run check` is the required gate and runs three steps:

1. `npm test` — `node --test test/*.test.mjs` (install, bridge, project grouping,
   and snapshot regression coverage).
2. `npm run test:upstream` — the history-format suites and execution test
   programs with an isolated temporary `DSH_HOME`.
3. `node scripts/package-audit.mjs` — scans the shipped package roots for
   personal absolute paths, credential patterns, and runtime data files.

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`, `npm run check`,
and `npm pack --dry-run` on Ubuntu and Windows with Node 24. Run a single file
with `node --test test/<name>.test.mjs`. If Windows child-process confinement
fails with `spawn EPERM`, retry with
`node --test --test-isolation=none <test-file>`; if it still fails, report the
blocker instead of changing the permission mode.

## Offline CI is not live DSH verification

`npm run check` proves formats, conversion, routing, and package hygiene. It does
not exercise a real DSH host, its tool sandbox, or its configured model. Live
checks are separate and their evidence must not be confused with CI:

- `node scripts/live-smoke.mjs` — no model usage. Checks MCP initialization, the
  six-tool catalogue, and rejection of unadvertised tools and drive-root
  workspaces.
- `node scripts/live-smoke.mjs --smoke <new-empty-project-directory>` — spends
  the configured DSH model budget on a real task and requires native tool
  evidence, independently passing tests, and an exact file scope. It writes
  `acceptance.json` under the user's Codex state directory.
- `node scripts/verify-existing.mjs <workspace> <session-id>` — rechecks
  recorded evidence from an existing acceptance session without model usage.

A green `npm run check` does not replace live DSH acceptance on each supported
OS, and a successful smoke run does not excuse offline checks. In a pull request,
say which commands you ran, on which OS, and what actually happened. See
[docs/verification.md](docs/verification.md) for the current tested scope and
known gaps (for example, real chats exported to Codex desktop are not validated
in every Codex version, and import/export is not live bidirectional merging).

## Keep real state out of the repository

Never commit real conversations, session IDs, transcripts, credentials, API
tokens, private project paths, acceptance evidence, backups, or logs. Use
synthetic fixtures under `test/` and relative example paths in documentation.

Runtime state lives outside the checkout:

- DSH state: `~/.dsh/codex-dsh-workspace/`
- Codex-side results, evidence, and backups: `~/.codex/codex-dsh-workspace/`

The `.gitignore` excludes `.env*`, `*.sqlite*`, `*.jsonl*`, `*.log`, `state/`,
`backups/`, and `artifacts/`. The package audit fails on Windows user-profile
paths, token-looking strings, and runtime data files; keep it passing and do not
weaken it to accommodate local files.

## Preserve upstream licensing

The project is MIT. Adapted upstream code is attributed in [NOTICE](NOTICE) and
[third_party/licenses](third_party/licenses). Keep `LICENSE`, `NOTICE`, the
upstream MIT license texts, and any adapted-source headers intact; do not
remove, rewrite, or relicense copyright notices. If you add or adapt code from
another project, add its license text and attribution to `NOTICE` and
`third_party/licenses`, and only combine code under compatible terms. Preserve
the original MIT notice in files you modify.

## Safety boundaries

- **No permission escalation.** If DSH asks a question, waits for approval, or a
  command is blocked by the sandbox, ACL, or a missing executable, stop and
  report it. Do not widen permission presets, edit ACLs, run elevated, or
  auto-answer prompts to force a check through. A blocked live run is reported
  as blocked, not "passed".
- **No recursive agent bridges.** Do not enable reverse MCP mirroring, automatic
  bulk history import, skill/instruction injection, or self-delegation by
  default, and do not load `dsh-mcp-server` or `dsh-codex-sync` alongside this
  package. Those cause callback recursion, duplicate context, and repeated tool
  calls. MCP mirroring and automatic import must stay off.
- **Keep the direction one-way.** Codex plans and verifies; DSH executes in its
  own workspace. Do not add hidden background loops or unattended retry chains
  that cross the bridge.
- **Make only supportable claims.** Do not promise fixed token savings or
  real-time shared-chat editing. History export produces a new conversation
  copy and depends on version-sensitive Codex formats.

## Pull requests

- Keep the change focused; avoid unrelated reformatting or dependency churn.
- Describe the behavior change, the commands you ran, offline versus live
  results, and any remaining blocker or untested platform.
- Update `docs/verification.md` only with evidence you actually observed, and
  never include real conversation IDs, private paths, or credentials.
- Do not include generated state, build output, or unrelated files in the diff.
