---
description: Management console — board snapshot, categorized menu, dispatch, oversight. Thin router to the switchboard-manage skill.
---

# Switchboard Manage — Workflow Router

This workflow is a **thin router**: the full protocol lives in the skill file so the
console behaves identically in every host (Antigravity, Claude Code, Cursor, terminal
agents). Do not duplicate console logic here — it would drift from the skill.

## Steps

1. Read `.agents/skills/switchboard-manage/SKILL.md` (use `view_file` / your host's file
   reader).
2. Follow it **exactly**, starting with **§1 Entry Protocol**: resolve the workspace root,
   one `/health` liveness call (save its `terminals` field), one-command awk board
   snapshot from the local kanban-state files, setup-gap check, then report concisely and
   present the categorized menu — **then stop and wait for the user's direction**.
3. All subsequent actions route through the skill's menu sections (§2–§7) and Hard Rules
   (§8). You are the manager, never the coder.

## Notes

- The skill is the single source of truth. If this router and the skill ever disagree,
  the skill wins.
- Entry must be **concise**: liveness + one-line board snapshot + menu. No feature lists,
  no UUIDs, no wall of text, no eager action.
