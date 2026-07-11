---
description: "Manage skill: after presenting any plan list, follow up with an offer to dispatch selected plans or group them into a feature — numbered list so the user can answer by number."
---

# Manager Mode: Follow-Up Offer After Presenting Plans (Dispatch or Group into Features)

## Goal

When the manager persona (switchboard-manage skill) presents a list of plans — a column
browse, a "what's in CREATED?" answer, a filtered list — it currently stops after the list.
The user must then compose a fresh instruction ("dispatch the second one", "group those three
into a feature") from scratch. The skill should instead end every plan-list presentation with
a short follow-up offer: **"Want me to dispatch any of these, or group some into a feature?"**
— with the list numbered so the user can answer by number.

### Problem / root cause

The skill's §2 "Features & Board → Browse / filter" bullet (`.agents/skills/switchboard-manage/SKILL.md:204-210`)
tells the agent where the data lives (`kanban-state-<slug>.md` local files) but says nothing
about what to do after presenting it. Hard Rule 2 ("Default is never automation. Report state,
then wait." — `SKILL.md:486`) and Hard Rule 3 ("No eager action on entry" — `SKILL.md:488`)
correctly stop the agent from *acting*, but the persona has generalized them into not even
*offering* the natural next actions. Offering is not acting: a question costs nothing and is
exactly the consultative behavior the persona is meant to have. The two natural next actions
after seeing a plan list already have first-class one-call surfaces:

- **Dispatch:** `POST /kanban/dispatch` with `{"workspaceRoot": "$ROOT", "plan": "<planId>"}` —
  complexity auto-routing, honest success semantics (skill §2 "Code").
- **Group into a feature:** `POST /kanban/features/reconcile` (declarative, skill §3) or
  `POST /kanban/feature/create` (imperative).

So this is a pure prose change to the skill: no new endpoint, no new verb, no host code.

### Current state (verified in source, 2026-07-11)

- `.agents/skills/switchboard-manage/SKILL.md` (529 lines) — §2 menu/category reference; §3
  feature management; §4 "Resolving Plan IDs (never ask the user for a UUID)"; §8 hard rules.
- A byte-identical body copy lives at `.claude/skills/switchboard-manage/SKILL.md` (frontmatter
  differs by design: `name`, `allowed-tools`, `disable-model-invocation`). Both must be edited;
  `npm run mirror:check` gates drift.
- Hard Rule 8 forbids displaying raw UUIDs — the follow-up must reference plans by list number
  / title, resolving planIds internally (§4 offline index) when the user picks.

## Metadata
- **Tags:** feature, skill, ux, manager
- **Complexity:** 2

## Scope

### ✅ IN SCOPE
1. New short subsection in §2 of `switchboard-manage/SKILL.md` (both copies), directly after
   the "Local-first for lists" callout: **"After presenting a plan list"** — rules:
   - Number the list when presenting plans (1., 2., 3. …) so answers can be by number.
   - End the presentation with a one-line offer, adapted to context:
     *"Dispatch any of these, or group some into a feature?"*
   - On "dispatch N [and M]": resolve the numbers to planIds internally (never echo UUIDs,
     never ask for one — §4), then `POST /kanban/dispatch` per plan, `targetColumn` omitted.
   - On "group N, M [into <name>]": use §3 feature management (reconcile or feature/create);
     if no name given, propose one derived from the plans' shared capability and confirm.
   - The offer is a question, not an action — nothing fires until the user answers
     (consistent with Hard Rules 2/3; entry snapshot is NOT a plan list, so the entry
     protocol's "report, menu, stop" behavior is unchanged).
2. One-line cross-reference from the "Features & Board → Browse / filter" bullet to the new
   subsection.

### ⚙️ OUT OF SCOPE
- Any change to the entry protocol (§1) — the entry board snapshot deliberately lists no plans.
- Any host/extension code, endpoints, or verbs.
- Auto-dispatch or auto-grouping defaults — the offer must never pre-select an action.

## Complexity Audit
### Routine
- Prose subsection + cross-reference in a skill file; sync the second copy; run `mirror:check`.
### Complex / Risky
- **Rule-interaction wording:** the new subsection must be phrased so it cannot be read as
  licensing eager action — it authorizes *offering after the user requested a list*, nothing
  more. Keep the explicit sentence "the offer is a question; act only on an answer".
- **UUID hygiene:** the numbered-list convention must be stated as the mechanism that keeps
  Hard Rule 8 intact (numbers → planIds resolved internally at action time).

## Edge-Case & Dependency Audit
- **Empty column list** ("_No plans_") — no offer; nothing to dispatch or group.
- **List contains feature rows or epic subtasks** — the offer's dispatch arm applies to plain
  plans only; feature rows route to §3 (orchestration/feature dispatch), and the skill should
  say so in one clause rather than silently including them.
- **Mixed answer** ("dispatch 2, group 3 and 4") — both arms in one reply are fine; execute
  dispatch first (cheap, verifiable), then grouping.
- **Stale numbering** — if the user answers much later or after another list was printed,
  re-confirm by title, not number, when ambiguity exists.
- **Dependencies:** none — both target actions are shipped surfaces (`/kanban/dispatch`
  2026-07-10; features reconcile in §3). No interaction with the §6/§6a oversight passes.

## Proposed Changes
### .agents/skills/switchboard-manage/SKILL.md
Insert after the "Local-first for lists" callout (before "Verb-rail payload trap"), a compact
subsection:

```markdown
> **After presenting a plan list (any list — column browse, filter, search):** number the
> entries (1., 2., …) and end with a one-line offer: *"Dispatch any of these, or group some
> into a feature?"* The offer is a question — act only on an answer (Hard Rules 2/3 stand).
> On "dispatch N": resolve N → planId internally (§4 — never echo or request UUIDs) and
> `POST /kanban/dispatch` with `{"workspaceRoot": "$ROOT", "plan": "<planId>"}`, targetColumn
> omitted. On "group N, M": use §3 (reconcile or /kanban/feature/create); propose a feature
> name from the plans' shared capability if none was given. Feature rows in the list are not
> dispatch candidates — route those to §3 / orchestration dispatch. Empty lists get no offer.
```

And in "Features & Board → Browse / filter", append: `After presenting the list, follow the
"After presenting a plan list" rule above.`

### .claude/skills/switchboard-manage/SKILL.md
Same body edit (keep the mirror's frontmatter untouched).

## Verification Plan
### Automated
- `npm run mirror:check` green (both skill copies in sync).
- No catalog/allowlist impact (prose only) — `catalog:check` unchanged.
### Manual / behavioral
- Invoke the manage skill, ask "what's in CREATED?" → the reply is a numbered list ending
  with the dispatch-or-group offer, and nothing is dispatched.
- Answer "dispatch 2" → exactly one `POST /kanban/dispatch` for the second plan's planId;
  no UUID appears in the conversation.
- Answer "group 1 and 3 into Payments Cleanup" → a feature is created/reconciled with those
  two subtasks.
- Ask for an empty column → "_No plans_", no offer.
- Entry protocol regression: fresh invocation still shows snapshot + menu + stop, with no
  plan list and no offer.

---
**Recommendation:** Complexity 2 → Send to Intern.
