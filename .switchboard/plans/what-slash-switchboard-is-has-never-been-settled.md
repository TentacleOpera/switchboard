# The manifest and the skill file have disagreed about what /switchboard is since the day both were created

## Goal

Settle whether `/switchboard` is the **management console** or the **Mission Control launcher**, and
make the mirror manifest, both workflow/skill copies, and their frontmatter say the same thing. Three
sources currently answer that question differently, and two of them have contradicted each other
since the commit that created them.

### Problem Analysis

**The contradiction was born in one commit.** `7068520` (2026-08-21) simultaneously:

- wrote the mirror manifest entry declaring `/switchboard` a **console** —
  `src/services/ClaudeCodeMirrorService.ts:49-55`: "`/switchboard` — local management console
  (**absorbs the former switchboard-manage skill body verbatim**)", with
  `descriptionFallback: 'Local Switchboard management console — drive the board when the VS Code extension is running'`;
- created `.claude/skills/switchboard/SKILL.md` and `.agents/workflows/switchboard.md` carrying the
  **launcher** body (123 / 121 lines), frontmatter
  `description: Start the Switchboard board and the orchestration agent — a two-step launcher`.

Same commit, two answers.

**Then five days of reviewer passes invested in the launcher, at that path:**

| commit | date | what it did |
| :--- | :--- | :--- |
| `d305a6b` | 08-21 | "repair the launcher's dead `$ROOT` and three sandbox seams" |
| `1eb5678` | 08-21 | "the adopt door could not be reached from the second host" |
| `684643c` | 08-24 | "fix a broken CI gate, **a dead front door**…" |
| `cefe9ad` | 08-26 | "the drive prefix argued with itself and four gates were red" |

**Then `abd3659` (08-26) replaced both bodies with the console** (607 / 605 lines) and **did not touch
the manifest** — `git show --stat abd3659 -- src/services/ClaudeCodeMirrorService.ts` is empty. So
that commit moved the *files* onto the side the *manifest* had claimed all along. It is not a blind
clobber, and the console is not abandoned work: it has its own plan
(`.switchboard/plans/switchboard-manage-console-skill.md`), three sibling plans, and a feature.

**But the console's own plan asks for a different command.** That plan's Goal is:

> Add **`/switchboard-manage`**: a host-agnostic management console…

with in-scope item "**New skill `.agents/skills/switchboard-manage/SKILL.md`**". No
`switchboard-manage` file exists anywhere in the tree — only plans referencing it. The manifest
comment records the resolution ("absorbs the former switchboard-manage skill body verbatim"), so the
rename to `/switchboard` was deliberate. The console is where it was meant to be.

**The absorb is nonetheless incomplete, and the manifest proves it — it is internally split:**

| Manifest field (`:52-54`) | Value | Matches |
| :--- | :--- | :--- |
| comment + `descriptionFallback` | "local management console…" | **console** |
| `allowedTools` | `'Bash, Read, Write, Glob, Grep'` | **launcher** (its exact frontmatter) |

The current console file's own frontmatter is `allowed-tools: Bash`. So the mirror grants five tools
to a skill that asks for one — a live inconsistency, and the fingerprint of a half-finished rename
rather than a completed one.

**What this means for the reported experience.** The user reached `/switchboard` expecting the
mission controller and got the console. Given the manifest, the console is arguably correct and the
*expectation* is what is unmet — but the expectation was set by five days of reviewer passes
maintaining a launcher at that exact path, and by the launcher being the only front door that ever
reached Mission Control. Manifest line `:46` records that "switchboard-mission-control is NOT in the
manifest — the engine launches it by path", so with the launcher gone there is **no slash command
that reaches Mission Control at all**; the only doors left are the panel's Start button and
`POST /mission-control/start`.

That is the substantive question this plan exists to answer, and it is a product decision, not a
git-history question.

### Root Cause

A rename was executed across three artifacts that must agree — the manifest, the workflow file, and
the mirrored skill file — with no gate asserting they do. The manifest was updated first and the
bodies five days later, and in between, four reviewer passes improved the body the manifest had
already superseded. Nothing failed, because nothing checks that the manifest's declared identity
matches the body it points at, or that its `allowedTools` matches the body's frontmatter.

### Non-goals

- **Not restoring the launcher over the console.** An earlier read of this history assumed that; the
  manifest contradicts it. Whatever lands here follows the decision below, not a revert.
