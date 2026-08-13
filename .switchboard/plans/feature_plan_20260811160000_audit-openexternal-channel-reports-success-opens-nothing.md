# Audit the openExternal channel — standalone returns `true` and opens nothing

## Goal

Audit every path by which the host is asked to open a URL, establish whether each one produces an
observable effect in the browser cockpit, and close the confirmed gaps behind a ratcheted gate. The
headless shim currently **reports success while doing nothing**, so `serveAndOpenHtml` — a verb whose
entire purpose is opening a preview tab — is a silent no-op in standalone.

This plan also **owns the browser-side notice surface** that the sibling command-seam plan consumes.
See "Shared surface ownership" below — that ownership is the reason this plan lands first.

### Problem

```ts
// src/standalone/vscodeShim.ts:282-286  ← the live standalone path
export async function openExternal(target: Uri | string): Promise<boolean> {
    const url = typeof target === 'string' ? target : target?.fsPath || '';
    console.log('[headless openExternal]', url);
    return true;
}
```

`return true` is the worst shape in the seam layer. Every other headless stub either throws
(`showInputBox` → `headlessReject`, `window.createTerminal` → throws) or returns a value that at least
*reads* as absence (`undefined`, `''`). This one affirmatively claims the URL was opened. Any caller
that branches on it takes the happy path; any audit that checks the return value gets a green.

The seam in front of it (`HostUI.openExternal`, declared at `hostSeams.ts:362`) is `Promise<void>`, so the
boolean is discarded before it reaches a caller — meaning the lie is **latent, not currently
mis-branching**. Verified against the current tree: the direct `vscode.env.openExternal` sites are
`extension.ts:1260`, `hostSeams.ts:418` (the seam's own vscode implementation, not a caller) and
`NotionFetchService.ts:611`; all `await` or fire-and-forget and none branch on the result. That is worth
stating precisely, because it changes the fix: the bug today is the *missing effect*, and the misleading
return is a trap for whoever next writes `if (await openExternal(...))`.

> **Superseded:** "the three direct `vscode.env.openExternal` callers (`extension.ts:1260`,
> `hostSeams.ts:418`, `NotionFetchService.ts:611`)" — and the Complexity Audit's "four direct
> `vscode.env.openExternal` sites".
> **Reason:** re-measured this pass. `hostSeams.ts:418` is the seam's *implementation*, not a caller, so
> counting it as one inflates the caller list. The fourth site is inside
> `src/services/PlanningPanelProvider.ts.bak3` — a 1,255-line backup file that is not compiled and not a
> call site at all.
> **Replaced with:** **two** real direct callers (`extension.ts:1260`, `NotionFetchService.ts:611`), plus
> one seam implementation (`hostSeams.ts:418`) and one occurrence in a dead `.bak3` file that must be
> deleted rather than audited.

**The missing effect, per call site.** Seven seam sites, and the browser gets nothing at any of them
(line numbers re-verified against the current tree this pass):

| Site | Enclosing verb | What the user did | Browser result |
| :--- | :--- | :--- | :--- |
| `PlanningPanelProvider.ts:2865` | `serveAndOpenHtml` | Preview an HTML doc | **nothing opens** |
| `DesignPanelProvider.ts:3118` | `serveAndOpenHtml` | Preview a design HTML | **nothing opens** |
| `TicketsPanelProvider.ts:3554` | `openAttachment` | Open a ticket attachment | **nothing opens** (`file://`) |
| `TaskViewerProvider.ts:12898` | `openExternalUrl` | (API-driven only) | nothing opens |
| `TaskViewerProvider.ts:12905` | `openDocs` | Open docs | nothing opens |
| `SetupPanelProvider.ts:1480` | `_openDocs` | Open docs | nothing opens |
| `sharedUtilityVerbs.ts:60` | `openExternalUrl` | (API-driven only) | nothing opens |

> **Superseded:** the previous table's line numbers `TicketsPanelProvider.ts:3344`,
> `TaskViewerProvider.ts:12565` and `TaskViewerProvider.ts:12572`, and the label "docs link" for the last
> of those.
> **Reason:** the tree moved since the plan was written; those lines no longer point at the call sites. A
> coder following stale line numbers edits the wrong arm or concludes the site was already fixed.
> **Replaced with:** `TicketsPanelProvider.ts:3554`, `TaskViewerProvider.ts:12898`,
> `TaskViewerProvider.ts:12905`, and the correct verb name `openDocs`.

`serveAndOpenHtml` is the headline: the verb serves the HTML *and then* opens it, so in the browser the
server starts and the tab never appears — indistinguishable from a broken preview.

### Root cause

Four compounding causes, each needing a different answer — which is why this needs an audit rather than
a one-line patch:

**1. No browser-facing delivery mechanism exists for "open a URL".** The only response-body convention
`transport.js` implements is `result.prompt` (→ clipboard, `:372-376`). There is no `openUrl` equivalent,
and `window.open` appears in only two webview files (`terminals.js:768`, `shell.js:739`) — both for panel
pop-outs, neither reachable from a verb response.

