# `sendToTerminal` Delivers Multi-Line Prompts Line By Line And The Receiving Agent Runs Fragments

## Goal

Make `sendToTerminal` deliver a full implementation prompt intact to a PTY terminal. Today its PTY branch does a raw write, so a multi-line prompt is submitted one line at a time and the receiving agent starts working on the first line while the remainder arrives as interleaved garbage.

This is the delivery primitive that agent-to-agent terminal dispatch depends on. It is a small fix with one non-obvious hazard that must not be got wrong.

### Root cause: one verb, two delivery paths, only one of them correct

`sendToTerminal` (`src/services/TaskViewerProvider.ts:13316`, the arm) resolves its target in two ways and delivers differently in each:

- **Registered-terminal branch** (`:13385`) — `await sendRobustText(terminal, input, paced)`. Correct: chunking and pacing.
- **PTY branch** (`:13339-13347`) — taken first, and the branch every HTTP caller hits, because PTYs live in the pty host child and are not in `_registeredTerminals`:

```js
const writeRes = await this._ptyHostVerb('ptyWrite', { name: target.friendlyName, data: input + '\r' });
```

A raw, unframed, unchunked, unlocked write. The codebase already documents exactly what this does, in the handler for the verb that should have been used (`src/standalone/ptyHost.ts:225-228`):

> *"Dispatch delivery, not a raw write. `sendPromptToPty` owns bracketed-paste framing, chunked writes and the confirm CR — **a raw write submits a multi-line prompt line by line and the agent runs fragments.**"*

`sendPromptToPty` (`src/standalone/ptyPromptDelivery.ts:21`) provides four things the raw write does not:

1. **Bracketed-paste framing** (`\x1b[200~…\x1b[201~`) — without it every `\n` in the prompt is a submit. This is the fault that matters.
2. **256-byte chunking with 30 ms spacing** (`CHUNK_SIZE`/`CHUNK_DELAY_MS`, `ptyPromptDelivery.ts:4-5`) — a single large write can overflow the pty input buffer.
3. **`withTerminalLock`, per-terminal** (`ptyPromptDelivery.ts:9`) — without it a concurrent send splices into an in-flight write. The lock is per-process state in the pty host, which is precisely why `ptySendPrompt` exists as a verb (`ptyHost.ts:230-232`): serialising is only possible on the side that owns the pty.
4. **A second confirm `\r`** for interactive CLI agents matching `/copilot|gemini|agy|claude|windsurf|cursor|cortex/i` — without it the prompt can sit unsubmitted at the input.

This is a known lesson already learned elsewhere in the same file. `TaskViewerProvider.ts:19417` carries the comment *"ptySendPrompt, NOT ptyWrite"* on a different dispatch path. `sendToTerminal` never got the same treatment.

The existing `ptyWrite` choice was deliberate but narrowly scoped — its comment says it mirrors the old `sendText(input, true)` bare line submit and deliberately avoids a `clearBeforePrompt` side effect that would double-clear when `input` is `/clear`. That reasoning is sound for a short slash command and wrong for everything else.

### The decisive fact the original draft missed: every shipped caller sends `/clear`

There are exactly four in-product callers of this verb, all in the sidebar webview, and **all four send a single-line slash command**:

| Site | Payload |
| :--- | :--- |
| `src/webview/implementation.html:1744` | `{ name, input: '/clear', paced: false }` (clear-all-terminals loop) |
| `src/webview/implementation.html:2927` | `{ name: 'Jules Monitor', input: '/clear', paced: false }` |
| `src/webview/implementation.html:2962` | `{ name, input: '/clear', paced: false }` |
| `src/webview/implementation.html:3367` | `{ name: termName, input: '/clear', paced: false }` |

Two consequences, and they invert the original plan's ordering of concerns:

1. **The multi-line corruption bug has no shipped victim today.** It is latent, and it bites only HTTP / agent callers — which is exactly the caller this feature introduces. The fix is still required; it is a forward-looking correctness fix, not a live-incident fix, and it must not disturb the four `/clear` callers.
2. **Applying standing orders unconditionally would be a live regression.** With standing orders registered, the "clear terminals" button would deliver `/clear` followed by a multi-kilobyte standing-orders block to every terminal in the fleet. The original draft anticipated the behaviour change but scored it as benign review noise. Against `/clear`-only callers it is a defect.

Both are resolved by making delivery **content-aware** rather than switching the branch wholesale.

## Implementation

### 1. Route the PTY branch by content, not unconditionally

