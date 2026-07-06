# Add Direct "Create Feature from Plans" Skill + Wire Into Planner & Improve-Plan

## Metadata

**Tags:** docs, cli, feature, refactor
**Complexity:** 5
**Project:** switchboard
**Plan ID:** 7f4c2a8e-3b1d-4f6a-9e2c-8b5d7a3f1c04

## Goal

### Problem

There are two gaps in how Switchboard teaches agents to create features:

**Gap 1: No direct-creation skill.** The two existing feature-creation skills don't cover the common case where the user already knows which plans belong together:

- **`create-feature`** — a remote-session fallback that writes the feature file directly to disk. Explicitly says "Do NOT use if the extension IS running." Wrong tool for local sessions.
- **`group-into-features`** — a discovery flow: scan the board, cluster loose plans by capability, propose groupings, get approval, then execute. Designed for when the user *doesn't* know the groupings. Overkill when the user says "these 5 plans I just wrote belong in this feature."

**Gap 2: The planner persona and improve-plan workflow tell agents to *suggest* features but never tell them *how* to create one.** Specifically:

- **`switchboard-chat` (the planner persona)** — Lines 78-84 have a "Feature Grouping" section that tells the planner to flag when work spans 3+ plans and offer to group them. But when the user says yes, the only instruction is: *"Only create the feature if the user confirms. Refer to existing files in `.switchboard/features/` for the expected format."* No mention of `create-feature.js`, the API, plan IDs in the DB, or any skill to invoke.
- **`improve-plan` workflow** — Has a "Trigger B" manifest path for restructuring plans into a feature during review. It documents the manifest JSON schema but says nothing about the actual creation mechanism. It assumes the agent writes feature files by hand and emits a manifest for the watcher.
- **`deep-planning` skill** — No mention of features at all.

The result: an agent that successfully identifies "this should be a feature" has no documented path to actually create one. It must either reverse-engineer `create-feature.js` from source (what I did), stumble onto `group-into-features` (overkill), or write files by hand + emit a manifest (error-prone).

### Background

`create-feature.js` at `.agents/skills/kanban_operations/create-feature.js` is the authoritative creation mechanism when the extension is running. It:
1. Discovers the extension's API port from `.switchboard/api-server-port.txt`
2. POSTs to `/kanban/feature` with `{ workspaceRoot, name, planIds, description }`
3. The extension does the DB upsert, subtask linking, feature-file write, and board refresh atomically
4. Returns `{ ok: true, featurePlanId, featureSessionId }`

Prerequisite: the plan files must already be imported into the kanban DB (the `plans` table) so their `plan_id` values exist. The `GlobalPlanWatcherService` auto-imports files written to `.switchboard/plans/` within a few seconds.

After creation, the feature file only contains the `## Goal` section (from the description arg). The `## How the Subtasks Achieve This` and `## Dependencies & sequencing` sections must be written manually into the feature file — `group-into-features` documents this post-step (lines 105-112).

### Root Cause

No skill wraps the direct "I know the plans, just make the feature" path, and neither the planner persona nor the improve-plan workflow references any creation mechanism. The agent is left to improvise.

### Desired Outcome

1. A new skill — `create-feature-from-plans` — that documents the direct creation path: given a feature name, a set of plan IDs (or plan files), and a goal description, create the feature via `create-feature.js`, verify it, and write the narrative sections into the feature file. No discovery, no scanning, no clustering.
2. The planner persona (`switchboard-chat`) updated to tell the agent to invoke `create-feature-from-plans` when the user confirms they want a feature created.
3. The `improve-plan` workflow updated to tell the agent to invoke `create-feature-from-plans` when restructuring plans into a feature during review (instead of only documenting the manifest path).
4. Cross-references from the two existing feature skills pointing to the new one for the direct case.

## User Review Required