> **Superseded:** "The response-body conventions `transport.js` implements are `result.prompt`
> (→ clipboard, `:372`) and `result.__notices`."
> **Reason:** verified this pass — `__notices` does not exist anywhere in `src/webview/` or
> `src/services/`. `grep -rn "__notices" src/` returns nothing. Building on a convention that isn't there
> is how a coder ends up inventing a second, incompatible notice channel.
> **Replaced with:** `result.prompt` is the **only** body convention today. The single browser-side notice
> primitive is `showTransportError` (`transport.js:324-342`) — an 8-second auto-dismissing error toast.

**2. The canonical verb returns nothing to act on.**

```ts
// src/services/sharedUtilityVerbs.ts:54-64
const url = msg.url as string;
if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    deps.seams().ui.openExternal(url);   // not awaited
    return { success: true };            // no url in the body
}
```

Identical shape to `copyDiagramPrompt`: side effect through a dead seam, `{ success: true }` back to a
client that has nothing to do with it.

**3. One site is not deliverable to a browser at all.** `openAttachment` builds a `file://` URL via
`pathToFileURL(localPath)`. A page served over `http://localhost` cannot `window.open` a `file://` URL —
browsers block it. So this site needs a *different* answer (serve the bytes over the existing static
route, or a download), not the same `openUrl` field. An audit that treats all seven sites as one fix
would ship six working buttons and one that fails for a reason nobody wrote down.

**4. (New this pass) `TaskViewerProvider`'s `openExternalUrl` arm returns a false success on a rejected
scheme.** Verified at `TaskViewerProvider.ts:12896-12902`:

```ts
case 'openExternalUrl':
    if (data.url && typeof data.url === 'string' && data.url.startsWith('https://')) {
        this._seams().ui.openExternal(data.url);
    } else if (data.url) {
        console.warn(`[TaskViewerProvider] Blocked openExternalUrl with disallowed scheme: ${data.url}`);
    }
    return { success: true };   // ← blocked scheme still reports success
```

Two defects in eight lines: it accepts **only `https://`** (diverging from `sharedUtilityVerbs`, which
allows `http://` too), and a *blocked* URL still returns `{ success: true }` with the rejection buried in
a server-side `console.warn`. That is a direct violation of PRD contract #4 ("Failure branches … return
`{success:false, error}` so an HTTP caller sees the failure, never a false success") sitting inside the
very arm this plan edits. Fix it in the same pass — it is one line, and leaving it turns the new `openUrl`
field into a body that is sometimes absent with no stated reason.

## Metadata

- **Complexity:** 6
- **Tags:** backend, frontend, bugfix, reliability, ui, security
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 5.
> **Reason:** this plan now additionally owns the shared browser notice surface (`showTransportNotice`)
> that the sibling command-seam plan consumes, and — after the browser-behaviour research came back — its
> open mechanism changed from a one-line response-handler `window.open` to a synchronous pre-allocated
> `about:blank` handle with its own lifecycle, plus a new client/server invariant (`URL_OPENING_VERBS`)
> that the gate must enforce. That is a cross-plan contract plus a cross-cutting invariant, not a 5.
> **Replaced with:** **Complexity:** 6.

## User Review Required

None. Every decision in this plan is made: the shim returns `false`, `openAttachment` is served through
the static-asset route (with an explicit browser message as the bounded fallback), this plan owns
`showTransportNotice`, `TaskViewerProvider`'s scheme divergence is aligned to `http(s)` with a real
failure body, and the open mechanism is the synchronous pre-allocated `about:blank` handle. The
browser-behaviour questions that previously blocked Phase 4 are settled — see **Resolved Assumptions**.
Nothing is left for the user to arbitrate.

## Shared surface ownership (cross-plan contract)

Both this plan and **Audit the command seam** need a browser-side notice that the transient
`showTransportError` cannot provide — this one needs a *persistent, clickable* link; the sibling needs a
*per-occurrence* report from `reportCommandFailure`. Neither plan originally said who builds it, so both
would have written a competing notice host into the same file.

**Decision: this plan owns it.** It needs the harder variant, so it builds the general primitive and the
command-seam plan consumes it:

```js
// transport.js — built here, consumed by reportCommandFailure's browser delivery.
// showTransportNotice(text, opts) where opts = { url?: string, persistent?: boolean, tone?: 'error'|'info' }
```

**The trap this must avoid:** `showTransportError`'s host element sets `pointer-events:none`
(`transport.js:335`). A clickable `<a>` inside that host is **unclickable** — the popup-blocked fallback
would render a link the user physically cannot activate, reproducing the exact silent-failure defect this
plan exists to fix. The persistent/link variant MUST set `pointer-events:auto` on its own host, and must
not reuse the `sb-transport-error` element (whose 8-second `_hideTimer` would eat the link).

