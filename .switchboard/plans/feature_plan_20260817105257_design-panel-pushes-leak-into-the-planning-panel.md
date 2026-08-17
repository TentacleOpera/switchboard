# Design panel pushes leak into the Planning panel — tag DesignPanelProvider's broadcasts with a surface

## Goal

Stop the Design panel's host→UI pushes from being delivered to the Planning panel (and every other
surface-declaring panel) in the browser cockpit, so opening `planning.html` after `design.html` no
longer shows the raw HTML source of the last file previewed in Design as the Docs tab's first
document.

### Observed problem

Open `design.html` in the cockpit, select an HTML file (HTML Previews / Design / Claude / Images /
Stitch HTML tab). Switch to `planning.html`. The Docs tab's preview pane is already populated —
with the **HTML source text** of the file that was last opened in the Design panel, rendered as if
it were a planning document. No document in the Planning panel's own tree is selected.

**Confirmed trigger (reporter, 2026-08-17):** a coding agent was writing to that HTML file while the
user was looking at a different panel. That is the save-watcher auto-refresh path, and it is the
only `previewReady` path that broadcasts — see Root cause §3. The selection itself is incidental: it
seats the file for the watcher, but a Design preview that is never re-written on disk cannot leak.

### Root cause

Three facts compose into the leak.

**1. `DesignPanelProvider` broadcasts every push untagged.**

`src/services/DesignPanelProvider.ts:817`

```ts
public postMessage(message: any): void {
    if (this._broadcaster) {
        this._broadcaster.push(message);          // ← no surface argument
    } else {
        this._postRawToWebview(message);
    }
}
```

All 116 `this.postMessage(...)` sites in the provider funnel through here. Compare
`PlanningPanelProvider.postMessageToWebview` (`src/services/PlanningPanelProvider.ts:927`), which
does pass one:

```ts
this._broadcaster.push(message, 'planning');
```

**2. An untagged push is delivered to every WS connection, by design.**

`src/services/wsHub.ts:379` — `broadcast(verb, payload, surface?)`:

```ts
// Deliver unless ALL THREE hold: the push is tagged, the connection
// declared a set, and the tag is not in it. Untagged → everyone (roughly
// half the producers pass no surface, and treating that as "no
// subscribers" would delete them all).
if (surface && meta.surfaces && !meta.surfaces.has(surface)) {
    continue;
}
```

The Planning cockpit iframe connects with `?surfaces=planning,common`
(`transport.js:112` `PANEL_SURFACES_MAP`, appended in `wsUrl()` at `transport.js:139`). That filter
can only fire on a *tagged* push. Design's are untagged, so `surface` is `undefined`, the guard
short-circuits, and the frame is written to the Planning connection.

Fail-open on untagged pushes is deliberate and is pinned by
`src/test/ws-surface-scoping-contract.test.js` ("an untagged push and an undeclared connection both
receive everything"). It is not the bug. The missing producer tag is.

**3. `planning.js` renders any `previewReady` it receives — and the leaking `previewReady` is the
auto-refresh one, not the user-initiated one.**

`src/webview/planning.js:4465` dispatches unconditionally to `handlePreviewReady`
(`src/webview/planning.js:3257`). The only gate is a request-id check:

```js
if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;
```

`requestId === -1` is the host-initiated / auto-refresh encoding and is explicitly *accepted*. There
is no `sourceId` allowlist and no sender check, so the handler falls through and paints Design's
HTML file content into the Docs pane.

> **Superseded:** "A user-initiated Design preview passes whenever the two panels' independent
> counters happen to agree — which they do at cockpit boot, when both are at their initial value."
> **Reason:** Factually wrong — a user-initiated Design preview is never broadcast at all, so the
> counters never get a chance to collide. `fetchPreview` (`DesignPanelProvider.ts:2751`) computes
> `const replyChannel = message.__replyChannel === 'http' ? 'http' : 'webview'` and hands it to
> `_buildAndSendPreview` at `:2774` and `:2816`; the payload is emitted through
> `this._postReply(payload, replyChannel)` (`:4714`, and `:4727` for `previewError`), **not**
> `this.postMessage`. `_postReply` (`:849`) pushes *nothing* on `'http'` (the arm returns the body,
> and `transport.js` re-dispatches it in the requesting tab only) and calls `pushWebviewOnly` on
> `'webview'` (no WS mirror). Neither reaches `wsHub.broadcast`. This is the reply-addressing work
> `src/test/design-reply-addressing-regression.test.js` already pins, and it is working.
> **Replaced with:** The **only** `previewReady` path that broadcasts is the save-watcher
> auto-refresh at `DesignPanelProvider.ts:4804`, which calls `_buildAndSendPreview` with **no**
> `replyChannel` (→ `undefined` → `_postReply` falls through to `this.postMessage` → untagged
> broadcast) and always stamps `requestId: -1` (`:4809`) plus `isAutoRefreshed: true`. So the leak
> requires the previewed file to **change on disk** while Design holds a preview seat — a user or
> agent save, or the `switchboard.design.externalFilePollMs` poll — not a mere selection. This does
> not weaken the report: auto-refresh-on-save is the Design panel's normal working mode (the seat
> comment at `:2789` exists precisely so agent edits to a bound design system repaint), so a user
> who edits HTML while previewing hits it constantly and would reasonably describe it as "the file
> I had open in Design".

