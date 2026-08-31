# Harden panel CSP — remove `script-src-attr 'unsafe-inline'` from both hosts

## Goal

Set `script-src-attr 'none'` in all 10 panel CSP definitions across both composition roots, and convert the 3 inline HTML event-handler attributes that currently depend on `'unsafe-inline'` to `addEventListener`. This closes the one CSP directive that permits the exact XSS vector every `innerHTML` sink in the webviews is exposed to.

### Problem Analysis

**Core problem.** Every panel in both hosts ships a CSP containing:

```
script-src 'nonce-…' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline';
```

`script-src` carries a nonce, so per CSP Level 3 its `'unsafe-inline'` (where present) is ignored and un-nonced `<script>` blocks are correctly blocked. **`script-src-attr` carries no nonce**, so its `'unsafe-inline'` *is* honored — inline event-handler attributes execute.

That is not a theoretical gap, because of how the panels render untrusted content:

- HTML injected via `innerHTML` **never executes `<script>` tags** — that is the HTML spec, not CSP. The directive that is doing work (`script-src`) blocks a vector that was already dead.
- The vector that *does* survive `innerHTML` is precisely the event-handler attribute — `<img src=x onerror=…>`, `<svg onload=…>` — and that is the one `script-src-attr 'unsafe-inline'` permits.

The panels are full of `innerHTML` sinks fed by content that is not fully trusted: `project.js:631,1012,1160`, `planning.js:3539,5131,6192`, `design.js:1661`, plus the ticket-description paths. Content reaching them includes ticket descriptions from integration-sync APIs and plan files imported from shared workspaces.

**Why it is currently latent, and why that is about to change.** Today the hand-rolled `renderMarkdown` (`sharedUtils.js:122`) escapes `&`, `<`, `>` up front (`:126-129`), so no attacker-controlled HTML reaches those sinks at all. The renderer, not the CSP, is what stands between untrusted markdown and script execution. `fix-kanban-plan-preview-dead-in-standalone` changes the engine on several of those paths, which is why the CSP's real posture matters now rather than later. That plan adds DOMPurify so it does not regress; this plan removes the reason a future regression would be exploitable.

**Measured scope — the directive is nearly unused.** Only **3** inline handler attributes exist in the entire webview source:

| Site | Handler | Notes |
| :--- | :--- | :--- |
| `design.html:4331` | `onerror="console.error(…); window.__sbInspectLoadError = true;"` on the `inspect.js` `<script>` tag | `window.__sbInspectLoadError` is written here and **read nowhere** in `src/` — a dead flag |
| `planning.js:6720` | `onclick="document.getElementById('prd-project-picker-modal').remove()"` | modal close button |
| `planning.js:6727` | `onclick="document.getElementById('prd-project-picker-modal').remove()"` | modal Cancel button |

Every other `on<event> =` match in `src/webview/` is a DOM **property** assignment in JS (`btn.onclick = () => …`), which CSP does not govern. Those need no change and must not be touched.

**Corrects a false premise in a sibling backlog plan.** `design-html-iframe-sandbox-csp-risk-assessment.md` (BACKLOG) states at `:20` that "`'unsafe-inline'` + `'unsafe-eval'` … make the nonce useless for script-src. Any inline script can execute." That is wrong: a nonce in `script-src` causes `'unsafe-inline'` to be ignored for that directive. It also states at `:34` that "the HTML body has extensive inline styles and inline event handlers" — there is exactly **one** inline event handler in `design.html`, and inline *styles* are a `style-src` concern, a different directive. That plan's conclusions about `script-src` should not be relied on.

### Root Cause

`script-src-attr 'unsafe-inline'` was added to every panel CSP uniformly rather than per-need. With only 3 inline handlers in the codebase, the directive grants a blanket capability to satisfy three call sites, two of which are a modal close button.

## Metadata

**Complexity:** 3
**Tags:** security, webview, standalone, extension

## User Review Required

None.

## Approach

1. **Convert the 3 inline handlers to `addEventListener`.** Do this *before* tightening the CSP, so no intermediate commit has a silently-dead handler.
2. **Set `script-src-attr 'none'` in all 10 CSP definitions** — 7 header CSPs in `src/services/headlessPanelHtml.ts` (standalone root) and 3 `<meta>` CSPs in the panel HTML (shared by both hosts).
3. **Add a contract test** that fails if `script-src-attr 'unsafe-inline'` reappears in any CSP, or if a new inline handler attribute appears in any webview HTML/JS.

**Use `'none'`, not deletion.** Omitting `script-src-attr` makes it fall back to `script-src`, which currently has a nonce and would therefore also block inline handlers — but that is a chain of inference that silently breaks the day someone adds `'unsafe-inline'` to `script-src` without a nonce. `'none'` states the intent, is immune to `script-src` edits, and is what the contract test asserts.