## Complexity Audit

### Routine

- The inventory. Seven seam sites plus the direct `vscode.env.openExternal` sites, all enumerable in one
  pass. Small enough that the audit is exhaustive by construction.
- Adding an `openUrl` field to a verb return body — the same shape as the existing `result.prompt`
  handling.
- Making the shim's `openExternal` return `false`. Verified safe: no caller branches on it today.
- Deleting `src/services/PlanningPanelProvider.ts.bak3`.
- Aligning `TaskViewerProvider`'s `openExternalUrl` scheme check with `sharedUtilityVerbs` and returning a
  real failure body.

### Complex / Risky

- **A post-`fetch` `window.open` is unconditionally dead on WebKit.** Research (see **Resolved
  Assumptions**) confirms WebKit revokes transient activation at the asynchronous task boundary — an
  `await fetch()` kills it regardless of latency. Chromium and Gecko keep it for ~5s wall-clock, so a
  post-response open *works there* and *never works in Safari*. This makes the naive "open it when the
  response arrives" design not a risk but a guaranteed one-engine failure, which is why Phase 4 now
  pre-opens synchronously at dispatch. Same class of restriction that already bites the clipboard path
  (`memo-browser-clear-and-copy-contract.test.js`).
- **The open must now be initiated before the verb is known to return a URL.** The synchronous pre-open
  pattern requires deciding *at click time* whether this verb will produce a URL, so it introduces a
  client-side `URL_OPENING_VERBS` map that must stay in sync with the server arms returning `openUrl`.
  Drift in that map is silent on Chromium/Gecko (the post-fetch open still works there) and fatal on
  WebKit — the single worst shape for a bug. Phase 2's gate must enforce the invariant; a code review
  will not catch it.
- **A pre-opened window is a resource with a lifecycle.** It can be closed by the user mid-fetch, and it
  leaks as a blank tab if the verb fails. Both paths need explicit handling or the fix ships a new
  defect (orphan `about:blank` tabs) in exchange for the old one.
- **The notice surface is shared with the sibling plan** (see "Shared surface ownership"). Getting the
  primitive's shape wrong forces the command-seam plan to fork it.
- **`openAttachment`'s `file://` case needs a design decision**, not a port. Serve the file through the
  existing static/attachment route and return that URL as `openUrl`. The attachment path is
  user-influenced, so the new route needs the same traversal guard as `design-asset-route-traversal.test.js`
  covers today.
- **Deciding what "success" means.** Once the URL is delivered to the browser, the host no longer knows
  whether the tab opened. The verb's `success` must mean "the URL was delivered to a client that will
  open it", and the browser must own the failure toast. Getting this boundary wrong recreates a lying
  return one layer up.

### Not in scope

- The direct non-verb callers (`extension.ts:1260`, `NotionFetchService.ts:611`).
  `NotionFetchService.ts:611` sits behind `if (choice)` from a `showWarningMessage` that returns
  `undefined` headless, so the branch is already unreachable in standalone — a second dead channel,
  recorded here and left to the notification plan.
- Notification and clipboard channels. Separately planned. **No plan covering either exists in this
  feature or the current candidate set** — they are the remaining two seams of the same shape.

**No confirmation dialogs are added. No migration is needed** — no persisted state is touched.

## Edge-Case & Dependency Audit

### Race Conditions

1. **`serveAndOpenHtml` starts a server before opening.** If the open half fails, the served port is
   still live. Confirm the verb reports the URL even on the open-failure path so the user can reach it
   manually, and that repeated clicks do not leak ports.
2. **The 8-second `_hideTimer` on `sb-transport-error` is shared state.** A link notice that reuses that
   element inherits the timer and vanishes mid-read. The link variant needs its own host element.

### Security

3. **URL validation must not regress.** `handleOpenExternalUrl` allows only `http://` and `https://`
   (`sharedUtilityVerbs.ts:59`). Any new `openUrl` body field is attacker-influenceable input to
   `window.open`, so `transport.js` must re-validate the scheme client-side — a server-side check is not
   sufficient once the value crosses into the DOM. Explicitly reject `javascript:`, `data:` and `file:`.
4. **The two arms disagree on allowed schemes today.** `sharedUtilityVerbs` permits `http(s)`;
   `TaskViewerProvider.ts:12897` permits `https` only. Converge on `http(s)` in both, with the strict arm
   returning `{ success: false, error }` rather than a silent `console.warn` + `{ success: true }`.
5. **A new attachment-serving route widens the file-read surface.** Reuse the traversal guard pattern
   `design-asset-route-traversal.test.js` locks down; if the attachment root cannot be safely bounded, do
   not ship the route — fall back to the explicit browser message.

### Side Effects

6. **`file://` cannot be opened from an `http://` origin.** Applies to `openAttachment` only. Must not be
   silently routed through the same `openUrl` field, or it becomes a blocked-popup mystery.
