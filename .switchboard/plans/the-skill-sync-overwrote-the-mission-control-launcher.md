# The skill sync overwrote the Mission Control launcher with a legacy console persona

## Goal

Restore `/switchboard` to the Mission Control launcher it was before the bundle sync replaced it,
and add a guard so a future bundle sync cannot silently clobber a maintained front-door skill again.

### Problem Analysis

**`/switchboard` no longer launches Mission Control at all.** The current
`.claude/skills/switchboard/SKILL.md` is a 607-line document titled *"Switchboard Manage —
Host-Agnostic Management Console"*. It contains **zero** occurrences of `mission-control`,
`Mission Control`, or `adopt`. The two-step launcher — (1) ensure a board is running via
`npx switchboard`, (2) `POST /mission-control/adopt` and adopt the seat in this conversation —
is gone from the file.

**This is a regression introduced by one commit, not an evolution.** File history:

| commit | lines | subject |
| :--- | :--- | :--- |
| `abd3659` | **607** | switchboard: sync skills, features, and plan updates |
| `cefe9ad` | 123 | Reviewer pass: the drive prefix argued with itself and four gates were red |
| `58c0030` | 123 | Reviewer pass: the mission backend never compiled… |
| `684643c` | 123 | Reviewer pass: fix a broken CI gate, a dead front door… |
| `fd1eb10` | 123 | Commit in-flight tree: control-plane trims and plan/feature updates |
| `1eb5678` | 140 | Reviewer pass: the adopt door could not be reached from the second host |
| `d305a6b` | 135 | Reviewer pass: repair the launcher's dead `$ROOT` and three sandbox seams |

Four consecutive reviewer passes maintained the 123-line launcher. `abd3659` replaced it wholesale.

**The console text is not an older revision of this file being restored — it never lived here.**
`git log --all -S"Host-Agnostic Management Console" -- .claude/skills/switchboard/SKILL.md`
returns exactly one commit: `abd3659`. The sync *introduced* this content into the front door.

**The commit was a bulk bundle sync, and it re-added legacy duplicates.** `abd3659` touches
hundreds of files under `.agents/skills/`, and for many skills it writes **both** naming
conventions side by side — `.agents/skills/archive.md` **and** `.agents/skills/archive/SKILL.md`,
`clickup_api.md` and `clickup-api/SKILL.md`, `deep_planning.md` and `deep-planning/SKILL.md`, and
so on. It also *deleted* maintained files (`.agents/skills/_lib/workspace-root.js`,
`.agents/skills/external-team-lead/SKILL.md`). The signature is a bundle unpacked over a working
tree, not a reviewed edit.

**The mirror was clobbered identically.** `.agents/workflows/switchboard.md` (605 lines) now
differs from `.claude/skills/switchboard/SKILL.md` (607 lines) only by the skill frontmatter
(`name:`, `allowed-tools:`). Both front doors carry the console persona; there is no surviving copy
of the launcher on this branch.

**Why the user experience is confusing rather than obviously broken.** The console persona is a
*plausible* Switchboard manager — it reads the board, lists columns, dispatches plans. So
`/switchboard` still appears to work. But it is a different persona with different rules:
it drives `POST /kanban/dispatch` with complexity-band routing, it has no concept of teams, leads,
pacing, queues, or the six-check pre-flight, and it never arms a session. Every downstream
complaint about "the mission controller" is really a complaint about this substituted persona —
or about the collision between it and the real Mission Control protocol when both reach one context.

### Root Cause

The front-door skill is a **generated/bundled artifact and a hand-maintained source at the same
path**, with nothing distinguishing the two. `.agents/.switchboard-bundled.json` (also rewritten by
`abd3659`) tracks bundle membership, but no gate compares a bundle write against the maintained
file, and no test asserts that `/switchboard` still names the launcher's contract. A bundle sync is
therefore a silent overwrite of reviewed work, and the only detector is a user noticing the persona
changed behaviour days later.

### Non-goals

- **Not re-authoring the launcher.** `cefe9ad:.claude/skills/switchboard/SKILL.md` is the reviewed
  content; this plan restores it, it does not redesign it.
