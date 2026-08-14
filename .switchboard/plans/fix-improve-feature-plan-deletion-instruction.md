# `improve-feature` Tells Agents Plan Deletion Hard-Deletes the Card. It Soft-Deletes, and the Card Stays.

## Goal

Correct the false deletion mechanism documented in `.agents/skills/improve-feature/SKILL.md:19`, and replace it with the mechanism that actually removes a card plus the ordering rule that stops an agent stranding one.

### Problem & background

The skill's restructuring guardrail instructs an agent removing a subtask to:

> *Remote (no extension):* `git rm` the removed subtask `.md` files **(the plan watcher hard-deletes their rows on the next local pull)**

Both halves of the parenthetical are wrong, and the error is load-bearing because it is the *only* thing the skill says about how a removed subtask leaves the board.

**It is a soft delete, not a hard delete.** `PlanIngestionEngine._handlePlanDelete` calls `db.markPlanMissingByPlanFile(plan.planFile, plan.workspaceId)` and logs `Soft-deleted (marked missing) plan: <file>`. The row survives. `deletePlanByPlanId` — the only hard delete — is never called from the engine or either watcher; its callers are the Planning panel, a runsheet-cleanup path in `TaskViewerProvider`, and `DELETE /kanban/plans`.

**It does not wait for a pull.** The delete is event-driven and immediate: both hosts' watchers emit `'delete'` (`GlobalPlanWatcherService.ts:144`, `:189`; `planIngestionHost.ts:82`, `:223`), the engine debounces 300 ms (`_debounceHandleDelete`, `:720`) and handles it. No git operation is involved anywhere in the path.

**The consequence is a stranded card.** An agent that follows the instruction deletes the `.md`, sees the row persist, and has destroyed the plan text with no way to finish the job — the card remains on the board pointing at a file that no longer exists. The plan document is unrecoverable if it was untracked, which a newly-authored subtask usually is. This happened in a real `improve-feature` run on 2026-08-14: the file was removed on the strength of this line, the row stayed, and the operator was left to clear it by hand.

