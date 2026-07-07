# Fix: Feature-creation prompts must reference the create-feature skill, not "see the format"

**Plan ID:** a1b2c3d4-1330-4a04-9f04-featureSkill1330

## Goal

When an agent is instructed to create a Switchboard feature (after memo processing, after plan refinement, or during switchboard-chat), the prompt it receives tells it to "See `.switchboard/features/` for the format" — which leads the agent to hand-write the feature file directly. This bypasses the authoritative `create-feature.js` script (which does DB upsert, subtask linking, and board refresh atomically) and the `create-feature` skill (which documents the script and the extension-running detection logic). The result is orphaned features: a file on disk with no DB record and no subtask links.

The fix: update every feature-creation instruction to explicitly direct the agent to use the `create-feature` skill or `create-feature.js` script, matching the pattern already established in `sw-remote.md`.

### Problem / background / root cause

Feature creation in Switchboard has an authoritative path and a fallback path:

- **Authoritative (extension running):** `node .agents/skills/kanban_operations/create-feature.js "<name>" '<planIdsJson>' "<workspaceRoot>" "<description>"` — routes through the extension's LocalApiServer (`POST /kanban/feature`), which performs DB upsert, subtask linking (`feature_id` on each plan row), feature-file write, and board refresh atomically.
- **Fallback (remote/no extension):** the `create-feature` skill — direct file write to `.switchboard/features/` with YAML frontmatter, full SUBTASKS markers, and a UUID-in-filename so the watcher imports it on next activation.

Three prompt/workflow files instruct the agent to create features but **neither mention the skill nor the script** — they say "See `.switchboard/features/` for the format", which an agent interprets as "write the file yourself by copying the format":

1. **`.agents/workflows/memo.md:53`** — the memo processing workflow's step 5 (feature grouping offer): *"See `.switchboard/features/` for format."*
2. **`src/services/TaskViewerProvider.ts:3195`** — the refine-ticket prompt template (the prompt copied into the clipboard when the user clicks "Refine" on a ticket): *"See ${workspaceRoot}/.switchboard/features/ for the format."*
3. **`.agents/workflows/switchboard-chat.md:84`** — the local consultative planning workflow's feature grouping section: *"Refer to existing files in `.switchboard/features/` for the expected format."*

One file **already has the correct pattern**:

4. **`.agents/workflows/sw-remote.md:214-216`** — *"In a remote session, feature creation follows the `/create-feature` skill (direct file write to `.switchboard/features/`) or the `create-feature.js` script if the extension is reachable."*

**Root cause:** the three wrong files were written before the `create-feature` skill and `create-feature.js` script existed (or were not updated when those tools were added). They preserve a stale "hand-write the file" instruction that predates the authoritative tooling. `sw-remote.md` was written/updated later and has the correct pattern. The other three were never brought into parity.

This is not a one-off behavioral bug — it is a **prompt infrastructure defect**. Every agent that processes a memo, refines a ticket, or runs switchboard-chat receives the wrong instruction and will hand-write the feature file. The fix must be applied at the prompt source, not patched per-session.

## Metadata

**Tags:** prompt-infrastructure, workflow, feature-creation, skills, agent-behavior, bugfix
**Complexity:** 2

## User Review Required

Yes. Before implementation, the user should review:
- The coordination decision with the sibling plan (add-direct-create-feature-skill) on switchboard-chat.md — that plan's `create-feature-from-plans` wording SUPERSEDES this plan's `create-feature` / `create-feature.js` wording for switchboard-chat. This plan should DROP the switchboard-chat.md edit (step 3) and let the sibling plan handle both file copies (`.claude/skills/` + `.agents/workflows/`).
- The workspace-path quoting in `TaskViewerProvider.ts` — the `node` command in the prompt template needs quoted paths (`"${workspaceRoot}/..."`) to handle paths with spaces (common on macOS, e.g. `/Users/Patrick Vuleta/...`).
- Whether to reference `create-feature-from-plans` (the new skill from the sibling plan) as the preferred path in the `memo.md` and `TaskViewerProvider.ts` edits, with `create-feature` / `create-feature.js` as fallbacks.

## Complexity Audit

### Routine
- Three text edits to workflow/prompt files, replacing "See ... for the format" with explicit skill/script references. Each is a single-line or short-block replacement.
- The correct pattern already exists in `sw-remote.md:214-216` — copy that pattern, adapted for local vs remote context.

