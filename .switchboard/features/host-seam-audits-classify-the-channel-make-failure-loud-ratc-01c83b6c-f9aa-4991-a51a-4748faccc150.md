# Host Seam Audits: Classify the Channel, Make Failure Loud, Ratchet It

**Complexity:** 7

## Goal

Audit the two largest silent channels between panel verbs and the host, classify every call site, make an undeliverable call observable per occurrence rather than warn-once to stdout, and add a ratcheted gate so the dead count cannot grow. The command seam has 175 call sites across 71 distinct command ids with only 9 registered in standalone, behind a blanket catch that turns every failure into the same undefined a successful void command returns. The openExternal shim is worse: it affirmatively returns true while opening nothing, so serveAndOpenHtml starts a server and never shows a tab. Both plans share one method - define the observable of delivery in advance, produce a per-site classification table with mandatory reasons, write the gate before the fixes and record its starting number.

## How the Subtasks Achieve This

- **Audit the command seam**: produces an AST-based inventory of every `commands.executeCommand` reachable from a panel verb — grep undercounts by 16 ids, because those calls put the id on the following line, and it contaminates the count with a doc comment. Each id gets one of four classifications (`bridged`, `editor-only`, `client-owned`, `dead`) with a mandatory reason, the 33 non-literal call sites are hand-resolved rather than silently dropped, `reportCommandFailure` replaces the warn-once-per-process breadcrumb with a per-occurrence signal reachable without shell access to the server, and `scripts/check-command-bridge-parity.js` ratchets the dead count. Only the `dead` ids whose subsystem actually exists headlessly get handlers; destructive DB commands are withheld by decision, with the reason recorded.
- **Audit the openExternal channel**: produces a per-site table across the 7 seam sites and 4 direct callers, adds an `openUrl` field to the verb return body with a client-side scheme re-validation and a persistent clickable-link fallback for the popup-blocked case (which is the default outcome after a `fetch` boundary, not the edge case), makes the shim return `false` so the trap is disarmed before someone writes `if (await openExternal(...))`, decides `openAttachment`'s `file://` case rather than deferring it, and ratchets with `scripts/check-open-external-parity.js`.

## Reconciliation (improve-feature pass, 2026-08-14)

**Read this before the Goal's figures.** Both subtasks were re-measured against the current tree this
pass — the command-seam plan by TypeScript AST walk over `src/services` + `src/standalone`, the
openExternal plan by direct call-site read. Every headline number in the original set was wrong, and the
ordering claim below was wrong in the direction that costs a collision.

### Superseded figures

> **Superseded:** the Goal's "175 call sites across 71 distinct command ids with only 9 registered in
> standalone" and "the 33 non-literal call sites are hand-resolved rather than silently dropped".
> **Reason:** measured this pass. The tree moved (`switchboard.pushTicketEdits` and
> `switchboard.pushTicketEditsWithSubtasks` are now registered in `bootstrap.ts`), five unbridged ids were
> missing from the original dead table — `markdown.api.render` alone has 10 call sites — and the
> non-literal figure was off by an order of magnitude. Sending a coder to hand-resolve 33 sites that do
> not exist reads as an incomplete audit when the audit is in fact complete.
> **Replaced with:** **196 call sites, 77 distinct ids, 11 registered, 66 unbridged, 1 non-literal**
> (`hostSeams.ts:332`, the seam's own forwarding call — excluded by definition, so the classifiable
> non-literal list is empty). 62 − 1 now-bridged + 5 newly found = 66, reconciling exactly.

> **Superseded:** the openExternal plan's "four direct `vscode.env.openExternal` sites" and its table's
> line numbers `TicketsPanelProvider.ts:3344`, `TaskViewerProvider.ts:12565`, `:12572`.
> **Reason:** `hostSeams.ts:418` is the seam's implementation, not a caller, and the fourth site is inside
> `src/services/PlanningPanelProvider.ts.bak3` — an uncompiled 1,255-line backup. The three line numbers
> drifted and now point at unrelated code.
> **Replaced with:** **7 seam sites** (count unchanged, lines corrected to
> `TicketsPanelProvider.ts:3554`, `TaskViewerProvider.ts:12898`, `:12905`) and **2** real direct callers
> (`extension.ts:1260`, `NotionFetchService.ts:611`). The `.bak3` file is deleted in the openExternal
> plan's Phase 0.

### The contended surface: `src/webview/transport.js`

Both subtasks independently required a browser-side notice that the existing primitive cannot give them,
and **neither said who builds it** — the collision this pass exists to catch:

- openExternal needs a **persistent, clickable** link for the popup-blocked path.
- the command seam needs a **per-occurrence** report surface for `reportCommandFailure`.
- the only thing that exists is `showTransportError` (`transport.js:324-342`) — an 8-second
  auto-dismissing error toast whose host sets `pointer-events:none`, so a link rendered inside it is
  physically unclickable.

