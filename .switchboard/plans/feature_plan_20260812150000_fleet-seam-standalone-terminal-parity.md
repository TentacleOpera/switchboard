# One Fleet Seam: Stop `_ptyHostPort` Meaning "A Fleet Exists"

## Goal

Make every terminal-delivery feature in the shared providers work on the standalone host, by replacing the `_ptyHostPort` guards with a host-agnostic fleet predicate and giving `_ptyHostVerb` an injectable in-process implementation.

Today, seven features that deliver a prompt to a terminal — the Design panel's send buttons, the Artifacts/Planning panel's planner and architect sends, the analyst message, the project-manager terminal, agent-to-agent messaging, the subagent/delegate prompt block, and role→terminal-name resolution — are silently unavailable under `npx switchboard`, on a host that owns a live PTY fleet, a workspace DB and an API token.

### Root cause: one field, two meanings

`TaskViewerProvider._ptyHostPort` is the HTTP port of the **pty host child process**. It is set to a real value in exactly one place — on the child's `ready` handshake inside `_startLocalApiServer`. The only other writes are the ones that clear it to `undefined`. Standalone sets `suppressLocalApiServer = true` (`bootstrap.ts:693`), so `_startLocalApiServer` never runs and the handshake never happens.

The field means *"the fleet lives in a child process."* It is used throughout as *"a fleet exists."* Those were the same statement before standalone gained an in-process `PtyFleetService`; they have not been since. Every guard below therefore reads as "this install has no terminals" on the one host where the terminals are in the same process as the code asking.

### The guard census (verified against HEAD, 2026-08-14)

> **Superseded:** "seven `_ptyHostPort` guards" / "Seven mechanical guard swaps" / "Replace all seven … guards listed above", against a table containing nine rows.
> **Reason:** The plan conflated *seven user-facing features* (correct — the Goal lists seven) with *the number of guard sites* (nine in its own table). A coder told to "swap seven guards" against a nine-row table leaves two behind, and the two most likely to be dropped are the cosmetic ones at the top and bottom of the table. Two further `_ptyHostPort` guard sites were also missing from the table entirely.
> **Replaced with:** the census below — **nine guards to swap, two guards deliberately kept, five non-guard uses excluded.** Line numbers re-verified at HEAD; the originals had drifted by +35 to +165 lines.

**Swap these nine** (`this._ptyHostPort` → `this._hasFleet()`):

| Line (HEAD) | Site | Gates |
| :--- | :--- | :--- |
| `:1059` | dispatch-toast terminal resolution | cosmetic |
| `:2977` | `hasPtyHost()` body | creation policy — read by `PlanningPanelProvider.ts:1273` |
| `:4881` | `sendPromptToAgentTerminal` | "fleet available → don't spawn a `vscode.Terminal`" |
| `:8669` | `_ptyTerminalNames` liveness check | is-this-terminal-live |
| `:8811` | role → live terminal name resolution | planner/coder role resolution |
| `:8834` | `_resolveDelegateIdentityForTarget` | the delegate/subagent block in dispatch prompts |
| `:19532` | `_isLikelyPtyDispatchTarget` | toast suppression (cosmetic) |
| `:19560` | `_tryFleetDeliveryForRole` | **the delivery chokepoint** |
| `:19667` | `_attemptDirectTerminalPush` | **the delivery chokepoint** |

**Keep these two on `_ptyHostPort` — they are correct as-is:**

- `:11201` `instantiateAgentGroup` — extension-host only by construction. Standalone never calls it: `bootstrap.ts:1757` registers `kanbanProvider.setAgentGroupInstantiator(...)` which drives `ptyFleetService` directly. Swapping this guard would make an unreachable path *look* host-agnostic without making it so, and would invite a later reader to retire the standalone instantiator on that false signal.
- `:13578` `sendToTerminal` arm — also intercepted before it can be reached on standalone. `bootstrap.ts:1076` routes `sendToTerminal` to `handlePtyVerb`, whose own `case 'sendToTerminal'` (`bootstrap.ts:1534`) serves it from `ptyFleetService`. The extension-host arm is dead code on standalone, not a broken capability.

**Exclude these five non-guard uses:**

