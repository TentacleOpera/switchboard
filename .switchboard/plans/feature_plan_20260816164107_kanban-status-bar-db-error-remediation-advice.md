# Kanban status bar: turn raw "disk I/O error" into an actionable recovery instruction

## Goal

When the kanban DB fails under memory pressure, the board's status bar shows the raw
SQLite string — `disk I/O error` — and nothing else. That message is actively
misleading: it reads as "your disk is full" or "your database is corrupt", when neither
is true. The user then has no idea what to do, and the message auto-hides after 5
seconds.

Make every DB-capacity failure surface as a one-line diagnosis plus the exact recovery
step for the host the user is actually looking at, and stop the advisory from vanishing
before it can be read.

### Problem analysis

**What the user sees.** `src/webview/kanban.html:5918` (`showStatusBarMessage`) renders
whatever text it is handed into `#status-message`, in red. The text that reaches it on a
failed board action in the **browser** comes from `src/webview/transport.js:386-389`:

```js
const text = result.error || ('Action failed: ' + verb);
if (STATUS_MESSAGE_PANELS[panel]) {
    dispatchMessage({ type: 'showStatusMessage', message: text, isError: true });
}
```

`result.error` is the *verbatim* `err.message` produced by the server —
`src/services/LocalApiServer.ts:2029`:

```ts
res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `kanban verb '${verb}' failed` }));
```

sql.js throws `Error: disk I/O error`, so the whole chain faithfully relays five words of
SQLite jargon with no remediation attached. `STATUS_MESSAGE_PANELS = { kanban: true }`
(`transport.js:322`), so the kanban board is precisely the panel this hits.

**What the error actually means.** It is not disk-full and not corruption. sql.js runs
every workspace's `kanban.db` inside ONE shared Emscripten WASM linear heap. When that
heap is exhausted, SQLite's in-memory VFS `xRead`/`xWrite` fail and return
`SQLITE_IOERR`, which surfaces as `disk I/O error` — simultaneously, across every
workspace's DB. The tell is that it hits all DBs at once. Free disk space is unaffected
and `PRAGMA integrity_check` returns `ok`. The codebase already knows this — the test
harness comment at `src/test/headless-feature-management-destructive.test.js:19-24` says
so explicitly:

> ONE temp workspace and ONE database for the whole suite. Per-test workspaces exhaust
> the shared sql.js WASM heap, which presents as "disk I/O error" across every DB at once.

**The recovery.** A fresh WASM heap. There is no data loss to fear — the `.db` files on
disk are healthy. But the *action that produces a fresh heap depends on which process
owns the heap*, and today's message says nothing about either:

| Where the board is running | Process holding the WASM heap | Recovery |
| :-- | :-- | :-- |
| VS Code webview (`switchboard.openKanban`) | extension host | `Developer: Restart Extension Host` |
| Browser tab served by the extension (`switchboard.openInBrowser`) | extension host | restart the extension host, then reload the tab |
| Browser tab served by `npx switchboard` | the CLI process | restart `npx switchboard`, then reload the tab |

**Root cause of the bad message.** There is no classifier anywhere between the sql.js
throw and the status bar. `src/services/errorMessages.ts` exists for exactly this job —
it localises HTTP failures into human sentences with a fix (`localizeHttpError`) — but it
has no DB arm, and nothing on the DB path calls into it. Every seam on the route passes
the raw string through untouched.

**Secondary defect — the message is invisible after 3 s, not 5 s.** `showStatusBarMessage`
uses one 5000 ms timeout for every message, success or error. That timeout is not even
the binding constraint: the `flashing` class it applies runs
`animation: statusFlash 3s ease-in-out forwards` (`kanban.html:447-449`), whose final
keyframe is `opacity: 0` (`kanban.html:2667-2672`), and a `DOMContentLoaded`-installed
`animationend` listener (`kanban.html:12059-12065`) then sets `display: none`. **The
element is hidden at 3 s; the 5 s timeout only wipes text that is already invisible.**
An advisory whose whole point is "here is the command to run" is gone before the user
can act on it — and lengthening the timeout alone would change nothing.

