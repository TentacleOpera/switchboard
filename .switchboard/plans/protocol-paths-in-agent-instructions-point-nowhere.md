# The Protocol Path in Our Own Agent Instructions Points Nowhere, and Nothing Stops the Fallout

<!-- board-collapse-02 -->
> **RESCOPED 2026-09-04 (Board Collapse 02).** The analysis paragraph describing `mirror:check` as regenerating from `MIRROR_MANIFEST` and passing green over extra `.agents/skills/` directories is being overtaken: the generator, the manifest and that gate are all deleted by *Delete the Claude mirror generator*. Rewrite that paragraph against a committed `.claude/skills/` tree. The plan's own contribution is unaffected and still wanted: correcting the seven dead `.switchboard/protocols/` references, and adding the whitelist gate over `.agents/skills/` contents — which becomes **more** valuable, since it is the only structural check left once `mirror:check` is gone.


## Goal

> **Superseded:** "Correct the 7 references in this repo's agent instructions that send agents to `.switchboard/protocols/`"
> **Reason:** CLAUDE.md has been rewritten since this plan was written and now contains **zero** `.switchboard/protocols/` references (verified 2026-09-11: `grep -rn "\.switchboard/protocols" CLAUDE.md` returns no matches). All six CLAUDE.md corrections the plan specified are already done. Only **one** reference remains — `.agents/plan-authoring-protocol.md:29`.
> **Replaced with:** Correct the 1 remaining reference in `.agents/plan-authoring-protocol.md`, and add a gate on the contents of `.agents/skills/` so a protocol written to the wrong place fails CI instead of shipping. Leave the 12 `.switchboard/protocols/` occurrences in `src/` alone: those are migration keys, and rewriting them breaks the migration.

### Problem & background

On 2026-08-24 an agent wrote a new `improve-feature` protocol to `.agents/skills/improve-feature/SKILL.md` — a path vacated four days earlier — while a second agent edited the canonical `.agents/protocols/improve-feature/SKILL.md` 96 minutes before it. Neither saw the other. The result is two diverged copies of a dispatched protocol, each holding one edit the other lacks.

That was not a resurrection of a deleted file, and it was not the seeding path. It was an agent following this repository's own instructions to a directory that is not there.

**The path history, from `git log --follow` on a full (non-shallow) clone:**

| When (UTC) | Commit | Event |
|---|---|---|
| 2026-07-05 | `308da5b8` | created as `.agents/workflows/improve-feature.md` |
| 2026-07-12 | `fa87c25d` | renamed → `.agents/skills/improve-feature/SKILL.md` |
| 2026-08-20 12:21 | `1a165cc2` | renamed out → `.switchboard/protocols/…` (R100) |
| 2026-08-21 00:23 | `33d4f3d2` | renamed → `.agents/protocols/…` (R100); `.claude/skills/improve-feature/` deleted |
| 2026-08-24 10:47 | `0417cc4` | canonical copy gains `### Goal Invariants` |
| 2026-08-24 12:23 | `baac26f` | **new blob added** at `.agents/skills/improve-feature/SKILL.md` |

Both moves were `R100` — pure renames — so the canonical protocol immediately before `0417cc4` is byte-identical to the pre-move file: blob `9c0e4f1a`, 8829 bytes. The file added by `baac26f` is blob `434b7890`, 9579 bytes, and diffs against `9c0e4f1a` as *that base plus two new edits* (`SWITCHBOARD STATUS: Live` port detection, and a `## Team Dispatch Instructions` section). An agent read the current canonical protocol, edited it correctly, and wrote the result to the historical path.

### Root Cause

`CLAUDE.md` names `.switchboard/protocols/<name>/SKILL.md` as the protocol location in six places (`:54`, `:93`, `:114`, `:116`, `:127`, and the summary at `:118`), and `.agents/plan-authoring-protocol.md` names it once. `33d4f3d2` relocated protocols to `.agents/protocols/` because `.vscodeignore` excludes `.switchboard/**` and the directory could not ship. The instructions were never updated.

