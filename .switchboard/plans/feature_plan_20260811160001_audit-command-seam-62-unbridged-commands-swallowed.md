# Audit the command seam — unbridged commands are dead and their failures are swallowed

## Goal

Audit every `commands.executeCommand` call reachable from a panel verb, classify each command id as
bridged / editor-only / client-owned / **dead in standalone**, make an unbridged command fail loudly
instead of returning `undefined`, and ratchet the dead count so it cannot grow. This is the largest
silent channel in the codebase: **196 call sites, 77 distinct command ids, 11 registered in standalone**
(measured by TypeScript AST walk over `src/services` + `src/standalone`, this pass).

> **Superseded:** the plan's title and headline figures — "62 of 71 commands are unbridged",
> "**175 call sites, 71 distinct command ids, 9 registered in standalone**".
> **Reason:** re-measured with a TypeScript AST walk this pass. The tree moved: `switchboard.pushTicketEdits`
> and `switchboard.pushTicketEditsWithSubtasks` are now registered in `bootstrap.ts`, and five unbridged
> ids the original table missed are called from in-scope files. Every number in the original was low.
> A count in the *title* rots the fastest of all, so the title no longer carries one.
> **Replaced with:** **196 call sites, 77 distinct ids, 11 registered, 66 unbridged.** The count lives in
> the Goal, where a re-measure updates it without renaming the card.

### Problem

Standalone injects `createVscodeHostSeams` (`src/standalone/bootstrap.ts:659`), so the command seam is
`VscodeHostCommands`, which is registry-first:

```ts
// src/services/hostSeams.ts:327-336
async executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
    try {
        if (this._registry.has(command)) {
            return await this._registry.execute<T>(command, ...args);
        }
        return await vscode.commands.executeCommand<T>(command, ...args);
    } catch {
        return undefined;      // ← every failure becomes "undefined"
    }
}
```

Unregistered commands fall through to `vscode.commands`, which under the webpack alias
(`webpack.config.js:149-150`) is the shim:

```ts
// src/standalone/vscodeShim.ts:243-250
const _warnedUnbridged = new Set<string>();
export async function executeCommand(command: string, ..._args: any[]): Promise<any> {
    if (!_warnedUnbridged.has(command)) {
        _warnedUnbridged.add(command);
        console.warn(`[headless] command '${command}' is not bridged — the calling arm's side effect did not happen`);
    }
    return undefined;
}
```

The shim's own comment states the consequence exactly: *"the calling arm's side effect did not happen."*
It is a `console.warn`, **warn-once per id per process**, on a long-running server — so occurrence #2
through #N are invisible, and #1 is lost to scrollback. Meanwhile `VscodeHostCommands` swallows
exceptions, so a *thrown* failure is indistinguishable from a command that returned nothing normally.

**Measured gap.** Commands registered by `bootstrap.ts` (11, verified this pass):

```
revealFileInOS, revealInExplorer, vscode.open,
switchboard.refreshUI, switchboard.focusTerminalByName,
switchboard.triggerAgentFromKanban, switchboard.triggerBatchAgentFromKanban,
switchboard.getAttachmentList, switchboard.downloadAttachment,
switchboard.pushTicketEdits, switchboard.pushTicketEditsWithSubtasks
```

Distinct ids called through the seam in scope: **77**. Unbridged: **66**. The dead list includes whole
feature surfaces:

| Surface | Dead command ids |
| :--- | :--- |
| Tickets integration writes | `importClickUpTask`, `importLinearTask`, `importAllTasks`, `importTaskAsDocument`, `postTicketComment`, `postTicketReply`, `loadTicketComments`, `changeTicketStatus`, `deleteTicket`, `removeLocalTicket`, `askAgentTask`, `dispatchToCoderTerminal` |
| Autoban / automation control | `setAutobanEnabledFromKanban`, `setAutobanPausedFromKanban`, `resetAutobanPoolsFromKanban`, `resetAutobanTimersFromKanban`, `addAutobanTerminalFromKanban`, `removeAutobanTerminalFromKanban`, `setPairProgrammingModeFromKanban` |
| Panel navigation | `openKanban`, `openPlanningPanel`, `openProjectPanel`, `openDesignPanel`, `openSetupPanel`, `openTicketsPanel`, `openConnectionsPanel`, `switchboard-view.focus` |
| Plan lifecycle | `completePlanFromKanban`, `restorePlanFromKanban`, `importPlanFromClipboard`, `importUnclaimedPlans`, `syncImportedPlans`, `openPlan`, `initiatePlan`, `kanbanForwardMove`, `kanbanBackwardMove`, `moveKanbanCardByPlanFileWithReason` |
| DB maintenance | `resetKanbanDb`, `reconcileKanbanDbs`, `fullSync` |
| MCP monitor lifecycle | `launchMcpMonitorTerminal`, `stopMcpMonitorTerminal`, `startMcpMonitorPolling`, `stopMcpMonitorPolling`, `checkMcpMonitorAuth` |
| Clipboard / prompt copies | `copyChatPrompt`, `copyPlanFromKanban`, `sendReviewComment` |
| Agent grid / setup | `createAgentGrid`, `createAgentGridEditor`, `setup`, `setupIDEs`, `focusTerminal`, `selectSession`, `toggleSilent`, `mappingsChanged`, `refreshControlPlaneRuntime`, `clearControlPlaneCache`, `analystMapFromKanban`, `batchDispatchLow`, `openInBrowser` |
| Editor built-ins (no headless meaning) | `workbench.action.terminal.paste`, `workbench.action.terminal.moveToTerminalPanel`, `workbench.action.openGlobalKeybindings`, `vscode.openFolder`, `markdown.api.render` |

(All `switchboard.*` ids above are shown without the prefix for width; the four `workbench.*`,
`vscode.openFolder`, `markdown.api.render` and `switchboard-view.focus` ids are literal.)

> **Superseded:** the previous dead table, which listed `pushTicketEdits` under Tickets integration writes
> and omitted `markdown.api.render`, `copyChatPrompt`, `copyPlanFromKanban`,
> `moveKanbanCardByPlanFileWithReason` and `sendReviewComment`.
> **Reason:** `pushTicketEdits` is now registered in `bootstrap.ts` — leaving it on the dead list sends a
> coder to write a handler that already exists. The five omissions are real unbridged ids reachable from
> in-scope files; `markdown.api.render` alone has **10 call sites**, more than any dead id previously
> listed. An audit that is itself incomplete is the failure mode this plan exists to end.
> **Replaced with:** the table above. 62 − 1 (now bridged) + 5 (newly found) = **66**, which reconciles
> exactly with the AST measurement.

Not every one of those is verb-reachable, and a handful are genuinely editor-only — that classification
**is the audit**. What is certain today is that nobody knows which, and the runtime tells no one.

### Root cause

**1. The swallow.** `catch { return undefined }` in `VscodeHostCommands` converts every failure —
unbridged command, thrown handler, bad args — into the same value a successful void command returns.
There is no failure signal for a caller or a test to observe.

**2. The fallback is silent by design, and warn-once makes it quieter.** A `console.warn` is not an
observable in the browser cockpit. The panel that dispatched the verb receives `{ success: true }` because
the arm's own code path completed; only the *effect* is missing.

**3. Panel-navigation commands are dead for a reason nobody recorded — and the reason is narrower than it
looks.** `transport.js:312-320` handles cross-panel switching client-side via `PANEL_SWITCH_VERBS` →
`postMessage({type:'switchPanel'})`. But that interception is **conditional and operates on a different
identifier**:

```js
// transport.js:356-359
if (PANEL_SWITCH_VERBS[verb] && window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'switchPanel', panel: PANEL_SWITCH_VERBS[verb] }, '*');
    return;
}
```

Two things follow, and both were missing from the original analysis:

- The map is keyed by **verb name** (`openKanban`), not command id (`switchboard.openKanban`). It
  intercepts a *webview→transport post*; it does nothing about a *provider arm* calling
  `executeCommand('switchboard.openKanban')`, which is a separate path that still dead-ends in the shim.
- The interception only fires **inside the shell iframe** (`window.parent !== window`). On the standalone
  full-page panel route the code comments say it falls through to the HTTP post and "the server returns a
  no-op ack" — so on that route the navigation is *not* client-owned; it is dead.

So `client-owned` is a real classification, but it must be justified per *call path*, not per id. An id
can be client-owned from the shell and dead from the full-page route simultaneously.

**4. Naive enumeration undercounts, so every previous count was wrong.** A single-line grep for
`executeCommand('...` misses every call that puts the id on the next line — **36 of the 196 in-scope call
sites** do exactly that. It also picks up `switchboard.X` from the doc comment at `commandRegistry.ts:6-7`
(verified: the AST walk correctly ignores it, grep does not). Any audit of this channel must be AST-based;
grep produces a number that is both too small and contaminated. The corrections at the top of this plan are
the proof — the original figures were themselves grep-shaped.

## Metadata

- **Complexity:** 7
- **Tags:** backend, bugfix, reliability, test
- **Project:** Browser Switchboard

## User Review Required

None. The destructive-command policy is decided (withhold the bridge, record the reason, no confirm gate),
the loud-failure mechanism is decided (report per occurrence, do not throw), and the browser delivery
surface is decided (consume `showTransportNotice`, owned by the sibling openExternal plan). The scope of
Phase 4 is bounded by the audit's own output rather than left open.

## Complexity Audit

### Routine

- The AST enumeration itself, and the diff against `bootstrap.ts`'s registration block.
- Registering additional handlers into `switchboardCommandRegistry` — `bootstrap.ts:818-871` already has
  eleven worked examples to copy.

### Complex / Risky

- **Removing the swallow is a behaviour change on 196 call sites.** `catch { return undefined }` is
  load-bearing today: arms were written against a seam that never throws, and several call commands
  opportunistically (fire-and-forget, or "focus the terminal if there is one"). Making it throw
  unconditionally would convert working no-ops into 500s. The change has to distinguish *this command does
  not exist here* from *this command failed*, and only make the former loud — and only where the arm can
  tolerate it. This is the single riskiest edit in the plan.
- **Classification requires judgment per command and per call path, and the judgment is not recoverable
  from the code.** `openKanban` is client-owned *from the shell* and dead *from the full-page route*;
  `postTicketComment` is a real dead write. Neither is annotated. Getting this wrong in the permissive
  direction leaves dead features looking audited; getting it wrong in the strict direction breaks working
  flows with new errors.
- **Some of these commands are destructive.** `resetKanbanDb`, `reconcileKanbanDbs`, `fullSync`. Bridging
  them into standalone gives the headless host destructive powers it does not have today. That is a
  deliberate decision, not a completeness exercise — and per repo policy, bridging them must not
  introduce a confirm dialog. Default to **not** bridging destructive commands; report them as
  "editor-only by decision" with the reason recorded.
- **Autoban and MCP-monitor commands imply subsystems that may not exist headlessly.** Bridging the
  command is meaningless if the thing it drives is absent. The audit must record, per command, whether its
  *subsystem* is present in standalone — otherwise the gate gets satisfied by handlers that no-op just as
  thoroughly as the shim did, which is the failure mode this whole exercise exists to end.
- **`reportCommandFailure`'s browser delivery is not this plan's to build.** It consumes the notice
  primitive the sibling openExternal plan owns (see **Dependencies**). Building a second notice host in
  `transport.js` is the collision this feature's reconciliation pass exists to prevent.

### Not in scope

- Bridging all 66. The deliverable is a classification, a loud failure, and a ratchet — not 66 handlers.
  Phase 4 is bounded to the Tickets-write ids the audit confirms have a headless subsystem; everything
  else is annotate-only.
- The `workbench.*` / `vscode.openFolder` / `markdown.api.render` editor built-ins beyond classifying them
  as such.
- Notification, clipboard and openExternal channels. Separately planned — and note that the three
  clipboard-shaped ids newly surfaced here (`copyChatPrompt`, `copyPlanFromKanban`, `sendReviewComment`)
  are classified in this audit but **fixed** by the clipboard plan, which does not exist yet. Record them
  as `dead` with that pointer rather than absorbing them.

**No confirmation dialogs are added.** Where a bridged command is destructive, it executes immediately as
it does in the editor — the policy is to withhold the bridge, not to gate it behind a prompt.
**No migration is needed** — no persisted state changes shape.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Warn-once is per process, not per request.** Long-running servers lose the signal entirely. Whatever
   replaces it must be observable *per occurrence* and reachable without shell access to the server —
   which means the response body, the browser notice, or the existing session log, not stdout.
2. **`registry.execute` throws on an unregistered command** (`commandRegistry.ts:50-56`), but
   `VscodeHostCommands` calls `has()` first, so that throw is unreachable through the seam. Any change to
   the `has()`-then-`execute` ordering makes it reachable — noted so a later refactor does not turn a
   dead command into a crash.

### Security

3. **Bridging a destructive command widens what an unauthenticated local HTTP caller can do.**
   `resetKanbanDb`, `reconcileKanbanDbs` and `fullSync` reach the board database. They stay `editor-only`
   by decision; the reason is recorded at the call site and in the gate file so the next auditor does not
   read the absence as an oversight.

### Side Effects

4. **Fire-and-forget call sites must not become errors.** `switchboard.refreshUI` (46 call sites — by far
   the most-called) is best-effort UI nudging. It *is* registered in standalone, but the pattern matters:
   any loud-failure change must be opt-in per command class, not blanket.
5. **The extension host must be unaffected.** In VS Code every one of these commands is registered via
   `vscode.commands.registerCommand`, so `has()`/fallback both resolve. Any new loud-failure path must key
   on *headless-and-unbridged*, never on "not in the registry" — the extension deliberately leaves editor
   built-ins out of the registry.
6. **`transport.js` owns panel switching only from inside the shell** (`:356`, guarded by
   `window.parent !== window`). Bridging `switchboard.openKanban` server-side would produce a second,
   competing navigation path in the shell — and doing nothing leaves the full-page route dead. Confirm
   against the client map *and* the route, rather than assuming one answer covers both.

### Dependencies & Conflicts

7. **`switchboard.X` is a doc-comment false positive** (`commandRegistry.ts:6-7`). Grep-based enumeration
   reports it as a dead command forever; the AST walk correctly ignores it. AST-only, verified.
8. **36 of 196 in-scope call sites put the id on a later line.** A single-line grep silently drops them,
   which is very likely how this channel passed prior audits — and how this plan's own original figures
   came out low.
9. **Non-literal call sites are effectively nil, not 33.** The AST walk finds exactly **one** in scope:
   `hostSeams.ts:332`, which is `VscodeHostCommands`'s own forwarding call
   (`vscode.commands.executeCommand<T>(command, ...args)`) — the seam itself, not a classifiable call
   site. Widening to all of `src` adds exactly one more: `extension.ts:2688` (`selected.command`, a
   quick-pick selection, extension-only and not verb-reachable).

   > **Superseded:** "**33 call sites pass a non-literal id** … They must be listed explicitly as
   > *unclassifiable-by-static-analysis* and resolved by reading each one", and the corresponding Phase 1
   > deliverable "a mandatory second list: the **33 non-literal call sites**".
   > **Reason:** measured this pass — the real count is 1 in scope (the seam's own pass-through) and 2
   > across all of `src`. A coder handed "hand-resolve 33 sites" would hunt for 31 things that do not
   > exist, and would reasonably conclude the audit was incomplete when it was not.
   > **Replaced with:** the non-literal list is expected to be **empty after excluding the seam's own
   > forwarding call**. The Phase 2 gate rule stays — a *new* non-literal call site must fail the gate —
   > because guarding zero is exactly how it stays zero. State the count as a finding, not as a backlog.

10. **Two registries, and one bundle is dead.** `src/standalone/hostServices.ts:371`'s
    `createHeadlessHostSeams` implements the same contract and has **zero callers** — verified this pass:
    the only `grep -rn "createHeadlessHostSeams" src/` hits are its definition and three comments saying it
    is not injected (`bootstrap.ts:664`, `bootstrap.ts:817`, `vscodeShim.ts:235`, plus one test comment).
    Any fix applied there is dead code that will read like a completed one to the next auditor.
11. **No existing gate covers this channel.** `check-push-routing.js` counts raw `postMessage` sends,
    `check-standalone-push-parity.js` counts webview message types, `check-verb-return-contract.js` counts
    `break` statements. A missing command side effect is none of those.
12. **`src/services/PlanningPanelProvider.ts.bak3` is in the tree.** The sibling openExternal plan deletes
    it in its Phase 0. Until it is gone, any AST walk globbing wider than `*.ts` double-counts a stale
    copy of a provider. This gate must exclude `*.bak*` and `*.d.ts` regardless.

## Dependencies

- **Blocked by:** *Audit the openExternal channel — standalone returns `true` and opens nothing* (same
  feature). That plan builds `showTransportNotice` in `src/webview/transport.js`;
  `reportCommandFailure`'s browser-visible delivery consumes it. Land that plan first, or this one ships
  a report the browser cannot show.
- **Shared files, serialise:** `package.json` and `.github/workflows/integration-tests.yml` — the sibling
  plan adds its own `test:contract:*` and `check-*` entries to both.
- **Baselines that must not move:** `check-push-routing.js`, `check-standalone-push-parity.js`,
  `check-verb-return-contract.js`.
- **Known baseline:** five regression tests are red at HEAD. Run the contract suites against a clean stash
  first.

## Adversarial Synthesis

**Risk Summary.** The riskiest edit is touching a `catch` that 196 call sites were written against —
mitigated by *adding* a report rather than removing the swallow, so no opportunistic call becomes a 500.
The second risk is classification drift: an id marked `client-owned` on the strength of `transport.js`'s
panel-switch map is only client-owned from inside the shell iframe and from a webview post, not from a
provider arm on the full-page route, so a per-id verdict is not sufficient and the gate must demand a
reason naming the specific client path. Third, this plan's own original figures were wrong in every
column, which is the strongest available argument for the AST-based gate: the number cannot be trusted
unless a machine recomputes it on every CI run.

## Proposed Changes

### Phase 1 — Audit (complete this before any behaviour change)

**Channel definition:** every `commands.executeCommand(...)` call in `src/services` and `src/standalone`
reachable from a panel verb arm.

**Observable of delivery (fixed in advance):** the command's *side effect* is present in standalone —
i.e. a registered handler exists **and** the subsystem it drives exists headlessly. "The seam was called"
does not count. "A handler is registered" alone does not count either: a registered handler that no-ops
is the same defect wearing a bridge.

**Inventory** — `scripts/audit-command-seam.js`, a TypeScript AST walk (not grep) producing one row per
distinct id:

| command id | call sites | verb-reachable? | registered in standalone? | subsystem present headless? | classification | reason |

Exclude `*.bak*` and `*.d.ts` from the walk.

Classifications, exactly four:
- `bridged` — registered and the subsystem exists.
- `editor-only` — no headless meaning (`workbench.*`, `vscode.openFolder`, `markdown.api.render`), or
  deliberately withheld (destructive DB commands). Requires a `reason`.
- `client-owned` — the browser does this itself. Requires a `reason` **naming the specific client path
  and the route on which it applies** — e.g. "`transport.js:356` `PANEL_SWITCH_VERBS`, shell iframe only;
  full-page route falls through to HTTP". A bare "the client does it" is not a reason.
- `dead` — verb-reachable, unbridged, no client-side substitute. **These are the findings.**

Plus a short **non-literal call-site list**: expected to contain only `hostSeams.ts:332` (the seam's own
forwarding call, excluded by definition) and, if the walk is widened past `src/services`/`src/standalone`,
`extension.ts:2688`. Report the count even when it is zero — a zero that was measured is a finding; a zero
that was assumed is the defect.

**Gate audit:** for each existing ratchet, state the one defect it would catch here. Expected: none for
all three. That is the justification for Phase 2.

**Falsification pass:** for each id classified `bridged`, trigger it in standalone and confirm the effect
(a DB row, a file, a log line from the *handler* — not from the seam). For each `dead`, confirm
`[headless] command '<id>' is not bridged` appears once in the server log. That line is positive proof;
"the button did nothing" is not.

### Phase 2 — `scripts/check-command-bridge-parity.js` (new ratcheted gate)

Follow the repo's actual gate convention — an inline baseline constant in the script plus a JSON file for
the reasoned classification entries, matching `check-standalone-push-parity.js` (`BASELINE_*` inline at
`:60,66`; `scripts/standalone-parity-allowlist.json` for reasons). `check-push-routing.js` likewise keeps
its `BASELINES` object inline at `:27`.

> **Superseded:** "Fails when the `dead` count exceeds `scripts/command-bridge-parity-baseline.json`."
> **Reason:** no gate in this repo keeps its numeric baseline in a JSON file; both existing ratchets use
> an inline constant and reserve JSON for reasoned allowlists. Introducing a third shape makes the gate
> family harder to read and the baseline easier to edit unnoticed.
> **Replaced with:** inline `const BASELINE_DEAD = <n>` (LOWER only) in the script, with
> `scripts/command-bridge-classifications.json` holding the per-id classification + `reason` rows.

- Re-runs the Phase 1 AST walk.
- Fails when the `dead` count exceeds `BASELINE_DEAD`.
- Fails when any id lacks a classification, or when an `editor-only` / `client-owned` entry lacks a
  `reason`. An unexplained classification is the drift this gate exists to prevent.
- Fails when a **new** non-literal call site appears outside the known-excluded seam forwarder.
- Fails when a classification file entry names an id the walk no longer finds (stale rows rot the same way
  this plan's own figures did).
- Baseline may only be lowered.

Run it before the fixes to record the true starting number.

### Phase 3 — Make an unbridged command loud, without breaking fire-and-forget

Add an explicit signal instead of removing the `catch`:

```ts
// src/services/hostSeams.ts — VscodeHostCommands
async executeCommand<T = unknown>(command: string, ...args: any[]): Promise<T | undefined> {
    if (this._registry.has(command)) {
        try {
            return await this._registry.execute<T>(command, ...args);
        } catch (err) {
            // A registered handler that THREW is a real failure, not an absent
            // command. Surface it rather than flattening it into `undefined`.
            reportCommandFailure(command, err);
            return undefined;
        }
    }
    try {
        return await vscode.commands.executeCommand<T>(command, ...args);
    } catch (err) {
        reportCommandFailure(command, err);
        return undefined;
    }
}
```

`reportCommandFailure` reports **per occurrence**, not warn-once, and is reachable without shell access to
the server: it routes through the browser notice primitive when a client is live and falls back to the
session log otherwise. The browser side is `showTransportNotice` — **built by the sibling openExternal
plan**, consumed here. Do not add a second notice host to `transport.js`.

It deliberately does not throw: 196 call sites were written against a never-throwing seam, and converting
opportunistic calls into 500s is a larger change than this plan should make. Loudness comes from the report
plus the gate, not from an exception.

The shim's warn-once set (`vscodeShim.ts:243-250`) stays as the stdout breadcrumb, but is no longer the
only signal.

### Phase 4 — Bridge the `dead` ids the audit confirms, and annotate the rest

For each `dead` id whose subsystem exists headlessly, register a handler in `bootstrap.ts` next to the
existing eleven (`:818-871`). Expected first candidates from the inventory: the remaining Tickets
integration writes, whose services are already constructed in the standalone bootstrap — and whose two
`pushTicketEdits*` siblings are already registered there, which is the working precedent to copy.

For each `editor-only` / `client-owned` id, add the `reason` **at the call site** as well as in the
classification file, so the next reader learns it from the code:

```ts
// client-owned (shell route only): transport.js:356 intercepts the `openKanban`
// VERB when the panel is framed by the shell (window.parent !== window) and
// switches panels client-side. It does NOT intercept this command id, and on the
// standalone full-page route the post falls through to HTTP. Bridging this
// server-side would create a second, competing navigation path in the shell.
await this._seams().commands.executeCommand('switchboard.openKanban');
```

Destructive commands (`resetKanbanDb`, `reconcileKanbanDbs`, `fullSync`) are classified `editor-only` by
decision, with that reason recorded. Do **not** bridge them, and do not add a confirm gate.

The three clipboard-shaped ids (`copyChatPrompt`, `copyPlanFromKanban`, `sendReviewComment`) stay `dead`
with a reason pointing at the not-yet-written clipboard plan — the `result.prompt` body convention
(`transport.js:372`) is their fix, not a command bridge.

### Phase 5 — `src/test/command-bridge-parity.test.js` (new)

- Assert `switchboardCommandRegistry.registeredCommands` in a standalone-bootstrapped process is a
  superset of the ids the gate classifies `bridged`.
- For three bridged Tickets commands, call the verb through `handleServiceVerb` with headless seams and
  assert the **effect** (a DB row or file), never that the seam was called.
- Assert a registered handler that throws produces exactly one `reportCommandFailure` per call — call it
  twice and assert two reports, which is the direct regression test against warn-once — and still resolves
  `undefined`.
- Assert `hostServices.ts`'s `createHeadlessHostSeams` has zero callers, so the dead bundle cannot quietly
  become the thing a future fix targets.
- Assert the AST walk's non-literal list contains nothing beyond the seam's own forwarding call.

Register as `test:contract:command-bridge` in `package.json` and add it plus
`check-command-bridge-parity` to `.github/workflows/integration-tests.yml`. A script in `package.json`
that CI never invokes is not a gate.

## Verification Plan

**Audit output (the actual deliverable)**
1. The full 77-row classification table, every row carrying a classification and every `editor-only` /
   `client-owned` row carrying a reason that names its client path and route.
2. The non-literal call-site list with its measured count (expected: the seam forwarder only).
3. `node scripts/check-command-bridge-parity.js` on the untouched tree — the starting `dead` count.
4. The gate-audit statement: which existing ratchets could have caught this (expected: none).
5. An explicit note of anything the audit did **not** cover, with the reason. Silent truncation is the
   failure mode being fixed; an audit that hides its own gaps repeats it.

**Build & static gates**
6. `npm run compile-tests`, `npm run compile`, `npm run lint`.
7. `node scripts/check-command-bridge-parity.js` — at the baseline, no unclassified ids, no reasonless
   classifications, no stale classification rows.
8. `node scripts/check-push-routing.js`, `node scripts/check-standalone-push-parity.js`,
   `node scripts/check-verb-return-contract.js` — no baseline may move.

### Automated Tests

9. `npm run test:contract:command-bridge` (new).
10. `npm run test:contract:verb-engine`, `:verb-engine-kanban`, `:verb-engine-planning`,
    `:verb-engine-tickets` — the broadest net for a seam-signature change.
11. `npm run test:contract:pty-host-gating`, `:terminal-input-path` — `focusTerminalByName` and the
    dispatch commands are on the terminal path.
12. Run 9–11 against a clean stash first; five regression tests are already red at HEAD.

**Manual — standalone**
13. `npx switchboard` with the extension stopped. Exercise one command per bridged surface and confirm the
    **effect**, not the absence of an error: a Tickets import writes a local file, a dispatch reaches a pty.
14. Trigger a `dead` command still classified as such and confirm the new per-occurrence report reaches the
    browser notice or session log — and that it appears on the *second* trigger too, unlike warn-once.
15. Confirm no bridged command produces a `[headless] command ... is not bridged` line (that line's
    presence for a supposedly-bridged id means the registration did not take).
16. Exercise `switchboard.refreshUI`-heavy flows (46 call sites) and confirm no new errors — the
    fire-and-forget regression check.
17. Open a panel on the **full-page** standalone route (not framed by the shell) and trigger a panel-nav
    verb. Confirm the `client-owned` reason recorded in Phase 4 matches what actually happens on that
    route — this is the check that catches a per-id verdict papering over a per-route difference.

**Manual — editor**
18. In VS Code, exercise one command per surface and confirm identical behaviour, including the
    destructive DB commands that remain editor-only.

---

**Recommendation: Send to Lead Coder** (complexity 7). Land after the sibling openExternal plan, which
owns the browser notice surface `reportCommandFailure` delivers through.