- **Not deleting the console.** It is planned, reviewed work with a feature behind it.
- **Not re-adding `/switchboard-manage`.** The absorb into `/switchboard` was deliberate.
- **Not fixing the protocol's internal defects.** Those are the four sibling plans, and they hold
  regardless of this decision.

## Metadata

**Complexity:** 3
**Tags:** bugfix, docs, devops, reliability

## User Review Required

Yes — this plan is a decision, and it is the user's.

**Does `/switchboard` reach Mission Control, or is it the console?** The history supports either, so
state the intent and the rest follows. Three coherent options:

1. **Console only (what the manifest says today).** `/switchboard` stays the console. Then accept
   that Mission Control has no slash door and is reached from the panel — and say so in the console
   body, so a user typing `/switchboard` expecting the mission controller is told where it lives
   instead of being silently handed a different persona. **Cheapest, and consistent with `src/`.**
2. **Launcher only.** `/switchboard` returns to the two-step launcher and the console moves to its
   own command (`/switchboard-manage`, as its plan asked). Requires a manifest entry and a new file;
   restores the door the reviewer passes were building; costs a second front door to maintain.
3. **Console with a launch step.** `/switchboard` keeps the console body and gains an "adopt Mission
   Control" path from its menu. One door, both capabilities. Most work, and risks the two personas
   sharing one context — which is exactly what the dispatch-contract plan is cleaning up.

**Recommendation: (1), unless you want a slash door to Mission Control** — in which case (3) beats
(2), because a second front door is what produced this whole tangle.

Whichever is chosen, the mechanical half is not optional: **the manifest's `allowedTools` must match
the chosen body's frontmatter**, and a gate must assert that agreement.

## Complexity Audit

### Routine

- Reconciling `allowedTools` with the frontmatter.
- Adding a note to the console body about where Mission Control lives (option 1).

### Complex / Risky

- **`allowedTools` vs `allowed-tools` is a real behavioural difference, not cosmetic.** The console
  body drives `curl`/`awk`/`stat` and its frontmatter requests `Bash` only, while the manifest grants
  five tools. Whichever is authoritative, the other must be corrected deliberately — and if the mirror
  writes the tool list, then the file's frontmatter is decorative and should be made to match rather
  than left to imply a narrower grant than the agent actually has.
- **Option 2 must not restore the launcher verbatim.** It was last reviewed at `cefe9ad` and
  references `.switchboard/orchestrator/session.md` and `POST /orchestration/confirm`, while
  `buildMissionControlKickoffPrompt` (`TaskViewerProvider.ts:11639`) and the protocol both use
  `.switchboard/mission-control/session.md` and `POST /mission-control/confirm`. A verbatim restore
  ships a launcher that arms nothing. `migrateLegacyOrchestratorDir` exists for that rename and must
  not be fought.
- **The two copies are one document for two hosts.** `.claude/skills/switchboard/SKILL.md` and
  `.agents/workflows/switchboard.md` must move together; the manifest points at the `workflows/` copy
  and the mirror produces the other.
- **The gate must check identity, not just equality.** Two identical files that both disagree with
  the manifest is the current state minus one symptom. Assert manifest↔body agreement as well.

## Edge-Case & Dependency Audit

**Race conditions**
- None. Source tree and manifest only.

**Security**
- `allowedTools` is a permission grant. Widening it to match a body is a real privilege change and
  should be a deliberate line in the diff, not a side effect of tidying frontmatter.

**Side effects**
- Under option 1, users who learned the launcher lose it; the note about the panel is what prevents
  that from reading as a bug.
- Under option 2 or 3, `.switchboard/plans/switchboard-manage-*.md` (four plans) and the
  `switchboard-manager-and-workflow-improvements` feature describe a console at a command name that
  changes again. Check them for stale command references.
- The mirror regenerates `.claude/skills/` from `.agents/workflows/`; a hand-edit to the mirrored copy
  is overwritten on the next mirror run. Edit the source.

**Migration**
- Source and manifest only. No schema, settings, stored state, or user data. Skills are read from the
  workspace at invocation time, so no install is affected.

## Dependencies

- **Independent of the four sibling plans.** They fix defects inside the Mission Control protocol and
  the console body; those defects exist under every option here. This plan settles naming and
  wiring only.