- `:416` — `if (!this._ptyHostChild || !this._ptyHostPort)` inside `_ptyHostVerb`. This is not a guard to swap; it is the *child-preference test* that section 1 below restructures.
- `:442` — `const port = this._ptyHostPort`, inside the HTTP forwarder. Genuinely the child's port.
- `:2108`, `:2111` — `ptyHostReady()` and `updateMirrorRegistry`, both closures inside `_startLocalApiServer`, which never runs on standalone. Unreachable there by construction.
- `:2721` — the `data-pty-host-origin` WS attribute. Genuinely about the child's port and has no standalone meaning (the browser cockpit dials its own origin). **Pinned by `pty-route-surface-contract.test.js:280`** — changing it reds a CI gate.

Plus the writes (`:660` declaration, `:2057`, `:2072`, `:2085`, `:22383`), which are untouched.

### The failure is honest, which is why it survived

`vscodeShim.ts:129` throws on `createTerminal`, callers catch it, and the send returns `false`. Nothing is written to the wrong terminal and nothing is corrupted; the feature simply reports that it could not deliver. That is why this has never presented as a bug report — it presents as "that button doesn't do anything in the browser."

The shim's own error message records the premise that has since expired:

> *"vscode.window.createTerminal is not available in the headless standalone host; dispatch verbs are not supported over npx (B3)."*

True when written. Standalone has had its own fleet since.

### The evidence that this is a pattern, not an oversight

> **Superseded:** "Standalone contains exactly **two** hand-written prompt-to-terminal paths: board dispatch (`bootstrap.ts:1413`) and memo send-to-planner (`:1596`)."
> **Reason:** Verified at HEAD, there are **three**, and the third is the most important one for this feature's sibling subtask. `handlePtyVerb`'s `case 'sendToTerminal'` (`bootstrap.ts:1534`) is a full hand-written prompt-to-terminal path that *also auto-creates the terminal when the name misses* (`ptyFleetService.create(role, name, root)`, returning `created: true`). Undercounting it hid the fact that standalone already ships the creation policy the sibling subtask proposes to invent.
> **Replaced with:** three hand-written paths — board dispatch (`:1408` `triggerAction`), `sendToTerminal` (`:1534`, which auto-creates), and the memo planner send (`:1596`, which deliberately degrades to clipboard because there is no shared-provider route to a planner terminal).

That is the shape of the problem — each feature that mattered enough got patched individually in `bootstrap.ts`, and every feature that did not keeps the extension-only assumption. Agent Groups (`feature_plan_20260812120400`) was the most recent instance and was fixed the same one-off way, with `setAgentGroupInstantiator`. This plan stops the pattern by fixing the seam instead of the next symptom.

The insight is already encoded as a contract test elsewhere in the suite — `browser-planner-dispatch-surface.test.js:171` asserts a widened liveness branch must **not** key on `_ptyHostPort`, with the comment *"A fix expressed against `_ptyHostPort` passes every extension-host test and leaves `npx switchboard` — where PTY is the ONLY fleet — exactly as broken."* That is this plan's thesis, already ratified for a neighbouring surface.

## Scope

One seam, one registration, and the guard swaps that follow from them. This plan does **not** change what any of the seven features do, does not touch the two chokepoints' delivery semantics, adds no verb, and opens no endpoint. It removes a false negative.

Explicitly out of scope: retiring the three hand-written `bootstrap.ts` paths (they work; consolidating them is a separate cleanup), `PtyFleetService` itself, and the terminal *creation* policy (owned by the sibling subtask — see Dependencies).

## Plan sizing

**One plan, deliberately.** The deliverable is a single seam; the nine guards are call sites of it rather than independent outputs, and they live in one region of one file. Splitting delivery-chokepoints from resolution-guards would put two plans on the same lines of `TaskViewerProvider.ts`, which the PRD's one-stream-per-file discipline exists to prevent.

## Implementation

### 1. The seam: an injectable fleet verb

`_ptyHostVerb(verb, payload, signal)` (`TaskViewerProvider.ts:415`) is already the single funnel for every fleet call in this provider — including the standing-orders chokepoint. Give it a fallback:

```ts
private _fleetVerb?: (verb: string, payload: any, signal?: AbortSignal) => Promise<any>;
public setFleetVerb(fn: (verb: string, payload: any, signal?: AbortSignal) => Promise<any>) {
    this._fleetVerb = fn;
}
```