`CLAUDE.md:118` is the specific trap: *"Skill Files Location: `.agents/skills/` (discoverable skills) and `.switchboard/protocols/` (path-delivered protocols)"* — one live path beside one dead one. An agent that looks for a protocol at the documented location finds nothing, globs, and lands in the only named directory that exists. That directory is also where this file genuinely lived for five weeks, so it looks right.

Two things then guarantee silence:

1. **The wrong path resolves.** `agentPromptBuilder.ts:1478` maps `.agents/skills/improve-feature/SKILL.md` to the protocols path at prompt-build time. Dispatch keeps working, so the misplacement produces no symptom.
2. **Nothing gates the directory.** `move-protocols-out-of-skill-discovery.md` cut `<available_skills>` from 91 entries to 4 by *moving files*. It added no invariant. The entire check surface — `catalog:check`, `parity:check`, `push-routing:check`, `standalone-parity:check`, `standalone-fork:check`, `kanban-dispatch-callers:check`, `verb-returns:check`, `mirror:check`, ~150 contract tests — asserts nothing about what may live in `.agents/skills/`. `mirror:check` regenerates from `MIRROR_MANIFEST` and diffs; a directory absent from the manifest produces no output to diff, so it passes green. `baac26f` added three such directories and both gates it did trip (`mirror:check`, `catalog:check`) went green on regeneration.

`.agents/skills/` grew from 5 entries to 8 in that one commit: `external-team-lead`, `improve-feature` and `switchboard-orchestration`, of which the first two duplicate an existing `.agents/protocols/` entry.

### Blast radius — repo-local, verified

This does **not** reach users, and the plan should not be sold as a user-facing fix:

- `AGENTS.md` contains zero `.switchboard/protocols` references.
- `RESIDENT_PROTOCOL_BODY` (`ClaudeCodeMirrorService.ts:148`) — the block written into a user's `AGENTS.md`/`CLAUDE.md` — is clean, as is `REMOTE_MODE_DIRECTIVE` (`:830`), which correctly uses `.agents/protocols/`.
- `.agents/plan-authoring-protocol.md` is **not** in `.agents/.switchboard-bundled.json`, so its one dead reference is never seeded either.

The audience for these broken instructions is agents working on this repository. That is exactly who followed them.

### Non-goals

- **Reconciling the two diverged `improve-feature` copies.** Owned by `feature-titles-and-prose-must-be-true-of-the-plans-inside.md` (Proposed Change 5, plus a **[user]** question on sync-vs-delete). This plan makes the *next* divergence impossible; it does not resolve the existing one, and must not race that plan's edits to the same file.
- **Classifying `switchboard-orchestration`.** It has no `.agents/protocols/` counterpart and `CLAUDE.md` does not list it as a protocol, so it may be a legitimate new skill or a protocol that only ever landed wrong. Requires intent, not investigation — see Outstanding Questions.
- **Rewriting `.switchboard/protocols/` in `src/`.** Those 12 occurrences are load-bearing; see the trap in Proposed Changes.
- **The 21 stale refs** carrying the old path. Noted as a risk, not fixed here — no code change can retire someone else's branch.

### Why this is one plan

Two deliverables, one root cause, and neither ships usefully alone: correcting the instructions without a gate lets the same drift recur the next time an agent guesses, and adding the gate without correcting the instructions just converts a silent misplacement into a CI failure while still pointing agents at a dead path. They land together or the fix is half-done.

---

## Metadata

**Tags:** docs, tooling, reliability, tech-debt
**Complexity:** 3

---

## User Review Required

- **`switchboard-orchestration`** — is it a skill or a misplaced protocol? The whitelist cannot be written until this is settled, because the answer decides whether it is an allowed entry or the gate's first failure.

---

## Complexity Audit

* **Score:** 3 / 10

### Routine

- Seven path-string corrections in two markdown files.
- One new `scripts/check-*.js` following the established pattern, one `package.json` script, one CI step.

### Complex / Risky

