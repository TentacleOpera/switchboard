---
description: "Manage skill presentation layer: plan lists and dispatch confirmations in natural language — titles not filenames/UUIDs, and dispatch reports that name the registered CLI agent from the response's dispatchedAgent field ('Dispatched to Lead Coder-Devin'), built only from fields the API actually returned."
---

# Manager Console: Natural-Language Presentation for Plan Lists and Dispatch Reports

## Goal

The manager persona presents like an API console, not a manager. Observed exchange
(2026-07-11): asked "what plans have been plan reviewed", it listed raw filenames
(`feature_plan_20260710_180001_fix_sidebar_scroll_on_plan_creation.md`) plus full UUIDs; asked
to dispatch, it reported a block of technical fields — and never said the one thing a human
wants to know: **who got the work**. The API response carried
`"dispatchedAgent":"Lead Coder-Devin"` — the registered CLI terminal that actually received
the prompt — and the summary never mentioned it. The skill needs presentation rules: plan
lists are numbered titles; dispatch confirmations are one natural sentence naming the
receiving agent ("Dispatched *Fix Lead Coder → Intern Bounce…* to **Lead Coder-Devin**"),
built strictly from the response fields.

### Problem / root cause

Three distinct failures, all prose-fixable in `switchboard-manage/SKILL.md`:

1. **Raw identifiers leak.** Hard Rule 8 ("Never display raw UUIDs") exists but is being
   violated, and it says nothing about filenames — so the agent prints
   `feature_plan_…_slug.md` + `ID: 4cac0e1b-…` lists. The kanban-state files the agent reads
   contain `topic` titles on every line; the skill never says "present the title, keep the
   rest internal."
2. **Dispatch reports bury the lede.** `POST /kanban/dispatch` returns
   `{success, moved, dispatched, role, routing, dispatchedAgent, dispatchedAt}`
   (`LocalApiServer.ts` dispatch handler; `dispatchedAgent` is the registered terminal/CLI
   name — `KanbanDatabase.ts:55`). The skill documents the endpoint's semantics but gives no
   reporting template, so the agent regurgitates field dumps and omits `dispatchedAgent` —
   the only field that proves a real CLI received the prompt (vs. a silent clipboard fall-through).
3. **Fabricated detail.** In the observed exchange the reply claimed
   `complexity 5 → coder / CODER CODED` while the actual response said
   `role: "Lead Coder", routing: "lead-coded"` — the agent narrated from stale assumptions
   instead of the response. The skill has honesty rules for API *semantics* but no rule that
   the user-facing report must be derived ONLY from the returned fields.

No host/extension code is wrong here — the API already returns everything needed. This is a
skill-prose plan.

## Metadata
- **Tags:** feature, skill, ux, manager
- **Complexity:** 2

## Scope

### ✅ IN SCOPE
1. **Presentation rules block** in `switchboard-manage/SKILL.md` §2 (both copies), near the
   "Local-first for lists" callout:
   - **Plan lists:** numbered, title only (plus column/complexity when relevant). Never
     filenames, never UUIDs, never file paths — those stay internal (Hard Rule 8 extended).
     Offer detail on request ("say 'details on 2' for the file and metadata").
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
   file paths"; add the one-line dispatch-report template as the positive example.

### ⚙️ OUT OF SCOPE
- Any change to `POST /kanban/dispatch` or its response shape — it already returns
  everything needed (`dispatchedAgent` included).
- Renaming registered terminals or adding display names to the registry — `dispatchedAgent`
  is presented verbatim (minus IDE suffix if present); a friendly-name layer is a separate
  concern.
- Other personas (orchestrator, fleet coder) — their reports are logs, not conversation.

## Complexity Audit
### Routine
- Prose block + hard-rule amendment; copy sync; `mirror:check`.
### Complex / Risky
- **Template rigidity vs. adaptability:** the skill must present the sentence as a shape to
  adapt, not a literal string to fill — otherwise multi-plan dispatches and failures read
  robotic. Give one success example, one failure example, one "dispatched but no agent
  recorded" example.
- **Fidelity-rule phrasing:** must be absolute ("only fields from this response") — the
  observed fabrication came from the agent blending its complexity-routing knowledge into
  the report.

## Edge-Case & Dependency Audit
- **Clipboard/prompt-mode columns:** dispatch responses where `mode` is prompt — the report
  must say "prompt copied, no terminal involved", not name an agent.
- **`success:false` / 4xx/409:** report the error's own message (they are written to be
  user-facing), no invented remedy.
- **Multiple plans dispatched in sequence:** one line each, same shape.
- **`dispatchedAgent` with IDE suffix** (e.g. `Lead Coder-Devin (Cursor)`): strip the
  suffix pattern if present, keep the rest verbatim.
- **Dependencies:** none — pure prose. Complements (but does not depend on) any other
  manage-skill presentation work; safely mergeable with other SKILL.md edits in the same
  session. `mirror:check` gates the copies; no catalog impact.

## Proposed Changes
### .agents/skills/switchboard-manage/SKILL.md
New callout in §2 (after "Local-first for lists"):

```markdown
> **Presentation: you are a manager, not an API console.** Plan lists = numbered titles
> (column/complexity when useful) — never filenames, UUIDs, or paths (they stay internal;
> offer "details on N"). Dispatch reports = one sentence from THIS response's fields, agent
> first: *Dispatched "Fix sidebar scroll" to **Lead Coder-Devin** (Lead Coder → LEAD CODED,
> auto-routed by complexity).* If `dispatchedAgent` is empty or mode was prompt/clipboard,
> say so plainly — never invent a recipient. Never report a routing/column you expected
> instead of the one returned; contradictions get reported AND flagged. Raw JSON is for you,
> not the user — translate it, keep it available on request. Times in local short form.
```

Hard Rule 8 becomes: "**Never display raw UUIDs, plan filenames, or file paths** in reports.
Resolve them internally when an action needs one; present titles. Dispatch reports follow the
presentation callout in §2."

### .claude/skills/switchboard-manage/SKILL.md
Same body edits (mirror frontmatter untouched).

## Verification Plan
### Automated
- `npm run mirror:check` green; `catalog:check`/`parity:check` untouched (prose only).
### Manual / behavioral
- "What plans are in PLAN REVIEWED?" → numbered titles only; no filename, UUID, or path in
  the reply; "details on 2" surfaces the file/metadata.
- Dispatch a plan to a terminal-mode column → reply is one sentence naming the exact
  `dispatchedAgent` value from the response and the returned role/column (cross-check the
  raw response manually).
- Dispatch to a prompt-mode column → reply says the prompt was copied, names no agent.
- Force a 409 (no terminals) → reply relays the endpoint's error message verbatim in plain
  framing, invents nothing.
- Regression: entry snapshot unchanged (no titles at entry, per §1).

---
**Recommendation:** Complexity 2 → Send to Intern.