**Reconciled end-state — one owner, one primitive.** The openExternal plan builds
`showTransportNotice(text, { url?, persistent?, tone? })` on its own host element with
`pointer-events:auto` and no timer on the persistent variant. The command-seam plan **consumes** it.
Neither plan adds a second notice host.

### Ordering — corrected

> **Superseded:** "**No hard ordering.** Both subtasks are audit-first and independently deliverable …
> Either can go first; running them in parallel is viable."
> **Reason:** established above — the command-seam plan's `reportCommandFailure` delivers through a
> browser notice primitive the openExternal plan owns. Running them in parallel puts two agents in
> `transport.js` writing competing notice hosts; running the command seam first ships a report the browser
> cannot display.
> **Replaced with:** **openExternal first, command seam second.** The `package.json` /
> `integration-tests.yml` serialisation noted below still applies on top of this, and the internal
> audit → gate → fix phase order inside each plan is unchanged and still load-bearing.

### Browser-behaviour research — returned and folded in

The openExternal plan's blocking unknowns were researched and are now closed (its
`## Resolved Assumptions` section is authoritative — do not re-open them). Two findings changed its
design outright:

- **`noopener` in the `windowFeatures` string forces `window.open` to return `null` even on success**
  (WHATWG-mandated, conformed to by all three engines). The originally planned blocked-popup detection
  would have fired on 100% of successful opens.
- **WebKit revokes transient activation at the `await fetch()` boundary**, regardless of latency. A
  response-time `window.open` can never succeed in Safari, while Chromium and Gecko keep a ~5s window —
  so the original design would have worked in testing and been dead for Safari users.

**Resulting mechanism change:** the window is now pre-opened synchronously as `about:blank` inside the
click, before the fetch, and navigated when the response arrives (`win.opener = null` supplies the
isolation `noopener` would have). This introduces a client-side `URL_OPENING_VERBS` map in
`transport.js` that must stay in sync with the server arms returning `openUrl` — an invariant the new
gate enforces, because drift is invisible on Chromium/Gecko and fatal on WebKit.

This does not change the ordering decision below; it strengthens it. `transport.js` now carries both the
notice primitive and the pre-open map, so two agents editing it concurrently is a worse idea than it was
before.

### Structural outcome

No merge, no split, no deletion. The two subtasks address genuinely different channels with different fix
shapes; merging them would produce a mega-plan and splitting the command-seam plan's Phase 4 would require
authoring a child plan before its own input (the classification table) exists. The restructure this pass
performed was **corrective**: both plans rewritten with measured figures, the shared surface assigned an
owner, and the ordering constraint recorded here.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Audit the openExternal channel — standalone returns `true` and opens nothing](../plans/feature_plan_20260811160000_audit-openexternal-channel-reports-success-opens-nothing.md) — **PLAN REVIEWED**
- [ ] [Audit the command seam — unbridged commands are dead and their failures are swallowed](../plans/feature_plan_20260811160001_audit-command-seam-62-unbridged-commands-swallowed.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**No hard ordering.** Both subtasks are audit-first and independently deliverable, and they touch different channels. Either can go first; running them in parallel is viable if the shared-file contention below is managed.

**Both are phased internally, and the phase order is load-bearing in each:** audit → gate → fix. The gate must be written and run **against the untouched tree** so its starting number is the audit's actual finding. A gate authored after the fixes, passing on its first run and never seen to fail, guards nothing — which is the same "green while incomplete" hole both plans exist to close.

**Shared files — serialise these two edits:**
- `package.json` — each adds a `test:contract:*` script and a `check-*` script.
- `.github/workflows/integration-tests.yml` — each adds its gate plus its contract test as steps. A script defined in `package.json` but never invoked in the workflow is not a gate.

Note that three other plans in this batch also add steps to those same two files (the two subtasks of **Finish the Dispatch-Path Extractions and Gate Them**, and the fleet-seam plan's new `standalone-fleet-seam` contract test). Five gate-adding plans, two shared files — sequence them across features.

**Existing baselines must not move:** `check-push-routing.js`, `check-standalone-push-parity.js` and `check-verb-return-contract.js` are unrelated to these channels (the command-seam plan's gate audit expects all three to catch nothing here, which is precisely the justification for the new gates) and must stay at their current numbers.

**Explicitly out of scope in both, and not silently absorbed:** the notification and clipboard channels, which both plans name as separately planned. **No plan covering either is in this feature or in the current candidate set** — worth tracking, since they are the remaining two seams of the same shape.

**Related, owned elsewhere:** the blanket `catch { return undefined; }` in `VscodeHostCommands.executeCommand` is the structural enabler behind the swallowed reveal failure that the **Standalone Host: Panel Flows** feature works around. The command-seam plan is the one that changes it — deliberately by adding a report rather than by throwing, since 175 call sites were written against a never-throwing seam and converting opportunistic calls into 500s is a larger change than either plan should make.

**Known baseline:** five regression tests are red at HEAD. Run the contract suites against a clean stash first.