**Ordering inside `_ptyHostVerb` is load-bearing.** At HEAD the method is:

1. `:416` early return when there is no child;
2. `:424-437` the standing-orders append block;
3. `:440+` the HTTP POST to the child.

> **Superseded:** "The standing-orders append block above it is untouched and now covers both hosts through one code path."
> **Reason:** The block sits **below** the early return, not above it. A coder who reads "above it is untouched" and preserves the existing top-to-bottom order verbatim will leave the early return in front of the standing-orders block, and the `_fleetVerb` route — reached from the bottom of the method — will skip standing orders entirely on standalone. The claimed outcome is right; the stated geometry is wrong, and the wrong geometry silently produces the opposite result.
> **Replaced with:** restructure to **guard → standing orders → route**:

```
if (!child && !this._fleetVerb) → return { success:false, error:'PTY host unavailable…' }
   (standing-orders append block — unchanged body, now reached by both hosts)
if (child) → existing HTTP POST, unchanged
else       → return this._fleetVerb!(verb, payload, signal)
```

The standing-orders block's own recursive `_ptyHostVerb('ptyListTerminals')` call (`:428`) resolves through whichever route is active, so it needs no change.

**Do not construct a fleet service instance here.** `src/test/pty-route-surface-contract.test.js` asserts `TaskViewerProvider.ts` contains no `new PtyFleetService(` — the fleet is the host's to own, and this provider only ever holds a function. That assertion is the guard keeping the extension host honest; the injected-function shape satisfies it by construction. (It matches on source text, so avoid that literal even inside a comment — which is why this paragraph does not spell it.)

**The neighbouring assertion's *intent* now needs a doc correction.** The same test is titled *"the extension host forwards pty verbs to the child process, never to an in-process fleet."* Its assertions are source-text and all still pass, but the title is about to be half-true: the extension host still always forwards to the child; the *provider* now also serves a host-injected in-process function when there is no child. Update the test's comment to say so, in this change. Leaving a green test whose stated contract contradicts the code is how the `_ptyHostPort` misreading survived in the first place.

### 2. The predicate

```ts
private _hasFleet(): boolean { return !!this._ptyHostPort || !!this._fleetVerb; }
```

Replace the nine guards listed in the census with `this._hasFleet()`. Leave the two kept guards and the five non-guard uses exactly as they are.

**`hasPtyHost()` keeps its name.** `src/test/browser-direct-terminal-helpers.test.js:96` pins the literal string `hasPtyHost()` inside `PlanningPanelProvider._sendPromptToTerminal`'s body. Change the method's body to `return this._hasFleet();` and leave every call site as it is. Renaming it to something more accurate breaks a green test for zero user benefit; the doc comment is where the correction belongs.

### 3. Standalone registers its fleet

In `bootstrap.ts`, beside the existing `setAgentGroupInstantiator` registration (`:1757`, after `ptyFleetService` is constructed at `:1734`, since `handlePtyVerb` closes over it):

> **Superseded:** `taskViewerProvider.setFleetVerb((verb, payload, signal) => handlePtyVerb(verb, payload, workspaceRoot, signal));`
> **Reason:** **This does not compile.** The two hosts' `handlePtyVerb` have different arities: the extension host's is `(verb, payload, root?, signal?)` (`TaskViewerProvider.ts:2145`) but standalone's is `(verb, payload, root)` — three parameters, no `signal` (`bootstrap.ts:1124`). Passing a fourth argument is `TS2554: Expected 3 arguments, but got 4`. The snippet was written against the extension host's signature and pasted into the standalone file.
> **Replaced with:** drop the fourth argument at the call, and let the seam's own `signal` parameter go unused on this host:

```ts
// `signal` is accepted by the seam signature but intentionally not forwarded:
// standalone's handlePtyVerb runs in-process and has no request to abort.
taskViewerProvider.setFleetVerb((verb, payload, _signal) => handlePtyVerb(verb, payload, workspaceRoot));
```

If abort support on standalone is wanted later, widen `handlePtyVerb`'s signature there first, as its own change — do not widen it as a side effect of this registration.

Routing through `handlePtyVerb` rather than `ptyFleetService` directly is the correct choice here and the opposite of the Agent Groups decision — deliberately. Agent Groups had to go *below* the wrapper because the wrapper overwrites `delegates` from role config, which would have discarded the group's members. These paths never create a terminal; they list and they send. Going through the wrapper gets `ptyReady` gating and the standalone prompt-delivery options for free.