## Complexity Audit

### Routine

- Replacing two `onclick="…"` attributes in a template literal with an `addEventListener` after the node is inserted.
- A find-and-replace of `script-src-attr 'unsafe-inline'` → `script-src-attr 'none'` across 10 sites.

### Complex / Risky

- **Two CSPs apply in standalone, and both must change.** `headlessPanelHtml` returns `{html, csp}`: the `csp` is sent as an HTTP `Content-Security-Policy` **header**, *and* the served HTML retains its own `<meta>` CSP (the function only rewrites `{{WEBVIEW_CSP_SOURCE}}` and the `connect-src https:` substring — it does not strip the meta tag). The effective policy is the **intersection**, so fixing only the header leaves the meta tag permitting handlers, and fixing only the meta leaves the header permitting them. Both must be edited or the change is a no-op in standalone. In the extension host only the `<meta>` tag applies for these three panels.
- **`design.html:4331` is an `onerror` on a `<script src>` tag.** Its replacement must be attached *before* the script can fail to load, which an `addEventListener` in a later script cannot guarantee. Handle it by dropping the handler entirely — see Proposed Changes; the flag it sets is never read.
- **Silent failure mode.** A missed inline handler does not error; the button just stops working. The contract test is what catches this, not the compiler.

## Edge-Case & Dependency Audit

**Race Conditions.** One, at `design.html:4331`: a `<script onerror>` can fire before any later-registered listener exists. Resolved by removing the handler rather than porting it.

**Security.** This is the point of the plan. After the change, an event-handler attribute that survives into an `innerHTML` sink is inert in both hosts. It does not replace sanitization — DOMPurify in the standalone `markdown.api.render` handler stays — it removes the exploitability of a sanitizer bypass. Note what this plan does **not** change: `'unsafe-eval'` remains in `script-src` (needed by the panels), and `frame-src 'self' http: https: about:srcdoc blob: data:` remains wide (it is load-bearing for the HTML preview iframes). Both are the subject of `design-html-iframe-sandbox-csp-risk-assessment.md` and are explicitly out of scope here.

**Side Effects.** The PRD project-picker modal's close and Cancel buttons are rewired; they must still dismiss the modal. `window.__sbInspectLoadError` stops being set — nothing reads it, so nothing observes this. No persisted state changes, no migration: CSP is computed per request/panel-load, never stored.

**Dependencies & Conflicts.** Independent of `fix-kanban-plan-preview-dead-in-standalone` — either can ship first, and neither blocks the other. Overlaps in subject matter (not in files) with `design-html-iframe-sandbox-csp-risk-assessment.md`; that plan should be re-scoped to `'unsafe-eval'` and `frame-src` after this one lands, and its `script-src` claims corrected.

## Dependencies

- None blocking. Ships independently of the markdown-preview plan.

## Adversarial Synthesis

Key risks: (1) **the intersection trap** — editing the header CSP in `headlessPanelHtml.ts` but not the `<meta>` tags (or vice versa) produces a change that passes review and does nothing; (2) **a missed inline handler** breaks a button with no error, and grep is the only detector because `onclick="…"` inside a JS template literal is invisible to the type checker; (3) the `design.html` `<script onerror>` cannot be faithfully ported to `addEventListener` without a load-order race.

Mitigations: change both CSP surfaces in the same diff and assert both in the contract test; enumerate handlers with the exact grep in Verification step 1, which excludes DOM property assignments; drop the `design.html` handler rather than porting it, justified by the flag being write-only.

The residual risk is a *future* inline handler being added and silently not firing. The contract test converts that from a runtime mystery into a failed build.

## Proposed Changes

### `src/services/headlessPanelHtml.ts` (standalone composition root — 7 CSP strings)

**Context.** Each `get<Panel>Html` builds a `csp` string returned to `LocalApiServer`, which sends it as the `Content-Security-Policy` header (`LocalApiServer.ts:1287,1339,1393,1467`, via `_widenCspForRequest`, which only touches `connect-src`).

**Logic.** In each of the 7 CSP template literals, replace `script-src-attr 'unsafe-inline'` with `script-src-attr 'none'`:

| Line | Panel |
| :--- | :--- |
| `:249` | mission-control |
| `:275` | project |
| `:311` | planning |
| `:347` | design |
| `:381` | setup |
| `:461` | tickets |
| `:490` | connections |

No other part of these strings changes.

### `src/webview/project.html:6`, `src/webview/planning.html:6`, `src/webview/design.html:6` (both hosts — meta CSP)

**Logic.** Same substitution in the `<meta http-equiv="Content-Security-Policy">` tag. These are the extension host's policy for these panels, and in standalone they intersect with the header above.

### `src/webview/design.html:4331` (inline `onerror` — remove)

**Context.**