- **Reads:** `.switchboard/plans/switchboard-manage-console-skill.md` and its three siblings for the
  console's intended scope.

## Adversarial Synthesis

Key risks: (1) **treating `abd3659` as an accident and reverting it** — the trap this plan was
rewritten to avoid; the manifest has said "console" since `7068520`, so a revert re-opens a
contradiction rather than closing one; (2) choosing option 2 and restoring `cefe9ad` verbatim,
shipping a launcher pointed at the pre-rename `orchestrator/` seams so confirm silently arms nothing;
(3) "fixing" the `allowedTools` mismatch by narrowing the manifest to `Bash` without checking that
the console body only needs Bash — it also reads files; (4) editing the mirrored `.claude/` copy and
having the mirror overwrite it; (5) adding an equality gate between the two copies and calling it
done, while both still disagree with the manifest. Mitigations: make the option an explicit decision
recorded in the commit message; if option 2, diff every path and endpoint claim against `src/` before
committing; treat the tool-grant change as a reviewed line, not a tidy-up; edit the `workflows/`
source; and assert manifest↔body↔frontmatter agreement, not just copy equality.

## Proposed Changes

1. **Record the decision** (option 1, 2 or 3 above) in the commit message, so the next reader is not
   re-deriving intent from git.
2. **Make the manifest and the body agree** — comment, `descriptionFallback`, and `allowedTools` all
   describing the persona that is actually in the file.
3. **Reconcile `allowedTools` with the body's frontmatter**, as a deliberate reviewed line. If the
   console needs more than `Bash`, widen the frontmatter; if not, narrow the manifest.
4. **Under option 1:** add one line to the console body saying Mission Control is started from the
   panel (or `POST /mission-control/start`), so the unmet expectation is answered in the place it is
   formed.
5. **Under option 2 or 3:** reconcile the launcher text against `src/` before it lands — session path
   `.switchboard/mission-control/session.md`, confirm endpoint `POST /mission-control/confirm` — and
   add the manifest entry for whichever command the console moves to.
6. **Edit the `.agents/workflows/` source, not the mirrored `.claude/` copy**, and let the mirror
   regenerate.
7. **Add a front-door consistency gate:** for every `MIRROR_MANIFEST` entry, assert the source file
   exists, its frontmatter `name` matches the entry's `name`, its `description` matches
   `descriptionFallback`, and its `allowed-tools` matches `allowedTools`. This is the check whose
   absence let the manifest and the body disagree for five days.
8. **Sweep the four `switchboard-manage-*` plans and the feature** for command names that the
   decision makes stale.

### Migration

Source files and one manifest entry. No schema, settings, stored state, or user data; skills are read
from the workspace at invocation time, so no install changes behaviour.

## Verification Plan

1. **Manifest matches body.** For the `switchboard` entry, assert the source file's frontmatter
   `name`, `description` and `allowed-tools` equal the manifest's `name`, `descriptionFallback` and
   `allowedTools`. **This fails today** (`allowed-tools: Bash` vs `'Bash, Read, Write, Glob, Grep'`)
   — that failure is the regression test.
2. **The gate covers every entry.** Break one field on a different manifest entry in a scratch branch
   and assert the gate fails and names the file and field.
3. **Both copies agree.** `diff .agents/workflows/switchboard.md .claude/skills/switchboard/SKILL.md`
   shows only frontmatter lines.
4. **The mirror is the writer.** Edit the `workflows/` source, run the mirror, and assert the
   `.claude/` copy regenerates to match.
5. **Invoking the command gets the declared persona.** Type `/switchboard`; assert the persona that
   loads is the one the manifest describes.
6. **Mission Control is reachable and documented.** Assert the chosen option's Mission Control door
   works end to end — panel Start (option 1) or the slash launcher (2/3) — reaching the pre-flight
   with `POST /mission-control/confirm` arming the session.
7. **Option 2/3 only — no stale seams.** `grep -n 'orchestrator/session.md\|POST /orchestration/confirm'`
   over both copies returns nothing.
8. **Option 2/3 only — no second terminal.** Assert the launcher adopts the seat in the invoking
   conversation rather than spawning a separate Mission Control terminal.
9. **Tool grant is honest.** Assert the console can perform every action its body prescribes with
   exactly the tools the reconciled grant allows.
10. **No stale command names.** Grep the four `switchboard-manage-*` plans and the feature for command
    references the decision invalidated.