### 4. Double-applied standing orders are already safe — verify, don't defend against

`_ptyHostVerb` appends the standing-orders block before forwarding, and standalone's `deliverPrompt` (`bootstrap.ts:206`) appends it again on the way in. That is a double application, and it is a no-op: `applyStandingOrders` early-returns when the prompt already contains `STANDING_ORDERS_MARKER` (`standingOrders.ts:59` — verified at HEAD: `if (!prompt || prompt.includes(STANDING_ORDERS_MARKER)) { return prompt; }`, and the function's doc comment is literally *"Idempotent."*). The marker is documented as exactly this contract — *"the marker string is the contract that prevents double-blocking when a prompt is processed by both client and host"* (`terminals.js:7476`).

Confirm it on the wire rather than trusting the read: one block, one marker, in the recipient's scrollback. Do **not** add a suppression flag to work around it — that would be a second mechanism for something the marker already handles, and it would diverge the two hosts again.

### 5. The one intentional behaviour change

Guard `:4881` currently reads "fleet available → return false, do not spawn a `vscode.Terminal`; no fleet → spawn one, and in standalone that throws and is caught." Under `_hasFleet()`, standalone takes the first branch and returns `false` without the throw/catch round trip. Same outcome for the caller, one fewer exception on a hot path. Note it; it is not a regression.

No configuration work is needed: `vscode.workspace.getConfiguration` is backed in standalone by `StandaloneConfiguration` (`vscodeShim.ts:192`), so the `clearBeforePrompt` / `clearBeforePromptDelay` reads at `:19694-19695` already resolve correctly there.

### 6. Do not touch

- The three hand-written `bootstrap.ts` delivery paths (`:1408`, `:1534`, `:1596`). They work. Consolidating them onto the seam is a follow-up, not this change.
- `handlePtyVerb`'s wire-facing `delete payload.startupCommand` and unconditional `delegates` overwrite, on either host. Those stop the *wire* supplying a launch command and are unrelated to this seam. (The sibling creation-policy subtask depends on this strip staying in place — see Dependencies.)
- `_registeredTerminals` and the `sendRobustText` path. The VS Code terminal fallback stays exactly as it is for the ~4,000 shipped extension installs.
- `_dispatchResearchToResearcher` (`:4790`). It resolves a researcher terminal the same way but **deliberately never spawns**, closing a documented TOCTOU gap ("Design Decision #3"). It does not read `_ptyHostPort` and is not part of this change. Named here only so a coder sweeping for terminal-resolution sites does not "fix" it.

## Metadata

**Tags:** backend, reliability, cli, refactor
**Complexity:** 5
**Project:** Browser Switchboard

## User Review Required

None. The seam shape, the `hasPtyHost()` name retention, the route-through-`handlePtyVerb` choice, the marker-idempotency reliance, and the keep/swap decision for the two extra guard sites are all decided above.

## Complexity Audit

### Routine
- One optional field and one setter on an existing provider.
- One registration line in `bootstrap.ts`, beside an identical existing one.
- Nine mechanical guard swaps.

### Complex / Risky
- **The blast radius is every terminal-delivery feature at once.** Seven capabilities change availability on a shipped host in one commit. A mistake in `_hasFleet()` does not break one button; it breaks the fleet path on both hosts.
- **Four source-text assertions across three CI-wired test files pin the exact guards this plan swaps.** See the Test Impact section below. This is the single most likely way the change lands red, and the original plan accounted for only one of the four.
- **The `_ptyHostVerb` restructure has an ordering trap.** Preserving the current statement order while adding the fallback route silently drops standing orders on the standalone path (section 1).
- **A false positive is worse than today's false negative.** If `_hasFleet()` returns true where no fleet can actually be reached, delivery paths stop falling back to the VS Code terminal and start reporting "could not deliver" on installs that work today. The predicate must be exactly "a child port OR an injected verb", nothing looser.

## Test Impact — the four pinned assertions

Verified by census (`grep -rn "_ptyHostPort" src/test/` plus `hasPtyHost`). **This plan owns three of the four; the sibling creation-policy subtask owns the fourth.** All three files are wired in `.github/workflows/integration-tests.yml`.