- **Not deleting the console persona's content.** Whatever in it is still wanted (the endpoint
  reference, the list template) is triaged by the sibling plans, not discarded here.
- **Not rebuilding the bundle system.** One guard against silent clobber, not a new pipeline.
- **Not fixing the protocol contradictions.** Those are the sibling plans; this one settles *which
  document is the front door*.

## Metadata

**Complexity:** 4
**Tags:** bugfix, reliability, devops, docs

## User Review Required

Yes — one decision.

**Is the console persona still wanted as a separate, named skill?** Recommendation: **restore the
launcher at `/switchboard` and do not keep the console persona as a second front door.** Two
personas that both answer "drive Switchboard" is precisely the collision the sibling plans are
cleaning up — a user typing `/switchboard` must get exactly one contract. If specific console
content has value (its endpoint list, its formatting templates), fold those paragraphs into the
launcher or the Mission Control protocol rather than preserving a rival persona.

The alternative — keeping it as e.g. `/switchboard-console` — is defensible only if the user
actually drives the board that way today. If nobody invokes it deliberately, a second front door is
a liability, and the last two weeks are the evidence.

## Complexity Audit

### Routine

- Restoring a known-good file from a known-good commit.
- Re-syncing `.agents/workflows/switchboard.md` to match.

### Complex / Risky

- **The restore must be verified against the *current* backend, not assumed.** The launcher was
  last reviewed at `cefe9ad`; `abd3659` and `7ca6b8c` landed after it. Re-read the restored file's
  claims against `src/` before committing — specifically `POST /mission-control/adopt`,
  `POST /orchestration/confirm` vs `POST /mission-control/confirm`, and the port-file path. The
  restored launcher's §2 references `.switchboard/orchestrator/session.md` and
  `POST /orchestration/confirm`, while `buildMissionControlKickoffPrompt`
  (`TaskViewerProvider.ts:11639`) and the current protocol both name
  `.switchboard/mission-control/session.md` and `POST /mission-control/confirm`. **A verbatim
  restore reintroduces stale paths** — the rename happened in between.
- **`migrateLegacyOrchestratorDir` exists for exactly this rename** (`TaskViewerProvider.ts`,
  called from `startMissionControlFromKanban`). The restored text must not fight it by writing to
  the pre-rename path.
- **Two files must move together.** `.claude/skills/switchboard/SKILL.md` and
  `.agents/workflows/switchboard.md` are the same document for two hosts. Restoring one is a
  divergence — the same class of failure `CLAUDE.md` documents for the extension/standalone roots.
- **The guard must not block legitimate bundle updates.** A gate that fails on every sync gets
  disabled. It should fail only when a bundle write would *replace* a file whose content the bundle
  did not produce.

## Edge-Case & Dependency Audit

**Race conditions**
- None inherent. This is a source-tree restore.

**Security**
- None. No new surface, no credentials, no network path.

**Side effects**
- A user who has adapted to the console persona's menu will see the launcher's shape instead. That
  is the point, but it should be stated in the restore commit message rather than discovered.
- Anything that grew to depend on the console persona's §3–§7 (feature reconcile, oversight passes,
  project pipeline) loses its documentation at this path. Triage those sections during the restore:
  the oversight/`/oversight/*` material in particular has no equivalent in the launcher and may need
  a home of its own rather than deletion.

**Migration**
- No stored state, no schema, no settings. Source files only. Users on older extension versions are
  unaffected — the skill is read from the workspace at invocation time.

## Dependencies

- **Blocks nothing, informs everything.** The four sibling plans fix the Mission Control protocol
  itself and are correct regardless of which door reaches it. But until this lands, "what does
  `/switchboard` do" has no single answer, so land it first if the plans are sequenced.
- **Related:** `two-documents-disagree-on-how-mission-control-dispatches.md`,
  `the-pre-flight-names-six-checks-and-supplies-one-command.md`,
  `mission-control-and-the-console-print-plan-lists-differently.md`,
  `the-terminal-logs-are-undocumented-so-agents-run-commands-instead.md`.