Yes. Before implementation, the user should review:
- The **Clarifications** appended to Implementation steps 1, 3, and 5 — these correct factual errors in the original plan (silent-blank-feature behavior, the improve-plan NO-IMPLEMENTATION conflict, the protocol skill-table registration, and stale line numbers 85/104). The original SKILL.md code block and wiring text are preserved verbatim; the Clarifications state exactly what to change when authoring.
- The addition of **`AGENTS.md`** (repo root) to the Files to Create/Modify table — required for the new skill to appear in the protocol's "Available Skills" table, not just the host's auto-discovered list.
- The complexity bump **4 → 5** (Mixed): routine multi-file docs work, elevated by one moderate, well-scoped risk (the silent-blank-feature footgun the skill must document correctly).

## Complexity Audit

### Routine
- Authoring one new markdown skill file (`.claude/skills/create-feature-from-plans/SKILL.md`) following the existing `create-feature` / `group-into-features` format.
- Small targeted edits to 5 existing markdown files (skill files + workflow files) — prose insertions only, no code.
- Cross-reference additions to two "When to Use" sections.
- No source code, no DB schema, no UI, no migrations, no tests.
- All changes reuse existing patterns (skill frontmatter, Trigger B phrasing, narrative-section positions).

### Complex / Risky
- **Silent-blank-feature footgun:** `createFeatureFromPlanIds` deliberately allows zero-resolved-subtasks and returns `success:true` (verified, `KanbanProvider.ts:10296-10308`). The skill MUST document the pre-flight DB check as the load-bearing gate and `delete-feature.js` as the recovery path — getting this wrong orphans blank features in the DB/board.
- **improve-plan NO-IMPLEMENTATION constraint conflict:** the original wiring proposal instructs mid-review `create-feature.js` invocation, which violates the workflow's own "ONLY permissible write action is updating the existing Feature Plan document" constraint. Must be reframed to a post-review reference.
- **Protocol skill-table registration:** the `AGENTS.md`/`CLAUDE.md` "Available Skills" table is sourced from a bundled static file, not auto-scanned — requires a manual table-row edit or the skill is invisible to protocol-following agents.

## Edge-Case & Dependency Audit

**Race Conditions**
- Plans just written to `.switchboard/plans/` may not yet be imported by `GlobalPlanWatcherService` when `create-feature.js` runs. If the agent skips the pre-flight SQL wait and invokes creation, the result is a silent blank feature (see Complex/Risky). Mitigation: the skill's Prerequisites §2 already gates on "Do NOT proceed until all plan IDs are confirmed in the DB" — this gate is load-bearing and must not be treated as optional.
- `_regenerateFeatureFile` is re-entrant via the file watcher (self-write loop), guarded by a byte-identical no-op skip (`KanbanProvider.ts:10027-10029`). Not a concern for this plan (no source change), but the narrative sections the skill writes must sit outside the `<!-- BEGIN SUBTASKS -->` / `<!-- END SUBTASKS -->` span to survive regen — verified correct.

**Security**
- The skill instructs shell invocation of `create-feature.js` with a user-supplied description inside double quotes. Shell metacharacters (`$`, backticks, backslashes) inside double quotes are an injection vector. Mitigation: the skill already warns to avoid these; Clarification 2 additionally notes newlines are safe (not a metacharacter) so legitimate multi-line goals aren't needlessly rephrased.
- No credential handling, no network egress beyond the local `127.0.0.1` API.

**Side Effects**
- `create-feature.js` creates a DB record, writes a feature file, links subtasks, may provision worktrees (`per-subtask`/`high-low` modes), refreshes the board, and syncs outbound to Linear/ClickUp (best-effort). All intentional, but the skill should set the expectation that creation is not reversible by re-running — a mistaken creation needs `delete-feature.js`.
- Edits to the bundled repo-root `AGENTS.md` propagate into `CLAUDE.md` on the next Switchboard setup run via `ClaudeCodeMirrorService` — a desired side effect, not a risk.

**Dependencies & Conflicts**
- Depends on the extension running for the primary path (`.switchboard/api-server-port.txt` present + `/health` responds). Falls back to the `create-feature` skill (remote file-write) when absent — but note `create-feature.js` itself has NO direct-DB fallback and fails with a clear message; the *agent* performs the fallback by switching skills, not the script.
- The new skill shares the `create-feature.js` / `assign-to-feature.js` verbs with `group-into-features` and `create-feature` — no conflict, complementary scopes (direct vs discovery vs remote).
- No dependency on any prior plan or session.

