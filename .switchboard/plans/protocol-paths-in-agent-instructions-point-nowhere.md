# The Protocol Path in Our Own Agent Instructions Points Nowhere, and Nothing Stops the Fallout

<!-- board-collapse-02 -->
> **RESCOPED 2026-09-04 (Board Collapse 02).** The analysis paragraph describing `mirror:check` as regenerating from `MIRROR_MANIFEST` and passing green over extra `.agents/skills/` directories is being overtaken: the generator, the manifest and that gate are all deleted by *Delete the Claude mirror generator*. Rewrite that paragraph against a committed `.claude/skills/` tree. The plan's own contribution is unaffected and still wanted: correcting the seven dead `.switchboard/protocols/` references, and adding the whitelist gate over `.agents/skills/` contents — which becomes **more** valuable, since it is the only structural check left once `mirror:check` is gone.


## Goal

Correct the 7 references in this repo's agent instructions that send agents to `.switchboard/protocols/` — a directory that has not existed since 2026-08-21 — and add a gate on the contents of `.agents/skills/` so a protocol written to the wrong place fails CI instead of shipping. Leave the 12 `.switchboard/protocols/` occurrences in `src/` alone: those are migration keys, and rewriting them breaks the migration.

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

## Proposed Changes

### 1. `CLAUDE.md` — six corrections

Replace `.switchboard/protocols/` with `.agents/protocols/` at:

- `:54` — the protocols sentence in the workflow-registry note (`…live as protocols under .switchboard/protocols/<name>/SKILL.md`)
- `:93` — the architecture diagram's `improve-plan` annotation
- `:114` — the Protocols paragraph's closing `These live at …` clause
- `:116` — the Usage line's `read .switchboard/protocols/improve-plan/SKILL.md` example
- `:118` — **Skill Files Location**, the trap: the parenthetical pairing a live path with a dead one
- `:127` — the plan-authoring protocol's `improve-plan` path

No wording changes beyond the directory segment. The one addition worth making is at `:118`: name `.agents/protocols/` as the *only* protocol location, so a future reader cannot infer a second one is also valid.

### 2. `.agents/plan-authoring-protocol.md` — one correction

Same substitution, one occurrence. This file is not bundled, so no seeded copy needs to follow.

### 3. `scripts/check-agent-skills-whitelist.js` — new gate

Follow the shape of `scripts/check-protocol-parity.js`: `#!/usr/bin/env node`, `'use strict'`, a header comment stating the guarantee, `REPO_ROOT` via `path.resolve(__dirname, '..')`, non-zero exit with a named diff on failure.

**Guarantee:** the top-level entries of `.agents/skills/` equal an explicit expected set exactly — no extras, no missing.

**Expected set** (pending the `switchboard-orchestration` decision): `_lib`, `kanban_operations`, `manage-features`, `query-kanban`, `worktree-cleanup`.

**Failure message** must say why, not just what — that a protocol belongs in `.agents/protocols/`, that an entry here becomes a discoverable skill injected into every agent's system prompt, and that adding one means editing this whitelist on purpose. The message is the only place a future agent will read the rule at the moment it matters.

### 4. `package.json` + CI

- Add `"skills-whitelist:check": "node scripts/check-agent-skills-whitelist.js"`.
- Wire it into `.github/workflows/integration-tests.yml` adjacent to the `mirror:check` step (currently `:53`), in the same fast-gate group — it needs no compile, so it belongs before the contract tests.

### Migration

None. Instruction text and a new gate; no persisted state, no user files, no shipped artifact.

---

## Verification Plan

### Goal Invariants

1. `grep -rn "\.switchboard/protocols" CLAUDE.md .agents/plan-authoring-protocol.md` returns **zero** matches.
2. `grep -rc "\.switchboard/protocols" src/services/agentPromptBuilder.ts` still returns **6**; `src/test/planner-workflow-path-migration.test.js` still **5**; `src/test/vsix-packaging-contract.test.js` still **1**. The negative half matters more than the positive half — it is what distinguishes this change from the find-and-replace that breaks the migration.
3. `npm run skills-whitelist:check` exits 0 on the corrected tree.
4. `npm run skills-whitelist:check` exits non-zero when a scratch directory is added under `.agents/skills/`, and the message names the offending entry.

### Automated Tests

- `src/test/planner-workflow-path-migration.test.js` — must pass unchanged. This is the regression guard proving the `.switchboard/protocols/` migration keys survived.
- ~~`npm run mirror:check`~~ **(VOID 2026-09-04 — the mirror generator, its manifest and this gate are deleted by *Delete the Claude mirror generator*; the drift test that asserts each `.claude/skills/*/SKILL.md` equals its `.agents/` counterpart modulo frontmatter replaces it)** and `npm run catalog:check` — unchanged and green; neither is affected, and neither would have caught this (worth asserting once so nobody later credits them with coverage they lack).
- New gate exercised both ways, per invariants 3 and 4.

### Manual Verification

- Ask an agent, in a fresh session on this repo, to edit the `accuracy` protocol. Confirm it opens `.agents/protocols/accuracy/SKILL.md` without a wrong guess first. This is the actual failure being fixed, and no automated check can stand in for it.

---

## Outstanding Questions

- **[user]** Is `switchboard-orchestration` a discoverable skill (add to the whitelist) or a protocol that landed in the wrong directory (move to `.agents/protocols/`, gate excludes it)? Blocks the expected set in Change 3.
- **[user]** `external-team-lead` now exists in **both** `.agents/skills/` and `.agents/protocols/`. Same duplication as `improve-feature` but not covered by the other plan. Fold it into that plan's Change 5, or handle here?
- Should the gate extend to `.agents/protocols/` as well — asserting every protocol there is referenced by at least one code path or `CLAUDE.md` entry? That would catch the inverse drift (an orphaned protocol nothing dispatches). Deliberately out of scope; worth its own plan if the answer is yes.

---

## Recommendation

Do it, and do the `CLAUDE.md` correction first and separately if anything delays the gate. Seven wrong strings in the file every agent reads is the whole cause of a split-brain in a dispatched protocol; that half is five minutes and needs no decision. The gate needs the `switchboard-orchestration` answer, and should land after `feature-titles-and-prose-must-be-true-of-the-plans-inside.md` settles whether the `improve-feature` alias is synced or deleted.
