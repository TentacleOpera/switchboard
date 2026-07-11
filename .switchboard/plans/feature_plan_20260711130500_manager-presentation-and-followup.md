---
description: "Manage skill presentation layer (consolidated): plan lists as numbered natural-language titles, dispatch reports naming the registered CLI agent from response fields only, and a follow-up offer (dispatch or group into a feature) after every plan list — one coherent §2 callout block plus a Hard Rule 8 amendment, in both skill copies."
---

# Manager Console: Natural-Language Presentation & Follow-Up Offer for Plan Lists and Dispatch Reports

**Feature:** 66ca830c-43b2-4406-974f-334b750c2208
**Consolidated From:** feature_plan_20260711120045_manager-plan-list-followup-offer.md, feature_plan_20260711121703_manager-natural-language-presentation.md

## Goal

The manager persona (switchboard-manage skill) presents like an API console, and then goes
silent. Two observed failures (2026-07-11), one shared surface:

1. **Presentation.** Asked "what plans have been plan reviewed", it listed raw filenames
   (`feature_plan_20260710_180001_fix_sidebar_scroll_on_plan_creation.md`) plus full UUIDs;
   asked to dispatch, it reported a block of technical fields and never said the one thing a
   human wants to know: **who got the work**. The API response carried
   `"dispatchedAgent":"Lead Coder-Devin"` — the registered CLI terminal that actually received
   the prompt — and the summary never mentioned it.
2. **Dead-end lists.** After presenting any plan list, the skill stops. The user must compose
   a fresh instruction ("dispatch the second one", "group those three into a feature") from
   scratch. The two natural next actions already have first-class one-call surfaces; the skill
   should end every plan-list presentation with a short offer — **"Dispatch any of these, or
   group some into a feature?"** — with the list numbered so the user can answer by number.

Both are pure prose fixes to the same insertion point in `switchboard-manage/SKILL.md` §2
(after the "Local-first for lists" callout), and both redefine how plan lists are rendered
(numbered titles) and what Hard Rule 8 covers. Written separately they would collide; this
consolidated plan owns that surface once.

### Problem / root cause

Four distinct failures, all prose-fixable in `switchboard-manage/SKILL.md`:

1. **Raw identifiers leak.** Hard Rule 8 ("Never display raw UUIDs", `SKILL.md:501`) exists
   but is being violated, and it says nothing about filenames — so the agent prints
   `feature_plan_…_slug.md` + `ID: 4cac0e1b-…` lists. The kanban-state files the agent reads
   contain `topic` titles on every line; the skill never says "present the title, keep the
   rest internal."
2. **Dispatch reports bury the lede.** `POST /kanban/dispatch` returns
   `{success, moved, dispatched, role, routing, mode, column, dispatchedAgent, dispatchedAt}`
   (`LocalApiServer.ts:655-671`; `dispatchedAgent` is the registered terminal/CLI name —
   `KanbanDatabase.ts:55`). The skill documents the endpoint's semantics but gives no
   reporting template, so the agent regurgitates field dumps and omits `dispatchedAgent` —
   the only field that proves a real CLI received the prompt (vs. a silent clipboard
   fall-through).
3. **Fabricated detail.** In the observed exchange the reply claimed
   `complexity 5 → coder / CODER CODED` while the actual response said
   `role: "Lead Coder", routing: "lead-coded"` — the agent narrated from stale assumptions
   instead of the response. The skill has honesty rules for API *semantics* but no rule that
   the user-facing report must be derived ONLY from the returned fields.