## Dependencies

None — standalone documentation / skill-authoring plan.

## Adversarial Synthesis

Key risks: (1) the skill's failure-mode documentation is factually wrong — `create-feature.js` returns `ok:true` with zero subtasks on stale plan IDs, so the pre-flight DB check is the only gate and `delete-feature.js` is the undocumented recovery; (2) the improve-plan wiring proposal violates that workflow's own NO-IMPLEMENTATION constraint by instructing mid-review `create-feature.js` invocation; (3) the skill won't appear in the protocol's "Available Skills" table without a manual `AGENTS.md` row (the table is a bundled static file, not auto-scanned). Mitigations: correct the failure-mode text and add recovery guidance, reframe improve-plan's addition as a post-review reference (keep the manifest as the in-workflow mechanism), and add the `AGENTS.md` table row.

## Implementation

### 1. New skill file — `.claude/skills/create-feature-from-plans/SKILL.md`

Create with the following content:

```markdown
---
name: create-feature-from-plans
description: Create a Switchboard feature from a known set of plans — no discovery, just mechanics. Use when the user already knows which plans to group.
---

# Create Feature from Plans (Direct)

Create a Switchboard feature when the user already knows which plans belong
together. This is the direct path — no board scanning, no clustering, no
proposal step. Just create the feature, verify it, and write the narrative.

## When to Use

- The user says "create a feature from these plans" / "group these into a
  feature" / "make a feature for X containing plans A, B, C"
- The user has just written several related plans and wants them grouped
- The planner persona (switchboard-chat) flagged 3+ related plans and the
  user confirmed they want a feature
- The improve-plan workflow restructured plans into a feature set during
  review and needs to create the feature
- Do NOT use this skill if the user wants you to *discover* groupings from
  the board — use `group-into-features` instead
- Do NOT use this skill if the extension is NOT running — use `create-feature`
  (the remote fallback) instead

## Prerequisites

### 1. Extension must be running

Check for `.switchboard/api-server-port.txt` in the workspace root. If absent,
the extension is not running — fall back to the `create-feature` skill (direct
file write).

### 2. Plans must be in the kanban DB

`create-feature.js` needs `planId` values from the kanban DB `plans` table.
If the plans were just written as files to `.switchboard/plans/`, the
`GlobalPlanWatcherService` will import them within a few seconds.

To check if plans are imported:
\```bash
sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db \
  "SELECT plan_id, topic FROM plans WHERE plan_file LIKE '%{plan-filename}%'"
\```

If the query returns no rows, wait 3-5 seconds for the watcher and re-check.
Do NOT proceed until all plan IDs are confirmed in the DB.

### 3. Collect plan IDs

If the user gave plan filenames, resolve them to plan_ids via the SQL query
above. If the user gave plan_ids directly, use those.

## Execution

### Step 1: Create the feature

\```bash
node .agents/skills/kanban_operations/create-feature.js \
  "<feature name>" \
  '["planId1","planId2","planId3"]' \
  "<workspace root absolute path>" \
  "<goal description — 2-4 sentences>"
\```

The description becomes the `## Goal` section in the feature file.

**Shell escaping:** Escape double quotes in the description (replace `"` with
`\"`). Avoid `$`, backticks, and backslashes — these are shell metacharacters
inside double quotes. Rephrase if needed.