**What the leaked frame actually does to Planning.** Design's `sourceId` values
(`html-folder`, `claude-folder`, `design-folder`, `stitch-html-folder`) miss Planning's
`planning-html-folder` branch (`planning.js:3261`) and its `local-folder`/`antigravity` branch
(`:3380`), so they land in the **`else`** arm at `planning.js:3394`. That arm treats the foreign
payload as an *online* document: it overwrites `state.activeDocFilePath` with Design's absolute
path, enables **Edit**, shows and enables **Import full doc**, re-gates **Push**, forces the docs
meta-bar visible — and then renders the HTML source into `markdownPreview`, also overwriting
`state.activeDocContent`. The primary local-save path is gated on `state.activeSource`
(`planning.js:6548`), which the leak does **not** set, so this stops short of a wrong disk write;
it is a corrupted pane plus corrupted button state, not data loss.

The cockpit makes this reachable on a plain tab switch: `shell.js` mounts **all** panels as
same-origin iframes up front and toggles them with `display`, so the Planning iframe and its
WebSocket are live and absorbing Design's pushes the whole time the user is looking at Design. When
the user finally clicks Planning, the leaked render is already on screen — which is exactly the
"the *first* doc that shows" in the report.

Note the panels also share **one** `BroadcastHub` in the standalone/browser host
(`src/standalone/bootstrap.ts:712`, `headlessBroadcaster` handed to Design, Setup, Tickets, Kanban,
TaskViewer and Planning at `:724`–`:851`). That is fine as long as producers tag; the surface tag is
the only discriminator the shared hub has.

### Blast radius beyond the reported symptom

Every message type Design **broadcasts** (`this.postMessage`, 116 sites) that another
surface-declaring panel also handles is currently mis-delivered. Cross-referencing Design's 47
emitted `type:` values against the other panel scripts:

| Design push | Emitted at | Also handled by | Consequence of the leak |
| :--- | :--- | :--- | :--- |
| `previewReady` / `previewError` | `:4714` / `:4727`, **auto-refresh path only** | `planning.js:3257` | **The reported bug** — Design's file content renders in the Docs pane, `activeDocFilePath` + `activeDocContent` clobbered |
| `restoredTabState` | `:2532` (the `ready` arm — a true broadcast) | `planning.js:4203`, `tickets.js:6972` | Design's tab-state payload replaces `_restoredPanelState`, so Planning/Tickets workspace dropdowns lose their restored selection |
| `workspaceItemsUpdated` | `:741`, `:2528` | `planning.js` | Redundant dropdown repopulation from a foreign sender |
| `activeContextSet` | `:2625`, `:2645`, `:2648`, `:2674` | `planning.js` | Spurious status-bar text (both providers emit this type for their own "Set Context" button) |
| `saveFileContentResult` | `:2686`, `:2707`, `:2717`, … | `planning.js:5042`, `project.js:1033` | **Confirmed live collision:** Design sends `tab: 'design'` (`design.js:1982`, `:3789`) and `planning.js:5044` has an explicit `tab === 'design'` branch that targets `markdown-editor-design` — a Design save result drives a real Planning code path, not a no-op |
| `markdownLiveRendered` | `:2498`, `:2506` | `planning.js:6287`/`:7636`, `tickets.js:3097`, `project.js:3113` | Foreign live-render payload; each consumer is a one-shot listener gated on `msg.requestId === requestId`, so this leaks only on a request-id collision |