**Tertiary defect — the status bar clips long text.** `#status-message` inherits
`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`
(`kanban.html:438-446`). A multi-sentence advisory is truncated to an ellipsis, so the
recovery command — the only part that matters — is the part the user never sees.

## Metadata

- **Complexity:** 5
- **Tags:** bugfix, ux, reliability, frontend
- **Project:** Browser Switchboard

> **Superseded:** Complexity 4.
> **Reason:** The verified fix spans six files and turns on a CSS-animation/visibility
> interaction (`statusFlash … forwards` + the `animationend` hide) that a naive timeout
> change silently loses to. That is one moderate, well-scoped risk on top of otherwise
> routine work — a 5, not a 4. Routing is unchanged (4-6 → Coder).
> **Replaced with:** Complexity 5.

## User Review Required

None. The recovery wording, the host attribution rule, and the display-funnel choke point
are all decided in this plan.

## Complexity Audit

### Routine

- Adding `isDatabaseCapacityError()` to `src/services/errorMessages.ts` — a pure predicate
  alongside the existing `localizeHttpError` / `classifyHttpError` pair.
- Adding `hostKind` to the existing `HostCapabilities` interface and setting it in the two
  composition roots that already build a capabilities object.
- Appending one advisory line to `KanbanDatabase._initialize`'s existing output-channel
  failure report.
- The new unit + source-contract tests.

### Complex / Risky

- **Choosing the single choke point.** Four independent producers can put a raw SQLite
  string on the board (server catch, arm-returned `{success:false,error}` body,
  `moveCardsFailed.reason` over a WS push, editor `postMessage`). Decorating a subset
  looks complete and is not; decorating several double-wraps the text. Exactly one seam —
  the display funnel `showStatusBarMessage` — sees all four.
- **Beating the animation.** The advisory must survive past `statusFlash`'s 3 s
  `opacity: 0` end-state and the `animationend` → `display:none` listener. A hold-time
  change alone is inert. This is the failure mode most likely to ship green and not work.
- **Beating the CSS clip.** `nowrap` + `text-overflow: ellipsis` truncates the recovery
  command. The advisory must render in a wrapping variant of the status bar.
- **Matching the right errors and only those.** The recogniser must fire on the
  WASM-exhaustion family (`disk I/O error`, `SQLITE_IOERR`, `out of memory`, `memory
  access out of bounds`, `Aborted(OOM`) and must NOT fire on ordinary failures. A false
  positive tells the user to restart their extension host over a typo'd column name.
- **Host attribution.** Getting this wrong is worse than saying nothing: telling a `npx
  switchboard` user to run a VS Code command-palette entry is a dead end. The host kind
  must come from the composition root that actually constructed the process, never from a
  runtime guess.

## Edge-Case & Dependency Audit

### Race Conditions

- **Message replacement mid-hold.** A second status message arriving while the advisory is
  up must cancel the advisory's pending timeout and reset the wrapping/animation state.
  `showStatusBarMessage` already clears `statusEl._statusTimeoutId`; the new class and the
  `flashing` skip must be reset on *every* entry, not only on the advisory branch, or a
  later ordinary message inherits sticky, wrapped, un-animated styling.
- **`animationend` from a previous message.** The listener installed at
  `kanban.html:12059` is permanent and un-scoped. If an in-flight `statusFlash` from a
  prior message ends *after* the advisory is written, it will `display:none` the advisory.
  Removing `flashing` on entry (already done at `:5926`) cancels the running animation, so
  no `animationend` fires for it — the reset ordering is what makes this safe and must not
  be reordered.
- Sub-second churn on the status bar needs no additional guard or UI. The last writer wins,
  which is the correct behaviour for a status line.

### Security

- The advisory text is fully static and host-derived; no error content is interpolated into
  markup. `showStatusBarMessage` assigns via `textContent`, and the original server string
  is preserved verbatim inside that assignment — so a hostile error string stays inert.
  Do not switch any part of this path to `innerHTML`
  (`headless-feature-management-contract.test.js:413-417` pins the equivalent rule for
  `transport.js`).
- `hostKind` rides the existing `data-host-capabilities` body attribute, which is already
  HTML-escaped through `htmlEscapeJson` (`headlessPanelHtml.ts:184`). No new escaping path.

### Side Effects