Expected output:
\```json
{"ok":true,"featurePlanId":"<uuid>","featureSessionId":"<uuid>"}
\```

If `ok: false`, read the `error` field. Common failures:
- Extension not reachable → fall back to `create-feature` skill
- Plan IDs not found → plans not yet imported; wait and retry

### Step 2: Verify

\```bash
sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db \
  "SELECT plan_id, is_feature, topic FROM plans WHERE plan_id='<featurePlanId>'"
\```

Confirm `is_feature=1`. Then verify subtasks are linked:

\```bash
sqlite3 {{WORKSPACE_ROOT}}/.switchboard/kanban.db \
  "SELECT plan_id, topic, feature_id FROM plans WHERE feature_id='<featurePlanId>'"
\```

All subtask plan IDs should appear with the feature's plan_id in `feature_id`.

### Step 3: Write narrative sections

The feature file is at `.switchboard/features/{slug}-{featurePlanId}.md`.
`create-feature.js` only writes the `## Goal` section. Write the remaining
narrative sections manually:

1. **`## How the Subtasks Achieve This`** — one bullet per subtask plan:
   `- **{Plan Name}**: {what it does and how it contributes to the goal}`

2. **`## Dependencies & sequencing`** — note ordering constraints between
   subtasks. If none, write "No hard ordering constraints; subtasks can be
   executed in parallel."

Insert `## How the Subtasks Achieve This` between the `## Goal` section and
the `<!-- BEGIN SUBTASKS -->` marker. Insert `## Dependencies & sequencing`
immediately after the `<!-- END SUBTASKS -->` marker.

These sections are preserved by `_regenerateFeatureFile` on subsequent
subtask changes, so they only need to be written once.

## Notes

- Feature creation does NOT sync to Linear/ClickUp.
- To add more plans to an existing feature later, use
  `node .agents/skills/kanban_operations/assign-to-feature.js "{featurePlanId}" '["newPlanId"]' "{workspaceRoot}"`
- The `<!-- BEGIN SUBTASKS -->` block is auto-managed by the extension —
  do not edit it manually.
```

> **Clarification 1 — SKILL.md Step 1 failure-mode is INACCURATE (verified against source).**
> `KanbanProvider.createFeatureFromPlanIds` (`src/services/KanbanProvider.ts:10296-10308`) deliberately removed the "No valid subtasks" guard: stale/absent plan IDs produce `{ success: true }` with **zero subtasks linked** (only a `console.warn` the agent never sees). `create-feature.js` therefore prints `{ok: true, featurePlanId, featureSessionId}` even when no subtasks resolved. The bullet `Plan IDs not found → plans not yet imported; wait and retry` is WRONG — that condition is NOT reported as `ok: false`.
>
> **Replace** the last two failure bullets with:
> ```
> - Extension not reachable → fall back to `create-feature` skill (the script itself returns ok:false with a clear message; the AGENT then switches skills).
> - Zero subtasks linked (silent blank feature) → `create-feature.js` returns `ok: true` even when none of the supplied plan IDs resolve to DB rows (the extension deliberately allows blank features). This is NOT an error. The Prerequisites §2 pre-flight SQL check is the ONLY gate that prevents this. If you skipped it, Step 2 verification will show zero subtasks — recover by deleting the blank feature: `node .agents/skills/kanban_operations/delete-feature.js "<featurePlanId>" "<workspaceRoot>"`, then re-run the pre-flight and retry.
> ```

> **Clarification 2 — SKILL.md Shell-escaping note is too restrictive (verified against source).**
> `createFeatureFromPlanIds` line 10417 normalizes only `\r\n` and trims; embedded `\n` newlines are preserved and render as multi-line `## Goal` content. **Update** the escaping note to: *"Escape double quotes (`"` → `\"`). Avoid `$`, backticks, and backslashes — shell metacharacters inside double quotes. Newlines ARE safe and preserved as multi-line Goal content — do not flatten them."*

### 2. Wire into the planner persona — `.claude/skills/switchboard-chat/SKILL.md`

Update the "Feature Grouping" section (lines 78-84) to tell the agent to invoke the new skill when the user confirms. Replace the current closing line:

**Current (line 85):**
```
Only create the feature if the user confirms. Refer to existing files in `.switchboard/features/` for the expected format.
```

**New:**
```
Only create the feature if the user confirms. When the user says yes, invoke the `create-feature-from-plans` skill — it handles the mechanics (plan ID resolution, `create-feature.js` execution, verification, and narrative section writing). Do NOT write feature files by hand or reverse-engineer the creation script. If the extension is not running, the skill will fall back to the `create-feature` remote path automatically.
```