7. **Extension-served browser vs standalone.** With the extension running, `openExternal` opens the tab on
   the machine hosting the extension — correct when that is the user's machine, wrong when the browser is
   remote. Once `openUrl` delivery lands, prefer the browser-side open in both hosts for consistency, and
   verify the double-open risk (host opens a tab *and* the browser opens one) does not materialise.
8. **`showTransportError`'s host is `pointer-events:none`.** Reusing it for a clickable link produces a
   link that cannot be clicked. Covered under "Shared surface ownership"; repeated here because it is the
   kind of detail that survives review and dies in UAT.
9. **A pre-opened `about:blank` tab leaks if the verb does not return a URL.** Failure branches, a
   `serveAndOpenHtml` whose server did not start, a rejected `fetch`, and a client-side scheme rejection
   all reach the response path with a live handle. Every one closes it (Phase 4). An orphan blank tab per
   click is a worse regression than the bug being fixed.
10. **WebKit does not propagate user activation across frames.** Chromium and Gecko propagate up through
    same-origin parents; WebKit isolates activation to the frame that received the hardware event. Today
    the click and the `window.open` both happen inside the panel iframe, so this is safe — but any future
    change that proxies panel clicks up to the shell before dispatching would break Safari **only**, and
    silently. Do not move the dispatch out of the panel frame.

### Dependencies & Conflicts

9. **`openExternalUrl` is verb-reachable but UI-dead.** No webview posts it — Tickets deliberately uses a
   native `<a href>` instead (`tickets.js`, with a comment saying the postMessage route "would trigger the
   permission modal"). So the verb is exercised only by external API clients. Do not "restore" a UI caller
   as part of this work; the `<a href>` approach is the better pattern and the audit should record it as
   such.
10. **The `<a href>` pattern may be the right fix for more sites.** Where a URL is known at render time, a
    real link beats a verb round-trip: no popup blocking, no delivery channel, no host involvement. The
    audit must state, per site, whether the URL is render-time-known — for those, the fix is markup, not
    plumbing.
11. **Two providers implement `serveAndOpenHtml`** (`PlanningPanelProvider.ts:2853`,
    `DesignPanelProvider.ts:3105`). Both need the fix; fixing one leaves a panel-shaped inconsistency
    that reads as "the Design preview is broken."
12. **No existing gate covers this channel.** `check-push-routing.js`, `check-standalone-push-parity.js`
    and `check-verb-return-contract.js` measure raw `postMessage` counts, webview message types and
    `break` counts respectively. None can express "this verb asked the host to open a URL and the browser
    never heard about it."
13. **`src/services/PlanningPanelProvider.ts.bak3` is in the tree** (1,255 lines, one `openExternal`
    occurrence). Any glob wider than `*.ts` picks it up and inflates the count. Delete it; do not
    allowlist it.

## Dependencies

- **Blocks:** *Audit the command seam — unbridged commands are dead and their failures are swallowed*
  (same feature). That plan's `reportCommandFailure` delivers through the notice primitive this plan
  builds. Land this first.
- **Shared files, serialise:** `package.json` and `.github/workflows/integration-tests.yml` — the sibling
  plan adds its own `test:contract:*` and `check-*` entries to both. `src/webview/transport.js` — this
  plan owns the notice primitive; the sibling only calls it.
- **Baselines that must not move:** `check-push-routing.js`, `check-standalone-push-parity.js`,
  `check-verb-return-contract.js`.
- **Known baseline:** five regression tests are red at HEAD. Run the contract suites against a clean stash
  first so a pre-existing red is not attributed to this change.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is now drift between the client-side `URL_OPENING_VERBS` map and the
server arms that return `openUrl`: a missing entry still works on Chromium and Gecko (their ~5s transient
activation covers a fast fetch) and is dead on WebKit, so it passes review and every single-engine test —
mitigated by making that invariant the gate's load-bearing rule and duplicating it as a contract test,
plus an ordering assertion that `window.open` precedes `fetch`. Secondary risks are lifecycle leaks from
the pre-opened `about:blank` handle (closed on every non-URL path, including rejected fetches) and the
shared notice surface, where `showTransportError`'s `pointer-events:none` host and 8-second timer would
render an unclickable or self-erasing link — so this plan builds a separate persistent host and the
sibling command-seam plan consumes it rather than forking one. The `noopener` and transient-activation
questions that previously carried this risk are resolved and closed.

## Proposed Changes

### Phase 0 — Delete the backup file

`git rm src/services/PlanningPanelProvider.ts.bak3`. It is a 1,255-line stale copy that contaminates any
count and will be re-found by the next auditor. Do this first so the Phase 1 numbers are clean.

### Phase 1 — Audit (do this before any other edit)

**Channel definition:** every call to `HostUI.openExternal` or `vscode.env.openExternal` reachable from a
panel verb.

**Observable of delivery (fixed in advance):** the HTTP response body carries the URL, **and**
`transport.js` acts on it. Nothing weaker counts — specifically, "the seam was called" does not count,
because that is true in both the working and broken worlds.

**Inventory:** the 7 seam sites and 2 real direct sites listed above. Produce a table with one row per
site and these columns, no cell left empty:

| site | enclosing verb | URL known at render time? | scheme | extension-served result | standalone result | fix: `<a href>` / `openUrl` body / serve-locally / unsupported |

**Gate audit:** for each of the three existing ratchets, state the one defect it would catch in this
channel. Expected answer for all three: none. Record that, because it is the justification for the new
gate.

**Falsification pass:** for each site, run it in standalone and confirm
`[headless openExternal] <url>` appears in the server log. That log line is *positive proof* the URL
reached the dead end — a stronger signal than "no tab appeared", which is consistent with a dozen
causes.

### Phase 2 — `scripts/check-open-external-parity.js` (new ratcheted gate)

Follow the repo's actual gate convention, which is **an inline baseline constant plus a JSON file for
allowlist entries that carry reasons** — `check-push-routing.js:27` holds `const BASELINES = {...}` in the
script, and `check-standalone-push-parity.js:60,66` holds `BASELINE_*` constants inline while reading
`scripts/standalone-parity-allowlist.json` for the reasoned allowlist.

> **Superseded:** "Following the `check-push-routing.js` convention (TypeScript AST walk, baseline
> lowered-only) … Baseline in `scripts/open-external-parity-baseline.json`."
> **Reason:** `check-push-routing.js` does **not** keep its baseline in a JSON file — it is an inline
> `const BASELINES` object at `:27`. Citing it as precedent for a JSON baseline sends the implementer to
> copy a convention that does not exist there, and produces a third, inconsistent gate shape.
> **Replaced with:** inline `const BASELINE_UNDELIVERED = <n>` in the script (LOWER only), plus
> `scripts/open-external-allowlist.json` for allowlisted sites, each entry requiring a non-empty `reason`
> — matching `check-standalone-push-parity.js` exactly.

