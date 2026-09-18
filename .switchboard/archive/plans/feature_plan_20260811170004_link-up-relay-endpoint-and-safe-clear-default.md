# Link-Up Wipes The Recipient's Context And Reads Like An API Tutorial

## Goal

Make link-up safe to use mid-task. Replace the hand-rolled curl recipe with a first-class relay endpoint, and remove the fail-dangerous `/clear` default that can destroy the receiving agent's work.

### Problem 1: the relay can wipe the terminal it delivers to

Reported from UAT: *"the link-up prompt clears the terminal before sending, so is completely useless and dangerous. You can't use it mid-task because it will wipe the progress."*

The panel's own send is safe. `sendLinkMessage` (`src/webview/terminals.js:7518`) passes an explicit `false` (`:7550-7554`), with a comment explaining exactly why:

```js
// EXPLICIT false. Omitting this applies the config default (true) in BOTH hosts —
// TaskViewerProvider and bootstrap — which writes /clear to the PARENT and destroys
// the very context it is being asked to hand over.
clearBeforePrompt: false
```

The danger is one hop further on. The relaying agent does not call the API the way the panel does — it runs the shell recipe the prompt hands it, and that recipe's `clearBeforePrompt` is a value the *agent* has to remember to include. The moment it doesn't:

```ts
if (verb === 'ptySendPrompt' && payload && payload.clearBeforePrompt === undefined) {
    payload = { ...payload,
        clearBeforePrompt: vscode.workspace.getConfiguration('switchboard')
            .get<boolean>('terminal.clearBeforePrompt', true),   // ← default TRUE
        ... };
}
```
— `TaskViewerProvider.ts:2094`

An **absent** field means `/clear`. The prompt asks the agent to reproduce a three-command `python3`/heredoc/curl sequence exactly; any simplification — the single most likely thing an agent does with a verbose recipe — silently arms a context wipe on the recipient. The failure is invisible at the call site and destroys the work of a terminal that was never consulted.

### Root cause

Two compounding decisions:

1. **The relay has no API of its own.** There is no "send a message from terminal A to terminal B" endpoint. Link-up simulates one by instructing an LLM to hand-assemble a `ptySendPrompt` call, which makes correctness depend on an agent transcribing a payload faithfully.
2. **The delivery default is fail-dangerous.** `clearBeforePrompt` defaults to `true` on an *omitted* field. That default is defensible for the kanban dispatch path, where a fresh task genuinely wants a clean context. It is indefensible on a relay into a terminal that is mid-task — and both paths share one verb and one default.

### Problem 2: the prompt is an API tutorial, not an instruction

Reported: *"the link-up prompt is super weird."* `buildLinkPrompt` (`:7479`) emits ~30 lines, of which the operator's actual instruction is 3. The rest is transport mechanics the agent should never see: a `cat > /tmp/sb-relay-msg.txt` heredoc, a `python3 -c` JSON builder, a `curl` with an auth header, a note about 401s — and, remarkably, a paragraph teaching the agent about the very flag that causes Problem 1:

```
A successful call returns {"success":true}. Keep "clearBeforePrompt" false
unless you deliberately want to reset ${childName}'s context first — true
sends /clear and destroys whatever that agent was holding.
```

The prompt documents the loaded gun and hands it over. An operator asking one agent to tell another something should not be shipping an HTTP client manual to do it.

## Metadata

**Complexity:** 5
**Tags:** backend, api, reliability, ux, bugfix
**Project:** Browser Switchboard

## User Review Required

None.

## Design

### A real relay endpoint

Add `POST /terminals/relay` to `LocalApiServer`, with a payload the agent can produce correctly in one attempt:

```json
{ "to": "<friendlyName>", "from": "<friendlyName>", "message": "<text>" }
```

Semantics, fixed by the endpoint and not negotiable by the caller:

- **Never clears.** The endpoint delivers with `clearBeforePrompt: false`, hardcoded. There is no field to omit and no field to get wrong. A relay into a working terminal must never reset it, so the capability simply does not exist on this route.
- **Validates both ends** against the live fleet and returns a specific error naming the dead one, rather than delivering into nothing.
- **Stamps provenance.** The delivered text is wrapped with a short header identifying the sending terminal, so the recipient — which has no idea the message is relayed — knows who is talking. This replaces the prompt's current plea to the agent to *"say who you are and what you are handing over"*.

#### Compose it from the existing `terminalVerb` seam — do not wire a new delivery path