> **Clarification 3 — line number correction.** The closing line is at **line 85**, not 84 (the "Feature Grouping" section header is line 78; the closing line follows the two bullets at lines 82-83). Verified against the current `.claude/skills/switchboard-chat/SKILL.md`.

### 3. Wire into the improve-plan workflow — `.agents/workflows/improve-plan.md` and `.claude/skills/improve-plan/SKILL.md`

Both files have identical "Trigger B" sections. Update the Trigger B description to reference the new skill. After the existing Trigger B text (line 103 in both files), add:

```
**Creating the feature:** When Trigger B applies (you restructured plans into a feature), invoke the `create-feature-from-plans` skill to create the feature via `create-feature.js`. This is the preferred path when the extension is running — it handles DB upsert, subtask linking, and feature-file write atomically. The manifest path (below) is the remote-session fallback for when the extension is not running.
```

This makes `create-feature-from-plans` the primary path and the manifest the fallback, rather than the manifest being the only documented option.

> **Clarification 4 — line number correction + NO-IMPLEMENTATION constraint conflict (verified against source).**
> (a) The Trigger B bullet is at **line 104** in both files, NOT line 103 (line 103 is the Trigger A bullet). Insert the addition **after line 104** (the Trigger B bullet), before line 105 ("Pure plan creation...").
>
> (b) The proposed addition above instructs the improve-plan agent to invoke `create-feature.js` **during review**. This **CONFLICTS** with improve-plan's Critical Constraint: *"NO IMPLEMENTATION... Your ONLY permissible write action is updating the existing Feature Plan document."* Running `create-feature.js` mints DB records, writes a feature file, links subtasks, may provision worktrees, and refreshes the board — a side-effecting creation beyond the allowed write. The manifest path exists precisely because it is metadata-only (a JSON declaration for the watcher) and constraint-compliant.
>
> **Replace** the proposed addition with this constraint-safe version:
> ```
> **Creating the feature:** When Trigger B applies (you restructured plans into a feature), the recommended creation path is the `create-feature-from-plans` skill (runs `create-feature.js`: DB upsert, subtask linking, feature-file write, board refresh — atomic). Run it AFTER the review is complete and the user has approved moving forward; do NOT invoke it mid-review, as this workflow's NO-IMPLEMENTATION constraint forbids side-effecting writes. The manifest path (below) remains this workflow's in-band mechanism for declaring feature relationships to the watcher.
> ```

### 4. Cross-reference from existing skills

**`.agents/skills/group-into-features/SKILL.md`** — Add to the "When to Use" section:
```
If the user already knows which plans to group (no discovery needed), use `create-feature-from-plans` instead — it skips the scan/propose/confirm flow and goes straight to creation.
```

**`.claude/skills/create-feature/SKILL.md`** — Add to the "When to Use" section:
```
If the extension IS running and the user already knows which plans to group, use `create-feature-from-plans` instead — it routes through `create-feature.js` (the authoritative path) and handles verification + narrative writing.
```

### 5. Register in available skills

The skill is auto-discovered from `.claude/skills/` by the skill listing mechanism. No explicit registration needed — placing the `SKILL.md` file in the right directory is sufficient.

> **Clarification 5 — "auto-discovered" is only half-true (verified against source).**
> The HOST (Devin CLI / Claude Code) auto-discovers skills from `.claude/skills/` and injects an `available_skills` list into the agent's system prompt — so `skill: "create-feature-from-plans"` will be invokable with no registration. ✓
>
> HOWEVER, the Switchboard protocol's **"Available Skills" table** in `AGENTS.md` / `CLAUDE.md` is NOT auto-generated. `src/extension.ts:3076` (`ensureProtocolFile`) sources the managed protocol block from a **bundled `AGENTS.md` shipped with the extension** — a static file. Every existing skill (`create-feature`, `group-into-features`, `improve-feature`, ...) has a hand-authored row in that table. Without a `create-feature-from-plans` row, an agent following the protocol document (rather than the host-injected list) will not see the skill listed. The switchboard-chat / improve-plan wiring compensates only along the wired paths.
>
> **Action:** Add a `create-feature-from-plans` row to the repo-root `AGENTS.md` "Available Skills" table (see Files to Create/Modify). `CLAUDE.md` auto-mirrors the table on the next Switchboard setup run via `ClaudeCodeMirrorService` — do NOT edit `CLAUDE.md` directly.

