# Settle on one clear vocabulary and sweep both audiences

## Goal

Settle on `POST /terminals/clear` as the single canonical clear endpoint for all agent- and lead-facing text, and sweep every audience surface to remove references to the low-level `ptyClearTerminal` verb. The two endpoints coexist today — `POST /terminals/clear` is the first-class endpoint with server-side invariants (caller protection, mid-turn deferral, structured result), while `POST /terminals/verb/ptyClearTerminal` is a low-level host verb with no invariant enforcement. Teaching the low-level verb to leads and agents bypasses the invariants the first-class endpoint exists to enforce.

### The problem

Two clear vocabularies are in circulation, split by audience:

| Audience | Taught endpoint | Where |
|---|---|---|
| Leads (team-head prompt) | `ptyClearTerminal` | `KanbanProvider.ts:5939`, `:5943` |
| Agents (workflow + skills) | `POST /terminals/clear` | `.agents/workflows/switchboard.md:82,86,89`, `.agents/skills/switchboard-orchestration/SKILL.md:221,223,247,249,253,256`, `.claude/skills/switchboard/SKILL.md:84,88,91` |
| Webview (internal UI) | `ptyClearTerminal` | `terminals.js:9859,9994,10022` |

A lead taught `ptyClearTerminal` calls the low-level verb directly. It clears the named terminal without enforcing the `from` guard (the caller is not excluded), without deferring mid-turn seats, and without returning a structured `{ cleared, deferred, skipped }` result. The first-class endpoint exists precisely to enforce those invariants — but the lead was never told to use it.

The orchestration skill already notes the relationship: *"`POST /terminals/verb/ptyClearTerminal` remains as a low-level host verb used internally, but `POST /terminals/clear` is the canonical agent-facing endpoint."* (`.agents/skills/switchboard-orchestration/SKILL.md:223`). The lead prompt contradicts this.

### Root cause

The shipped clear-endpoint plan scoped its doc changes to three skill files only. The lead-facing prompt in `KanbanProvider.ts` was not swept — it still teaches `ptyClearTerminal` from before the first-class endpoint existed. The webview's internal usage is correct (it is the host's own UI calling the host's own verb) and stays as-is.

## Metadata

**Complexity:** 2
**Tags:** docs, reliability
**Project:** Browser Switchboard

## User Review Required

None — the canonical endpoint is already established (`POST /terminals/clear`); this plan sweeps the surfaces that still teach the old one.

## Complexity Audit

### Routine
- Replacing `ptyClearTerminal` with `POST /terminals/clear` in the lead-facing prompt text in `KanbanProvider.ts`.
- Updating the `switchboard api` command examples to match the canonical endpoint shape.

### Complex / Risky
- None — this is a text sweep with no logic changes.

## Edge-Case & Dependency Audit

**Race Conditions:** None — text-only changes, no runtime behaviour change.

**Security:** Switching leads from the low-level verb to the first-class endpoint is a security improvement — the first-class endpoint enforces the `from` guard (never clears the caller) and mid-turn deferral, which the low-level verb does not.

**Side Effects:** A lead that previously called `ptyClearTerminal` directly will now call `POST /terminals/clear`, which returns a structured result. The lead's prompt text changes but the CLI command shape changes too (`switchboard api POST /terminals/clear '{"name":"...","from":"..."}'` vs `POST /terminals/verb/ptyClearTerminal {"name":"..."}`). The lead must include `from` — the first-class endpoint rejects without it.

**Dependencies & Conflicts:** None — this plan is text-only and does not touch the barrier mechanism or any runtime code path.

## Dependencies

None — this plan is independent and can land in any order relative to the other subtasks in this feature.

## Adversarial Synthesis

Key risks: (1) the lead prompt must include the `from` field in the new command examples — `POST /terminals/clear` rejects without it, and a lead that drops it gets a 400 instead of a clear; (2) the webview's internal `ptyClearTerminal` calls must NOT be swept — they are the host's own UI calling the host's own verb, and routing them through the HTTP endpoint would add a network round-trip for no invariant gain. Mitigations: include `from` in every command example, explicitly scope the sweep to lead-facing and agent-facing text only.

## Proposed Changes

### 1. Sweep the lead-facing prompt in KanbanProvider.ts

At `KanbanProvider.ts:5939`, replace `ptyClearTerminal` with `POST /terminals/clear` in the stand-down instruction. The current text:

> "Manual ptyClearTerminal is for the stand-down case only — a terminal you are putting away without dispatching new work to it."

Replace with:

> "Manual `POST /terminals/clear` is for the stand-down case only — a terminal you are putting away without dispatching new work to it. Include `from` (your terminal name) — the endpoint rejects without it."

At `KanbanProvider.ts:5943`, replace `ptyClearTerminal` with `POST /terminals/clear`:

> "If standing the terminal down without new work, `POST /terminals/clear` it."

### 2. Confirm the agent-facing surfaces are already correct

The following already teach `POST /terminals/clear` as canonical — verify they are unchanged and do not reference `ptyClearTerminal` as an agent-facing command:

- `.agents/workflows/switchboard.md:82,86,89` — correct, no change needed.
- `.agents/skills/switchboard-orchestration/SKILL.md:221-256` — correct, already notes `ptyClearTerminal` is internal-only (`:223`). No change needed.
- `.claude/skills/switchboard/SKILL.md:84,88,91` — correct, no change needed.

### 3. Do NOT sweep the webview's internal usage

`terminals.js:9859,9994,10022` call `POST /terminals/verb/ptyClearTerminal` directly. This is the host's own webview calling the host's own low-level verb — it is not agent-facing or lead-facing. Routing it through the first-class HTTP endpoint would add a network round-trip and buy no invariant (the webview is the host, not a caller that needs protection from itself). Leave as-is.

### 4. Add a contract assertion

Add a source-text assertion to the existing clear-endpoint contract test (or a new one) that grep for `ptyClearTerminal` in `KanbanProvider.ts` returns zero matches — the lead prompt must not teach the low-level verb. This prevents the vocabulary from drifting back.

## Verification Plan

### Automated Tests

1. `grep -n "ptyClearTerminal" src/services/KanbanProvider.ts` returns zero matches — the lead prompt no longer teaches the low-level verb.
2. `grep -n "POST /terminals/clear" src/services/KanbanProvider.ts` returns at least two matches — the canonical endpoint is taught in both the stand-down instruction and the stand-down-if-no-new-work instruction.
3. `grep -n "ptyClearTerminal" src/webview/terminals.js` returns the same three matches as before — the webview's internal usage is unchanged.
4. Existing clear-endpoint contract tests pass unchanged.

### Goal Invariants

- `KanbanProvider.ts` contains zero occurrences of `ptyClearTerminal` — the lead prompt does not teach the low-level verb.
- `KanbanProvider.ts` contains at least two occurrences of `POST /terminals/clear` — the canonical endpoint is taught in both stand-down instructions.
- `terminals.js` still contains three occurrences of `ptyClearTerminal` — the webview's internal usage is not swept.
- Every `POST /terminals/clear` command example in `KanbanProvider.ts` includes a `from` field — the endpoint rejects without it.

**Recommendation:** Complexity 2 → Send to Intern.