Replace the single `ptyWrite` call at `TaskViewerProvider.ts:13346` with a two-way split on the input:

- **Control-string path** — input is a single line (no `\n`) **and** starts with `/`. Keep the current `ptyWrite` of `input + '\r'`, unchanged, with no standing orders. This is the four shipped callers, byte-for-byte.
- **Prompt path** — everything else. Call `ptySendPrompt` through `_ptyHostVerb`, passing:
  - `data: input` — the trailing `\r` goes away; `sendPromptToPty` owns the confirm CR.
  - `clearBeforePrompt: false` — explicit, non-negotiable (see the hazard below). `sendToTerminal` has never cleared, and must not begin to.
  - **no** `standingOrders` field — so the chokepoint applies them (see §2).

State the rule in a comment at the branch. It is a content rule, not a caller rule, so a future caller sending `/clear` gets the control-string behaviour without registering anywhere.

> **Superseded:** "Do not reach for the fallback pre-emptively" — the content rule was framed as a contingency to adopt only if a slash command regressed under bracketed-paste framing.
> **Reason:** The four shipped callers of this verb send nothing *but* `/clear`. Making prompt delivery unconditional and treating slash-command survival as a thing to verify afterwards bets the entire shipped surface of the verb on unverified CLI behaviour (does the agent CLI treat a bracketed-paste `/clear` + double CR as a command?) and simultaneously routes a standing-orders block into a clear. The content rule costs one `if` and removes both bets.
> **Replaced with:** The content rule is the primary design. Single-line-and-leading-slash keeps the existing raw write; everything else goes through `ptySendPrompt`.

### 2. Standing orders must be applied on the prompt path

`TaskViewerProvider.ts:379-398` appends standing orders to any `ptySendPrompt` payload passing through `_ptyHostVerb` unless `standingOrders: false` is passed. Its own comment calls it *"the sole extension-host chokepoint"*, covering the HTTP terminals rail, the browser cockpit, and all internal fleet dispatches. Routing the prompt path through `ptySendPrompt` therefore starts applying standing orders to `sendToTerminal` prompts, which today receive none.

**Let them apply on the prompt path.** Do not pass `standingOrders: false` there.

This is a deliberate behaviour change, and it is the correct one. A standing order (`src/services/standingOrders.ts`) is a durable parent→child instruction — the mechanism that carries "when you finish, report back to your parent" to a coder terminal. It is designed to govern *every* prompt a terminal receives; a delivery path that silently strips it is the same defect class as the raw-write bug this plan fixes. Agent-to-agent dispatch depends on it: a coder that receives a work prompt with its callback contract stripped completes the work and reports to nobody, and the driving agent stalls with no diagnosable failure.

The control-string path never reaches `ptySendPrompt`, so it never carries a standing-orders block — which is why the four `/clear` callers are untouched.