The theme quartet (`switchboardThemeChanged`, `cyberAnimationSetting`, `cyberScanlinesSetting`,
`ultracodeAnimationSetting`, plus `themeChanged`) is the one group that is *genuinely* cross-panel,
and must stay that way — `SURFACES.common` exists for precisely this.

`sbContentDims`, `sbInspectState`, `sbSpacePan`, `sbWheel` and `stitchElementSelected` also appear in
both files but are **not** affected: they are `window.parent.postMessage` calls inside the injected
`_INSPECTOR_SCRIPT` string (`DesignPanelProvider.ts:522`–`:629`), so they travel iframe→parent and
never touch the broadcaster.

### Host scope

The editor (VS Code) webview path is unaffected: each provider owns a `BroadcastHub` bound to its
own panel's webview, so the editor's Planning webview never sees Design's `postMessage`. The leak
travels the WS mirror (`BroadcastHub.push` → `mirrorToWs` → `wsHub.broadcast`,
`broadcastHub.ts:91`/`:112`), which runs in **both** hosts — so an editor user with the browser
cockpit or a popout open leaks too. The fix is host-agnostic because it lands on the producer.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, frontend, backend, reliability
- **Project:** Browser Switchboard

> **Superseded:** Complexity 3.
> **Reason:** The code edit is still small, but this pass surfaced two traps that make an Intern the
> wrong seat: the target contract test is **already red at HEAD** for an unrelated reason (see the
> Edge-Case audit), and the naive repairs for that red are both wrong; and the original root cause
> mis-identified which `previewReady` path leaks, which means the obvious UAT passes without
> exercising the fix. Judgement is required at three points, not zero.
> **Replaced with:** Complexity 4 — routine edit, non-routine verification.

## User Review Required

None. Every decision in this plan is settled below: the producer-tag approach over the three
alternatives, `SURFACES.common` for the five theme pushes, the narrowed double-filter assertion,
Kanban/Setup deferred, and the Project panel's fail-open residual accepted and documented.

## Complexity Audit

### Routine

- A default argument on one method, plus five explicit `SURFACES.common` call sites and one import
  in `DesignPanelProvider.ts`.
- A literal→constant rename in `PlanningPanelProvider.ts` (`'planning'` → `SURFACES.planning`,
  identical value).
- The mechanism is already built, documented and tested — `PlanningPanelProvider` has tagged since
  the surface work landed; Design was simply never converted. `SURFACES.design` and
  `PANEL_SURFACES.design` already exist on both the server (`wsHub.ts:41`, `:74`) and the
  `transport.js` mirror (`:116`), so no map edit is required.

### Complex / Risky

- **The contract test is red at HEAD before you touch anything.** `test('the client does not
  double-filter')` asserts `!/msg\.surface/.test(transportJs)`, and `transport.js:242` contains
  `msg.surface` inside a diagnostic `wsLog(...)` line added by commit `3b3c6367` (2026-08-11) —
  *after* the test was re-anchored (2026-08-10). Establish the baseline before editing, or the red
  gets mis-attributed to this change. The two tempting repairs are both wrong: deleting the log line
  destroys the only surface-tag diagnostic in the client, and deleting the assertion removes the
  guard that stops the next mis-tag being papered over client-side. Narrow the assertion instead
  (see Proposed Changes §5).
- **Could tagging starve a panel that legitimately needs a Design push?** Only a panel that
  **declares** a surface set can be filtered. `PANEL_SURFACES` declares: kanban, terminals, planning,
  design, setup, memo, tickets, connections. The Project panel is deliberately absent (fail-open) and
  is therefore never starved. Of the declared panels, the only Design pushes any of them handle are
  the six rows in the blast-radius table (all bugs) and the theme quartet (kept on `common`).
  Verified by cross-referencing all 47 of Design's emitted types against every other panel script.
