---
name: codex-sync
description: Preview or import Codex chats into DSH by project, export a DSH chat as a new Codex copy, or inspect the merged workspace bridge settings. Use for explicit history-portability requests, not ordinary coding tasks.
---

# Project chat portability

The merged codex-dsh-workspace plugin provides native DSH commands. Select the user's project and conversations; avoid importing unrelated history.

```text
/import-codex --dry-run --project project-name
/import-codex --ids codex-thread-id
/attach-workspaces
/export-codex --dry-run
/export-codex --ids dsh-session-id
/codex-settings
/mcp-status
```

Preview imports to check scope. If the user already authorized importing those conversations, perform the scoped import without asking again. New imported sessions attach by their recorded absolute working directory. Existing custom project titles remain intact.

Export creates a new Codex conversation copy and never overwrites the original. The two apps do not concurrently edit one live shared conversation. Codex may need to reload before exported copies appear.

MCP mirroring is disabled in the merged bridge. Do not install the original reverse bridge or enable recursive delegation to resolve a history issue. Report unsupported history formats instead of rewriting unrelated session logs.