## Files to Create/Modify

| File | Action | Change |
|------|--------|--------|
| `.claude/skills/create-feature-from-plans/SKILL.md` | **Create** | New skill file with direct creation mechanics (apply Clarifications 1 & 2 to the Step 1 failure-mode and shell-escaping text when authoring) |
| `.claude/skills/switchboard-chat/SKILL.md` | **Edit** | Update "Feature Grouping" section closing line (**line 85**, not 84) to invoke new skill |
| `.agents/workflows/improve-plan.md` | **Edit** | Add creation guidance after Trigger B bullet (**line 104**, not 103); use the constraint-safe version from Clarification 4 — do NOT instruct mid-review `create-feature.js` invocation |
| `.claude/skills/improve-plan/SKILL.md` | **Edit** | Same Trigger B addition as the workflow file (line 104, constraint-safe version) |
| `.agents/skills/group-into-features/SKILL.md` | **Edit** | Add cross-reference in "When to Use" |
| `.claude/skills/create-feature/SKILL.md` | **Edit** | Add cross-reference in "When to Use" |
| `AGENTS.md` (repo root) | **Edit** | Add `create-feature-from-plans` row to the "Available Skills" table (bundled static source; `CLAUDE.md` auto-mirrors) — see Clarification 5 |

## Proposed Changes

### `.claude/skills/create-feature-from-plans/SKILL.md` (NEW)
- **Context:** No skill wraps the direct "I know the plans, just make the feature" path; `create-feature` is remote-only, `group-into-features` is discovery-only.
- **Logic:** Document the direct path — pre-flight DB check (load-bearing), `create-feature.js` invocation, verification, narrative-section writing, fallback to `create-feature` when extension absent.
- **Implementation:** Use the full SKILL.md content in `## Implementation` step 1, with the two corrections from Clarifications 1 (failure-mode: silent blank feature + `delete-feature.js` recovery) and 2 (newlines safe in description).
- **Edge Cases:** Stale plan IDs → silent blank feature (pre-flight is the only gate); extension unreachable → agent switches to `create-feature` skill; narrative sections must sit outside the `<!-- BEGIN/END SUBTASKS -->` span to survive `_regenerateFeatureFile` (verified).

### `.claude/skills/switchboard-chat/SKILL.md` (EDIT)
- **Context:** Planner persona's "Feature Grouping" section tells the agent to suggest features but not how to create them.
- **Logic:** Replace the closing line (line 85) with an instruction to invoke `create-feature-from-plans` on user confirmation.
- **Implementation:** One-line prose replacement at line 85 (see `## Implementation` step 2).
- **Edge Cases:** None — pure prose edit; preserves the "only create if user confirms" gate.

### `.agents/workflows/improve-plan.md` + `.claude/skills/improve-plan/SKILL.md` (EDIT)
- **Context:** Trigger B documents the manifest but not the creation mechanism.
- **Logic:** Add a reference to `create-feature-from-plans` as the recommended **post-review** creation path; keep the manifest as the in-workflow mechanism (constraint-compliant).
- **Implementation:** Insert the constraint-safe addition after line 104 (Trigger B bullet) in both files (see Clarification 4).
- **Edge Cases:** The original proposal violated the NO-IMPLEMENTATION constraint; the reframed version defers creation to post-review. Local vs remote: `create-feature-from-plans` for local, manifest remains the remote fallback.