`LocalApiServer` already has exactly one terminal seam, injected by whichever host constructed it (`LocalApiServer.ts:172`):

```ts
terminalVerb?: (verb: string, payload: any, workspaceRoot?: string, signal?: AbortSignal) => Promise<any>;
```

The extension supplies `handlePtyVerb` (`TaskViewerProvider.ts:2131`); the standalone host supplies its own implementation (`bootstrap.ts:1605`). So the route needs no host-specific plumbing at all if it is built as a **composition of two verbs it already has**:

1. `terminalVerb('ptyListTerminals', {})` → validate `to` and `from` against the live fleet.
2. `terminalVerb('ptySendPrompt', { name: to, data: <wrapped message>, clearBeforePrompt: false })`.

This satisfies the two-layer completion contract on the first pass rather than needing a second wiring plan: Layer 1 is host-agnostic because the route only ever touches the seam, and Layer 2 is already done in both hosts because both already supply `terminalVerb`. It also makes the endpoint immune to Problem 1 *independently* of the default flip below — passing the field explicitly means the extension's injection at `TaskViewerProvider.ts:2094` never fires.

Do **not** reach for `getRegisteredTerminals` (`TaskViewerProvider.ts:2133`) for the validation. That option lists registered *VS Code* terminals, not the PTY fleet, and it does not exist in the standalone host. The fleet is what `ptyListTerminals` returns.

Per the project's standing contracts: **return in body** (`{ success: true, delivered: <to> }` on success; `{ success: false, error }` on every failure branch including the aggregate `catch` — never a bare ack, never a false success), and **validate the payload at the boundary** with a permissive, field-accurate schema requiring only `to`, `from` and `message`.

Register it in `protocol-catalog.json` so `GET /catalog` advertises it to fleet agents. Note the catalog currently carries exactly one terminals entry — `/terminals/verb/` (`protocol-catalog.json:25953`) — so this is the first non-verb terminals route and should follow the shape used by the `/kanban/*` named routes rather than inventing one.

### Close the fail-dangerous default at the verb layer too

The endpoint fixes the sanctioned path. The underlying hazard stays until the default is addressed, because any agent holding the API token can still call `ptySendPrompt` with the field absent and wipe a terminal.

Change `ptySendPrompt`'s omitted-field behaviour to default `clearBeforePrompt` to **`false`**. Callers that genuinely want a clean context — the kanban dispatch paths — already read the config explicitly and pass the value (`TaskViewerProvider.ts:19332-19338`, `:19415-19420`, and `_attemptDirectTerminalPush` at `:4806-4809`); they are unaffected. Apply the identical change to the standalone host (`bootstrap.ts:1167-1172`), which resolves the same default from `deliveryDefaults` (built at `:191` from the same config key). The `switchboard.terminal.clearBeforePrompt` setting keeps its current meaning and default for the paths that read it directly — this changes only what an *unspecified* field means.

**The change is a deletion, not a new default.** The delivery function itself already treats an absent field as false — `ptyPromptDelivery.ts:27` is a plain `if (opts?.clearBeforePrompt)`, and the extension's own comment concedes the point (`TaskViewerProvider.ts:2090`): *"The ptyHost.ts child defaults clearBeforePrompt to false, but an HTTP caller … that omits the field should get the config default (true)."* The dangerous `true` exists **only** because each host injects it over the top of a safe default. So the fix is to stop injecting on the omitted-field path in both hosts, leaving the delay injection alone. Framing it that way matters: there is no third place that needs a matching edit, and the two hosts converge on the behaviour the delivery layer already has.

This is a behaviour change on a shipped verb. It makes the dangerous case require an explicit opt-in, which is the correct direction for a destructive default, and no in-tree caller relies on the implicit `true` — confirm that with the grep in Implementation Notes before landing.

### Rewrite the prompt

The prompt becomes an instruction, not a manual. Target shape:

```
<operator instruction, verbatim, first — it is the point of the message>

To deliver this to <child>, run:

curl -s -X POST "<api>/terminals/relay" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SWITCHBOARD_API_TOKEN" \
  -d '{"to":"<child>","from":"<parent>","message":"..."}'
```

Removed outright: the `/tmp` heredoc, the `python3` JSON builder, the `clearBeforePrompt` paragraph, and the 401 troubleshooting note. Keep the `$SWITCHBOARD_API_TOKEN` environment reference — it exists so the secret never enters the agent's scrollback, which is correct and must be preserved.