| File:line | Assertion | Effect of this plan | Owner |
| :--- | :--- | :--- | :--- |
| `browser-direct-terminal-helpers.test.js:75` | `_tryFleetDeliveryForRole` must contain literal `if (!this._ptyHostPort) { return false; }` | **RED** — guard `:19560` is swapped | **this plan** |
| `browser-direct-terminal-helpers.test.js:109` | `sendPromptToAgentTerminal` must contain literal `if (this._ptyHostPort) { return false; }` | **RED** — guard `:4881` is swapped | **this plan** |
| `pty-dispatch-focus-contract.test.js:199` | `_isLikelyPtyDispatchTarget` must contain literal `if (!this._ptyHostPort) { return false; }` | **RED** — guard `:19532` is swapped | **this plan** |
| `browser-direct-terminal-helpers.test.js:96` | `_sendPromptToTerminal` must contain `hasPtyHost()` | green (name retained) | sibling subtask |

> **Superseded:** "Two tests pin implementation details by source text… `pty-route-surface-contract.test.js` forbids `new PtyFleetService(`… `browser-direct-terminal-helpers.test.js:96` requires the literal `hasPtyHost()`. Both are correct guards; both fail on a well-intentioned rename." — and, in the Verification Plan, "`npm run test:contract:browser-direct-terminal-helpers` — pins `hasPtyHost()` by name" listed among tests that must **stay green**.
> **Reason:** Both statements describe pins that survive a *rename*, and conclude the risk is a careless rename. The actual exposure is the opposite and much larger: three assertions pin the **literal `_ptyHostPort` guards this plan deliberately swaps**, so they go red on the plan executing *correctly*. One of them lives in a third file the plan never mentions (`pty-dispatch-focus-contract.test.js`, CI-wired at `integration-tests.yml:97`). Listing `browser-direct-terminal-helpers` as a must-stay-green gate would have the coder treat their own correct change as a regression and revert the two chokepoint swaps — the exact two guards the whole feature exists to move.
> **Replaced with:** the table above. Each swapped guard's assertion is rewritten to pin `_hasFleet()` in the same commit, with an inline comment recording that the assertion previously pinned `_ptyHostPort` and why the predicate widened.

## Edge-Case & Dependency Audit

**Race Conditions**
- `setFleetVerb` must be registered before the first delivery. In `bootstrap.ts` it lands during startup, well before `server.start()`, so no request can observe the unset state. An unset `_fleetVerb` degrades to today's behaviour rather than throwing.
- The per-terminal send lock stays in the fleet's own process on both hosts — the extension's in the pty child, standalone's in-process. This change moves no locking.

**Security**
- No new endpoint, no new auth surface, no widening. The injected function is set by the host process at startup and is unreachable from the wire.
- The `startupCommand`/`delegates` strip on both hosts' `ptyCreateTerminal` is untouched. These paths do not create terminals.

**Side Effects**
- Seven capabilities become available under `npx switchboard`. That is the goal, and each is a prompt delivered to a terminal the user can see.
- Standing orders begin reaching standalone deliveries routed through the shared providers. Correct, and the same block the board-dispatch path already carries there.
- `_logEvent('dispatch', …)` in `_attemptDirectTerminalPush` starts firing on standalone deliveries. Intended: those dispatches are real and were previously invisible to the log.

**Dependencies & Conflicts**
- Touches `TaskViewerProvider.ts` and `bootstrap.ts`. `feature_plan_20260812120400` (Agent Groups) touched both; land after it, or expect a conflict in the same `bootstrap.ts` registration block.
- `PlanningPanelProvider.ts` and `DesignPanelProvider.ts` are read but not modified — they call the public wrappers, whose signatures do not change.
- **Must land before the sibling creation-policy subtask**, which rewrites guard `:4881` a second time. See Dependencies.

## Dependencies

- **Blocking (outbound):** the sibling subtask `terminal-creation-policy-spawn-in-the-fleet.md` must land **after** this one. It replaces guard `:4881` with a fleet-spawn attempt; written against `_ptyHostPort` first, that guard gets rewritten twice and the `_hasFleet()` swap is lost in the merge.
- **Practical, not blocking:** `feature_plan_20260812120400_agent-groups-in-agents-tab.md`. It introduced `setAgentGroupInstantiator` and the shared `agentGroupInstantiation.ts` core; this plan registers its seam in the same `bootstrap.ts` block and follows the same precedent. Landing this first means resolving that block twice.
- Supersedes nothing. No plan file covers this surface.