- **The Project panel is fail-open, so this fix does not cover it.** After tagging, `project.js`
  still receives Design's `saveFileContentResult` and `markdownLiveRendered`. Bounded, not fixed:
  `project.js:1033` branches on `msg.tab ∈ {kanban, constitution, features, …}` and Design sends
  `tab: 'design'`, so the arm no-ops; `markdownLiveRendered` is request-id gated. Untangling
  `PlanningPanelProvider`'s dual `'planning'`/`'project'` tagging is the prerequisite for declaring
  a set for `project`, and the contract test's own comment says not to "complete" that map first.
  Out of scope here; recorded so it is not mistaken for done.
- **Could an older browser client be starved?** No. A client that predates the `surfaces` parameter
  sends none, `meta.surfaces` is `undefined`, and the guard fails open. No migration is needed —
  nothing on disk or in the DB changes.
- **Do the theme pushes need to reach other panels from Design?** No — each provider registers its
  own `onDidChangeConfiguration` listener and pushes its own copy, so every panel is served by its
  own provider. Tagging them `common` anyway is the correct, conservative choice and matches the
  documented meaning of the surface. Getting this wrong is silent: a `design`-tagged theme push
  freezes every other panel's theme with no error anywhere.

## Edge-Case & Dependency Audit

**Race Conditions**

