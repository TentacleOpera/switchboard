# A Lead-Dispatched Plan Is Never Registered, So Every Backstop Downstream Is Blind

## Goal

Register the seat→plan dispatch record **at the delivery layer**, by parsing the plan identity already carried in the prompt, so `ptySendPrompt` writes the same `dispatched_terminal` / `dispatched_at` a board dispatch writes. Today that record exists only if the caller opts in — either a separate `attributePastedPrompt` `curl` beforehand, or a `dispatch` field on the send — and every mechanism that reads it — the stall sweep, the turn-end notifier, and the commit trailers' plan ids — silently degrades when it doesn't. Make registration a property of the layer, with the existing opt-in path left intact and authoritative wherever it is used.

### Problem analysis and root cause

**The record has exactly two writers.** `dispatched_terminal` is written by `KanbanDatabase.updateDispatchInfoByPlanFile` (`:9696`, UPDATE at `:9710`) and `attributePasteDispatch` (`:9734`, UPDATE at `:9741`). The board dispatch path and the `attributePastedPrompt` verb (`KanbanProvider.ts:10156`, standalone twin `bootstrap.ts:1763`) are their callers.

> **Superseded:** *"…and neither is on the fleet path. `ptySendPrompt` writes nothing."*
> **Reason:** False at HEAD, and the correction changes what this plan must build. `ptySendPrompt` **does** register — on both hosts — when the caller supplies a `dispatch` object in the payload. `TaskViewerProvider._ptyHostVerb:488-532` reads `payload.dispatch`, pulls `planId` / `planFile` / `role` off it, and calls `this._kanbanProvider.handleServiceVerb('attributePastedPrompt', …)`, hard-failing the whole send when `attributed === 0`. `bootstrap.ts`'s `ptySendPrompt` case carries the same branch. So the fleet path is not un-instrumented; it is instrumented **opt-in**, behind a payload field the caller must know to set.
> **Replaced with:** The defect is unchanged in substance and narrower in statement: registration on the fleet path is a **property of the caller's payload**, not of the delivery layer. A lead that sends a dispatch prompt without a `dispatch` field — which is every lead following `terminal-coder-dispatch` §3.5, since that skill documents a separate `attributePastedPrompt` `curl` instead — registers nothing. This plan closes that hole by parsing the identity already present in the prompt text, and **defers to the existing branch whenever `payload.dispatch` is set** (see the `hasDispatch` guard under Proposed Changes). Two writers on one row in one send is not a second safety net; it is a re-stamped `dispatched_at` and a race between two timestamps.

**So the mechanism is documented as an agent's chore.** `.agents/skills/terminal-coder-dispatch/SKILL.md` §3.5 exists solely to compensate:

> On 2026-08-16 a coder with a correctly-oriented standing order finished its subtask and **sent nothing back**; the head sat idle for eleven minutes and would have sat idle indefinitely. … `ptySendPrompt` writes no record, so the sweep never saw the dispatch and the notifier never fired.
>
> **Register BEFORE you send, not after.** … `attributed: 0` is a failed registration, not a success.

An incident, a mandatory ordering rule, a return-code check, and a retry loop — all of it prose an agent must read, remember and execute correctly on every dispatch. That is the weakest possible gate for a mechanism three separate backstops depend on. The seat safeguard block solved the same class of problem the right way, and its own comment says so: it *"rides the delivery layer precisely so behaviour does not depend on what a lead remembers to type."* Registration was left on the other side of that line.

**Everything downstream inherits the weakness.**

| Consumer | Reads | Fails as |
| :--- | :--- | :--- |
| Stall/blocked sweep | `getActiveDispatchedByTerminal` | head waits forever (the 2026-08-16 incident) |
| Turn-end `completed` notice | same | completion never observed |
| Commit trailer plan ids | same | `Switchboard-Stage` with no `Switchboard-Plan` |
| Reviewer's review unit | the trailers above | no commit resolves; review falls back to a dirty tree |

**The parser already exists — on the wrong side of the seam.** `extractPastedDispatchIdentity` (`src/webview/terminals.js:7438`) pulls plan identity straight out of prompt text: it strips bracketed-paste and ANSI wrappers, requires `PLANS TO PROCESS:`, rejects `PLANS TO DISCUSS:` (consultation prompts are not dispatches), then scrapes `PLAN_ID=` and `Plan File:`. It is armed on xterm's `onData`, so it covers an operator **pasting into a pane** and covers nothing that arrives over HTTP. The fleet path — the one an orchestrator and every lead actually uses — has no equivalent.