- TypeScript AST walk (not grep — the sibling plan documents why grep is disqualified on this codebase).
- Find every `case` arm whose body reaches `ui.openExternal` or `env.openExternal`.
- Assert the arm returns an object literal carrying a non-empty `openUrl` (or is allowlisted with a
  required `reason` — `openAttachment` will be, until its serving decision lands).
- **Assert the client/server pre-open invariant:** every verb whose arm can return `openUrl` must appear
  in `URL_OPENING_VERBS` in `src/webview/transport.js`, and every key in `URL_OPENING_VERBS` must map to
  such an arm. This is the load-bearing rule of the whole gate. A verb missing from that map still works
  on Chromium and Gecko (the ~5s transient-activation window covers a fast fetch) and is **dead on
  WebKit** — a defect no reviewer and no single-engine test will catch. Parse the map from
  `transport.js` and diff it against the AST-derived arm set.
- Exclude `*.bak*` and `*.d.ts` from the walk.
- Fail when an allowlist entry has no `reason`.

Write the gate **before** the fixes and record its starting number. That number is the audit's finding.

### Phase 3 — Deliver the URL to the browser

`src/services/sharedUtilityVerbs.ts` — the canonical arm:

```ts
export async function handleOpenExternalUrl(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<{ success: boolean; error?: string; openUrl?: string }> {
    const url = msg.url as string;
    if (!url || !(url.startsWith('https://') || url.startsWith('http://'))) {
        return { success: false, error: 'Only http:// and https:// URLs may be opened externally.' };
    }
    await deps.seams().ui.openExternal(url);
    // Standalone's openExternal is a shim no-op that reports success
    // (vscodeShim.ts:282-286), so the body is the only channel that reaches the
    // browser. `success` means "delivered to a client that will open it" — the
    // browser owns the open and its own failure surface.
    return { success: true, openUrl: url };
}
```

Same one-line addition at `PlanningPanelProvider.ts:2865` (`serveAndOpenHtml`),
`DesignPanelProvider.ts:3118` (`serveAndOpenHtml`), `TaskViewerProvider.ts:12898` (`openExternalUrl`),
`TaskViewerProvider.ts:12905` (`openDocs`), and `SetupPanelProvider.ts:1480` (whose `_openDocs` helper
must return the URL to its calling arm).

`TaskViewerProvider`'s `openExternalUrl` arm additionally converts its silent rejection into a real
failure body and accepts `http://` in line with the canonical arm:

```ts
case 'openExternalUrl': {
    const u = typeof data.url === 'string' ? data.url : '';
    if (!u.startsWith('https://') && !u.startsWith('http://')) {
        // Was: console.warn + `{ success: true }` — a false success on a REJECTED
        // scheme, which PRD contract #4 forbids. The caller now sees the refusal.
        return { success: false, error: 'Only http:// and https:// URLs may be opened externally.' };
    }
    await this._seams().ui.openExternal(u);
    return { success: true, openUrl: u };
}
```