4. **No follow-through after lists.** The skill's §2 "Features & Board → Browse / filter"
   bullet (`SKILL.md:209-212`) tells the agent where the data lives (`kanban-state-<slug>.md`
   local files) but says nothing about what to do after presenting it. Hard Rule 2 ("Default
   is never automation. Report state, then wait." — `SKILL.md:486`) and Hard Rule 3 ("No eager
   action on entry" — `SKILL.md:488`) correctly stop the agent from *acting*, but the persona
   has generalized them into not even *offering* the natural next actions. Offering is not
   acting: a question costs nothing and is exactly the consultative behavior the persona is
   meant to have. The two natural next actions already have first-class surfaces:
   - **Dispatch:** `POST /kanban/dispatch` with `{"workspaceRoot": "$ROOT", "plan": "<planId>"}` —
     complexity auto-routing, honest success semantics (skill §2 "Code").
   - **Group into a feature:** `POST /kanban/features/reconcile` (declarative, skill §3) or
     `POST /kanban/feature/create` (imperative).

No host/extension code is wrong here — the API already returns everything needed. This is a
skill-prose plan: no new endpoint, no new verb, no host code.

### Current state (verified in source, 2026-07-11)

- `.agents/skills/switchboard-manage/SKILL.md` (529 lines) — §2 menu/category reference with
  the "Local-first for lists" callout at `:158-163` and the "Verb-rail payload trap" callout
  immediately after (`:165`); §3 feature management; §4 "Resolving Plan IDs (never ask the
  user for a UUID)"; §8 hard rules (Rule 8 at `:501-502`).
- A byte-identical body copy lives at `.claude/skills/switchboard-manage/SKILL.md` (frontmatter
  differs by design: `name`, `allowed-tools`, `disable-model-invocation`). Both must be edited;
  `npm run mirror:check` gates drift (verified bodies currently match).
- Hard Rule 8 forbids displaying raw UUIDs — the numbered-list convention is the mechanism
  that keeps it intact: numbers → planIds resolved internally (§4 offline index) at action time.

## Metadata
- **Tags:** feature, ux, docs
- **Complexity:** 3
- **Feature:** 66ca830c-43b2-4406-974f-334b750c2208

## User Review Required

- None — prose-only skill change; no endpoints, no host code, no automation defaults. The
  follow-up offer is explicitly a question, never a pre-selected action.

## Scope

