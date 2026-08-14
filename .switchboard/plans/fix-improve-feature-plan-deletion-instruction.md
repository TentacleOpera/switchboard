# `improve-feature` Tells Agents Plan Deletion Hard-Deletes the Card. It Soft-Deletes, and the Card Stays.

## Goal

Correct the false deletion mechanism documented in `.agents/skills/improve-feature/SKILL.md:19` and replace it with the one the code actually implements.

### Problem & background

The skill's restructuring guardrail instructs an agent removing a subtask to:

> *Remote (no extension):* `git rm` the removed subtask `.md` files **(the plan watcher hard-deletes their rows on the next local pull)**

Both halves of the parenthetical are false, and it is the only thing the skill says about how a removed subtask leaves the board. An agent that believes it deletes the `.md`, the row stays, and the card remains on the board pointing at a file that no longer exists — with the plan text gone if it was untracked. That happened on 2026-08-14: three stranded cards (`d548ee36`, `352684b3`, `1eedb80d`) cleared by hand, all still `status='active'`, two of them `git rm`'d days earlier.

### What the code does

1. **Unlink** → the folder watcher emits `'delete'` (`PlanIngestionEngine._setupWatcherForFolder`, `:543-552`).
2. **300 ms debounce** (`_debounceHandleDelete`, `:720`).
3. **`_handlePlanDelete`** (`:1074`) → `markPlanMissingByPlanFile` → `status='missing'`.
4. **The card leaves the board at that instant.** `getPlansByColumn` (`KanbanDatabase.ts:4119`) renders `status='active'` only.
5. **`runPurgeSweep()`** (`:612`), on startup and every scan tick, hard-deletes `'missing'` rows older than 24 h via `deletePlanByPlanFile` (`:670`).

So with the extension running, `git rm` / `rm` **is** a complete card removal. No git operation is involved in the path, and no pull is waited on.

> **Superseded:** "`deletePlanByPlanId` — the only hard delete — is never called from the engine or either watcher", and the implication that a soft-deleted row survives indefinitely.
> **Reason:** the engine hard-deletes via `deletePlanByPlanFile` in `runPurgeSweep` 24 h after the soft delete. Soft-delete is stage one of two, not a terminal state.
> **Replaced with:** the five-step chain above.

> **Superseded:** "this workspace's `plans.status` vocabulary is `active` / `completed` / `deleted` only, 40 rows carry `deleted` (4 of them in PLAN REVIEWED, so the soft-delete path does work in general)".
> **Reason:** the vocabulary is five values (`KanbanDatabase.ts:53`), and the soft delete writes `'missing'`, not `'deleted'`. The 40 `'deleted'` rows come from `purgeOrphanedPlans` (`:5871`), a different mechanism. They are not evidence about the watcher path. The real signal was zero `'missing'` rows — the watcher path had never fired for anything.
> **Replaced with:** nothing; the inference is withdrawn.

> **Superseded:** "**Inferred, not measured:** a staged-and-uncommitted `git rm` may not surface as a watcher `'delete'` event the way a plain `rm` does."
> **Reason:** both unlink the working-tree file, and both hosts register deletes unconditionally — a VS Code `onDidDelete` on `.switchboard/{plans,features}/**/*.md` plus a native recursive `fs.watch` fallback (`GlobalPlanWatcherService.ts:131-181`). Nothing discriminates on how the unlink happened. `d548ee36` was a plain `rm` and stranded anyway.
> **Replaced with:** the discriminator is whether a watcher was alive at unlink time.

### Why the remote case never resolves

`PlanIngestionEngine`'s only delete path is the live watcher event; its scans import what exists and never enumerate rows to check for absent files. The one disk-vs-DB reconciler, `KanbanDatabase.purgeOrphanedPlans` (`:5871`), has a single non-test caller — `TaskViewerProvider._syncKanbanDbFromSheetsSnapshot` (`:4540`) — reachable only from a startup path gated on an **empty** database (`:4600-4618`: *"DB-first: DB already has data. Just run cleanup, do NOT re-sync from files."*).

On an established workspace that sweep never runs. A plan file removed while nothing is watching leaves its row `active` forever — no later session catches it. That is the stranded card.

---

## Metadata

**Tags:** docs, reliability
**Complexity:** 2

---

## User Review Required

**None.**

---

## Complexity Audit

* **Score:** 2 / 10

### Routine