## Adversarial Synthesis

Key risks: three CI-wired source-text assertions pin the exact `_ptyHostPort` guards this plan swaps, so a correct execution lands red and invites a revert of the two delivery chokepoints; the `_ptyHostVerb` restructure silently drops standing orders on standalone if the existing statement order is preserved; a loosened `_hasFleet()` turns a benign false negative into an active false positive on ~4,000 shipped installs; and the standalone registration snippet as originally written does not compile against standalone's three-parameter `handlePtyVerb`. Mitigations: the assertion table names every pinned test and assigns each an owner, the `_ptyHostVerb` restructure is specified as an explicit guard→standing-orders→route order rather than a diff, the predicate is exactly two ORed fields and nothing else, and the registration is given with the correct arity plus a note on why `signal` is dropped.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`
- **Context:** `_ptyHostVerb` at `:415`; `_ptyHostPort` declared at `:660`; `hasPtyHost()` at `:2976`; the nine guards in the census.
- **Logic:** Add `_fleetVerb` + `setFleetVerb`; restructure `_ptyHostVerb` to guard → standing orders → route (child preferred, injected function otherwise); add `_hasFleet()`; swap the nine census guards; re-point `hasPtyHost()`'s body.
- **Implementation:** Leave `:416`, `:442`, `:2108`, `:2111` and `:2721` alone — all five are genuinely about the child's port or unreachable on standalone. Leave `:11201` and `:13578` on `_ptyHostPort` per the census rationale. Correct the `_ptyHostPort` doc comment to say what the field means, since that misreading is the whole defect.
- **Edge Cases:** neither child nor injected verb → today's `PTY host unavailable` error, unchanged; the standing-orders append runs identically on both hosts.

### `src/standalone/bootstrap.ts`
- **Context:** `handlePtyVerb` at `:1124` (three parameters); `ptyFleetService` at `:1734`; the `setAgentGroupInstantiator` registration at `:1757`.
- **Logic:** One `setFleetVerb` registration routing to `handlePtyVerb`, at the corrected arity.
- **Edge Cases:** `ptyReady === false` — `handlePtyVerb`'s own guard already returns the readable node-pty error, so no second gate is needed here.

### `src/test/browser-direct-terminal-helpers.test.js`
- **Logic:** Rewrite the two assertions at `:75` and `:109` to pin `_hasFleet()` instead of the `_ptyHostPort` literal. Leave `:96` (`hasPtyHost()`) untouched — it stays green here and is the sibling subtask's to change.
- **Implementation:** Record inline, at each rewritten assertion, that it previously pinned `_ptyHostPort` and that the predicate widened to cover the in-process fleet.

### `src/test/pty-dispatch-focus-contract.test.js`
- **Context:** `:199` pins `_isLikelyPtyDispatchTarget`'s literal `if (!this._ptyHostPort) { return false; }`. CI-wired at `integration-tests.yml:97`.
- **Logic:** Rewrite to pin `_hasFleet()`. The neighbouring assertions (no `_ptyHostVerb` round-trip on the hot path) are unaffected and must stay.

### `src/test/pty-route-surface-contract.test.js`
- **Context:** The test *"the extension host forwards pty verbs to the child process, never to an in-process fleet"*. All its assertions still pass; only its stated contract needs correcting.
- **Logic:** No assertion changes. Update the comment to state the refined contract: the extension host still always forwards to the child, and the provider never constructs a fleet — it may hold a host-injected function which, on standalone only, serves verbs in-process.