```html
<script nonce="{{NONCE}}" src="{{INSPECT_JS_URI}}" onerror="console.error('[design.html] inspect.js failed to load'); window.__sbInspectLoadError = true;"></script>
```

**Logic.** Drop the `onerror` attribute, leaving the tag otherwise unchanged. Do **not** port it to `addEventListener`: a listener registered by a later script cannot be guaranteed to exist before this script's load failure, so the port would be unreliable in exactly the failure case it exists for.

**Justification.** `window.__sbInspectLoadError` is assigned here and read nowhere in `src/` — removing the assignment changes no behavior. The `console.error` is a diagnostic that the browser already reports as a failed resource load in the network panel.

### `src/webview/planning.js:6720, 6727` (inline `onclick` ×2 — convert)

**Context.** Both are in the PRD project-picker modal's HTML template literal:

```js
<button class="modal-close-btn" onclick="document.getElementById('prd-project-picker-modal').remove()">&times;</button>
…
<button class="strip-btn" onclick="document.getElementById('prd-project-picker-modal').remove()">Cancel</button>
```

**Logic.** Remove both `onclick` attributes. After the modal element is inserted into the DOM, bind both buttons:

```js
const modalEl = document.getElementById('prd-project-picker-modal');
modalEl.querySelectorAll('.modal-close-btn, .strip-btn').forEach(btn => {
    btn.addEventListener('click', () => modalEl.remove());
});
```

**Edge Cases.** Bind after insertion, not before — `querySelectorAll` on a detached template string finds nothing. If the modal can be opened more than once per session, confirm the old node is removed (it is — both handlers call `.remove()`) so ids stay unique and listeners do not accumulate.

### `src/test/panel-csp-inline-handler-contract.test.js` (new)

**Logic.** A source-reading contract test, in the style of the existing webview contract tests. No DOM, no host.

## Verification Plan

### Automated Tests

1. **Enumerate handlers first (reproduce the scope).** Run:

   ```
   grep -rn -oE '\son[a-z]+\s*=\s*["'"'"']' src/webview/*.html src/webview/*.js
   ```

   Confirm exactly 3 hits: `design.html` ×1 `onerror`, `planning.js` ×2 `onclick`. This grep deliberately requires a quote directly after `=`, which excludes DOM property assignments (`btn.onclick = () => …`). If the count is not 3, the plan's scope is stale — re-enumerate before editing.
2. **After the change, the same grep returns 0 hits.**
3. **Contract test — CSP.** Assert that no CSP string in `src/services/headlessPanelHtml.ts` and no `<meta http-equiv="Content-Security-Policy">` in `src/webview/*.html` contains `script-src-attr 'unsafe-inline'`, and that all 10 contain `script-src-attr 'none'`. Pin the count to **10** exactly — a test asserting "none contain unsafe-inline" also passes if someone deletes the directive entirely, which is the weaker posture this plan rejects.
4. **Contract test — handlers.** Assert the grep in step 1 returns zero matches across `src/webview/`. This is the guard that makes a future inline handler fail the build instead of silently not firing.
5. **PRD project-picker modal, extension host.** Open the Project panel, trigger the PRD project picker, click the `×` — modal closes. Reopen, click Cancel — modal closes. Reopen a third time to confirm no listener accumulation or duplicate-id breakage.
6. **PRD project-picker modal, standalone host.** Same three interactions in `npx switchboard`. Both hosts, because the meta CSP is shared and the header CSP is standalone-only — a break could appear in either.
7. **Handlers are actually blocked (the positive security check).** In the standalone project panel devtools console, run:
   `document.querySelector('#kanban-preview-content').innerHTML = '<img src=x onerror="window.__cspProbe=1">'`
   Confirm the browser logs a CSP violation for `script-src-attr` and `window.__cspProbe` is `undefined`. Repeat in the extension host's webview devtools. Before the change this probe sets the flag; after it must not.
8. **No panel regressed.** Load all 7 standalone panels (mission-control, project, planning, design, setup, tickets, connections) and confirm each renders and its buttons respond — a CSP typo breaks the whole panel, not one button.
9. `npm run compile` and `tsc` clean.

### Goal Invariants

- **Positive:** all 10 CSP definitions contain `script-src-attr 'none'` (7 in `headlessPanelHtml.ts`, 3 in panel `<meta>` tags).
- **Positive:** an `onerror` attribute injected into a panel `innerHTML` sink does not execute in either host (Verification step 7).
- **Negative (paired):** zero inline `on<event>="…"` attributes remain in `src/webview/`. Paired positive: the PRD project-picker modal still closes from both its `×` and Cancel buttons in both hosts — a change that removes the attributes without rebinding fails this pair.
- **Negative:** no DOM property assignment (`el.onclick = …`) was rewritten. These are not CSP-governed; touching them is scope creep and this plan forbids it.