### ✅ IN SCOPE
1. **One consolidated presentation-and-follow-up callout block** in
   `switchboard-manage/SKILL.md` §2 (both copies), inserted directly after the "Local-first
   for lists" callout and before "Verb-rail payload trap":
   - **Plan lists:** numbered (1., 2., 3. …), title only (plus column/complexity when
     relevant). Never filenames, never UUIDs, never file paths — those stay internal (Hard
     Rule 8 extended). Offer detail on request ("say 'details on 2' for the file and
     metadata").
   - **Follow-up offer:** end every plan-list presentation (column browse, filter, search)
     with a one-line offer, adapted to context: *"Dispatch any of these, or group some into
     a feature?"* The offer is a question, not an action — nothing fires until the user
     answers (Hard Rules 2/3 stand; entry snapshot is NOT a plan list, so the entry
     protocol's "report, menu, stop" behavior is unchanged).
     - On "dispatch N [and M]": resolve the numbers to planIds internally (never echo UUIDs,
       never ask for one — §4), then `POST /kanban/dispatch` with
       `{"workspaceRoot": "$ROOT", "plan": "<planId>"}` per plan, `targetColumn` omitted.
     - On "group N, M [into <name>]": use §3 feature management (reconcile or
       `/kanban/feature/create`); if no name given, propose one derived from the plans'
       shared capability and confirm.
     - Feature rows in the list are not dispatch candidates — route those to §3 /
       orchestration dispatch, said in one clause rather than silently including them.
     - Empty lists ("_No plans_") get no offer.
   - **Dispatch confirmations:** one sentence from the response fields, leading with the
     agent: `Dispatched "<title>" to <dispatchedAgent> (<role> → <target column>).` Add the
     routing decision in plain words when auto-routed ("auto-routed by complexity"). Times in
     local short form, never raw ISO. If `dispatched` is true but `dispatchedAgent` is empty,
     say exactly that — do not invent a recipient.
   - **Fidelity rule:** every fact in the report must come from THIS response (or the plan
     record it already holds) — never from expectations about what routing *should* have
     done. If the response contradicts the expectation, report the response and flag the
     surprise.
   - **No raw JSON to the user** — extract, translate, keep the raw available on request.
2. **Hard Rule 8 amendment** (both copies): "raw UUIDs" → "raw UUIDs, plan filenames, or
   file paths"; add the one-line dispatch-report template as the positive example and a
   cross-reference to the §2 callout.
3. **One-line cross-reference** from the "Features & Board → Browse / filter" bullet to the
   new callout: `After presenting the list, follow the presentation & follow-up callout above.`

### ⚙️ OUT OF SCOPE
- Any change to `POST /kanban/dispatch` or its response shape — it already returns
  everything needed (`dispatchedAgent` included).
- Any change to the entry protocol (§1) — the entry board snapshot deliberately lists no
  plans and gets no offer.
- Any host/extension code, endpoints, or verbs.
- Auto-dispatch or auto-grouping defaults — the offer must never pre-select an action.
- Renaming registered terminals or adding display names to the registry — `dispatchedAgent`
  is presented verbatim (minus IDE suffix if present); a friendly-name layer is a separate
  concern.
- Other personas (orchestrator, fleet coder) — their reports are logs, not conversation.

## Complexity Audit
### Routine
- One prose callout block + Hard Rule 8 amendment + cross-reference; sync the second copy;
  `npm run mirror:check`.
### Complex / Risky
- **Rule-interaction wording:** the callout must be phrased so it cannot be read as
  licensing eager action — it authorizes *offering after the user requested a list*, nothing
  more. Keep the explicit sentence "the offer is a question; act only on an answer".
- **UUID hygiene:** the numbered-list convention must be stated as the mechanism that keeps
  Hard Rule 8 intact (numbers → planIds resolved internally at action time).
- **Template rigidity vs. adaptability:** the dispatch-report sentence is a shape to adapt,
  not a literal string to fill — otherwise multi-plan dispatches and failures read robotic.
  Give one success example, one failure example, one "dispatched but no agent recorded"
  example.
- **Fidelity-rule phrasing:** must be absolute ("only fields from this response") — the
  observed fabrication came from the agent blending its complexity-routing knowledge into
  the report.

## Edge-Case & Dependency Audit
- **Empty column list** ("_No plans_") — no offer; nothing to dispatch or group.
- **List contains feature rows or epic subtasks** — the offer's dispatch arm applies to plain
  plans only; feature rows route to §3 (orchestration/feature dispatch).
- **Mixed answer** ("dispatch 2, group 3 and 4") — both arms in one reply are fine; execute
  dispatch first (cheap, verifiable), then grouping.
- **Stale numbering** — if the user answers much later or after another list was printed,
  re-confirm by title, not number, when ambiguity exists.
- **Clipboard/prompt-mode columns:** dispatch responses where `mode` is prompt — the report
  must say "prompt copied, no terminal involved", not name an agent.
- **`success:false` / 4xx/409:** report the error's own message (they are written to be
  user-facing), no invented remedy.
- **Multiple plans dispatched in sequence:** one line each, same shape.
- **`dispatchedAgent` with IDE suffix** (e.g. `Lead Coder-Devin (Cursor)`): strip the
  suffix pattern if present, keep the rest verbatim.
- **Dependencies:** none — both target actions are shipped surfaces (`/kanban/dispatch`
  2026-07-10; features reconcile in §3). No interaction with the §6/§6a oversight passes.
  `mirror:check` gates the copies; no catalog impact. Merges cleanly with this feature's
  other SKILL.md edits (they touch §1; this plan owns §2 + Hard Rule 8).

## Dependencies

- None — no `sess_` dependencies; self-contained within this feature.

## Adversarial Synthesis

Key risks: (1) the follow-up offer being generalized by the persona into eager action —
mitigated by the absolute "offer is a question; act only on an answer" sentence and keeping
Hard Rules 2/3 untouched; (2) numbered lists leaking identifiers when the user picks a
number — mitigated by stating number→planId resolution is internal (§4); (3) dispatch-report
fabrication recurring — mitigated by the absolute fidelity rule with a failure example.
Consolidation itself removes the fourth risk: two plans writing adjacent, overlapping
callouts at the same insertion point.

## Proposed Changes
### .agents/skills/switchboard-manage/SKILL.md
Insert after the "Local-first for lists" callout (before "Verb-rail payload trap"), one
consolidated callout:

```markdown
> **Presentation & follow-up: you are a manager, not an API console.**
> **Plan lists** (any list — column browse, filter, search) = numbered titles
> (column/complexity when useful) — never filenames, UUIDs, or paths (they stay internal;
> offer "details on N"). End every non-empty plan list with a one-line offer: *"Dispatch any
> of these, or group some into a feature?"* The offer is a question — act only on an answer
> (Hard Rules 2/3 stand; the entry snapshot is not a plan list and gets no offer). On
> "dispatch N": resolve N → planId internally (§4 — never echo or request UUIDs) and
> `POST /kanban/dispatch` with `{"workspaceRoot": "$ROOT", "plan": "<planId>"}`, targetColumn
> omitted. On "group N, M": use §3 (reconcile or /kanban/feature/create); propose a feature
> name from the plans' shared capability if none was given. Feature rows are not dispatch
> candidates — route those to §3 / orchestration dispatch. Empty lists get no offer.
> **Dispatch reports** = one sentence from THIS response's fields, agent first: *Dispatched
> "Fix sidebar scroll" to **Lead Coder-Devin** (Lead Coder → LEAD CODED, auto-routed by
> complexity).* If `dispatchedAgent` is empty or mode was prompt/clipboard, say so plainly —
> never invent a recipient. Never report a routing/column you expected instead of the one
> returned; contradictions get reported AND flagged. Raw JSON is for you, not the user —
> translate it, keep it available on request. Times in local short form.
```

Hard Rule 8 becomes: "**Never display raw UUIDs, plan filenames, or file paths** in reports.
Resolve them internally when an action needs one; present titles. Plan lists and dispatch
reports follow the presentation & follow-up callout in §2."

In "Features & Board → Browse / filter", append: `After presenting the list, follow the
presentation & follow-up callout above.`

### .claude/skills/switchboard-manage/SKILL.md
Same body edits (mirror frontmatter untouched).

## Verification Plan
### Automated
- `npm run mirror:check` green (both skill copies in sync).
- No catalog/allowlist impact (prose only) — `catalog:check`/`parity:check` unchanged.
### Manual / behavioral
- Invoke the manage skill, ask "what's in CREATED?" → the reply is a numbered list of titles
  only (no filename, UUID, or path) ending with the dispatch-or-group offer, and nothing is
  dispatched; "details on 2" surfaces the file/metadata.
- Answer "dispatch 2" → exactly one `POST /kanban/dispatch` for the second plan's planId;
  no UUID appears in the conversation; the reply is one sentence naming the exact
  `dispatchedAgent` value from the response and the returned role/column (cross-check the
  raw response manually).
- Answer "group 1 and 3 into Payments Cleanup" → a feature is created/reconciled with those
  two subtasks.
- Dispatch to a prompt-mode column → reply says the prompt was copied, names no agent.
- Force a 409 (no terminals) → reply relays the endpoint's error message verbatim in plain
  framing, invents nothing.
- Ask for an empty column → "_No plans_", no offer.
- Entry protocol regression: fresh invocation still shows snapshot + menu + stop, with no
  plan list, no titles, and no offer.

---
**Recommendation:** Complexity 3 → Send to Intern.

## Review Findings

Direct reviewer pass (2026-07-11). Prose-only change in `switchboard-manage/SKILL.md` (both copies): the consolidated Presentation & follow-up callout is inserted between "Local-first for lists" and "Verb-rail payload trap"; Hard Rule 8 extended to "raw UUIDs, plan filenames, or file paths" with a §2 cross-ref; the Browse/filter bullet gains the follow-the-callout pointer. Verified the callout references only real response fields — `dispatchedAgent` is returned at `LocalApiServer.ts:675` and is nullable, and the callout explicitly handles the empty/prompt-mode case ("never invent a recipient"). The offer is phrased as a question with Hard Rules 2/3 left untouched (no eager-action regression), and the numbered-titles→internal-planId mechanism keeps UUID hygiene intact. No CRITICAL/MAJOR findings; no code surface, no fixes required. Validation: `.agents`↔`.claude` manage body byte-identical; no catalog/allowlist impact (`catalog:check` ✅ / `parity:check` ✅). No remaining risks.