### Complex / Risky
- **`TaskViewerProvider.ts:3195` is a TypeScript string literal** inside a template function. The edit must preserve the template literal syntax (`${workspaceRoot}`, `${issues.length}`, backtick delimiters). The surrounding code (`TaskViewerProvider.ts:3180-3201`) builds the refine prompt — verify the string concatenation and variable interpolation remain valid after the edit.
- **`memo.md` is consumed by multiple hosts** (Claude Code, Antigravity, claude.ai). The instruction must be host-neutral — it should say "use the `create-feature` skill or `create-feature.js`" without assuming a specific host's skill-invocation syntax. The `sw-remote.md` pattern is already host-neutral ("follows the `/create-feature` skill ... or the `create-feature.js` script").
- **No data migration.** No DB changes, no config changes. Pure text edits to prompt sources.

## Edge-Case & Dependency Audit

- **Local vs remote context.** `memo.md` and `switchboard-chat.md` are local workflows; `TaskViewerProvider.ts` generates a prompt that may be pasted into any host. The instruction should cover both paths: "If the VS Code extension is running (check `.switchboard/api-server-port.txt`), use `create-feature.js` — it does DB upsert + subtask linking atomically. Otherwise, use the `create-feature` skill (direct file write)." This mirrors the `create-feature` SKILL.md's own detection logic.
- **`group-into-features` skill.** The AGENTS.md skills table also lists `group-into-features` (scans pre-coding columns, clusters, proposes groupings, creates via `create-feature.js`). The memo/refine prompts are not doing the scan-and-cluster flow — they already know which plans to group (the ones just created). So the instruction should reference `create-feature` (single feature from known plan IDs), not `group-into-features` (scan-and-propose). Do not conflate the two.
- **Plan ID source.** `create-feature.js` takes plan IDs (UUIDs from the DB), not filenames. The instruction should remind the agent to use the `planId` from the DB/kanban-board.md, not the filename — the `group-into-features` SKILL.md already documents this (`Use the planId: value from the comment — NOT the filename`). This was a secondary failure in the session: even after invoking the skill, I initially tried to use the fake `Plan ID:` from inside the plan file instead of querying the DB for the real `plan_id`.
- **`dist/` artifacts.** `TaskViewerProvider.ts` is compiled to `dist/`. The edit is to `src/` only; the build regenerates `dist/`. No `dist/` edit needed.
- **No dependency on the two git-strategy plans.** This plan is independent of the prompts-tab-layout and git-strategy-defaults plans. It touches different files (workflow `.md` files and `TaskViewerProvider.ts`, not `sharedDefaults.js` or `kanban.html`).

## Dependencies

Coordinates with the create-feature-skill plan (add-direct-create-feature-skill, same feature) on switchboard-chat.md — that plan creates the `create-feature-from-plans` skill and wires it into switchboard-chat; this plan's switchboard-chat edit (step 3) should be DROPPED in favor of that plan's wording (which references the new skill that wraps `create-feature.js`). This plan's `memo.md` and `TaskViewerProvider.ts` edits are independent. No dependency on the board-snapshot-staleness or project-scope-wording plans.

## Adversarial Synthesis

Key risks: (1) switchboard-chat.md collision with the sibling plan (add-direct-create-feature-skill) — both edit the same source line ("Refer to existing files in `.switchboard/features/` for the expected format.") in different file copies (`.claude/skills/switchboard-chat/SKILL.md:85` vs `.agents/workflows/switchboard-chat.md:84`) with conflicting replacement text (this plan says "use `create-feature` or `create-feature.js`"; the sibling says "invoke `create-feature-from-plans`"); the sibling plan's wording supersedes because `create-feature-from-plans` wraps `create-feature.js` — this plan should DROP the switchboard-chat edit (step 3). (2) Unquoted workspace path in the `TaskViewerProvider.ts` template literal breaks the `node` command for paths with spaces (common on macOS) — quote it: `node "${workspaceRoot}/.agents/skills/..."`. (3) This plan's wording doesn't reference `create-feature-from-plans` (the sibling plan's new skill) — add it as the preferred path when the extension is running, with `create-feature` / `create-feature.js` as fallbacks. Mitigations: drop the switchboard-chat edit (let the sibling plan handle both copies); quote workspace paths in the template literal; reference `create-feature-from-plans` as the preferred path.

## Proposed Changes

### 1. `.agents/workflows/memo.md:53` — reference skill + script, not "the format"

```markdown
<!-- BEFORE — memo.md:53 -->
5. **Offer feature grouping.** After creating all plan files: if 3 or more of the plans cover a related topic (sharing a common feature area or root cause), offer to group them under a feature — "These [N] plans cover related work — want me to create a feature to group them together?" Only create the feature if the user confirms. See `.switchboard/features/` for format.

<!-- AFTER -->
5. **Offer feature grouping.** After creating all plan files: if 3 or more of the plans cover a related topic (sharing a common feature area or root cause), offer to group them under a feature — "These [N] plans cover related work — want me to create a feature to group them together?" Only create the feature if the user confirms. **Do NOT hand-write the feature file.** Use the `create-feature` skill or run `create-feature.js` — these perform the DB upsert, subtask linking, and board refresh atomically. If the VS Code extension is running (check `.switchboard/api-server-port.txt`), run `node .agents/skills/kanban_operations/create-feature.js "<featureName>" '<planIdsJson>' "<workspaceRoot>" "<description>"`. If the extension is not reachable, use the `create-feature` skill (direct file write to `.switchboard/features/`). Use the `planId` UUIDs from the kanban DB or `kanban-board.md` — NOT the filenames.
```