### Phase 4 — `src/webview/transport.js` — pre-open synchronously, navigate on response

> **Superseded:** opening the URL in the response handler —
> `const win = window.open(url, '_blank', 'noopener'); if (!win) { showTransportNotice(...) }` — wired next
> to the existing `result.prompt` branch.
> **Reason:** research settled both of the questions this plan flagged, and both answers break that design.
> (1) `noopener` in the `windowFeatures` string makes `window.open` return `null` **per specification,
> whether or not the window opened**, conformed to by Chromium, WebKit and Gecko — so `if (!win)` would
> have fired on every successful open and shown a "popup blocked" link next to a tab that opened fine.
> (2) WebKit revokes transient activation at the `await fetch()` boundary regardless of latency, so a
> response-time `window.open` is **never** permitted in Safari — the fallback would not have been an edge
> case there, it would have been the only path. A design whose success branch is dead on one engine and
> whose failure branch is dead on all three is not salvageable by tuning the check.
> **Replaced with:** the **synchronous pre-allocated `about:blank` handle**. Open the window inside the
> user gesture *before* the fetch, detect blocking immediately and deterministically, then navigate the
> held handle when the response arrives and sever `opener` manually.

`vscodeShim.postMessage` (`transport.js:345`) is already called synchronously from the webview's click
handler, so it still holds transient activation. That is the only place the window can be opened.

```js
const OPENABLE_SCHEMES = /^https?:\/\//i;

// Verbs whose response may carry `openUrl`. The window must be pre-opened INSIDE
// the click, before the fetch — WebKit revokes transient activation at the await
// boundary, so a response-time window.open can never succeed in Safari. Same
// shape and same file as PANEL_SWITCH_VERBS (:312); kept in sync with the server
// arms by scripts/check-open-external-parity.js, which fails if an arm returns
// `openUrl` for a verb that is not listed here.
const URL_OPENING_VERBS = {
    openExternalUrl: true,
    openDocs: true,
    serveAndOpenHtml: true,
};

// A PERSISTENT, CLICKABLE notice. Deliberately NOT sb-transport-error: that host
// is pointer-events:none (:335) — a link inside it cannot be clicked — and it
// self-hides after 8s (:341), which would erase a link before the user reaches it.
function showTransportNotice(text, opts) {
    // opts: { url?: string, persistent?: boolean, tone?: 'error' | 'info' }
    // Own host element, pointer-events:auto, no timer when persistent.
    // When opts.url is set, render an <a target="_blank" rel="noopener"> the user
    // can click — their click supplies the transient activation the fetch lost.
}
```

At the top of `postMessage`, still inside the gesture:

```js
let pendingWindow = null;
if (URL_OPENING_VERBS[verb]) {
    // NOTE: no `noopener` here. Passing it forces a null return by spec even on
    // success, which destroys the only reliable blocked-popup signal. Isolation
    // is applied after navigation via `pendingWindow.opener = null` instead.
    pendingWindow = window.open('about:blank', '_blank');
    // Cross-engine blocked-popup test. WebKit can hand back a handle that is
    // already closed rather than null, so truthiness alone is not sufficient.
    if (!pendingWindow || pendingWindow.closed || typeof pendingWindow.closed === 'undefined') {
        pendingWindow = null;   // resolved after the response, once the URL is known
    }
}
```

In the response handler, next to the existing `result.prompt` branch (`transport.js:372`):

```js
if (result && typeof result.openUrl === 'string' && result.openUrl) {
    deliverUrl(pendingWindow, result.openUrl);
    pendingWindow = null;
} else if (pendingWindow && !pendingWindow.closed) {
    // The verb was on the pre-open list but returned no URL (failure branch, or a
    // serveAndOpenHtml that could not start its server). Do not leak a blank tab.
    pendingWindow.close();
    pendingWindow = null;
}

function deliverUrl(win, url) {
    // The URL crosses into a navigation, so re-validate client-side: a server-side
    // check does not protect the DOM once the value is in the body. javascript:,
    // data: and file: are rejected here regardless of what the host sent.
    if (typeof url !== 'string' || !OPENABLE_SCHEMES.test(url)) {
        console.warn('[transport] refusing to open non-http(s) URL:', url);
        if (win && !win.closed) { win.close(); }
        return;
    }
    if (!win) {
        // Popup was blocked at click time — detected BEFORE the fetch, so this
        // notice is deterministic, not a guess about the return value.
        showTransportNotice('Popup blocked — click to open:', { url, persistent: true, tone: 'info' });
        return;
    }
    if (win.closed) {
        // User closed the blank tab while the fetch was in flight. Fall back to a
        // link rather than silently discarding the URL.
        showTransportNotice('Tab was closed — click to open:', { url, persistent: true, tone: 'info' });
        return;
    }
    win.location.href = url;
    win.opener = null;   // the isolation `noopener` would have given us
}
```