### `src/test/standalone-fleet-seam-contract.test.js` (new)
- **Context:** No test covers the fleet seam.
- **Logic:** Source-level assertions: `_hasFleet()` is the guard on all nine census sites; `_ptyHostVerb` falls back to `_fleetVerb` and does so **after** the standing-orders block; `bootstrap.ts` registers `setFleetVerb`; `hasPtyHost()` still exists by that name and delegates to `_hasFleet()`.
- **Implementation:** Follow the shape of `pty-route-surface-contract.test.js`.

  > **Superseded:** assert that "no bare `if (this._ptyHostPort)` remains outside the two allowed uses."
  > **Reason:** That assertion reds on the day it is written. Seven legitimate `_ptyHostPort` references survive this change — `:416`, `:442`, `:2108`, `:2111`, `:2721`, `:11201`, `:13578` — plus five writes. The rule was drafted from the belief that only two non-guard uses existed.
  > **Replaced with:** a positive, site-specific assertion — each of the nine census sites reads `_hasFleet()`, asserted by extracting the enclosing method body by name rather than by counting occurrences file-wide. An occurrence-count rule on a 26,000-line file is a tripwire for unrelated work, not a contract.

### `.github/workflows/integration-tests.yml`
- **Context:** The contract-test job. A check defined in `package.json` but never invoked here is the "green while incomplete" hole.
- **Logic:** Add the `test:contract:standalone-fleet-seam` script **and** its workflow step in the same change.

  > **Superseded:** "the review of this feature's four subtasks found two CI gates already failing and no new test wired at all."
  > **Reason:** Stale on two counts. The feature has **two** subtasks, not four (the other two were resolved out before this pass). And the specific gates this plan touches are all wired at HEAD — `pty-route-surface` (`:76`), `pty-dispatch-focus` (`:97`), `browser-direct-terminal-helpers` (`:113`) — so "no new test wired at all" is not a description of this feature's CI state. Carrying an unverifiable failure claim into a plan invites a coder to accept unrelated red as pre-existing.
  > **Replaced with:** the three gates this plan touches are wired and expected green at HEAD; if any is red before work starts, capture that baseline first and do not attribute it to this change.

## Verification Plan

### Automated
1. `npm run test:contract:standalone-fleet-seam` — the new source contract above. Wired into `.github/workflows/integration-tests.yml` in the same commit; a script without a step does not count as a gate.
2. `npm run test:contract:browser-direct-terminal-helpers` — **expected to require the two assertion edits in this change** (`:75`, `:109`). Green only after they are rewritten to `_hasFleet()`. `:96` must remain untouched and green.
3. `npm run test:contract:pty-dispatch-focus` — **expected to require the assertion edit at `:199`.** Green only after it is rewritten to `_hasFleet()`.
4. `npm run test:contract:pty-route-surface` — must stay green **unmodified in its assertions**; only its explanatory comment changes. In particular the `data-pty-host-origin` pin at `:280` proves `:2721` was left alone.
5. `npm run catalog:check` and `npm run mirror:check` — no verb or skill surface changes here, so both must stay green rather than needing regeneration.
6. `npx tsc --noEmit` — clean against the known pre-existing errors. The `setFleetVerb` registration is the specific line to watch: a fourth argument to standalone's `handlePtyVerb` is `TS2554`.

### Manual — both hosts, same features
7. **Extension host, no regression.** With a PTY fleet live, exercise the Design panel send, the Artifacts planner send, and an agent-to-agent message. All three must behave exactly as before.
8. **Extension host, fleet-less.** Disable the pty host. Confirm the VS Code terminal fallback still works — this is the ~4,000-install path and the one a false-positive predicate would break.
9. **Standalone, the actual fix.** Under `npx switchboard` with a coder terminal live: Design panel send, Artifacts planner send, analyst message, project-manager terminal, and an agent-to-agent message. Each must deliver to the real terminal. Capture the *current* failing behaviour first so the comparison is anchored on observed output.
10. **Standing orders, once — and present at all.** With an order registered for the recipient, deliver via a shared-provider path under standalone and confirm the scrollback carries exactly one block and one `STANDING_ORDERS_MARKER`. Zero blocks means the `_ptyHostVerb` ordering trap (section 1) was hit; two means the marker check regressed.
11. **Delegate block.** With delegates configured for a head role, dispatch under standalone and confirm the prompt now carries the delegate block that `_resolveDelegateIdentityForTarget` previously withheld.
12. **Standalone, no node-pty.** Force `ptyReady === false` and confirm every one of these paths reports the readable node-pty error rather than throwing.
13. **Agent Groups and `sendToTerminal` still work on standalone** — the two guards deliberately left on `_ptyHostPort`. Their standalone routes bypass the guarded code entirely; confirm the census reasoning by exercising both.

## Recommendation

Complexity 5 → **Send to Coder.**