### 2. `src/services/TaskViewerProvider.ts:3195` — reference skill + script in the refine prompt

```typescript
// BEFORE — TaskViewerProvider.ts:3195
- If you created 3 or more plan files that cover a related topic (sharing a common feature area or root cause), offer to create a feature grouping them: "These [N] plans cover related work — want me to create a feature to group them together?" Only create the feature if the user confirms. See ${workspaceRoot}/.switchboard/features/ for the format.\`;

// AFTER
- If you created 3 or more plan files that cover a related topic (sharing a common feature area or root cause), offer to create a feature grouping them: "These [N] plans cover related work — want me to create a feature to group them together?" Only create the feature if the user confirms. Do NOT hand-write the feature file. If the VS Code extension is running (check ${workspaceRoot}/.switchboard/api-server-port.txt), run: node ${workspaceRoot}/.agents/skills/kanban_operations/create-feature.js "<featureName>" '<planIdsJson>' "${workspaceRoot}" "<description>" — this does DB upsert + subtask linking atomically. If the extension is not reachable, invoke the create-feature skill (direct file write to .switchboard/features/). Use planId UUIDs from the kanban DB or kanban-board.md, NOT filenames.\`;
```

### 3. `.agents/workflows/switchboard-chat.md:84` — reference skill + script

```markdown
<!-- BEFORE — switchboard-chat.md:84 -->
Only create the feature if the user confirms. Refer to existing files in `.switchboard/features/` for the expected format.

<!-- AFTER -->
Only create the feature if the user confirms. **Do NOT hand-write the feature file.** Use the `create-feature` skill or run `create-feature.js` — these perform the DB upsert, subtask linking, and board refresh atomically. If the VS Code extension is running (check `.switchboard/api-server-port.txt`), run `node .agents/skills/kanban_operations/create-feature.js "<featureName>" '<planIdsJson>' "<workspaceRoot>" "<description>"`. If the extension is not reachable, use the `create-feature` skill (direct file write to `.switchboard/features/`). Use the `planId` UUIDs from the kanban DB or `kanban-board.md` — NOT the filenames.
```

### 4. Audit for any other "for the format" / "for format" feature-creation references

Search all `.agents/`, `.claude/`, and `src/` files for feature-creation instructions that say "for the format" / "for format" / "expected format" without referencing the skill or script. Update any found to match the pattern above. (The grep in investigation found only the three locations above + the already-correct `sw-remote.md`, but a final audit grep before merge confirms no new ones were added.)

## Verification Plan

> **Session directive:** Compilation and automated tests are SKIPPED per session directives (SKIP COMPILATION, SKIP TESTS). Step 3 (`npm run build`) below should be deferred to the user's discretion. All other verification steps are manual.

1. **Grep guard:** After the edits, run:
   ```
   grep -rn "for the format\|for format\|expected format" .agents/workflows/ src/services/ --include="*.md" --include="*.ts" | grep -i feature
   ```
   Confirm zero results (every feature-creation instruction now references the skill/script, not "the format").

2. **Pattern parity check:** Confirm all four feature-creation locations (`memo.md`, `TaskViewerProvider.ts`, `switchboard-chat.md`, `sw-remote.md`) now contain the string `create-feature` (either the skill name or the script name). Run:
   ```
   grep -l "create-feature" .agents/workflows/memo.md .agents/workflows/switchboard-chat.md .agents/workflows/sw-remote.md src/services/TaskViewerProvider.ts
   ```
   Confirm all four files appear in the output.

3. **TypeScript build:** Run `npm run build` (or the project's compile command). Confirm `TaskViewerProvider.ts` compiles with no template-literal errors from the edited string.

4. **Manual (refine prompt):** Click "Refine" on a ticket in the Planning tab. Paste the copied prompt into a new session. Confirm the feature-grouping instruction now says to use `create-feature.js` / the `create-feature` skill, not "See ... for the format."

5. **Manual (memo processing):** Capture 3+ memo entries, run `process memo`, confirm the plans are created. When the agent offers to group them and the user confirms, confirm the agent runs `create-feature.js` (not a hand-written file). Verify the feature appears in the kanban DB with `is_feature = 1` and both plan rows have `feature_id` set.