- **A repo-wide find-and-replace of `.switchboard/protocols/` breaks the migration.** `agentPromptBuilder.ts` holds 6 occurrences, `src/test/planner-workflow-path-migration.test.js` 5, `vsix-packaging-contract.test.js` 1. In `agentPromptBuilder.ts` they are **keys** in `RETIRED_WORKFLOW_PATH_MAP` (`:1487` for improve-feature), normalising a persisted config value of that vintage to `.agents/protocols/`. Rewriting a key to equal its own value makes the entry a no-op and strands every install that stored a `.switchboard/protocols/` path. The test occurrences assert exactly that mapping; the `vsix-packaging-contract.test.js` one is a comment explaining why the destination was unshippable. **All 12 stay.** Only the 7 in `CLAUDE.md` and `.agents/plan-authoring-protocol.md` change.
- **The whitelist's source of truth.** Deriving it from `.agents/.switchboard-bundled.json` (which lists exactly the 4 shipped skills) is tempting and wrong: that file is generated, `_lib/` is not in it, and a gate that reads a generated artifact fails open the moment generation changes. The whitelist is an explicit literal in the script, with a comment saying that adding an entry is a deliberate act.
- **`_lib/` is not a skill** but must be allowed — it holds `sb_api_call.sh` and `workspace-root.js`, both bundled.
- **Ordering against the other plan.** If `feature-titles-and-prose…` deletes the `.agents/skills/improve-feature` alias, this gate's expected-set changes. Land this plan's gate *after* that decision, or the gate's first run fails on a file someone is mid-way through removing.

---

## Edge-Case & Dependency Audit

### Side Effects

- CI gains a step that fails on any new `.agents/skills/` entry, including a legitimate new skill. That is the intent: adding a discoverable skill becomes a two-file change (the skill, and the whitelist), which is the point at which someone asks whether it should be a protocol instead.

### Dependencies & Conflicts

- **Conflicts on file** with `feature-titles-and-prose-must-be-true-of-the-plans-inside.md` if that plan's Change 5 deletes the alias. Sequence, don't parallelise.
- **21 refs still carry `.agents/skills/improve-feature/SKILL.md`**, mostly long-lived `claude/switchboard-cloud-*` branches cut before the move; four hold the pre-move blob `9c0e4f1a`. Any of them merging to `main` re-creates this situation, and the new gate is what will catch it — as a merge-time CI failure rather than a silent landing.

---

## Dependencies

- **`feature-titles-and-prose-must-be-true-of-the-plans-inside.md` Change 5** — previously depended on for the `improve-feature` sync-or-delete decision. Now resolved: this plan deletes the alias (Change 5). That plan's Change 5 should be updated to reflect the deletion, or dropped if its only action was the sync-or-delete question.
- **Changes 5 and 6 must land before the gate (Change 3)** — the gate's 6-entry expected set assumes `improve-feature` is deleted and `switchboard-orchestration` is moved. If the gate lands first, it fails on the current 8-entry tree.
- **This plan is self-contained** — both user decisions are resolved. No external dependency blocks landing.

---

## Adversarial Synthesis

Key risks: (1) the expected set drops from 8 to 6 entries — two removals (improve-feature alias deleted, switchboard-orchestration moved to protocols) must land before the gate or it fails on the current tree; (2) deleting the `improve-feature` alias and moving `switchboard-orchestration` creates dead references in `manage-features` (lines 444, 494) and the `switchboard` skill (line 99) — these must be updated to point at protocol paths in the same change; (3) the `agentPromptBuilder.ts` stale mappings at `:1706` and `:1718` reference `switchboard-orchestrator` (with `or`), not `switchboard-orchestration` (with `ion`) — remove them, but leave the migration keys at `:1698-1720` that normalise persisted config values. Mitigations: Changes 5 and 6 land together with the gate; all references updated in the same change; migration keys preserved.

---

## Proposed Changes

### 1. `CLAUDE.md` — ALREADY DONE (verified 2026-09-11)

> **Superseded:** Six corrections at `:54`, `:93`, `:114`, `:116`, `:118`, `:127` replacing `.switchboard/protocols/` with `.agents/protocols/`.
> **Reason:** CLAUDE.md has been rewritten since this plan was written. `grep -rn "\.switchboard/protocols" CLAUDE.md` returns zero matches. The corrections are already done — no action needed.
> **Replaced with:** No change. Verify the zero-match invariant holds (see Goal Invariant 1).

### 2. `.agents/plan-authoring-protocol.md` — one correction

Same substitution, one occurrence. This file is not bundled, so no seeded copy needs to follow.