- **Boot-order does not matter.** The surface set is parsed at upgrade time, before the resync is
  sent (`ws-surface-scoping-contract.test.js`, "the surface set is parsed BEFORE the resync is
  sent"), so a Planning connection is filtered from its first frame. Design cannot win a race
  against a connection that has not declared yet, because an undeclared connection is fail-open and
  a Design push landing there is the *pre-fix* behaviour, not a new failure mode.
- **The `requestId` collision is not separately fixable and, for `previewReady`, is now moot.**
  Two panels running independent counters will always be able to agree, and `-1` is a legitimate
  accept value for auto-refresh. Since the only leaking `previewReady` path *is* the `-1` one,
  tightening request-id hygiene would fix nothing. Routing is the correct layer.

**Security**

- No new input surface. `surface` is a server-side constant chosen by the producer; the client-side
  `?surfaces=` list is already validated against `VALID_SURFACES` (`wsHub.ts:81`, `:267`) and an
  empty parse falls open rather than storing an empty set. No auth, path, or payload boundary moves.

**Side Effects**

- Tagging *reduces* WS fan-out. The cockpit currently amplifies every push across all mounted panel
  connections; a `design`-tagged push now stops at the connections that asked for it. This is a
  latency/bandwidth improvement, not a behaviour change, and `seq` is deliberately not incremented
  on the skip path so filtered connections do not see a permanent gap (`wsHub.ts`, pinned by the
  "seq is not incremented on the skip path" test).
- **`_postReply` / `pushWebviewOnly` (`DesignPanelProvider.ts:849`) is untouched.** The `'http'` and
  `'webview'` channels never mirror to WS, so they cannot leak and need no tag. Only the
  `undefined` (host-initiated) fall-through reaches `postMessage`, and that inherits the new default.
- **`_postRawToWebview` is untouched.** Editor-webview-only path.
  `scripts/check-push-routing.js` ratchets this file at **one** raw webview send and the doc comment
  at `:804` says so explicitly — do not add a second raw call site, and do not spell the raw call
  out in prose (the checker is a regex over source text).

**Dependencies & Conflicts**

- **No client-side double filter.** Do **not** add a `sourceId` allowlist or a surface check to
  `planning.js` as belt-and-braces — it would hide the next mis-tag by making a producer bug look
  like a delivery problem. The producer tag is the whole fix. (The assertion that enforces this is
  the one currently red; repair it, do not remove it.)
- **Use the shared constant, not a literal.** `ws-surface-scoping-contract.test.js` already enforces
  this for `bootstrap.ts` ("producers use the shared constant, not string literals"). Import
  `SURFACES` from `./wsHub` in `DesignPanelProvider.ts`.
- **Spy compatibility.** `src/test/design-reply-addressing-regression.test.js:53` stubs the
  broadcaster as `push: (msg) => pushCalls.push(msg)`; an extra argument is ignored, so that suite is
  unaffected. That suite is also the direct guard on the reply-addressing behaviour this plan now
  depends on being correct — it must stay green.
- **`PlanningPanelProvider` uses the literal `'planning'`** rather than `SURFACES.planning`. Convert
  it in the same pass for consistency with the enforced convention — a pure rename to an identical
  value. It already imports nothing from `wsHub`, so the import is new.
- **Known sibling defect, deliberately OUT OF SCOPE:** `KanbanProvider.ts:2231` and
  `SetupPanelProvider.ts:271` also call `this._broadcaster.push(message)` untagged. They are not the
  reported producer, and unlike Design their pushes have plausible cross-panel consumers (board and
  setup state are read in more than one place), so converting them needs its own consumer audit
  rather than a copy of this one-liner. Not fixed here; recorded so it is not mistaken for done.
- **PRD contract check.** This change touches no verb arm, returns nothing new in an HTTP body, adds
  no schema, and moves no `break`. `npm run verb-returns:check`, `npm run parity:check` and
  `npm run push-routing:check` are all no-ops for it — none of their inputs change. It is a
  push-routing correction, and the PRD's "one agent stream per provider file" rule applies:
  `DesignPanelProvider.ts` must not be edited concurrently by another stream.

## Dependencies

- None. This plan has no upstream session dependency — `SURFACES`, `PANEL_SURFACES`, the
  `transport.js` mirror, the surface-filtered `broadcast`, and the reply-addressing split all exist
  and are tested at HEAD. It is a leaf change.

## Adversarial Synthesis

**Risk summary.** Two risks dominate, and neither is the code edit. First, the verification is
booby-trapped: `ws-surface-scoping-contract.test.js` is already failing at HEAD on
`!/msg\.surface/.test(transportJs)` because a diagnostic `wsLog` line in `transport.js:242` mentions
`msg.surface`, so a coder who does not baseline first will either blame this change or "repair" the
red by deleting the client's only surface diagnostic or the assertion that forbids client-side
double-filtering. Second, the original UAT exercised the wrong path — user-initiated Design previews
are addressed replies that never broadcast, so "select a file, switch panels" passes before the fix
and would certify nothing; the leak needs a **disk write** to the previewed file. Mitigations: pin
the red baseline before editing and narrow (never delete) the assertion; make the save-triggered
auto-refresh the primary UAT with the selection case kept only as a negative control; and assert the
theme quartet stays on `SURFACES.common`, since a mis-tag there silently freezes every other panel's
theme with no error surface anywhere.

## Proposed Changes

### 1. `src/services/DesignPanelProvider.ts` — tag the broadcast

Add the import alongside the existing `broadcastHub` import (line 3):

```ts
import { BroadcastHub } from './broadcastHub';
import { SURFACES } from './wsHub';
```

Give `postMessage` a surface parameter defaulting to the panel's own surface (line 817):

```ts
    /**
     * Broadcast to this panel's clients. `surface` defaults to SURFACES.design so the
     * 116 call sites stay one-argument; pass SURFACES.common for the handful of pushes
     * that are genuinely cross-panel (theme/animation settings). An UNTAGGED push is
     * delivered to every WS connection regardless of what it subscribed to (see
     * wsHub.broadcast) — which is how Design's save-watcher previewReady auto-refresh
     * used to paint the Planning panel's Docs pane in the cockpit.
     */
    public postMessage(message: any, surface: string = SURFACES.design): void {
        if (this._broadcaster) {
            this._broadcaster.push(message, surface);
        } else {
            this._postRawToWebview(message);
        }
    }
```

Leave `_postReply` alone. Its `'http'` and `'webview'` channels never reach the WS mirror; its
`undefined` channel delegates to `postMessage` and inherits the new default. That single
delegation is what fixes the reported `previewReady` leak.

### 2. `src/services/DesignPanelProvider.ts` — keep the cross-panel pushes cross-panel

Five sites, all theme/appearance, must pass `SURFACES.common` explicitly. Lines 761–781 (inside the
`if (!this._themeListenersRegistered)` block — the `onDidChangeActiveColorTheme` /
`onDidChangeConfiguration` listeners):

```ts
                vscode.window.onDidChangeActiveColorTheme(() => {
                    this.postMessage({ type: 'themeChanged' }, SURFACES.common);
                })
...
                        this.postMessage({ type: 'cyberAnimationSetting', disabled }, SURFACES.common);
...
                        this.postMessage({ type: 'cyberScanlinesSetting', disabled }, SURFACES.common);
...
                        this.postMessage({ type: 'switchboardThemeChanged', theme }, SURFACES.common);
...
                        this.postMessage({ type: 'ultracodeAnimationSetting', enabled }, SURFACES.common);
```

Lines 2545–2547 in the `ready` arm are replies to Design's *own* handshake, not cross-panel
notifications, so they stay on the `SURFACES.design` default:

```ts
                this.postMessage({ type: 'switchboardThemeChanged', theme: ... });
                this.postMessage({ type: 'cyberAnimationSetting', disabled: ... });
                this.postMessage({ type: 'cyberScanlinesSetting', disabled: ... });
```

Leave every other `this.postMessage(...)` call in the file exactly as it is — the default covers them.

### 3. `src/services/PlanningPanelProvider.ts` — use the constant

Line 927, plus a new `SURFACES` import (the file does not currently import from `wsHub`):

```ts
import { SURFACES } from './wsHub';
```

```ts
    public postMessageToWebview(message: any): void {
        if (this._broadcaster) {
            this._broadcaster.push(message, SURFACES.planning);
        } else {
            this._panel?.webview.postMessage(message);
        }
    }
```

Do not touch this provider's other push sites — `pushTo(...)` calls that tag `'project'` are the
dual-panel tagging the contract test explicitly wants left alone until the Project panel's surface
set is untangled.

### 4. `src/test/ws-surface-scoping-contract.test.js` — pin the producer tag

Read `DesignPanelProvider.ts` at the top of the file next to the other `readFileSync` calls:

```js
const designProviderCode = fs.readFileSync(path.join(__dirname, '../services/DesignPanelProvider.ts'), 'utf8');
```

Then append two tests beside the existing "producers use the shared constant" one:

```js
test('the Design panel provider tags its broadcast', () => {
    assert.ok(/this\._broadcaster\.push\(message, surface\)/.test(designProviderCode),
        'an untagged push is delivered to EVERY connection — the Design save-watcher previewReady '
        + 'auto-refresh used to render in the Planning panel Docs pane in the cockpit '
        + '(shell.js mounts all panels at once)');
    assert.ok(/surface: string = SURFACES\.design/.test(designProviderCode),
        'the default must be the panel own surface, so the 116 one-argument call sites stay tagged');
    assert.ok(designProviderCode.includes("import { SURFACES } from './wsHub'"),
        'a mis-tag is a silent functional bug with no type-level protection — use the shared vocabulary');
});

test('Design cross-panel pushes stay on `common`', () => {
    const listener = block(designProviderCode,
        '_themeListenersRegistered = true',
        "affectsConfiguration('switchboard.design.externalFilePollMs')");
    ['themeChanged', 'cyberAnimationSetting', 'cyberScanlinesSetting',
     'switchboardThemeChanged', 'ultracodeAnimationSetting'].forEach(type => {
        const at = listener.indexOf(`type: '${type}'`);
        assert.ok(at !== -1, `the theme listener must still push '${type}'`);
        assert.ok(/SURFACES\.common/.test(listener.substring(at, at + 200)),
            `'${type}' is genuinely cross-panel; tagging it 'design' silently freezes every other panel theme`);
    });
});
```

Use the file's existing `block(code, startMarker, endMarker)` helper rather than hand-rolled
`indexOf` arithmetic — it already asserts both markers exist, so a future rename fails with
"marker not found" instead of silently searching an empty string and passing.

### 5. `src/test/ws-surface-scoping-contract.test.js` — repair the pre-existing red

`test('the client does not double-filter')` currently fails at HEAD. Its intent is to forbid a
client-side **filter**; its regex forbids any *mention* of `msg.surface`, and `transport.js:242`
mentions it in a `wsLog` diagnostic. Narrow the assertion to its intent — keep the diagnostic, keep
the guard:

```js
test('the client does not double-filter', () => {
    // A DIAGNOSTIC mention is fine and useful (transport.js logs the tag on every
    // frame). What must never appear is a client-side branch on it: a second filter
    // would mask a producer mis-tag by making it look like a delivery problem.
    const filtering = transportJs
        .split('\n')
        .filter(l => /msg\.surface/.test(l) && !/wsLog\(/.test(l));
    assert.deepStrictEqual(filtering, [],
        `transport.js must not branch on msg.surface: ${filtering.map(l => l.trim()).join(' | ')}`);
});
```

This repair is in scope because the same test file is being edited for §4 and the coder cannot
otherwise tell a real regression from the standing red.

## Verification Plan

### Automated Tests

1. **Baseline first — `npm run test:contract:ws-surface-scoping` on unmodified HEAD.** Record which
   assertions fail. Expect exactly one: "the client does not double-filter". Anything else failing
   is a second pre-existing red and must be triaged before starting, not absorbed into this change.
2. **Red-for-the-right-reason.** Add the §4 assertions *before* the §1–§3 source edits and re-run.
   The two new tests must fail on the `push(message)` / missing-import / missing-`SURFACES.common`
   assertions specifically — not on a `marker not found` error, which would mean the block markers
   drifted and the test is asserting over an empty string.
3. **Green after.** Apply §1–§3 and §5, re-run `npm run test:contract:ws-surface-scoping`. All
   assertions green, including the previously-red one and in particular "an untagged push and an
   undeclared connection both receive everything", "the client mirror matches the server map
   exactly", and "producers use the shared constant, not string literals".
4. **Design regression suites** — `npm run test:contract:design-reply-addressing`,
   `npm run test:contract:design-system`, and `npm run test:contract:design-view-state`. Use the npm
   scripts, not bare `node` — they add the `--require ./src/test/bootstrap/sandboxStateHome.js`
   bootstrap, and running them raw points the suite at the real state home. The reply-addressing spy
   takes one argument and ignores the second; confirm no assertion counts arity.
5. **Push-routing ratchet** — `npm run push-routing:check`. No raw webview send is added, so the
   `DesignPanelProvider.ts` ceiling of one must be unchanged.
6. **Lint/compile** — `npm run lint` and `npm run compile-tests` (the two default/typed-argument
   changes are the only type-level edits).

### Manual UAT

Exercise the installed VSIX's browser host — `dist/` is not the dev surface.

7. **The real repro (save-triggered auto-refresh).** Open the cockpit, go to Design, select an HTML
   file in HTML Previews so it renders. Switch to Planning → Docs tab and **leave it there**. Now
   have something else write to that HTML file on disk — a coding agent editing it is the reported
   case, and a plain editor save is equivalent — to fire the save-watcher auto-refresh
   (`requestId: -1`, the only broadcasting `previewReady` path). **Expected:** Planning's preview
   pane shows its empty state — no HTML source, and the Edit / Import-full-doc buttons are still in
   their default state. Repeat the write two or three times with Planning left mounted; it must stay
   empty. Watching Planning while the write happens is the point: the pre-fix bug paints the pane
   with no user interaction at all.
8. **Negative control (selection only).** Repeat step 7 but *without* saving. **Expected:** empty
   both before and after the fix — this path is an addressed HTTP/webview reply and never
   broadcast. If this one ever leaks, the reply-addressing split has regressed and that is a
   different bug.
9. **Planning's own previews still work.** In Planning, select a local doc; confirm it renders and
   that switching to Design and back leaves it intact (the tag must not filter Planning's *own*
   pushes).
10. **Restored-state regression** (the second-order symptom): with a workspace selected in Planning's
    Docs dropdown, reload the cockpit. **Expected:** Planning's dropdown restores its own selection —
    previously Design's `restoredTabState` could overwrite `_restoredPanelState` first. Repeat for
    the Tickets panel.
11. **Save-result regression:** with both panels mounted, save a file from Design's Design tab
    (`tab: 'design'`). **Expected:** Planning's Docs pane does not exit edit mode or repaint —
    previously this drove `planning.js`'s `tab === 'design'` branch.
12. **Theme regression** (the one thing the tag could break): with the cockpit open on Kanban, change
    `switchboard.theme.name`. **Expected:** every panel restyles, including Design. Then open Design
    and confirm it restyles on its own handshake too. Repeat for
    `switchboard.theme.disableCyberAnimation`, `disableCyberScanlines`, and `ultracodeAnimation` —
    all four settings and the VS Code color-theme switch, since each is a separate call site.
13. **Editor-host no-op check:** open the Planning and Design panels in VS Code with no browser
    client connected and confirm both behave exactly as before — this path never used the WS mirror.

---

**Recommendation: Send to Coder.** (Complexity 4.)