Add an optional `standingOrders: { type: 'boolean' }` field to the `sendToTerminal` schema (`src/services/verbSchemas.ts:1232`) so a caller that genuinely needs a bare send can opt out, defaulting to applied. The schema is permissive (PRD contract #5): the field is optional and the arm tolerates its absence.

### 3. The `clearBeforePrompt` hazard — corrected, and still guarded

> **Superseded:** "Switching the PTY branch to `ptySendPrompt` without explicitly passing `clearBeforePrompt: false` sends `/clear` to the target terminal before every prompt, because `TaskViewerProvider.ts:2137-2143` injects the config default (`true`) whenever the caller omits the field."
> **Reason:** Factually wrong for *this* call path. That injection lives inside `handlePtyVerb` (`TaskViewerProvider.ts:2092`), a closure defined in `_startLocalApiServer` and exposed only as the `terminalVerb` option (`:2204`) — i.e. the `/terminals/verb/*` HTTP rail. The `sendToTerminal` arm calls `this._ptyHostVerb(...)` **directly** at `:13346`, one level below that wrapper, so the config default is never injected on this path. The pty host's own default is safe (`payload.clearBeforePrompt === true` at `ptyHost.ts:238` — absent reads as `false`).
> **Replaced with:** Pass `clearBeforePrompt: false` explicitly anyway. The consequence of being wrong is severe and silent — every dispatch would wipe the coder's conversation before delivering, destroying the property that makes iterative correction work at all (a resend goes to a terminal still holding the context of its first attempt), and would present as a coder with no memory of work it did minutes earlier. An explicit `false` costs one field and survives a future refactor that reroutes this branch through `handlePtyVerb`.

**The hazard is real; it just lives elsewhere.** Two live surfaces *do* clear by default, and both are on the path this feature's driving agent will use:

- `POST /terminals/verb/ptySendPrompt` — goes through `handlePtyVerb`, which injects `clearBeforePrompt: true` from config when the field is absent. Any caller driving a coder over this route **must** pass `clearBeforePrompt: false`.
- Standalone's own `sendToTerminal` (see §5) — calls `deliverPrompt(handle, text, getPromptDeliveryOptions())`, and `getPromptDeliveryOptions()` (`bootstrap.ts:198`) reads the same config default of `true`.

Both must be documented in the `terminal-coder-dispatch` skill (separate plan). This plan fixes the second one.

### 4. Report delivery failures

The current PTY branch swallows failure: if `writeRes.success` is falsy it falls through to the registered-terminal lookup and ultimately returns `terminal '<name>' not found or not local` (`:13382`), which misdescribes a delivery failure on a terminal that was found and active. Return the real error instead. A caller driving another agent needs to distinguish "no such terminal" from "the terminal is there and delivery failed."

Concretely: when the PTY lookup **found** an active target and delivery failed, return `{ success: false, error: <the pty host's error> }` immediately rather than falling through. Only a lookup miss continues to the registered-terminal path. `_handleTaskViewerVerb` (`LocalApiServer.ts:2134`) maps `success:false` to HTTP 502, so the caller sees the real reason in the body.

### 5. Standalone parity — the same verb name, a different contract

This is the largest gap in the original draft, and it is the one that makes an agent recipe wrong on one of the two hosts.

`sendToTerminal` exists in **both** hosts with **incompatible** contracts:

| | Extension host | Standalone host (`npx switchboard`) |
| :--- | :--- | :--- |
| Route | `POST /taskViewer/verb/sendToTerminal` (`LocalApiServer.ts:3897`) | `POST /terminals/verb/sendToTerminal` (`bootstrap.ts:1439`, via `handlePtyVerb`); also reachable on the kanban verb route (`bootstrap.ts:1047`) |
| Payload | `{ name, input, paced? }` | `{ terminalName, text }` |
| Missing terminal | `{ success:false, error:"terminal '<name>' not found or not local" }` | **creates one** — `ptyFleetService.create(payload.role \|\| 'coder', terminalName, root)` |
| Delivery | raw `ptyWrite` (this plan's bug) | `deliverPrompt` → `sendPromptToPty` (already correct) |
| Standing orders | none today (fixed by §2) | applied (`deliverPrompt`, `bootstrap.ts:206-224`) |
| `clearBeforePrompt` | never (config default not injected on this path) | **config default, i.e. `true`** — wipes context before every send |

The cross-host consequences: `POST /taskViewer/verb/sendToTerminal` under standalone reaches the shared `TaskViewerProvider` arm, but `_ptyHostPort` is only assigned in `_startLocalApiServer` (`:2034`) and standalone sets `suppressLocalApiServer = true` (`bootstrap.ts:694`), so the PTY branch is skipped, `_registeredTerminals` is empty, the vscode-shim terminal seam finds nothing, and the call fails as "not found or not local". In the other direction, `POST /terminals/verb/sendToTerminal` under the extension host has no case in `handlePtyVerb` and falls through to the pty host's `default`, which rejects the verb. **The two hosts have disjoint working routes for the same verb name.**

Bring standalone into line, without breaking its existing contract:

- **Accept both payload shapes.** Read `payload.name ?? payload.terminalName` and `payload.input ?? payload.text`. Additive; no existing caller breaks.
- **Apply the same content rule.** Single-line-leading-slash → `handle.write(text + '\r')` under the lock (`clearPty` shows the shape); everything else → `deliverPrompt` with `clearBeforePrompt: false`.
- **Pin `clearBeforePrompt: false`.** Do not use `getPromptDeliveryOptions()` here — clearing before a send is the board-dispatch contract, not this verb's, and the extension host has never done it.
- **Keep auto-create, but make it visible.** Return `created: true` in the body when the terminal was created rather than found. Removing auto-create is a behaviour change on a surface that may already be in use; making it *detectable* costs nothing and lets the driving agent refuse to talk to a terminal it accidentally spawned. Document the flag in the skill.
- **Do not add a `/taskViewer/verb/sendToTerminal` → pty bridge in standalone.** That is a second delivery path into the same fleet and re-creates exactly the divergence this section is closing. The skill names the per-host route instead (and prefers the portable `ptySendPrompt` route for agent use).

### 6. Do not touch

- `_attemptDirectTerminalPush` and the registered-terminal branch (`sendRobustText`) — out of scope, unchanged.
- `ptyWrite` itself (`ptyHost.ts:173`) — it is a legitimate raw-write primitive; the bug is the caller's choice of verb.
- The pty-host verb surface — no new verbs. `src/test/pty-route-surface-contract.test.js:245` asserts the host serves `ptySendPrompt` via `sendPromptToPty`; this plan adds a caller, not a route.

## Metadata

**Tags:** bugfix, backend, reliability, cli
**Complexity:** 5
**Project:** Browser Switchboard

## User Review Required

None. The content rule, the standing-orders scope, and the standalone payload tolerance are all decided above.

## Complexity Audit

### Routine
- Swapping one verb call for another inside a single arm.
- Adding one optional boolean to a verb schema.
- Returning a real error instead of falling through.

### Complex / Risky
- **Two hosts, two implementations, one verb name.** The fix must land in `TaskViewerProvider.ts` *and* `bootstrap.ts:1439` or the capability works on one host and misleads on the other.
- **Behaviour change on a shipped surface.** Standing orders begin applying to a verb that never carried them. The content rule is what keeps the four `/clear` callers byte-identical; get the rule wrong and the "clear terminals" button starts pasting a standing-orders block into every terminal in the fleet.
- **A silent-by-construction failure mode.** If `clearBeforePrompt` ever resolves to `true` on this path, nothing errors — the coder simply forgets everything, and the symptom appears one turn later as a confused agent.

## Edge-Case & Dependency Audit

**Race Conditions**
- Concurrent sends to one terminal are serialised by `withTerminalLock` in the pty host — but only for the prompt path. Two concurrent `/clear` control-string writes still bypass the lock, exactly as today. Acceptable: that is the pre-existing contract for a 7-byte write, and narrowing it is not this plan's scope.
- `_ptyHostVerb` calls itself (`ptyListTerminals`) while resolving standing orders. The inner call is not a `ptySendPrompt`, so there is no recursion into the append block.
- The standing-orders resolver reads the live terminal set on every send; a terminal that exits between resolution and delivery yields a dropped order, not an error. Pre-existing.

**Security**
- No new endpoint, no new auth surface. `_handleTaskViewerVerb` already gates on `_checkAuth(req, true)`.
- The prompt path carries user/agent text into a PTY under bracketed-paste framing, which is *safer* than the current raw write (framing suppresses embedded newline submits).
- Standing-orders text is capped server-side (`MAX_INSTRUCTION_CHARS = 2000`, `MAX_BLOCK_CHARS = 4000`) and `validateInstruction` rejects an instruction containing the marker, so a malicious order cannot forge a second block.

**Side Effects**
- Prompts sent via `sendToTerminal` now carry the standing-orders block; visible in terminal scrollback. Intended.
- Delivery latency rises for the prompt path: 30 ms per 256-byte chunk + a 100 ms settle + up to 200 ms for the CLI confirm CR. A 4 KB prompt takes roughly half a second. Acceptable, and the same cost every other dispatch path already pays.
- Standalone callers using `{terminalName, text}` are unaffected; the new `created` flag is additive.

**Dependencies & Conflicts**
- No other plan in this feature edits `TaskViewerProvider.ts`'s `sendToTerminal` arm or `bootstrap.ts`'s pty verb router. The Agent Groups plan changes what standing orders are *registered*; this plan changes whether they are *applied*. Different files, complementary concerns — verify them together, not separately.
- `verbSchemas.ts` is shared across all provider work (PRD orchestration discipline): append the one optional field, do not restructure the block.

## Dependencies

- None blocking. This plan is the delivery primitive; it depends on nothing else in the feature.
- Consumed by: `feature_plan_20260812120000_head-agent-terminal-dispatch-pattern.md` (documents this verb's contract) and `feature_plan_20260812120400_agent-groups-in-agents-tab.md` (registers the standing orders this path applies).

## Adversarial Synthesis

Key risks: a wholesale switch to prompt delivery would regress the four shipped `/clear` callers and paste standing orders into a context reset; the `clearBeforePrompt` default is a silent context-wipe if it ever resolves true on this path; and the verb has two incompatible host implementations, so a one-host fix produces a capability that appears to work and then fails on the other. Mitigations: a content rule that leaves single-line slash commands on the existing raw write, an explicit `clearBeforePrompt: false` on every prompt-path send in both hosts, payload-shape tolerance plus a `created` flag in standalone, and a real delivery error instead of a misleading "not found".

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** The `sendToTerminal` arm at `:13316`; PTY branch at `:13339-13347`. The standing-orders chokepoint is `_ptyHostVerb` at `:379-398`. The config-default injection that does *not* apply here is `handlePtyVerb` at `:2136-2143`.
- **Logic:** After resolving an active PTY target, branch on content. `isControlString = !input.includes('\n') && input.trimStart().startsWith('/')`.
- **Implementation:**
  - Control string → existing `_ptyHostVerb('ptyWrite', { name: target.friendlyName, data: input + '\r' })`.
  - Otherwise → `_ptyHostVerb('ptySendPrompt', { name: target.friendlyName, data: input, clearBeforePrompt: false, ...(data.standingOrders === false ? { standingOrders: false } : {}) })`.
  - Either way, if the result is falsy-success, return `{ success: false, error: res?.error || 'delivery failed' }` instead of falling through to the registered-terminal lookup.
  - Comment the rule and the reason (`/clear` is the shipped payload; framing a control string is a bet on CLI behaviour).
- **Edge Cases:** empty `input` (schema requires a string, not a non-empty one — an empty prompt path send is a no-op paste; leave it); leading whitespace before `/`; a multi-line payload that starts with `/` (prompt path — correct, it is a prompt).

### `src/services/verbSchemas.ts`
- **Context:** `TASK_VIEWER_VERB_SCHEMAS.sendToTerminal` at `:1232`.
- **Logic:** Add `standingOrders: { type: 'boolean' }` (optional).
- **Implementation:** One field. Do not make `paced` or anything else required — a schema that rejects a valid webview payload is a regression on shipped installs (PRD contract #5).
- **Edge Cases:** Older webview payloads omit the field; absence must mean "apply".

### `src/standalone/bootstrap.ts`
- **Context:** `case 'sendToTerminal'` at `:1439` inside the pty verb router; `deliverPrompt` at `:206`; `getPromptDeliveryOptions` at `:198`.
- **Logic:** Accept both payload shapes, apply the content rule, pin `clearBeforePrompt: false`, report `created`.
- **Implementation:**
  ```js
  const name = payload.name ?? payload.terminalName;
  const text = payload.input ?? payload.text ?? '';
  let handle = ptyFleetService.get(name);
  let created = false;
  if (!handle) { handle = await ptyFleetService.create(payload.role || 'coder', name, root); created = true; }
  // content rule: single-line leading-slash stays a bare submit
  if (!text.includes('\n') && text.trimStart().startsWith('/')) { handle.write(text + '\r'); }
  else { await deliverPrompt(handle, text, { clearBeforePrompt: false }, payload.standingOrders !== false); }
  return { success: true, ...(created ? { created: true, terminalName: handle.friendlyName } : {}) };
  ```
- **Edge Cases:** a create that throws (pty pool exhausted) must return `{success:false,error}` rather than dereferencing a null handle; `name` absent under either key → `{success:false,error:'invalid terminal name'}`.

## Verification Plan

Manual verification against a live install (per session directive, no compilation or automated-test steps here).

1. **The actual bug.** Send a multi-KB, multi-line implementation prompt via `POST /taskViewer/verb/sendToTerminal` with `{name, input}` to a live Claude Code PTY terminal. Confirm it arrives as a single prompt and the agent begins one coherent turn. Capture the *current* behaviour first so the comparison is anchored on observed output, not on this plan's description.
2. **The four shipped callers are byte-identical.** Click "clear terminals" (and the two single-terminal clear buttons). Confirm each terminal receives exactly `/clear` + CR — no bracketed-paste wrapper, no standing-orders block, no double CR — with a standing order registered for that terminal.
3. **Context is preserved.** Send two multi-line prompts in succession to the same terminal; confirm the second turn still has the first's context. Then set `switchboard.terminal.clearBeforePrompt` to `true` explicitly and repeat, confirming the behaviour is unchanged — this proves the config default cannot reach this path.
4. **Concurrency.** Send two long prompts to the same terminal simultaneously; confirm they serialise and neither is spliced into the other.
5. **Registered-terminal branch unaffected.** Confirm the `sendRobustText` path still behaves identically, including the `paced` flag.
6. **Standing orders apply, and opt out.** With an order registered for a parent/child pair, confirm a multi-line `sendToTerminal` prompt to that child arrives carrying the block delimited by `STANDING_ORDERS_MARKER`. Then confirm `standingOrders: false` suppresses it. Verify on the wire (terminal scrollback), not by inspecting config.
7. **Error reporting.** Kill a terminal's pty mid-flight (or target one whose `status !== 'active'`) and confirm a delivery failure on a *found* terminal returns a delivery error at HTTP 502, while an unknown name still returns not-found.
8. **Standalone parity.** Under `npx switchboard`: send `{terminalName, text}` and `{name, input}` to `POST /terminals/verb/sendToTerminal`; confirm both work, that a multi-line prompt does not clear the terminal first, that `/clear` still clears, and that a send to an unknown name returns `created: true` with the new terminal's name.

## Outstanding Questions

- **[user]** Should standalone's auto-create-on-missing-terminal be retired outright rather than merely surfaced via `created: true`? — proceeding on the assumption that it stays (removing it is a behaviour change on a possibly-in-use surface, and the flag makes it safe for an agent to detect and refuse).

## Recommendation

Complexity 5 → **Send to Coder.**

## Completion Report

**Status:** Complete. All three files modified.

### Changes made

| File | Change |
| :--- | :--- |
| `src/services/TaskViewerProvider.ts` | `sendToTerminal` PTY branch: content-aware delivery. Single-line leading-slash (`/clear`) → `ptyWrite` (byte-identical to shipped behaviour). Everything else → `ptySendPrompt` with `clearBeforePrompt: false` pinned and `standingOrders` opt-out. Failed delivery on a found, active terminal now returns the real error instead of falling through to the registered-terminal lookup. |
| `src/services/verbSchemas.ts` | Added optional `standingOrders: { type: 'boolean' }` to `sendToTerminal` schema. |
| `src/standalone/bootstrap.ts` | `sendToTerminal` case: accepts both payload shapes (`{name, input}` and `{terminalName, text}`). Content rule mirrors the extension host. `clearBeforePrompt` pinned false for prompts. Auto-create now surfaces `created: true` + `terminalName` in the response. Create failure returns a real error. |

### Key design decisions

- **Content rule, not wholesale verb swap.** The four shipped callers all send `/clear`; a wholesale swap to `ptySendPrompt` would paste a standing-orders block into every `/clear`. The content rule (`!includes('\n') && trimStart().startsWith('/')`) keeps the shipped callers byte-identical.
- **`clearBeforePrompt: false` pinned explicitly.** Both hosts inject the config default (`true`) when the field is absent. An explicit `false` survives a future refactor that reroutes through `handlePtyVerb`.
- **Error reporting.** A delivery failure on a found, active terminal returns the pty host's error at HTTP 502, instead of falling through to the registered-terminal lookup which would misdescribe a delivery fault as "not found or not local".

### Verification

- TypeScript compiles clean (5 pre-existing TS2835 errors in unrelated files; none from this change).
- `deliverPrompt` 4th argument (`applyOrders = true`) confirmed — `payload.standingOrders !== false` correctly gates standing-order application.
- Both payload shapes (`{name, input}` and `{terminalName, text}`) handled additively in standalone; no existing caller breaks.

## Review Findings

Implementation matches the plan and survived the regression sweep: the content rule (`!input.includes('\n') && input.trimStart().startsWith('/')`) keeps the four shipped `/clear` callers on the raw `ptyWrite` byte-for-byte; the prompt path pins `clearBeforePrompt: false` and honours the `standingOrders: false` opt-out through `_ptyHostVerb`'s chokepoint; a delivery failure on a found, active terminal now returns the pty host's real error instead of falling through to "not found or not local"; standalone accepts both payload shapes and surfaces `created: true`. `deliverPrompt`'s 4th argument gates orders correctly. No fixes were required in this subtask.

**One correction to the plan's own reasoning, not its code:** §2 justified applying standing orders as "the mechanism that carries 'when you finish, report back to your parent' **to a coder terminal**". `applyStandingOrders` delivers a block to the order's `parent`, not its `child` — so this path only carries a callback to a child if the order is registered with the child as `parent`. The code change is still correct and required; the rationale was based on an inverted model, corrected in the sibling skill and Agent Groups plans.

**Validation:** typecheck clean (5 pre-existing TS2835 only); `test:contract:pty-route-surface` (including "all three ptySendPrompt delivery paths honour an EXPLICIT clearBeforePrompt"), `delegate`, `multi-parent-terminals`, `paste-attribution` all green. **Remaining risk:** no automated test covers the content rule itself — a future edit could route `/clear` through `ptySendPrompt` and paste a standing-orders block into every context reset with every gate still green.