### 3. `scripts/check-agent-skills-whitelist.js` — new gate

Follow the shape of `scripts/check-protocol-parity.js`: `#!/usr/bin/env node`, `'use strict'`, a header comment stating the guarantee, `REPO_ROOT` via `path.resolve(__dirname, '..')`, non-zero exit with a named diff on failure.

**Guarantee:** the top-level entries of `.agents/skills/` equal an explicit expected set exactly — no extras, no missing.

**Expected set** (after this plan's changes, decided 2026-09-11): `_lib`, `external-team-lead`, `kanban_operations`, `manage-features`, `query-kanban`, `worktree-cleanup` — 6 entries.

**Decisions resolved:**
- **`improve-feature` — DELETE the alias.** `improve-feature` is only ever dispatched by the extension on a column move to `PLAN REVIEWED`, same as `improve-plan`. `improve-plan` has no `.agents/skills/` alias and never did. `improve-feature` should follow the same pattern — protocols only, no discoverable alias. The alias is deleted by Change 5 below, and the expected set excludes it. `manage-features` lines 444 and 494 reference `improve-feature` by skill name — update them to point at `.agents/protocols/improve-feature/SKILL.md` by path (Change 5).
- **`switchboard-orchestration` — MOVE to `.agents/protocols/`.** The only skill a user types is `switchboard`, and that skill references `switchboard-orchestration` by name at line 99. A user is not going to type `switchboard-orchestration` directly. It is a reference document, not a dispatched workflow — but it belongs in `.agents/protocols/` alongside the other path-referenced documents, and the `switchboard` skill should reference it by path. Move the directory from `.agents/skills/` to `.agents/protocols/` (Change 6), update the `switchboard` skill line 99 to point at the protocol path (Change 6), and clean up the dead `agentPromptBuilder.ts:1706` mapping that references `switchboard-orchestrator` (with `or`) — a stale path to a directory that never existed (Change 6).

**Failure message** must say why, not just what — that a protocol belongs in `.agents/protocols/`, that an entry here becomes a discoverable skill injected into every agent's system prompt, and that adding one means editing this whitelist on purpose. The message is the only place a future agent will read the rule at the moment it matters.

### 4. `package.json` + CI

- Add `"skills-whitelist:check": "node scripts/check-agent-skills-whitelist.js"`.
- Wire it into `.github/workflows/integration-tests.yml` adjacent to the `mirror:check` step (currently `:53`), in the same fast-gate group — it needs no compile, so it belongs before the contract tests.

### 5. Delete `.agents/skills/improve-feature/` alias + update `manage-features` references

**Delete the alias:**
- `git rm -r .agents/skills/improve-feature/` — the canonical copy at `.agents/protocols/improve-feature/SKILL.md` is the sole source. The extension dispatches from the protocols path (`agentPromptBuilder.ts:1683`, `KanbanProvider.ts:7072`); the skills alias was only a discoverable entry in the system prompt's skill registry. `improve-plan` has no alias and never did — `improve-feature` follows the same pattern.
- Remove the `agentPromptBuilder.ts:1704` mapping: `'.agents/skills/improve-feature/SKILL.md': DEFAULT_FEATURE_PLANNER_WORKFLOW` — the path it maps no longer exists. The migration key at `:1713` (`.switchboard/protocols/improve-feature/SKILL.md`) stays — it normalises a persisted config value from a vintage that predates the move.

**Update `manage-features` references:**
- `.agents/skills/manage-features/SKILL.md:444` — change `**\`improve-feature\` / \`switchboard-feature\`**` to reference `.agents/protocols/improve-feature/SKILL.md` by path instead of by skill name.
- `.agents/skills/manage-features/SKILL.md:494` — change "hand off to `improve-feature`" to "hand off to `.agents/protocols/improve-feature/SKILL.md`" (read the protocol by path).

### 6. Move `switchboard-orchestration` to `.agents/protocols/` + update references

**Move the directory:**
- `git mv .agents/skills/switchboard-orchestration/ .agents/protocols/switchboard-orchestration/` — it is a reference document, not a dispatched workflow, but it belongs in `.agents/protocols/` alongside the other path-referenced documents. A user never types `switchboard-orchestration` directly; the only skill a user types is `switchboard`, which references it by path after this change.

**Update references:**
- `.claude/skills/switchboard/SKILL.md:99` — change "the `switchboard-orchestration` skill documents every endpoint" to "`.agents/protocols/switchboard-orchestration/SKILL.md` documents every endpoint" (reference by path).
- `agentPromptBuilder.ts:1706` — remove the dead mapping `'.agents/skills/switchboard-orchestrator/SKILL.md': 'switchboard-mission-control'`. The path references `switchboard-orchestrator` (with `or`), not `switchboard-orchestration` (with `ion`) — a stale path to a directory that never existed. The mapping at `:1718` (`.agents/protocols/switchboard-orchestrator/SKILL.md`) is also stale (same `or` vs `ion` mismatch) — remove it too. The `switchboard-mission-control` workflow is resolved via `GET /protocol/switchboard-mission-control` at runtime, not via these path mappings.

### Migration

None. Instruction text and a new gate; no persisted state, no user files, no shipped artifact.

---

## Verification Plan

### Goal Invariants

1. `grep -rn "\.switchboard/protocols" CLAUDE.md .agents/plan-authoring-protocol.md` returns **zero** matches.
2. `grep -rc "\.switchboard/protocols" src/services/agentPromptBuilder.ts` still returns **6**; `src/test/planner-workflow-path-migration.test.js` still **5**; `src/test/vsix-packaging-contract.test.js` still **1**. The negative half matters more than the positive half — it is what distinguishes this change from the find-and-replace that breaks the migration.
3. `npm run skills-whitelist:check` exits 0 on the corrected tree.
4. `npm run skills-whitelist:check` exits non-zero when a scratch directory is added under `.agents/skills/`, and the message names the offending entry.
5. `.agents/skills/improve-feature/` does not exist — the alias is deleted.
6. `.agents/skills/switchboard-orchestration/` does not exist — moved to `.agents/protocols/switchboard-orchestration/`.
7. `.agents/protocols/switchboard-orchestration/SKILL.md` exists and contains the HTTP contract content.
8. `manage-features/SKILL.md` contains zero references to `improve-feature` as a skill name — references are by protocol path.
9. The `switchboard` skill (`.claude/skills/switchboard/SKILL.md`) references `switchboard-orchestration` by protocol path, not by skill name.

### Automated Tests

- `src/test/planner-workflow-path-migration.test.js` — must pass unchanged. This is the regression guard proving the `.switchboard/protocols/` migration keys survived.
- ~~`npm run mirror:check`~~ **(VOID 2026-09-04 — the mirror generator, its manifest and this gate are deleted by *Delete the Claude mirror generator*; the drift test that asserts each `.claude/skills/*/SKILL.md` equals its `.agents/` counterpart modulo frontmatter replaces it)** and `npm run catalog:check` — unchanged and green; neither is affected, and neither would have caught this (worth asserting once so nobody later credits them with coverage they lack).
- New gate exercised both ways, per invariants 3 and 4.

### Manual Verification

- Ask an agent, in a fresh session on this repo, to edit the `accuracy` protocol. Confirm it opens `.agents/protocols/accuracy/SKILL.md` without a wrong guess first. This is the actual failure being fixed, and no automated check can stand in for it.

---

## Outstanding Questions

- Should the gate extend to `.agents/protocols/` as well — asserting every protocol there is referenced by at least one code path or `CLAUDE.md` entry? That would catch the inverse drift (an orphaned protocol nothing dispatches). Deliberately out of scope; worth its own plan if the answer is yes.

---

## Recommendation

Do it. The CLAUDE.md corrections are already done (verified zero matches). The remaining work: (1) fix the one reference in `.agents/plan-authoring-protocol.md:29` — five minutes; (2) delete the `.agents/skills/improve-feature/` alias and update `manage-features` lines 444/494 to point at the protocol path (Change 5); (3) move `switchboard-orchestration` to `.agents/protocols/` and update the `switchboard` skill line 99 + clean up stale `agentPromptBuilder.ts` mappings (Change 6); (4) write the whitelist gate with the 6-entry expected set (Change 3). Changes 5 and 6 must land before the gate, or the gate fails on the current 8-entry tree.