* Rewriting one bullet in a skill file and applying the same edit to its mirror.

### Complex / Risky

* **The remote sentence has now been drafted wrong twice** — first "hard-deletes on the next local pull", then "marked missing on the next local session". Both optimistic, both false. The replacement below is written to be transcribed, not re-derived.

---

## Edge-Case & Dependency Audit

### Race Conditions

* Not applicable — a documentation change.

### Security

* None.

### Side Effects

* None. The corrected text describes existing behaviour; no code path changes.

### Dependencies & Conflicts

* **`.agents/skills/improve-feature/SKILL.md`** — `:19` (the false claim) and `:67` (High/Low mode step 4, which repeats `git rm the original subtask files`). Line numbers verified at time of writing.
* **`.claude/skills/improve-feature/SKILL.md`** — generated mirror; same bullet at `:25`. The mirror is the `.agents` body prefixed with six lines of YAML frontmatter and nothing else. There is **no npm regeneration script** (`generateClaudeMirror` runs only from the extension's scaffold path), so edit both files in lockstep.
* **`rearrange-feature`, `group-into-features`** — checked; neither mentions `git rm` or any deletion mechanism. Nothing to fix there.
* Read-only references: `PlanIngestionEngine.ts` (`:543`, `:612`, `:720`, `:1074`), `KanbanDatabase.ts` (`:3219`, `:3227`, `:4119`, `:5871`), `LocalApiServer.ts:3050-3095`, `TaskViewerProvider.ts:4540`/`:4600-4618`. **No source change in this plan.**

---

## Dependencies

* None. Two file edits, no source change, no state change.

---

## Adversarial Synthesis

Key risk: writing a third wrong sentence about the remote case, which is why the replacement text is specified verbatim below. Secondary risk: mirror drift, since there is no npm regeneration path and the two files must stay byte-identical below the frontmatter. Mitigations: transcribe the specified wording; edit both files together and diff them.

---

## Proposed Changes

### `.agents/skills/improve-feature/SKILL.md`

**Context:** `:19` is the `*Remote (no extension):*` child bullet under `- **Route set changes through the real mechanisms**, not the block:`. `:67` is High/Low mode step 4.

**`:19` — replace the false parenthetical.** The bullet currently opens:

> *Remote (no extension):* `git rm` the removed subtask `.md` files (the plan watcher hard-deletes their rows on the next local pull), create any new consolidated plan file…

Replace the parenthetical with the true mechanism, split by session type. Transcribe:

* *Local (extension running):* `git rm` the removed subtask `.md` files — the watcher clears the card from the board within a second and the row is purged within a day. `DELETE /kanban/plans?planId=<id>&deleteFile=true&workspaceRoot=<abs workspace path>` does both in one call if you want it immediate; `workspaceRoot` is required in a multi-root window or the route resolves against an arbitrary root and returns `404 Plan not found`.
* *Remote (no extension):* `git rm` the removed subtask `.md` files — **this removes the file and nothing else, now or ever.** The row stays `active` and the card stays on the board until it is deleted from a local session.

**`:67` — do not restate the mechanism.** High/Low mode step 4 opens ``4. `git rm` the original subtask files (their intent now lives in the two tier files)…``. Point it at the Guardrails bullet instead, so there is one description to keep true.

### `.claude/skills/improve-feature/SKILL.md`

Apply the identical body edits at `:25` and in High/Low step 4. Leave the six-line YAML frontmatter untouched.

---

## Verification Plan

Automated tests and compilation are skipped per session directive. `npm run mirror:check` requires `npm run compile-tests` (it loads `out/services/ClaudeCodeMirrorService.js`), so the byte diff below stands in for it.

### Automated Tests

* Not run (session directive).

### Static checks

1. `grep -rn "hard-delete\|hard delete\|next local pull" .agents/ .claude/` returns nothing.
2. `diff <(tail -n +7 .claude/skills/improve-feature/SKILL.md) .agents/skills/improve-feature/SKILL.md` is empty — this is exactly what `mirror:check` asserts for this file, without compiling.

---

## Recommendation

Complexity 2 → **Send to Intern.** The replacement wording is specified verbatim; transcribe it rather than re-deriving it.

**Follow-up, not in scope:** `purgeOrphanedPlans` is unreachable on a populated database, so nothing reconciles disk against the DB. That is the durable fix for stranded cards and deserves its own plan.

**Migration:** none. Documentation only.