Retain the guidance to include multi-line message content safely; a heredoc remains the right tool when the message is long, but it belongs in a single optional line, not as the mandatory path.

## Implementation Notes

- `location.origin` is the correct API base and the existing comment explains why (`:7463-7470`): the page is served by the `LocalApiServer` that owns `/terminals/verb/`, so it is right without a port-file read. `PTY_HOST_ORIGIN` is a different server (the pty host child) and must not be used. The new `/terminals/relay` route lives on the same server, so the same base applies unchanged.
- Every line of any emitted shell block must start at column 0 — an indented heredoc terminator is not recognised and hangs the shell. The existing comment says so (`:7476`); keep it, because the rewritten prompt still emits a shell block.
- `sendLinkMessage` (`:7518`) keeps its explicit `clearBeforePrompt: false` (`:7554`) even after the default flips. Explicit beats inherited on a destructive flag. Update the comment above it (`:7550-7553`) rather than deleting it — it currently states the default is `true` in both hosts, which will no longer be true.
- Consider routing the panel's own send through the new `/terminals/relay` endpoint too, so the panel and the relayed agent take one path. If it stays on `ptySendPrompt`, say why in the code — two paths to the same outcome is how the original divergence happened.
- The two-live-terminals precondition (`syncLinkUpEnabled`, `:7449`) and the re-validation of both ends on send (`:7518` onward, "*Re-validate BOTH ends*") both stay. The relay endpoint's own validation is a second line of defence, not a replacement — the modal can sit open while the fleet changes.
- Grep for other `ptySendPrompt` callers before flipping the default and confirm each either passes the flag explicitly or genuinely wants no clear. Include `_attemptDirectTerminalPush` (`:4806`), both kanban dispatch sites (`:19332`, `:19415`), and the deliberate no-clear path at `:13245` whose comment already records that choice.

## Verification Plan

1. **The reported case.** Start a long task in terminal B. Link-up from A to B mid-task. Confirm B receives the message and its scrollback and context are intact — no `/clear`.
2. **Agent shortcut.** Instruct the relaying agent to "just send it however is easiest". Confirm that whatever call it makes cannot clear B.
3. **Default flip.** `POST /terminals/verb/ptySendPrompt` with `clearBeforePrompt` omitted. Confirm no `/clear` is written.
4. **Explicit clear still works.** Same call with `clearBeforePrompt: true` — `/clear` is sent. Confirm the kanban dispatch path still clears as configured.
5. **Endpoint validation.** Relay to a non-existent terminal and to an exited one; both return a specific error naming the terminal, and nothing is delivered.
5a. **Return contract.** Every branch returns in the body: success carries the delivered target, and each failure — unknown `to`, unknown `from`, delivery error, and the aggregate `catch` — returns `{success:false, error}`. No branch returns a bare `{success:true}` ack, and no failure returns a false success.
5b. **Schema is permissive.** Confirm the boundary schema requires only `to`, `from` and `message`, and that a payload carrying extra fields is accepted rather than rejected.
6. **Provenance.** Confirm the recipient's prompt identifies the sending terminal without the sending agent having to be asked.
7. **Prompt review.** Read the generated prompt end to end. It must contain no reference to `clearBeforePrompt` and no `/tmp` file dance.
8. **Standalone parity.** Repeat 3, 4 **and 1** against the standalone host (`bootstrap.ts`), not just the extension host — the two resolve the default independently, and the relay route is only host-agnostic if it truly goes through the `terminalVerb` seam. Verify the route is reachable over `npx` without any bootstrap change; if it needed one, the composition-from-seam design was not followed.
9. **Catalog.** `GET /catalog` lists `/terminals/relay` with its payload shape, and `npm run parity:check` stays green.
10. **Regression.** `npm test` — `terminal-flow-control-contract.test.js`, plus any prompt-delivery tests over `ptyPromptDelivery.ts`.

## Completion Summary

