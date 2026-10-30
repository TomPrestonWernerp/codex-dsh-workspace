# Verification for 0.1.0

Environment: Windows, Node 24.21.0, DSH 0.2.1-rc.5. Runtime evidence is stored outside this repository; this document contains no real conversation IDs or private project paths.

- Live MCP initialize and six-tool catalog; non-advertised tools and drive-root execution rejected.
- One installed DSH package loads both execution and history UI; reverse MCP mirroring and automatic bulk import remain disabled.
- Existing Codex project metadata registers through DSH workspaceRegistry; original custom DSH names retained. An explicitly matched formerly ungrouped acceptance session attaches to its project. Sessions with mismatched recorded cwd are refused.
- DSH created two real source/test files, then implemented an NFKC follow-up in the same session and project.
- Initial command attempts encountered Windows ACL initialization, an inherited private PowerShell path, and Node child-process confinement errors. No automatic permission escalation was used. The dedicated acceptance folder received an owner ACL repair during diagnosis; the plugin does not perform ACL repair.
- With system PowerShell configured and Node's single-process test mode, the DSH native tool result recorded 5 tests, 5 passes, 0 failures. Codex independently reran the standard Node test runner and extra assertions. Only the two authorized files existed.
- Offline checks include the integration tests, 61 history-format tests, and 16 execution test programs. CI repeats these on Windows and Ubuntu; these do not replace live DSH host acceptance on each OS.
- Chat format import/export is covered by fixtures. The history browser bundle is registered, but the final display of real exported chats in every Codex desktop version has not been validated. This release does not provide concurrent editing or automatic real-time merging of two native chat stores.

Developers can run `node scripts/live-smoke.mjs` for no-model protocol checks. `node scripts/live-smoke.mjs --smoke <new-empty-project-directory>` spends the configured DSH model budget on a real task and requires native tool evidence, independent test success and an exact file scope. Evidence is written under the user's Codex state directory. Existing acceptance sessions can be rechecked without model usage with `node scripts/verify-existing.mjs <workspace> <session-id>`.