Also add a `catch` on the existing fetch rejection path (`transport.js:414`) that closes `pendingWindow` —
a network failure must not strand a blank tab either.

**Ordering note:** the `result.prompt` clipboard write and the URL delivery can both appear in one
response. `navigator.clipboard.writeText` is also an activation-gated API, but by response time no
activation remains on any engine and the pre-opened handle does not need any, so the two are independent.
Keep the clipboard branch first, unchanged.

### Phase 5 — Make the shim honest

```ts
// src/standalone/vscodeShim.ts:282-286
export async function openExternal(target: Uri | string): Promise<boolean> {
    const url = typeof target === 'string' ? target : target?.fsPath || '';
    // Returns FALSE: headless cannot open a tab. The previous `true` claimed
    // success and would send any future `if (await openExternal(...))` down the
    // happy path. The real delivery is the verb body's `openUrl` field.
    console.log('[headless openExternal] not opened (headless):', url);
    return false;
}
```

Safe today — verified that no caller branches on the result — and it stops the trap from being armed.

### Phase 6 — `openAttachment`, decided rather than deferred

`file://` is not openable from the cockpit's origin. Research confirms the block is universal **and that
its failure mode diverges by engine**: assigning `win.location.href = 'file://…'` throws a
`SecurityError` in WebKit and Gecko but is silently blocked in Chromium with console-only output, and a
direct `window.open('file://…')` throws nowhere. So routing `openAttachment` through the `openUrl`
channel would produce an exception on two engines and silence on the third — strictly worse than the
single silent failure it replaces. This settles the decision rather than merely justifying it.

Serve the attachment through the existing static-asset route instead and return that HTTP URL as
`openUrl`, reusing the traversal guard pattern that `design-asset-route-traversal.test.js` locks down for
design assets. If the audit finds the attachment root cannot be safely bounded, the fallback is an
explicit browser notice — "attachments open in the editor only" — never a silent no-op, and never a
`file://` value in the `openUrl` field. `openDeliveredUrl`'s scheme check rejects `file:` as a backstop.

### Phase 7 — `src/test/browser-open-external-parity.test.js` (new)

- For `openExternalUrl` and both `serveAndOpenHtml` arms: call `handleServiceVerb` with headless seams and
  assert the body's `openUrl` **equals** the URL handed to the seam recorder. Equality is the assertion —
  a body field that disagrees with the seam is worse than no field.
- Assert a `javascript:` URL is rejected by the arm *and* by `openDeliveredUrl`.
- Assert `TaskViewerProvider`'s `openExternalUrl` returns `{ success: false, error }` — not
  `{ success: true }` — for a rejected scheme.
- **The pre-open invariant:** assert `URL_OPENING_VERBS` equals the set of verbs whose arms can return
  `openUrl`. This duplicates the gate deliberately — the gate catches drift in CI, the test catches it in
  the suite a coder actually runs locally.
- **Ordering:** assert `window.open` is called **before** `fetch` for a listed verb (record call order on
  the stubs). This is the regression test for the whole WebKit failure mode; a refactor that moves the
  open into the response handler passes every other assertion here.
- **`noopener` must not be in the feature string.** Assert the third argument to `window.open` does not
  contain `noopener` — the exact mistake this phase supersedes, and one that reintroduces a
  100%-false-positive "popup blocked" notice.
- Assert `win.opener` is set to `null` after `location.href` is assigned.
- JSDOM matrix on the pre-opened handle:
  - stub returning a live object → assert `location.href` receives the URL and **no** notice appears;
  - stub returning `null` → assert a persistent link node appears, that it is clickable
    (`pointer-events` is not `none` on it or any ancestor the test constructs), and that no dismiss timer
    is registered;
  - stub returning `{ closed: true }` → assert the same link fallback (the WebKit already-closed-handle
    case);
  - stub returning a live object, then a response with **no** `openUrl` → assert `close()` was called
    (no leaked blank tab);
  - stub returning a live object, then a rejected `fetch` → assert `close()` was called.
- Assert the shim's `openExternal` resolves `false`.

Register as `test:contract:browser-open-external` in `package.json` and add it plus
`check-open-external-parity` to `.github/workflows/integration-tests.yml`. A script in `package.json` that
CI never invokes is not a gate.

## Resolved Assumptions

Web research was run and returned. **These questions are closed — do not re-open them.** All four
outcomes are already folded into Phases 2, 4, 6 and 7 above.

1. **`window.open(url, '_blank', 'noopener')` returns `null` on success as well as on failure.** Mandated
   by the WHATWG HTML Living Standard (`window.open` steps, step 15) and conformed to by Chromium, WebKit
   and Gecko. **Consequence:** `noopener` must never appear in the `windowFeatures` string here; isolation
   is applied post-navigation via `win.opener = null`. The pre-2017 belief that Chrome/Safari return a
   stripped handle is a legacy bug, not current behaviour.