**And the existing parser's id regex is broken.** `const idRe = /\bPLAN_ID=(\d+)/g` matches digits only. Plan ids are UUIDs:

```
$ sqlite3 .switchboard/kanban.db "select plan_id, plan_file from plans where plan_file like '%sweep-the-whole%';"
b93fd9a7-bd7a-4e8a-9856-1643f69604f4|.switchboard/plans/agent-commits-sweep-the-whole-shared-tree.md

$ node -e "…/\bPLAN_ID=(\d+)/g against 'PLAN_ID=6bef84f4-726d-437c-8ad2-dbc3f34af9d9'…"
captured planIds: ["6"]
```

It captures `"6"`. That junk id resolves nothing, and the call silently survives on the `planFiles` fallback — which is why nobody has noticed. The host-side parser must not copy this regex, and the client's should be corrected in the same pass since both are now one behaviour.

**Blast radius.** One parse and one conditional DB write on the `ptySendPrompt` path. No verb, schema, prompt-text or board behaviour changes. A prompt that carries no plan identity writes nothing and is byte-identical to today.

## Metadata

**Complexity:** 5
**Tags:** bugfix, reliability, backend, database

## User Review Required

None. The parser's home, the idempotency rule, the fire-and-forget ordering and the regex correction are decided below.

## Complexity Audit

### Routine

- Moving an existing pure function into a shared module and fixing one regex.
- One guarded DB write beside writes the same function already performs.

### Complex / Risky

- **This writes to the DB on the prompt-delivery path, which currently only reads.** `_ptyHostVerb` and `deliverPrompt` read config and compose text; they do not mutate plan rows. Adding a write means a slow or failing write must never delay or block a send. **Fire-and-forget, after the send is dispatched** — `void register(...).catch(() => {})`, in the style of the existing turn-end reports mirror (`void writeOrchestratorReport(...).catch()`, *"never awaited ahead of the pty send, never able to suppress it"*). A lost registration degrades a backstop; a blocked send loses the dispatch.

- **`dispatched_at` ordering is load-bearing and inverts the completion test.** The skill's own warning: completion is `plan-file mtime > dispatchedAt`, so registering *after* the coder has already written inverts the compare and the completion is invisible. Fire-and-forget must therefore still stamp a timestamp taken **before** the send, not at write time. Capture the ISO stamp at parse time and pass it in.

  > This requires a stamp parameter the current writers do not accept — both hardcode `new Date().toISOString()` inside the UPDATE. Add an optional `dispatchedAt` to `attributePasteDispatch`, defaulted to now so every existing caller is byte-identical.

- **Re-dispatch and non-dispatch traffic must not churn the record.** The seat block rides *every* `ptySendPrompt`, including coder→lead reports and operator chatter. The parser's `PLANS TO PROCESS:` requirement and `PLANS TO DISCUSS:` rejection are what keep those out, and they are the reason to reuse the existing function rather than write a looser one. A report that happens to quote its dispatch prompt is the residual risk; it re-stamps `dispatched_at` for a plan already dispatched to that same terminal, which resets the stall clock and is harmless.