- **No confirm dialogs, no action buttons that gate.** Per project rules, the advisory is
  text only. Do not add a "Restart now?" prompt or a two-click gate.
- Adding a non-boolean key to `HostCapabilities` is inert for the existing consumer:
  `applyCapabilityGating` (`transport.js:449-500`) reads named boolean keys only and
  already tolerates the non-boolean `integrationsConfigured`.
- `showStatusBarMessage` gains a second visual mode (wrapping, un-animated). The sub-bar
  grows in height while an advisory is shown. That is intended and reverts on the next
  message.
- The editor webview never receives `data-host-capabilities` (only `headlessPanelHtml`
  injects it), so its `hostKind` is `undefined` — which is precisely the third case
  (editor webview) and must map to the Command-Palette-only advice.
- **Migration:** none required. This adds no persisted state, no config key, and no file
  format. `hostKind` is resolved fresh on every page render.

### Dependencies & Conflicts

- **Contract-test surface — do not restructure.**
  `src/test/headless-feature-management-contract.test.js:401-406` pins
  `STATUS_MESSAGE_PANELS = { kanban: true }` and the exact
  `{ type: 'showStatusMessage', message: text, isError: true }` dispatch shape in
  `transport.js`; `:419-421` pins the `case 'showStatusMessage':` handler in `kanban.html`
  calling `showStatusBarMessage(msg.message || '', { isError: !!msg.isError });`. The fix
  goes **inside the body of `showStatusBarMessage`**, so both regexes keep matching
  unchanged. Do not touch either pinned line.
- **PRD contract #1 (anti-divergence).** Both hosts render byte-identical `kanban.html`.
  Putting the classifier in that shared file satisfies this by construction — there is no
  per-host fork, only a per-host data attribute.
- **Files touched:** `src/webview/kanban.html` (classifier + CSS + hold),
  `src/services/headlessPanelHtml.ts` (`HostCapabilities.hostKind`),
  `src/standalone/bootstrap.ts` (one line), `src/services/TaskViewerProvider.ts` (one
  line), `src/services/errorMessages.ts` (predicate),
  `src/services/KanbanDatabase.ts` (output-channel line). No new packages.
- **Deliberately out of scope:** `transport.js`'s `showTransportError` fallback toast (the
  non-kanban panels) and the script-facing REST routes `POST /kanban/move`
  (`LocalApiServer.ts:1474`) and `POST /kanban/dispatch` (`:1215`). Those serve other
  panels and CLI scripts, not the kanban status bar named in the Goal. Their raw error
  strings stay raw — machine callers are better served by the unmodified message.

## Dependencies

- None.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is a fix that passes its own tests and still shows the
user `disk I/O error`: the raw string reaches the board through four independent producers
(server catch, arm-returned failure body, `moveCardsFailed` WS push, editor `postMessage`),
and only the webview display funnel sees all four — a server-side classifier at the verb
catches misses the drag path entirely in *both* hosts. The second risk is a correctly
classified advisory that is still unreadable, because `statusFlash 3s … forwards` hides
the element at 3 s and `text-overflow: ellipsis` clips the recovery command. Mitigations:
one choke point inside `showStatusBarMessage`, an explicit `flashing`-skip plus wrapping
variant for advisory messages, host identity carried on the already-escaped
`data-host-capabilities` attribute, and a deliberately narrow recogniser with an explicit
negative-case test set.

## Proposed Changes

