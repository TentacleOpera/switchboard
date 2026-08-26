---
name: rearrange-feature
description: Restructure a feature's subtasks — split one subtask into several, move scope between subtasks, merge, or reorder — WITHOUT rewriting their content. Structure-only; the missing counterpart to improve-feature (content) and group-into-features (composition).
---

# Rearrange Feature

Re-slice the subtasks of an existing feature so each one is the right size and scope for a single coding agent — **while keeping the subtask content as written.** This is the structure-only operation: it changes *boundaries* (how work is partitioned across subtasks), not *words* (how each subtask is authored).

Use it when a feature's subtasks are the wrong shape for execution — most often when one subtask bundles several independent tasks and burns a coder's whole context on reading before it can code — and you want to split/move/merge the pieces without a content rewrite.

## When to use vs. the neighbours

- **This skill (`rearrange-feature`)** — the subtask *boundaries* are wrong (one is too big, two overlap, work is in the wrong subtask). Split one into N, move scope between them, merge, reorder. **Content is preserved verbatim.**
- **`improve-feature` / `switchboard-feature`** — the subtask *content* needs work (deepen, dedupe, make the set coherent). It re-authors each subtask in its own voice, so it will re-inflate content you deliberately trimmed. Use it *after* rearrange if the freshly-sliced pieces then need polishing — never as a substitute for a structure-only change.
- **`switchboard-split`** — the narrow special case: **one plan → two, along complexity lines** (Complex/Risky vs Routine). If that's exactly the split you want, use it. This skill is the general form: any subtask → N pieces along any axis (usually task-separation), plus move/merge/reorder across the whole feature.
- **`group-into-features` / `create-feature-from-plans`** — the *inverse* direction: composing loose plans *into* a feature. This skill decomposes/rearranges an existing one.

## Core principle — preserve content, change structure

Every implementation step, code block, line reference, and edge case in the source subtasks must land in exactly one destination subtask (shared context — Goal/background/dependencies — may be duplicated into each so every file stays self-contained). **Do not re-author.** If a piece reads well already, it reads well in its new home unchanged. Git is the undo.

## Inputs

- The **feature** (its feature plan-id, or the feature file path — the id is in `.switchboard/features/<slug>-<uuid>.md`).
- The **target shape**: which subtask splits into what, and/or what moves where. If not given, propose the re-slicing and confirm before touching anything.

Read the feature and every subtask first:
```bash
PORT=$(cat .switchboard/api-server-port.txt); BASE="http://127.0.0.1:$PORT"
curl -s "$BASE/kanban/plans?featureId=<featurePlanId>" | jq '.data[] | {planId, topic, planFile, kanbanColumn}'
```

## The building blocks

Subtask membership is `<!-- planId:… subtask-of:"<feature name>" -->` in the kanban-state mirror, backed by `kanban.db`. **Never edit `kanban.db` or the state `.md` mirror by hand** (this workspace has a history of board-clobber from that). Compose the rearrangement from these primitives instead:

| Goal | Local (extension running) | Remote (no extension) |
|---|---|---|
| **Keep a subtask but change its scope** | **Rewrite its `.md` file in place.** This preserves its `planId`, `subtask-of`, and column — zero board churn. The most important move: make one output *be* the rewritten original. | Same — just a file write. |
| **Create a new subtask in the feature** | `POST /kanban/plans` (writes file, imports, returns `planId`) → `node .agents/skills/kanban_operations/assign-to-feature.js <featurePlanId> '["<newPlanId>"]' <workspaceRoot>` | Write the `.md` with `**Feature:** <feature-plan-id>` (and `**Project:** <name>` if needed) in the metadata block — applied apply-if-empty on import — then move it to `PLAN REVIEWED` via the Notion/Linear provider or MCP. |
| **Detach a subtask (keep the plan)** | `node .agents/skills/kanban_operations/remove-from-feature.js <subtaskPlanId> <workspaceRoot>` (or `POST /kanban/feature/remove`) | Remove the `**Feature:**` line and re-import. |
| **Delete a subtask entirely** | `DELETE /kanban/plans?planId=<id>&deleteFile=true` — **`deleteFile=true` is required**, or the file re-imports on the next scan | Delete the `.md` file. |

`POST /kanban/plans` body: `{ title, slug?, complexity?, tags?, project?, body?, workspaceRoot? }` — returns `{ planId, planFile, slug }`. It refuses to overwrite an existing slug (409).

## Steps — split one subtask into N (the common case)

1. **Read** the feature and the target subtask in full.
2. **Decide the partition.** Every step/section of the source lands in exactly one piece; shared Goal/background/dependencies are copied into each so each is self-contained.
3. **Rewrite the original file in place** to hold piece 1 (keeps its `planId` + linkage + column). Do NOT create a new file for piece 1 — reuse the original, so one card stays stable.
4. **Create pieces 2..N** as new subtasks via the table above (local: `POST /kanban/plans` → `assign-to-feature.js`; remote: file + `**Feature:**` line → move to `PLAN REVIEWED`).
5. **Verify nothing was lost** — every source step/code block/edge case is now in exactly one piece.
6. **Update the feature's prose** — the `## Goal`, `## How the Subtasks Achieve This`, and any dependencies/sequencing narrative — to describe the new subtask set. **Never touch the auto-generated `<!-- BEGIN/END SUBTASKS -->` block** — the extension regenerates it from the DB.
7. **Confirm the board** reflects the new set: `curl -s "$BASE/kanban/plans?featureId=<featurePlanId>" | jq '.data[].topic'`.

Move scope, merge, and reorder are the same primitives: **move** = rewrite two files (cut from one, paste into the other); **merge** = fold one file's steps into another, then delete the emptied subtask (`deleteFile=true`); **reorder** = purely narrative (subtask order is presentation — encode intended sequence in the feature's dependencies prose, not by renumbering cards).

## Guardrails

- **Preserve content, not structure** — nothing in the source subtasks may be dropped or rewritten for style; git is the undo.
- **Rewrite-in-place to keep `planId`s stable** — creating four new cards to replace two churns the board and loses history. Reuse originals wherever a piece maps back to one.
- **Never touch a feature's `<!-- BEGIN/END SUBTASKS -->` block** — it is regenerated from the DB; hand-edits are cosmetic and get overwritten.
- **Never write `kanban.db` or `kanban-state-*.md` directly** — go through the API / `kanban_operations` scripts (local) or plan-file frontmatter (remote).
- **`deleteFile=true` on real deletes** — otherwise the `.md` re-imports and the subtask reappears.
- **This is structure-only.** If the sliced pieces need content work afterward, hand off to `improve-feature` as a separate, explicit step — do not let a rearrangement quietly become a rewrite.

## Report

State: the feature, the before→after subtask list (which cards were reused-in-place vs. newly created vs. deleted), and a one-line confirmation that every source step landed in exactly one destination subtask.