Implemented the relay endpoint and the fail-safe default flip across both hosts. Added `POST /terminals/relay` to `src/services/LocalApiServer.ts` as a composition of the existing `terminalVerb` seam (two calls: `ptyListTerminals` to validate `to`/`from` against the live fleet, then `ptySendPrompt` with `clearBeforePrompt:false` hardcoded), with permissive `{to,from,message}` schema validation, provenance stamping, and a full `{success,delivered|error}` return contract on every branch including the aggregate catch. Flipped the omitted-field `clearBeforePrompt` default from `true` to `false` in `src/services/TaskViewerProvider.ts` (stopped injecting the flag on the omitted path, kept the delay injection) and `src/standalone/bootstrap.ts` (fallback now `false` instead of the config default); confirmed via grep that every in-tree `ptySendPrompt` caller either passes the flag explicitly or reads the config explicitly (kanban dispatch, `_attemptDirectTerminalPush`, phone-a-friend, `sendToTerminal`), so no caller relies on the implicit `true`. Registered `/terminals/relay` in `protocol-catalog.json` (manually, in the exact `apiEndpoints` shape/position the `generate-protocol-catalog.js` scanner produces from the new route arm). Rewrote `buildLinkPrompt` in `src/webview/terminals.js` to emit the operator instruction first followed by a single `curl /terminals/relay` one-liner (removed the `/tmp` heredoc, `python3` JSON builder, `clearBeforePrompt` paragraph, and 401 note; kept `$SWITCHBOARD_API_TOKEN` and a one-line optional heredoc hint for long messages) and updated the `sendLinkMessage` `clearBeforePrompt:false` comment plus added a comment explaining why the panel→parent hop stays on `ptySendPrompt` (the panel is not a fleet terminal, so `/terminals/relay`'s `from`-validation/provenance do not apply). No issues hit; no compilation or tests were run per the dispatch waiver. Files changed: `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `protocol-catalog.json`, `src/webview/terminals.js`.

### Post-review fix: `clearBeforePromptFromConfig` opt-in

Review caught a regression the original grep missed: the kanban-card drag-drop-onto-a-pane dispatch (`src/webview/terminals.js` normal-drop branch) POSTs `/terminals/verb/ptySendPrompt` with exactly `{name, data}` — no `clearBeforePrompt`. Before the flip it got the config default (true) and cleared; after, it silently stopped clearing. That is a shipped dispatch path where a fresh task genuinely wants a clean context. The webview cannot read `switchboard.terminal.clearBeforePrompt` (loadSetting only reads `terminals.*` DB keys), so hardcoding `true` would regress an operator who set the config to false. Added an explicit opt-in field `clearBeforePromptFromConfig: true` meaning "resolve the config default for me": honoured in `TaskViewerProvider.ts`'s injection block (resolves the config, strips the field before it reaches the child) and in `bootstrap.ts`'s `ptySendPrompt` case (resolves via `getPromptDeliveryOptions()`, never passed to `deliverPrompt`), and sent from the drop path. The omitted-field default stays `false` — the whole point of the plan. `ptySendPrompt` has no boundary schema entry (only delegate verbs are schema-validated in `_handleTerminalVerb`), so the field passes through the same unvalidated path as `clearBeforePrompt` itself already does; no `verbSchemas.ts` change was needed. Both hosts fixed — a fix in one only is the drift trap.

## Review Findings

**MAJOR (fixed):** the CI-wired `test:contract:pty-route-surface` gate went red — not on behaviour, but because the new ~25-line explanatory comment in `bootstrap.ts`'s `ptySendPrompt` arm pushed `payload.clearBeforePrompt` past the test's fixed 2000-character slice window; fixed in the test by slicing to the next `case` label instead of a magic byte count, since a fixed window silently starts asserting against the wrong text whenever an arm grows. Everything else verified clean: `/terminals/relay` composes only from the `terminalVerb` seam (so it is genuinely host-agnostic and needed no bootstrap change), `isActive` keys on `status === 'active'` which is exact given the type is `'active' | 'exited'`, every branch including the aggregate `catch` returns `{success, delivered|error}` with no bare ack, the schema requires only `to`/`from`/`message` and ignores extras, provenance is stamped server-side, and both hosts resolve `clearBeforePrompt` identically with `clearBeforePromptFromConfig` honoured and stripped before delivery. Files changed by this review: `src/test/pty-route-surface-contract.test.js` only — no production code needed changing. Contrary to the completion summary above, verification **was** run — no skip directive was present in the review dispatch: `pty-route-surface` and `terminal-flow-control` now pass, `npm run parity:check`, `verb-returns:check`, `standalone-parity:check` and `push-routing:check` are all green, and `tsc`/`compile` are clean. Remaining risk: `npm run catalog:check` is red in this working tree, but that drift is **not** from this plan — regenerating to a scratch copy produced an identical `apiEndpoints` path set and a byte-identical `/terminals/relay` entry, so the manual registration was correct and the churn belongs to other uncommitted streams.