> **Superseded:** Apply a server-side `describeDbFailure()` at the four panel-verb `catch`
> blocks in `LocalApiServer.ts` (`:2029`, `:2057`, `:2085`, `:2193`), plus `:1215` /
> `:1474`, plus `KanbanProvider.moveCardToColumnWithReason`'s catch (`:7306`) and
> `_handleMessage`'s error posts — carried by a new `hostKind` option on
> `LocalApiServerOptions`.
> **Reason:** Verified against the code, that choke point does not see most of the traffic
> it needs to. Three concrete gaps:
> 1. **The verb catch only fires on a throw.** `_handleKanbanVerb` serialises an
>    arm-returned failure at `LocalApiServer.ts:2024-2025` (`ok = result.success !== false`
>    → 502 with the body verbatim). `KanbanProvider` has 274 `success: false` return
>    sites, several of which (`:2680`, `:8103`, …) carry `err.message` from an arm's own
>    catch. Those never reach line 2029.
> 2. **The provider catch is the wrong layer for the drag path.**
>    `KanbanDatabase.updateColumnByPlanFileWithReason` already catches at
>    `KanbanDatabase.ts:2500` and returns `{ ok:false, reason:'error', detail: error.message }`.
>    `moveCardToColumnWithReason` (`:7279`) receives that as a *value*, so its own catch at
>    `:7304-7307` never runs and the raw string flows out through `failures[].reason`
>    (`KanbanProvider.ts:6010`) to ~10 `moveCardsFailed` posts.
> 3. **`moveCardsFailed` is a WS push, not an HTTP response.** In standalone,
>    `KanbanProvider.postMessage` is routed to the WS hub via `setApiServer`, so it bypasses
>    the LocalApiServer response path entirely — a server response-side classifier cannot
>    reach it in *either* host. A user dragging a card, the single most likely way to meet
>    this error, would still see the raw string after the whole fix shipped.
>
> **Replaced with:** One classifier at the **display funnel** —
> `showStatusBarMessage` in `src/webview/kanban.html` — which every one of those producers
> funnels through, with the host identity delivered on the existing
> `data-host-capabilities` body attribute. `errorMessages.ts` still gains the shared
> predicate for the non-status-bar surface (the output channel).

### 1. `src/services/errorMessages.ts` — add the DB-capacity predicate

Append below the existing HTTP helpers:

```ts
/**
 * The sql.js WASM-heap exhaustion family. SQLite's in-memory VFS returns
 * SQLITE_IOERR when the single shared Emscripten linear heap cannot grow, and
 * that surfaces as the literal string "disk I/O error" across EVERY workspace
 * DB at once. It is not disk-full and not corruption — the .db files are
 * healthy and `PRAGMA integrity_check` returns ok.
 *
 * Deliberately narrow: a false positive tells the user to restart their whole
 * host over a typo'd column name.
 *
 * KEEP IN SYNC with DB_CAPACITY_RE in src/webview/kanban.html (the webview is a
 * self-contained HTML file and cannot import this module). The source contract
 * test asserts the two literals are identical.
 */
export const DB_CAPACITY_RE =
    /disk i\/o error|SQLITE_IOERR|out of memory|memory access out of bounds|Aborted\(OOM/i;

export function isDatabaseCapacityError(raw: unknown): boolean {
    return DB_CAPACITY_RE.test(String(raw ?? ''));
}
```

Note on the pattern set: `disk i/o error` is the confirmed, in-repo-documented surface
form. The other four alternatives are defensive widenings of the same Emscripten/sql.js
exhaustion family — a miss there costs one unclassified failure mode, never a false
positive on an ordinary error.

### 2. `src/services/headlessPanelHtml.ts` — carry the host identity to the browser

`HostCapabilities` (`:16-29`) already carries a non-boolean member
(`integrationsConfigured`), and the object is already serialised onto
`data-host-capabilities` for every panel (`:184` for the board). Add one field rather than
a new getter parameter — zero signature churn across the ten panel getters:

```ts
export interface HostCapabilities {
    // …existing fields…
    integrationsConfigured?: { clickup?: boolean; linear?: boolean; notion?: boolean; stitch?: boolean };
    /**
     * Which process serves this page. Decides the recovery step named in a
     * DB-capacity advisory: a `npx switchboard` user told to run a VS Code
     * command-palette entry has a dead end. Absent = the VS Code webview
     * itself (which never receives this attribute at all).
     */
    hostKind?: 'editor' | 'standalone';
}
```

Leave `DEFAULT_HOST_CAPABILITIES` (`:31-43`) unchanged — an unset `hostKind` must stay
unset so the webview can tell "served by the extension" from "is the webview".

### 3. `src/standalone/bootstrap.ts` — declare the standalone host

In `baseStandaloneCapabilities` (`:559`), add:

```ts
        hostKind: 'standalone',
```

It flows through `getStandaloneCaps()` (`:578-582`) into every panel getter, so the board
(`:584`) and the shell's per-panel route (`:599`) both carry it.