### `.agents/skills/group-into-features/SKILL.md` + `.claude/skills/create-feature/SKILL.md` (EDIT)
- **Context:** The two existing skills cover adjacent scopes (discovery; remote) but don't point to the direct path.
- **Logic:** Add a one-line cross-reference in each "When to Use" section.
- **Implementation:** Prose insertions (see `## Implementation` step 4).
- **Edge Cases:** None — additive cross-references.

### `AGENTS.md` (repo root) (EDIT)
- **Context:** The protocol's "Available Skills" table is a bundled static file, not auto-scanned (Clarification 5).
- **Logic:** Add a `create-feature-from-plans` row so protocol-following agents see the skill documented alongside every other skill.
- **Implementation:** Insert one table row in the "Available Skills" table with a one-line "When to Use" description. `CLAUDE.md` auto-mirrors via `ClaudeCodeMirrorService` — do not edit it directly.
- **Edge Cases:** The repo-root `AGENTS.md` is the bundled source (`extension.ts:3076`); editing it propagates to all workspaces on next setup. No migration needed (additive row).

## Verification Plan

### Automated Tests
Skipped per session directive (SKIP TESTS). No automated test or compilation step is part of this plan — all changes are markdown / skill-file authoring with no source code.

### Manual Verification
- New skill appears in the host's auto-discovered `available_skills` list after `.claude/skills/create-feature-from-plans/SKILL.md` is created.
- New skill appears as a row in the `AGENTS.md` "Available Skills" table after the manual edit (and in `CLAUDE.md` after the next Switchboard setup run).
- Invoking the skill with a known set of plan IDs (all pre-confirmed in the DB) creates the feature correctly and Step 2 verification shows all subtasks linked.
- Skill correctly detects when plans aren't yet in the DB and waits for the watcher (the load-bearing pre-flight gate).
- Skill falls back to `create-feature` when the extension is not running (`.switchboard/api-server-port.txt` absent).
- Narrative sections are written into the feature file in the correct position (between Goal and `<!-- BEGIN SUBTASKS -->`; after `<!-- END SUBTASKS -->`) and survive a subsequent board refresh.
- Planner persona (`switchboard-chat`) references `create-feature-from-plans` at line 85 of the Feature Grouping section.
- Improve-plan workflow (both `.agents/workflows/` and `.claude/skills/` copies) references `create-feature-from-plans` as the post-review path at line 104, and does NOT instruct mid-review `create-feature.js` invocation.
- `group-into-features` skill cross-references the new skill.
- `create-feature` skill cross-references the new skill.
- End-to-end: planner suggests a feature → user confirms → agent invokes `create-feature-from-plans` → feature created and verified.

## Test Plan

- [ ] New skill appears in `available_skills` list after creation
- [ ] New skill appears in `AGENTS.md` "Available Skills" table (and `CLAUDE.md` after next setup)
- [ ] Invoking the skill with a known set of plan IDs creates the feature correctly
- [ ] Skill correctly detects when plans aren't yet in the DB and waits for the watcher
- [ ] Skill falls back to `create-feature` when extension is not running
- [ ] Narrative sections are written into the feature file in the correct position
- [ ] Planner persona (`switchboard-chat`) now references `create-feature-from-plans` in the Feature Grouping section (line 85)
- [ ] Improve-plan workflow (both `.agents/workflows/` and `.claude/skills/` copies) references `create-feature-from-plans` in Trigger B (line 104, post-review framing — no mid-review invocation)
- [ ] `group-into-features` skill cross-references the new skill
- [ ] `create-feature` skill cross-references the new skill
- [ ] End-to-end: planner suggests a feature → user confirms → agent invokes `create-feature-from-plans` → feature created and verified
- [ ] Failure path: passing a stale plan ID produces a silent blank feature; Step 2 verification catches it; `delete-feature.js` cleans it up (Clarification 1)

---

**Recommendation:** Complexity 5 (Mixed) → **Send to Coder.** Routine multi-file docs work elevated by one moderate, well-scoped risk (the silent-blank-feature footgun the skill must document correctly). Apply Clarifications 1–5 when authoring — they correct factual errors in the original spec without narrowing product scope.