2. **A blocked popup returns `null` in Chromium and Gecko; WebKit may return a handle that is already
   closed.** **Consequence:** the detection is
   `!win || win.closed || typeof win.closed === 'undefined'`, not a truthiness check. No engine throws a
   catchable exception on a blocked popup — exceptions occur only under CSP or sandbox violations.
3. **Transient activation does NOT survive a `fetch()` boundary on WebKit.** Chromium and Gecko keep it
   for a ~5s wall-clock window, so a post-response open works there; WebKit binds activation to the
   synchronous task context and revokes it at any async boundary, irrespective of latency.
   **Consequence:** the window must be opened synchronously inside the click, before the fetch — the
   pre-allocated `about:blank` pattern in Phase 4. Also confirmed: activation is *consumed* by the first
   gated call, so a `clipboard.writeText` before a `window.open` in the same gesture would block the open
   on every engine.
4. **`file://` from an `http://` origin is blocked everywhere, and the failure mode diverges.**
   `window.open('file://…')` throws nowhere; assigning `location.href = 'file://…'` throws `SecurityError`
   in WebKit and Gecko but is silently blocked with console-only output in Chromium. **Consequence:**
   `openAttachment` must not use the `openUrl` channel at all — Phase 6's serve-over-HTTP decision is
   now load-bearing rather than merely preferred.

Additional finding folded in: activation propagates up through same-origin parent frames on Chromium and
Gecko but stays isolated to the frame receiving the hardware event on WebKit. The click originates in the
panel iframe, which is the frame that opens the window, so the current shell layout is safe — recorded
under Edge Cases so a future shell-level click proxy does not break Safari silently.

Everything else in this plan was measured directly against the tree.

## Verification Plan

**Audit output (the actual deliverable)**
1. The per-site table from Phase 1, every cell filled, with `unknown` used where it is true rather than
   inferred.
2. `node scripts/check-open-external-parity.js` on the untouched tree — the starting violation count.
3. The gate-audit statement: which existing ratchets could have caught this (expected: none).

**Build & static gates**
4. `npm run compile-tests`, `npm run compile`, `npm run lint`.
5. `node scripts/check-open-external-parity.js` — at the allowlist floor, every allowlist entry carrying a
   `reason`.
6. `node scripts/check-push-routing.js`, `node scripts/check-standalone-push-parity.js`,
   `node scripts/check-verb-return-contract.js` — no baseline may move.

### Automated Tests

7. `npm run test:contract:browser-open-external` (new).
8. `npm run test:contract:design-asset` — the traversal guard, mandatory if Phase 6 adds a serving route.
9. `npm run test:contract:verb-engine`, `:verb-engine-planning`, `:verb-engine-tickets`.
10. Run 7–9 against a clean stash first; five regression tests are already red at HEAD.

**Manual — standalone (the broken host)**
11. `npx switchboard` with the extension stopped. Project panel → preview an HTML doc. Expect a new tab
    (today: nothing, silently).
12. Design panel → preview a design HTML. Same expectation — this is the second `serveAndOpenHtml`.
13. Block popups for the site, repeat 11. Expect a **persistent, clickable** link notice — not a console
    warning, not a toast that vanishes before it can be clicked, and not a link with
    `pointer-events:none`.
14. With popups **allowed**, repeat 11 and confirm **no** "popup blocked" notice appears alongside the
    opened tab. This is the regression check for the superseded `noopener` design, which produced that
    notice on 100% of successful opens.
15. **Repeat 11 in Safari** (or any WebKit build). This is the engine the superseded design failed on
    entirely and the only one that exercises the pre-open path's reason for existing. A tab must open.
16. Trigger a URL-opening verb whose server side fails (e.g. `serveAndOpenHtml` on a missing file) and
    confirm **no blank `about:blank` tab is left behind**.
17. Close the blank tab manually while a slow `serveAndOpenHtml` is still fetching. Expect the persistent
    link notice, not silence.
18. Setup panel → docs link. Expect a tab.
19. Tickets → open an attachment. Expect either the served URL opening, or an explicit
    "editor only" message — **not** silence, and **not** a `file://` value in the response body.
20. POST `openExternalUrl` with a `javascript:` URL through the API and confirm the body is
    `{ success: false, error }`, not `{ success: true }`.
21. Confirm the server log's `[headless openExternal]` line no longer appears for the fixed sites
    (positive proof the URL took the body channel instead of the dead end).

**Manual — extension-served and editor**
22. With the extension running, repeat 11–13 and 18 and confirm exactly **one** tab opens per click, not
    two (host open + browser open).
23. In VS Code, exercise the same buttons in the panel webviews and confirm unchanged native behaviour.

---

**Recommendation: Send to Coder** (complexity 6). No blockers remain — the browser-behaviour research is
back and folded in (**Resolved Assumptions**). All seven phases can proceed. Land this before the sibling
command-seam plan, which consumes the notice primitive built here.