### 4. `src/services/TaskViewerProvider.ts` — declare the editor host explicitly

In `baseHostCapabilities` (`:3193`), add:

```ts
                    hostKind: 'editor' as const,
```

`as const` is required: that object literal is untyped (`const baseHostCapabilities = {`),
so a bare `'editor'` widens to `string` and fails to satisfy `HostCapabilities` when
spread at `:3226` / `:3234` / `:3244`. Explicit rather than relying on a default, so a
future default flip cannot silently mislabel the editor-served browser tab.

### 5. `src/webview/kanban.html` — classify and hold at the display funnel

This is the whole user-visible fix. Three edits, all inside this file.

**a. CSS — a wrapping variant of the status bar.** Beside the existing rules at `:443-449`,
add:

```css
        /* An advisory naming a command to run must not be clipped to an ellipsis.
           The base .sub-bar-status inherits nowrap/ellipsis from the sub-bar; the
           advisory opts out and is allowed to wrap the sub-bar taller. */
        #status-message.sub-bar-status.status-advisory {
            white-space: normal;
            overflow: visible;
            text-overflow: clip;
            line-height: 1.35;
            max-width: 100%;
        }
```

**b. The classifier**, placed immediately above `showStatusBarMessage` (`:5917`):

```js
        // KEEP IN SYNC with DB_CAPACITY_RE in src/services/errorMessages.ts.
        // sql.js runs every workspace's kanban.db in ONE shared Emscripten WASM
        // heap; exhausting it makes SQLite's in-memory VFS return SQLITE_IOERR,
        // which surfaces as the literal "disk I/O error" across every DB at once.
        // Not disk-full, not corruption — the .db files are healthy.
        const DB_CAPACITY_RE =
            /disk i\/o error|SQLITE_IOERR|out of memory|memory access out of bounds|Aborted\(OOM/i;

        // The sentence that marks an already-classified message (idempotency
        // sentinel). Matched anywhere in the text, never anchored: the drag path
        // composes its own prefix ("1 plan(s) not advanced: …") ahead of ours.
        const DB_ADVISORY_MARK = 'the database ran out of memory, not disk space';

        /**
         * Which process owns the WASM heap, and therefore what the user must
         * restart. Read from the capabilities attribute the serving host injects
         * (headlessPanelHtml). Absent attribute = the VS Code webview itself,
         * which is never served that way.
         */
        function dbRecoveryAdvice() {
            let hostKind;
            try {
                const raw = document.body && document.body.dataset.hostCapabilities;
                if (raw) { hostKind = JSON.parse(raw.replace(/&quot;/g, '"')).hostKind; }
            } catch (err) {
                console.warn('[kanban] hostKind read failed; assuming VS Code webview:', err);
            }
            if (hostKind === 'standalone') {
                return 'Restart the `npx switchboard` process, then reload this tab.';
            }
            if (hostKind === 'editor') {
                return 'Restart the VS Code extension host (Developer: Restart Extension Host), then reload this tab.';
            }
            return 'Run "Developer: Restart Extension Host" from the Command Palette.';
        }

        /**
         * Append a diagnosis + recovery step to a DB-capacity failure. Returns the
         * text unchanged for every other message. Idempotent — re-classifying an
         * already-advised string is a no-op. The ORIGINAL text is preserved in
         * front of the advisory: it is the only thing a support conversation can
         * key on, and the drag path's own prefix stays meaningful.
         */
        function withDbRecoveryAdvice(text) {
            const s = String(text == null ? '' : text);
            if (!s || s.indexOf(DB_ADVISORY_MARK) !== -1) { return s; }
            if (!DB_CAPACITY_RE.test(s)) { return s; }
            return s + ' — ' + DB_ADVISORY_MARK + ' (your data is safe). ' + dbRecoveryAdvice();
        }
```

**c. `showStatusBarMessage` (`:5918`) — classify, then make the advisory actually visible.**
The load-bearing detail is that the `flashing` class ends at `opacity: 0` (`statusFlash`,
`:2667-2672`, `forwards`) and the permanent `animationend` listener (`:12059-12065`) then
sets `display: none`. An advisory must therefore run **no animation at all** — the hold is
owned by the timeout alone:

```js
        function showStatusBarMessage(text, { isError = false } = {}) {
            const statusEl = document.getElementById('status-message');
            if (!statusEl) return;
            const message = withDbRecoveryAdvice(text);
            const isAdvisory = message !== String(text == null ? '' : text)
                || message.indexOf(DB_ADVISORY_MARK) !== -1;
            statusEl.textContent = message;
            statusEl.style.color = isError
                ? 'var(--vscode-errorForeground, #ff6b6b)'
                : 'var(--accent-teal)';
            statusEl.style.display = 'inline-block';
            // Reset BOTH modes on every entry — a previous advisory must not leave
            // the next ordinary message wrapped and un-animated.
            statusEl.classList.remove('flashing');
            statusEl.classList.remove('status-advisory');
            void statusEl.offsetWidth; // restart animation
            if (isAdvisory) {
                // No 'flashing': statusFlash ends at opacity:0 after 3s and the
                // animationend listener then display:none's the element, so an
                // animated advisory is invisible long before its hold expires.
                statusEl.classList.add('status-advisory');
                statusEl.style.opacity = '1';
            } else {
                statusEl.style.opacity = '';
                statusEl.classList.add('flashing');
            }
            if (statusEl._statusTimeoutId) clearTimeout(statusEl._statusTimeoutId);
            // An advisory that names a command to run must outlive a glance and a
            // trip to the Command Palette. Bounded rather than sticky so a
            // recovered board is never left wearing a stale red banner.
            const holdMs = isAdvisory ? 60000 : (isError ? 20000 : 5000);
            statusEl._statusTimeoutId = setTimeout(() => {
                statusEl.textContent = '';
                statusEl.classList.remove('flashing');
                statusEl.classList.remove('status-advisory');
                statusEl.style.opacity = '';
                statusEl.style.display = 'none';
                statusEl._statusTimeoutId = null;
            }, holdMs);
        }
```

> **Superseded:** `const holdMs = /^Database unavailable —/.test(text) ? 0 /* sticky */ : (isError ? 20000 : 5000);`
> **Reason:** Two defects. (i) The regex is anchored at `^`, but the drag path renders
> `` `${failed.length} plan(s) not advanced: ${failed[0]?.reason}` `` (`kanban.html:8623`)
> — the advisory is never at index 0 there, so the most common DB-error path would fall
> through to the ordinary error timeout. (ii) `0` = sticky-until-replaced leaves a red
> banner on a board that has since recovered, with no event that clears it.
> **Replaced with:** A boolean `isAdvisory` computed by the classifier itself (no
> re-matching of our own prose) and a bounded 60 s hold. 60 s outlives a Command-Palette
> round trip; if the DB is still broken, the user's next action re-fires it.

The `case 'showStatusMessage':` handler at `:8444-8447` is untouched — it is pinned by
`headless-feature-management-contract.test.js:419-421`, and putting the logic inside
`showStatusBarMessage` is exactly what keeps that regex matching.

**Non-goal in this file:** the direct `#status-message` writer at `:9174-9180`
(dispatch-failure prompt-copied notice) bypasses `showStatusBarMessage`. It is not a DB
path and is out of scope; leave it alone.

### 6. `src/services/KanbanDatabase.ts` — name the fix in the init-failure output channel

In `_initialize`'s catch (`:6681-6704`), where the failure is already written to the
`Switchboard` output channel and `channel.show()` is called (`:6696-6702`), append one
line before `channel.show()`:

```ts
                if (isDatabaseCapacityError(errorMessage)) {
                    channel.appendLine(
                        '[KanbanDatabase] This is a memory-capacity failure, not disk or corruption. '
                        + 'Restart the extension host (Developer: Restart Extension Host) — the .db files are healthy.'
                    );
                }
```

`errorMessage` is already coerced from non-`Error` throws at `:6684-6692` (sql.js
sometimes throws plain objects), so the predicate receives a string. This block is inside
the existing `try { require('vscode') … } catch {}`, so it stays inert in standalone,
where that output channel does not exist.

## Verification Plan

### Automated Tests