- **The existing `payload.dispatch` branch is the first writer, and this plan must yield to it — not race it.** Both hosts already register when the caller sets `dispatch` (`TaskViewerProvider.ts:488-532`; the matching case in `bootstrap.ts`'s `ptySendPrompt`). That branch is **strict**: it returns `{success:false}` and refuses the send when `attributed === 0`, which is a deliberate contract for callers that know their plan id. This plan's parse-based path is the opposite — best-effort, never able to fail a send. Running both on one request would (a) issue two UPDATEs to the same row, (b) let the fire-and-forget write land *after* the strict one and overwrite its `dispatched_at`, and (c) make the strict branch's hard-fail meaningless, because the lenient path would quietly re-register whatever the strict one rejected. **Guard on `hasDispatch`: parse and register only when `payload.dispatch` is absent.** The explicit field stays the precise path; the parser is the backstop for callers that do not use it.

- **Two hosts, one parser.** The function must live somewhere both `TaskViewerProvider.ts` and `standalone/bootstrap.ts` import, and it must stay pure (no `vscode`, no DB) so it is testable and so the standalone bundle does not drag in the extension. `src/services/` beside the other host-agnostic helpers.

- **The client copy becomes a mirror.** `terminals.js` cannot import TypeScript, so its copy stays — and joins the set of hand-copied prose/logic this codebase already pins with byte-equality contract tests. Pin it the same way, or the two parsers drift and paste-attribution and fleet-attribution start disagreeing about what a dispatch is.

## Edge-Case & Dependency Audit

**Race Conditions** — two leads dispatching different plans to the same seat in quick succession: the newest write wins, and `getActiveDispatchedByTerminal` is `ORDER BY dispatched_at DESC LIMIT 1` anyway, so the read matches the write. Concurrent dispatch to *different* seats touches different rows.

**Security** — the parsed values reach a parameterised `UPDATE` through the shipped writers; no string interpolation into SQL. Plan resolution is scoped by `workspace_id`, so a prompt naming a plan file from another workspace resolves nothing rather than stamping a foreign row.

**Side Effects** — one extra `UPDATE` per genuine dispatch send. Prompts with no plan identity (the majority of seat traffic: reports, chatter, turn-end notices) parse to `null` and write nothing.

**Migration** — none. Existing columns, existing writers, existing config. Records already written by the manual path are indistinguishable from ones written here.

**Dependencies & Conflicts** — touches `src/services/TaskViewerProvider.ts` (`_ptyHostVerb`, `:487-644`), `src/standalone/bootstrap.ts` (`deliverPrompt` `:246-319` and the `ptySendPrompt` case), a new shared module under `src/services/`, `src/services/KanbanDatabase.ts` (one optional parameter), and `src/webview/terminals.js` (regex fix at `:7463`). **Same two function bodies as `a-team-commits-once-as-its-head.md` and `lead-dispatched-commits-carry-no-stage-trailers.md`** — serialise all three.

`terminals.js` is also touched by `agent-commits-sweep-the-whole-shared-tree.md`, but in a disjoint region (`GIT_SAFETY_DIRECTIVE_CLIENT` at `:8831` vs. the parser at `:7452`). Still one stream per file — sequence, do not parallelise.

## Dependencies

- None as a prerequisite — this plan stands alone and improves three existing mechanisms immediately.
- `lead-dispatched-commits-carry-no-stage-trailers.md` consumes its output (reliable plan ids for the head's commit trailers). Land this **first**; the trailer plan is materially weaker without it.

## Adversarial Synthesis

**Risk summary.** The dominant risk is putting a DB write in front of prompt delivery — an awaited or throwing registration converts a degraded backstop into a lost dispatch, which is strictly worse than the bug being fixed. Second is racing the writer that already exists: `payload.dispatch` registers strictly and refuses the send on failure, and an unguarded second write lands after it, overwrites its `dispatched_at`, and silently re-registers a dispatch that branch deliberately rejected — a defect that no functional test surfaces, because both writers produce a plausible row. Third is the timestamp: fire-and-forget writes land after the send, and stamping at write time inverts the `mtime > dispatchedAt` completion compare that the whole notifier depends on. Fourth is copying the client's `\d+` plan-id regex, which silently captures a single digit from a UUID and has been surviving on the plan-file fallback. Mitigations: fire-and-forget with the stamp captured before the send and passed in; a `hasDispatch` guard pinned by a source-text assertion so the two writers are mutually exclusive by construction; an optional `dispatchedAt` parameter defaulted to now so existing callers are untouched; the regex corrected in both copies and pinned by a byte-equality contract test.

## Proposed Changes

### `src/services/dispatchIdentity.ts` *(new)* — the parser, host-agnostic

- **Logic:** port `extractPastedDispatchIdentity` verbatim except for the id regex. Keep the ANSI/bracketed-paste stripping (harmless on HTTP input, and it keeps the two copies identical), the `PLANS TO PROCESS:` requirement, the `PLANS TO DISCUSS:` rejection and the `PASTE_SCAN_MIN_CHARS` floor.

```ts
const idRe = /\bPLAN_ID=([0-9a-fA-F-]{8,})/g;   // UUIDs, not \d+
```

- **Edge Cases:** returns `null` — never an empty object — when neither ids nor files are found, so the caller's guard is a single truthiness check.

### `src/services/KanbanDatabase.ts` — accept an explicit stamp

- **Context:** `attributePasteDispatch` (`:9734-9744`) hardcodes `new Date().toISOString()` in both stamp positions (`:9741-9742`).
- **Logic:** add `dispatchedAt?: string` to the `info` object, defaulted to `new Date().toISOString()`. Every existing caller is byte-identical.

### `src/services/TaskViewerProvider.ts` — register on the extension delivery path

- **Context:** `_ptyHostVerb`'s `ptySendPrompt` branch (`:487`), where `db` (`:542`), `payload.name` and the seat role (`:593`) are already resolved. `hasDispatch` is already computed at `:488`.
- **Logic:** parse the **original** `payload.data` — before `ensureDispatchProtocolDirectives` rewrites it at `:530` and before the seat block / standing orders are appended at `:604` / `:634` — capture `dispatchedAt` at that moment, and after the proxied send is dispatched:

```ts
if (!hasDispatch) {
    void registerDispatch(db, wsId, payload.name, role, identity, dispatchedAt).catch(() => {});
}
```

  Resolve plans by `planIds` first, falling back to `planFiles`, mirroring the `attributePastedPrompt` arm.

- **Edge Cases:** never awaited ahead of the send; a throw is swallowed; `identity === null` skips entirely; `hasDispatch` skips entirely, so the strict branch at `:488-532` keeps sole ownership of the row whenever a caller names its plan explicitly.

### `src/standalone/bootstrap.ts` — same on the standalone host

- **Context:** the `ptySendPrompt` case, which carries the matching `payload.dispatch` branch, and `deliverPrompt` (`:246-319`), keyed on `handle.friendlyName`. Single-root, so `wsId` is unambiguous.
- **Logic:** identical shape, identical ordering, identical `hasDispatch` guard — parse and stamp before `sendPromptToPty` (`:318`), register after.
- **Edge Cases:** `deliverPrompt` is also called directly by the standalone board path and by `sendToTerminal` (`:1825`), which never set `dispatch`. Those calls carry no `PLANS TO PROCESS:` unless they genuinely are a dispatch, so the parser's own guard is what gates them — do not add a second caller-shape test.

### `src/webview/terminals.js` — fix the mirror's regex

- **Logic:** apply the same `[0-9a-fA-F-]{8,}` correction to `extractPastedDispatchIdentity` (function at `:7452`, regex at `:7463`). The paste path has been discarding real plan ids and surviving on the file fallback; this is a defect in shipped code, not collateral.

### `src/test/terminal-plan-attribution-contract.test.js` — extend

- **Logic:** add —
  1. The shared parser returns the full UUID for `PLAN_ID=6bef84f4-726d-437c-8ad2-dbc3f34af9d9` — the regression test for `"6"`.
  2. A prompt with `PLANS TO DISCUSS:` returns `null`.
  3. A prompt with no `PLANS TO PROCESS:` returns `null`.
  4. Byte-equality: the client mirror's parser body matches the shared module's, in the style of the existing mirror contract tests.
  5. Source-text: neither host `await`s the registration call, and both capture the stamp before `sendPromptToPty` / the proxied send.
  6. `attributePasteDispatch` with no `dispatchedAt` produces the same SQL parameters as before this change.
  7. Source-text: both hosts guard the registration on the absence of `payload.dispatch` — the parse-based path is unreachable when the strict branch has already run. Assert the guard, not merely that the call exists; a missing guard is invisible in every functional test because both writers produce a correct-looking row.

## Verification Plan

### Automated Tests

1. `npm run lint`.
2. The six new cases in `terminal-plan-attribution-contract.test.js`; all existing cases pass unchanged.
3. `paste-attribution-contract.test.js` passes unchanged — the shipped paste path keeps its behaviour apart from the corrected id capture.

### Manual

4. `POST /terminals/verb/ptySendPrompt` a real board-composed dispatch prompt to a coder seat **without** calling `attributePastedPrompt` first. Query `plans` — `dispatched_terminal` is that seat and `dispatched_at` is stamped.
5. Confirm the ordering: the plan file's mtime after the coder writes its report is **later** than the stored `dispatched_at`, and the turn-end `completed` notice fires.
6. Send an ordinary message (no `PLANS TO PROCESS:`) to the same seat: no row is touched.
7. Send a consultation prompt containing `PLANS TO DISCUSS:`: no row is touched.
8. Kill the DB mid-send (or point at a read-only file): the prompt still arrives in the terminal, unchanged and undelayed.
9. Paste a dispatch prompt into a pane by hand: attribution resolves by `planId` now, not only by `planFiles`.
10. Send the same dispatch prompt **with** a `dispatch: {planId, planFile, role}` payload field: exactly one UPDATE runs (the strict branch), and `dispatched_at` matches the value that branch wrote — the parse-based path did not re-stamp it.
11. Send a `dispatch` payload naming a plan that resolves nothing: the send still returns `{success:false, attributed:0}` as it does today. The parser must not rescue it into a success.
12. Repeat 4–6 on the standalone host.

---

**Recommendation:** Complexity 5 → **Send to Coder.**