**Observed 2026-08-14, and worse than "soft-deleted": the soft-delete did not fire at all.** Three stranded cards were cleared by hand that day — `d548ee36` (*Nested Agent Teams*, file `rm`'d, never committed), `352684b3` (*Clear the Activity Light on Sustained Terminal Quiescence*) and `1eedb80d` (*Completion Toasts Fire in Every Pop-Out Window*), the latter two `git rm`'d up to three days earlier as part of the `1ce76fcb` restructure. Measured against `kanban.db` before deletion: this workspace's `plans.status` vocabulary is `active` / `completed` / `deleted` only, 40 rows carry `deleted` (4 of them in PLAN REVIEWED, so the soft-delete path does work in general) — and all three of these rows were still **`active`**, with `plan_events` holding nothing but a `workflow_event`/`start` per row. No delete event was ever recorded, for files that had been gone for days.

So the failure mode the skill produces is not a row tagged missing; it is a row indistinguishable from live work, rendering as a normal card in Planned. That is strictly worse than what the corrected instruction (below) will describe, and it means the *remote* half of the guardrail is wrong in a second, independent way: `git rm` did not eventually soft-delete these rows on a later local session, across days of local sessions. **Inferred, not measured:** a staged-and-uncommitted `git rm` may not surface as a watcher `'delete'` event the way a plain `rm` does. The coder should establish which of the two paths actually emits before writing the remote sentence — the honest claim may be "no DB change, ever, until someone calls the route."

**The correct mechanism already exists and does both halves in one call.** `DELETE /kanban/plans?planId=<id>&deleteFile=true` (`LocalApiServer.ts:3051-3090`) hard-deletes the row via `deletePlanByPlanId` and unlinks the plan file, path-confined to `.switchboard/plans/`. The route's own comment states the constraint the skill should have carried: *"deletePlanByPlanId removes the DB row only; the .md file re-imports on the next import_plans unless the caller opts into unlinking it too."*

**There is also an ordering rule worth stating explicitly.** Row removal is gated — it needs the API, and in a permission-restricted session that call may be refused. File removal is not gated and is irreversible. An agent that deletes the file first can be left unable to complete the operation. The destructive, ungated step must come last, or better, be performed by the same call.

---

## Metadata

**Tags:** docs, reliability
**Complexity:** 2

---

## User Review Required

**None.** Three decisions made here:

* **The instruction is corrected, not annotated.** No "note: this may soft-delete" hedge — the line states the mechanism that works.
* **`?deleteFile=true` is the documented local path**, because one call in the right order beats two steps an agent can half-complete.
* **The remote (no-extension) case keeps `git rm`** but stops claiming the row disappears. It states what actually happens — the row is marked missing on the next local session — so the agent's expectations match reality.

---

## Complexity Audit

* **Score:** 2 / 10

### Routine

* Rewriting one bullet and one step in a skill file.
* Regenerating the `.claude/` mirror.

### Complex / Risky

* **Getting the remote-session claim right.** `git rm` in a session with no extension running produces *no* immediate DB effect at all; the soft-delete fires whenever a local watcher next sees the file gone. Overstating this in the other direction would be the same class of error.

---

## Edge-Case & Dependency Audit

### Race Conditions

* Not applicable — a documentation change.
* Worth documenting, though: `_handlePlanDelete` skips the soft-delete when the file still exists after the debounce (atomic write/rename guard, `:3-11` of the handler) and when the path is in `_recentRenames`. An agent that deletes and immediately recreates a plan file at the same path gets no delete effect at all.

### Security

* None. The `?deleteFile=true` unlink is already path-confined to `.switchboard/plans/` and that confinement is not being changed.

### Side Effects

* Agents following the corrected instruction will call a hard-delete route where previously they called nothing. That is the intent, and it is the same route the Planning panel's delete button uses.

### Dependencies & Conflicts

* **`.agents/skills/improve-feature/SKILL.md`** — `:19` (the Guardrails bullet, the false claim) and `:67` (High/Low mode step 4, which says `git rm the original subtask files` and inherits the same wrong expectation without restating it).
* **`.claude/skills/improve-feature/SKILL.md`** — generated mirror. Edit `.agents/`, never the mirror; regenerate and verify with `npm run mirror:check`.
* **`src/services/PlanIngestionEngine.ts`** — `_handlePlanDelete`, `_debounceHandleDelete` (`:720`), `_setupWatcherForFolder` (`:543-552`). Read-only reference; **no source change in this plan.**
* **`src/services/LocalApiServer.ts:3051-3090`** — the `DELETE /kanban/plans` route and its `deleteFile` param. Read-only reference.
* **`.agents/skills/kanban_operations/`** — has no plan-delete script (only `move-card.js`, `delete-feature.js`, `remove-from-feature.js`). If the corrected instruction should be runnable without curl, adding `delete-plan.js` is the obvious follow-up — **noted, not in scope here.**
* **`rearrange-feature` and `group-into-features`** — sibling skills that restructure subtask sets. Grep both for the same claim; the audit at time of writing found the wording only in `improve-feature`, but a paraphrase would not have matched.

---

## Dependencies

* None. One file edit plus a mirror regeneration.

---

## Adversarial Synthesis

Key risks: (1) **fixing the sentence and leaving the ordering trap** — an agent told the right route can still delete the file first and strand itself if the route is refused, so the ordering rule has to be stated, not implied; (2) **over-correcting the remote case**, where `git rm` genuinely is the only available action and the honest statement is "the row is marked missing when a local session next sees it", not "this removes the card"; (3) **editing the generated mirror instead of `.agents/`**, which reverts on the next generation; (4) **the same claim surviving as a paraphrase** in a sibling restructuring skill that a literal grep misses. Mitigations: state the ordering rule in the same bullet as the route; describe the remote case in terms of what the operator will observe; edit `.agents/` and gate on `npm run mirror:check`; read `rearrange-feature` and `group-into-features` for the claim rather than only grepping for its exact words.

---

## Proposed Changes

### `.agents/skills/improve-feature/SKILL.md`

**Context:** `:19` is the Guardrails sub-bullet covering set changes; `:67` is High/Low mode step 4.

**Implementation — `:19`, local case:** state the one-call mechanism and the ordering rule.

* Removing a subtask locally (extension running) is `DELETE /kanban/plans?planId=<id>&deleteFile=true&workspaceRoot=<abs workspace path>` — it hard-deletes the row and unlinks the plan file in one call.
* **`workspaceRoot` is not optional in practice.** Every root in a multi-root window writes the *same* port into its own `.switchboard/api-server-port.txt`, and the route falls back to `this._options.workspaceRoot` (`LocalApiServer.ts:3064`) — one arbitrary root. Omit the param and a planId that lives in a sibling root returns `404 Plan not found`, which reads exactly like "the row is already gone". On 2026-08-14 that 404 is what convinced an agent the stranded row did not exist; the same omission makes `GET /kanban/plans` return only the default root's cards. `deleteFile` also silently no-ops without it, since the unlink is resolved against `root`.
* **Never delete the plan file first.** The row removal is the gated step; the file removal is irreversible. Deleting the file on its own leaves a card pointing at nothing, and an untracked plan document is gone for good.

**Implementation — `:19`, remote case:** keep `git rm`, drop the false claim, describe the real effect.

* `git rm` the removed subtask `.md` files. No DB change happens in a remote session. When a local session next observes the file missing, the watcher **soft-deletes** the row — marks it missing (`markPlanMissingByPlanFile`) — which is not the same as removing the card. Clearing it fully requires the local route above.

> **Verify this sentence before shipping it.** The 2026-08-14 evidence (see Problem & background) is that two `git rm`'d subtasks kept `status='active'` with no `plan_events` entry across three days of local sessions — i.e. the soft-delete never fired. If manual verification step 3 reproduces that, this bullet must say the row is **untouched** until someone calls the route, not "marked missing". Writing the optimistic version would repeat the original defect in a milder form.

**Implementation — `:67`:** point High/Low mode's `git rm` step at the corrected bullet rather than restating the mechanism, so there is one description to keep true.

**Edge cases:** do not add a "may vary" hedge — the mechanism is deterministic and now documented. Do not edit `.claude/skills/improve-feature/SKILL.md` directly; regenerate it.

---

## Verification Plan

Tests are skipped per session directive, and compilation is skipped per session directive.

### Automated Tests

* Grepping `.agents/` for `hard-delete`, `hard delete` and `next local pull` returns nothing.
* `npm run mirror:check` passes, and `.claude/skills/improve-feature/SKILL.md` carries the corrected text.

### Manual Verification

1. **The documented call works:** create a throwaway plan file, let it import, then run `DELETE /kanban/plans?planId=<id>&deleteFile=true&workspaceRoot=<abs path>`. Confirm the card is gone from the board *and* the file is gone from disk. Read the row back from `kanban.db` **twice, seconds apart** — the route returns on the in-memory mutation and the write-back to disk is throttled, so an immediate read can still show the row. That stale read cost real confusion on 2026-08-14.
2. **The same call without `workspaceRoot`, from a multi-root window:** confirm it returns `404 Plan not found` for a row that demonstrably exists in a sibling root's `kanban.db`. This is the failure the corrected bullet exists to prevent, so it should be reproduced once rather than trusted.
3. **Which removal actually emits a delete:** create two throwaway plans; `rm` one and `git rm` the other. For each, check the log for `Soft-deleted (marked missing) plan:`, then read `plans.status` and `plan_events`. Write the remote sentence from whichever result you get — the 2026-08-14 evidence is that `git rm`'d files left rows `active` with no event for days, which contradicts the "marked missing on the next local session" wording proposed above.
4. **Read the corrected bullet** as an agent would and confirm it cannot be followed in an order that strands a card.

---

## Recommendation

Complexity 2 → **Send to Intern.**

**The thing to get right:** the ordering rule is the substance, not the route name. An agent that knows the correct endpoint can still destroy the plan file first, discover the row removal is refused, and leave the board holding a broken card with the plan text unrecoverable. The instruction must make the gated step first and the irreversible step last — or, better, a single call that cannot be half-completed.

**Migration:** none. Documentation only; no source change, no state change.