## Adversarial Synthesis

Key risks: (1) restoring `cefe9ad` verbatim and reintroducing the pre-rename
`.switchboard/orchestrator/` + `POST /orchestration/confirm` seams, producing a launcher that arms
nothing — the restore *looks* clean and the confirm silently targets a moved door; (2) restoring
only the `.claude/` copy and leaving `.agents/workflows/switchboard.md` on the console persona, so
the two hosts disagree about the front door; (3) deleting the console persona's oversight and
feature-reconcile sections along with it, losing documentation that has no other home;
(4) adding a bundle guard so strict that the next sync fails and someone deletes the guard.
Mitigations: restore, then diff the restored text's every endpoint and path claim against `src/`
before committing; move both files in one commit and assert their equality in the guard; inventory
the console-only sections and rehome them deliberately; scope the guard to *replacement of
non-bundle-authored content* and give its failure message the exact remedy.

## Proposed Changes

1. **Restore the launcher** to `.claude/skills/switchboard/SKILL.md` from
   `cefe9ad:.claude/skills/switchboard/SKILL.md`.
2. **Reconcile the restored text against the current backend** before committing — at minimum the
   session-file path (`.switchboard/mission-control/session.md`, not `orchestrator/`) and the
   confirm endpoint (`POST /mission-control/confirm`, per `TaskViewerProvider.ts:11639` and
   `.agents/protocols/switchboard-mission-control/SKILL.md`). Fix every stale reference found.
3. **Re-sync `.agents/workflows/switchboard.md`** to the restored content, differing only by
   frontmatter, in the same commit.
4. **Inventory the console-only sections** (§3 feature reconcile, §5 guided setup/tour,
   §6 oversight pass, §7 project pipeline) and decide per section: fold into the launcher, move to
   the Mission Control protocol, move to `switchboard-orchestration`, or drop. Do not lose them by
   accident.
5. **Add a front-door guard** — a test asserting that `.claude/skills/switchboard/SKILL.md` and
   `.agents/workflows/switchboard.md` are identical modulo frontmatter, and that the skill names its
   launcher contract (the adopt endpoint and the two-step shape). A bundle sync that overwrites it
   then fails a gate instead of shipping.
6. **Record the clobber in the bundle manifest path** — if `.agents/.switchboard-bundled.json` is
   the authority on what a sync may write, the front-door skill should be excluded from it, so the
   next sync cannot target the file at all.

### Migration

Source files only — no stored state, schema, settings, or user data. No migration required.

## Verification Plan

1. **The front door names Mission Control.** `grep -c 'mission-control' .claude/skills/switchboard/SKILL.md`
   is non-zero, and the file describes the two-step launcher.
2. **No stale seams survive the restore.** `grep -n 'orchestrator/session.md\|POST /orchestration/confirm'`
   over both restored files returns nothing.
3. **Both hosts agree.** `diff .agents/workflows/switchboard.md .claude/skills/switchboard/SKILL.md`
   shows only the frontmatter lines.
4. **The adopt door works end to end.** With a board running, invoke `/switchboard`; assert it
   resolves the port, calls `POST /mission-control/adopt`, receives a `prompt`, and runs the
   pre-flight *in the invoking conversation* — no second Orchestrator/Mission Control terminal is
   spawned.
5. **Confirm arms.** Answer the pre-flight; assert `.switchboard/mission-control/session.md` is
   written and `POST /mission-control/confirm` returns `{success:true}` and sets
   `missionControlArmed`.
6. **The guard catches a clobber.** Overwrite `.claude/skills/switchboard/SKILL.md` with the console
   persona in a scratch branch; assert the new gate fails, and that its message names the file and
   the remedy.
7. **The guard passes a legitimate change.** Make a real edit to the launcher, mirrored to
   `.agents/workflows/switchboard.md`; assert the gate is green.
8. **Console-only content is accounted for.** Every §3/§5/§6/§7 section from the console persona is
   either present in a named destination file or listed in the commit message as deliberately
   dropped — none silently vanished.