1. **Unit — the predicate.** New `src/test/db-failure-advisory.test.js`:
   - `isDatabaseCapacityError` returns true for `'disk I/O error'`, `'Error: disk I/O error'`,
     `'SQLITE_IOERR: something'`, `'out of memory'`, `'memory access out of bounds'`,
     `'Aborted(OOM'`.
   - **Negatives — the false-positive guard:** `'No plan found for key X'`,
     `'Invalid JSON body'`, `'Unknown Kanban verb: foo'`,
     `'ClickUp API token is invalid or expired.'`, `''`, `null`, `undefined` all return
     false.
2. **Unit — the webview classifier**, exercised by loading `kanban.html`'s
   `withDbRecoveryAdvice` / `dbRecoveryAdvice` into a jsdom-free harness (extract the
   function source by regex and `eval` it against a stubbed `document.body.dataset`, the
   pattern the existing source-contract tests already use for `kanban.html`):
   - `hostKind` absent → output contains `Command Palette` and not `npx switchboard`.
   - `hostKind: 'editor'` → contains `Developer: Restart Extension Host` **and**
     `reload this tab`.
   - `hostKind: 'standalone'` → contains `npx switchboard` and not `Command Palette`.
   - **Composed-prefix case:** `'1 plan(s) not advanced: disk I/O error'` is classified
     (proves the match is not anchored) and the original prefix survives in the output.
   - **Idempotency:** `withDbRecoveryAdvice(withDbRecoveryAdvice('disk I/O error'))`
     equals the single-pass result — no doubled advisory.
   - **Pass-through:** `'No plan found for key X'` returns byte-identical.
3. **Source contract — the two regexes agree.** Assert the `DB_CAPACITY_RE` literal in
   `src/webview/kanban.html` is textually identical to the one in
   `src/services/errorMessages.ts`. This is the only thing standing between the duplicated
   pattern and silent drift.
4. **Source contract — the animation is skipped for advisories.** Assert
   `showStatusBarMessage`'s source contains a branch that adds `status-advisory` **without**
   adding `flashing`, and that a `#status-message.sub-bar-status.status-advisory` rule with
   `white-space: normal` exists in the stylesheet. Without these two, a green unit suite
   still ships an invisible, clipped advisory — they are the regression guards for the two
   defects that hide best.
5. **Source contract — host wiring.** Assert `bootstrap.ts` contains
   `hostKind: 'standalone'`, `TaskViewerProvider.ts` contains `hostKind: 'editor' as const`,
   and `headlessPanelHtml.ts`'s `DEFAULT_HOST_CAPABILITIES` does **not** define `hostKind`
   (an unset default is what distinguishes the VS Code webview).
6. **Regression — existing contract tests stay green.** Run
   `headless-feature-management-contract.test.js`. Its pins at `:401-406` (transport.js
   dispatch shape) and `:419-421` (`case 'showStatusMessage':` handler) must still match,
   proving the change stayed inside `showStatusBarMessage`'s body.

### Manual

7. **Editor.** Open the board in VS Code. Force the failure by monkey-patching
   `KanbanDatabase._db.prepare` to throw `disk I/O error`. Drag a card. Confirm the status
   bar reads `1 plan(s) not advanced: disk I/O error — the database ran out of memory …`,
   is red, names the Command Palette entry, **wraps instead of ellipsing**, and is still
   on screen well past 5 s (this is the case the pre-fix code lost at 3 s).
8. **Browser served by the extension.** `switchboard.openInBrowser`, same forced failure.
   Confirm the advisory names the extension-host restart **and** "reload this tab".
9. **Browser served by the CLI.** Repeat via `npx switchboard`; confirm the advisory names
   the CLI restart and never mentions the Command Palette.
10. **No false positives.** Trigger an ordinary failure (drag a card whose plan row was
    deleted). Confirm the plain original message, the normal flash animation, the ordinary
    error timeout, and no wrapping.
11. **Mode reset.** Show an advisory, then immediately trigger an ordinary status message.
    Confirm the second message flashes normally, is single-line, and clears on its own
    timer — i.e. the advisory left no sticky/wrapped residue.
12. **No dialogs.** Confirm nothing added a modal, a confirm, or a two-click gate anywhere
    on this path.

---

**Recommendation: Send to Coder** (complexity 5).
