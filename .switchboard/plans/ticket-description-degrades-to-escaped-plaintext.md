# Ticket Description Degrades to Escaped Plaintext When the Host Cannot Render Markdown

## Goal

When `renderedDescriptionHtml` comes back empty, render the description with the webview's own markdown renderer instead of dumping escaped source text — so inline images, headings, lists and links survive on every host.

### The problem

Both detail renderers gate on `renderedDescriptionHtml` and, when it is empty, fall back to escaping the raw markdown:

- ClickUp — `src/webview/tickets.js:3444-3448`
- Linear — `src/webview/tickets.js:3339-3343`

The fallback is `escapeHtml(markdown).replace(/\n/g, '<br>')`. For a description containing `![](https://…)` the user sees the literal characters `![](https://…)` — every image gone, along with all formatting. It reads as "the viewer doesn't show inline images", but nothing image-specific is happening: the entire description has been downgraded to source text.

`renderedDescriptionHtml` is produced by `commands.executeCommand('markdown.api.render', …)`, wrapped in a `try` that swallows any failure to `''`:

- `src/services/TicketsPanelProvider.ts` (Linear at `:2470-2476`, ClickUp at `:2534-2540`)
- `src/services/TaskViewerProvider.ts:12045-12051` and `:12450-12456`

That command is a VS Code built-in. It is unavailable in the standalone host, which has no `vscode.commands` at all, so **every** ticket description in standalone renders as escaped plaintext. Confirmed empirically against the live server: the REST route `GET /task/clickup/86d385v98` returns `renderedDescriptionHtml` of length 0, while the panel verb `clickupLoadTaskDetails` for the same ticket returns 1748 characters of HTML containing two correct `<img>` tags. Same ticket, same data, two different answers depending on whether a VS Code command was reachable.

It is also silent. The `catch` writes `''` with a comment saying the frontend handles the fallback natively — but the frontend's "fallback" is `escapeHtml`, which handles nothing.

### Root cause

The webview already ships a competent markdown renderer — `renderMarkdown` in `src/webview/sharedUtils.js:122`, which emits `<img>` tags at `:364` and routes every URL through `sanitizeUrl` (`:25`). The local-file path already uses it: `_applyTicketFilePayloadToSelected` renders with `renderMarkdown(previewMarkdown)` at `tickets.js:6822`, which is why an imported ticket looks right and a non-imported one does not.

The API-loaded path simply never reaches for it. The two branches are `host-rendered HTML` or `escaped text`, with the working renderer sitting unused between them.

> **Superseded:** The original citations `tickets.js:3426-3431` / `:3321-3326` (renderers), `:2988` (`enterTicketsEditMode`), `:7621` and `:7621-7648` (the local-file path, described as `localTicketFileRead`), and `TicketsPanelProvider.ts` "~`:2264`" / "~`:2330`", `TaskViewerProvider.ts:11848-11854` / `:12253-12260`.
> **Reason:** All drifted; the local-file citation also named a message type rather than the function that owns the logic, which is the thing a coder has to edit.
> **Replaced with:** Verified today — renderers at `tickets.js:3339-3343` (Linear) and `:3444-3448` (ClickUp); `enterTicketsEditMode` at `:3006` (backup at `:3018`, edit-markdown derivation at `:3015-3017`); the local-file path is the function `_applyTicketFilePayloadToSelected` at `:6814-6851`, which handles **both** the `ticketFileChanged` and `localTicketFileRead` messages (render at `:6822`, change-detect at `:6829`, cache writes at `:6831-6849`); providers at `TicketsPanelProvider.ts:2470-2476` / `:2534-2540` and `TaskViewerProvider.ts:12045-12051` / `:12450-12456`.

> **Superseded:** "The fallback is `escapeHtml(markdown).replace(/\n/g, '<br>')` … [and branch 3 is] the existing `No description provided.` paragraph."
> **Reason:** Faithful in effect, imprecise in shape, and the imprecision changes the edit. There is no separate empty-description branch today. Both renderers have exactly **two** branches, and the empty case is a default folded into the escape expression: `` `<p>${escapeHtml((task.markdownDescription || task.description || '').trim() || 'No description provided.').replace(/\n/g, '<br>')}</p>` ``. So branch 3 is not "kept", it is **created** by splitting the existing expression.
> **Replaced with:** The current shape is two branches with an inline `|| 'No description provided.'` default. The change splits that single expression into two distinct branches (locally-rendered markdown / empty-state paragraph), giving three total.

## Metadata

**Tags:** frontend, ui, bugfix
**Complexity:** 4

> **Superseded:** **Complexity:** 3 — and **Tags:** frontend, tickets, bugfix.
> **Reason:** (1) `tickets` is not in the allowed tag vocabulary; the domain is already clear from the title. (2) A 3 reads as "intern-safe single-file edit". The change touches four sites in `tickets.js` (two renderers, two ingestion handlers) and interacts with cached-issue state that governs edit-mode entry, cancel-restore, and redraw suppression — a pane with a documented redraw-oscillation history. The edit is small; the traps around it are not.
> **Replaced with:** **Complexity:** 4, **Tags:** frontend, ui, bugfix.

## User Review Required

None.

## Complexity Audit

### Routine

- Splitting a two-branch conditional into three in two nearly-identical renderers.
- Calling an existing, already-loaded webview function (`renderMarkdown`) that this file already calls at `:5142`, `:6822`, and `:7758`.
- Adding a clarifying comment at four provider call sites.

### Complex / Risky

- **Cached-issue state.** `renderedDescriptionHtml` is not just a render input; it is read by `enterTicketsEditMode` (`:3012`, `:3018`), compared for redraw suppression (`:6829`, `:3365`, `:3470`), and persisted into `clickUpTaskDetailCache` / `linearIssueDetailCache`. Whatever value the fix produces must be consistent everywhere or edit-mode cancel will restore a blank pane.
- **`localDescription` is a semantic flag, not a hint.** It is honoured at `:7539` and `:7565` to make locally-rendered content win over a fresh remote payload. Setting it for a merely *locally-rendered remote* description would freeze the description and make subsequent remote edits invisible.
- **Two providers, separate code.** The Linear and ClickUp branches are duplicated and have drifted before.

## Edge-Case & Dependency Audit

### Race Conditions

- **Detail load vs. file-change push.** `_applyTicketFilePayloadToSelected` (`:6814`) can fire between a detail request and its response. Its change-detect at `:6829` compares `rendered === prev?.renderedDescriptionHtml`; once the ingestion handlers normalise that field, the comparison is against locally-rendered HTML on both sides — which is exactly what makes the comparison meaningful rather than a guaranteed mismatch. No new race; the equality becomes *more* accurate, not less.
- **Edit mode.** Both ingestion handlers already guard their re-render with `if (!ticketsEditMode)` (`:7557`, `:7583`), and `_applyTicketFilePayloadToSelected` returns early on `ticketsEditMode` (`:6815`). Normalising the field inside the handler body (before those guards) is safe: it updates the cache without touching the DOM mid-edit.

### Security

- `renderMarkdown` HTML-escapes its input on the way in (`sharedUtils.js:126-129`) and routes every emitted URL through `sanitizeUrl` (`:25`), so replacing `escapeHtml` with it does **not** widen the injection surface. `escapeHtml` is not buying safety here, only lost formatting.
- Rendering images means the panel now issues requests to provider CDNs it previously only displayed as text. That is the intended behaviour and matches what the host-rendered branch already does today.
- Anchors: `renderMarkdown` already emits `target="_blank" rel="noopener noreferrer"` (`sharedUtils.js:48` and `:368`). `externalizeAnchors` (`:62`) exists solely to patch `markdown.api.render`'s bare `<a href>` for the browser iframe, and it is idempotent — its regex skips anchors that already carry `target=`. So locally-rendered HTML is correct whether or not it passes through `externalizeAnchors`. Record this, or a reviewer will "fix" one of the two paths.

### Side Effects

- The detail caches (`clickUpTaskDetailCache`, `linearIssueDetailCache`) will now hold non-empty `renderedDescriptionHtml` on hosts where they previously held `''`. Every cache-restore site (`:3124`, `:3145`, `:5354`, `:5368`, `:5466`, `:5470`, `:5528`, `:5539`, `:5781`, `:5789`, `:4308`) therefore inherits the fix with no edit.
- Push/save is unaffected: `enterTicketsEditMode` derives edit markdown from `descriptionMarkdown` and only falls back to `htmlToMarkdown(descHtml)` when that is absent (`:3015-3017`). Both ingestion handlers always set `descriptionMarkdown` (`:7546`, `:7572`), so `htmlToMarkdown` is not reached for these tickets and cannot round-trip the locally-rendered HTML back into the remote.

### Dependencies & Conflicts

- `renderMarkdown`, `sanitizeUrl`, `escapeHtml`, `externalizeAnchors` all live in `src/webview/sharedUtils.js` and are already in scope in `tickets.js`.
- No provider, API-server, or standalone-bootstrap change. This is Layer-1-free: the payload already carries the markdown.
- No conflict with the two inline-image plans (`ticket-inline-images-never-resolve-to-downloaded-copies.md`, `auto-download-inline-ticket-images-on-import.md`). Those govern the *imported `.md`* path; this governs the *API-loaded* path. They meet only in that both end up rendering images.

## Dependencies

- *(No `sess_` session dependencies exist for this work.)*
- None. This plan is independently shippable and does not require either inline-image plan.

## Adversarial Synthesis

Key risks: (1) doing the fix inside the render functions means mutating cached issue state during a redraw, in a pane with a known redraw-oscillation history, and requires a separate explicit patch to keep edit-mode entry and cancel-restore consistent; (2) marking the locally-rendered result with `localDescription: true` would make it win over every future remote payload and silently freeze the description; (3) the Linear and ClickUp branches are duplicated and will drift if only one is covered. Mitigations: normalise at the two ingestion handlers so every downstream consumer — renderers, edit mode, redraw suppression, both detail caches — sees one value with no render-time writes; leave `localDescription` alone; and run every test case against both providers.

## Proposed Changes

### `src/webview/tickets.js`

#### 1. Normalise the description HTML where the payload is ingested

> **Superseded:** "### 2. Keep the edit path consistent — Once branch 2 exists, the displayed HTML may be locally rendered while `renderedDescriptionHtml` stays `''`. Set the same locally-rendered HTML on the cached issue object (as the `localTicketFileRead` path already does at `:7621-7648`) rather than leaving the field empty, so edit-mode entry, cancel-restore, and the `_lastTicketsClickUpDetailContentHtml` change-detection all see one consistent value."
> **Reason:** The requirement is right and the mechanism is inverted. As written, the renderer computes the HTML and then writes it back onto the cached issue — a state mutation performed inside a function that runs on every redraw, in the one pane with a documented redraw-oscillation history, and it needs a *second* explicit patch to keep edit mode honest. Both detail payloads arrive at exactly two places (`linearTaskDetailsLoaded` `:7537-7561`, `clickupTaskDetailsLoaded` `:7563-7588`) which already compute `renderedDescriptionHtml` **and** `descriptionMarkdown` side by side. Normalising there is the same number of edit sites, writes state where state is already written, and makes edit-mode entry, cancel-restore, redraw suppression, and both detail caches correct with no further work.
> **Replaced with:** Normalise at the two ingestion handlers. In each, when the incoming `renderedDescriptionHtml` is empty and source markdown exists, store `renderMarkdown(source)` in its place. The renderers then need no cache writes at all.

**Context.** `:7540-7552` (Linear) and `:7566-7578` (ClickUp) build the selected-issue object and immediately `set()` it into the detail cache. Both already honour a `localDescription` flag that preserves a previous local render.

**Logic.**

```js
// Linear — inside case 'linearTaskDetailsLoaded', replacing the renderedDescriptionHtml line
const _linearSrc = message.issue.description || '';
renderedDescriptionHtml: _keepLinearDesc
    ? _prevLinear.renderedDescriptionHtml
    // The host's markdown renderer (markdown.api.render) is a VS Code built-in and is
    // unreachable in the standalone host, where it yields ''. Render locally rather than
    // letting the view fall back to escaped source text.
    : (message.renderedDescriptionHtml || renderMarkdown(_linearSrc)),
```

and the ClickUp mirror at `:7571`, sourced from `message.task.markdownDescription || message.task.description || ''` — the same expression `:7572` already uses for `descriptionMarkdown`.

**Implementation.**

- **Do not set `localDescription: true`.** It must stay `_keepClickUpDesc || false`. That flag means "local file content outranks the remote payload" (`:7539`, `:7565`); setting it for a locally-*rendered remote* description would pin the first render forever and make later remote edits invisible. This is the single most damaging way to get this change wrong.
- Leave `descriptionMarkdown` exactly as it is — it is already the source of truth for edit mode.
- `renderMarkdown('')` returns `''` (`sharedUtils.js:123`), so an empty description still yields an empty field and the renderers' empty-state branch fires.

**Edge Cases.** A payload where the host renderer worked is untouched (`message.renderedDescriptionHtml` is truthy → short-circuit). A ticket restored from cache never re-enters this handler and already carries the normalised value.

#### 2. Insert the renderer as the middle branch in both renderers

**Context.** `:3339-3343` (Linear) and `:3444-3448` (ClickUp). Step 1 covers every issue that arrived through a detail load; these branches additionally cover the pre-fetch stub built on card click at `:3134` / `:3151` (`{ issue, detailsFetched: false }`), which has no `renderedDescriptionHtml` at all and today renders escaped source text until the detail response lands.

**Logic.** Restructure each to:

1. `renderedDescriptionHtml` present → `externalizeAnchors(renderedDescriptionHtml)` (unchanged; the host renderer stays preferred where available, and `externalizeAnchors` is idempotent so a locally-rendered value passing through it is safe).
2. Otherwise, if there is source markdown (`descriptionMarkdown`, then `task.markdownDescription`/`task.description`, then `issue.description`) → `renderMarkdown(source)`.
3. Only genuinely empty → `<p>No description provided.</p>`.

**Implementation.** Drop the `escapeHtml(...).replace(/\n/g,'<br>')` limb entirely. It has no case left where it is the best available answer. `renderMarkdown` performs its own HTML escaping on the way in (`sharedUtils.js:126-129`), so this does not widen the injection surface — `escapeHtml` is not buying safety here, only lost formatting.

These branches must **not** write to `selectedClickUpIssue` / `selectedLinearIssue` or to the caches. Rendering stays a pure function of state; step 1 owns the state.

**Edge Cases.** Whitespace-only descriptions must reach branch 3, not produce an empty `<p></p>` — keep the existing `.trim()` before the emptiness test. The `_lastTickets*DetailContentHtml` comparisons at `:3365` and `:3470` continue to work unchanged because they compare the fully assembled `contentHtml`.

### `src/services/TicketsPanelProvider.ts` and `src/services/TaskViewerProvider.ts`

#### 3. Do not paper over it in the provider

**Context.** Four `try`/`catch` blocks: `TicketsPanelProvider.ts:2470-2476` and `:2534-2540`; `TaskViewerProvider.ts:12045-12051` and `:12450-12456`.

**Logic.** Leave the provider-side `catch` returning `''`. Rendering markdown to HTML inside the provider for hosts that have no markdown renderer would mean shipping a second renderer in TypeScript to sit alongside the one already in the webview.

For the same reason, leave `GET /task/clickup/{id}` alone. Agents consuming that route want the markdown, which the payload already carries.

> **Superseded:** "leave `GET /task/clickup/{id}` returning empty `renderedDescriptionHtml`."
> **Reason:** Mechanism misstated in a way that would send a coder looking for code that does not exist. `renderedDescriptionHtml` does not appear anywhere in `src/services/LocalApiServer.ts`; the route (`:3802-3804` → `_handleGetTask`) never computes the field. It is **absent** from that payload, not emptied.
> **Replaced with:** `GET /task/clickup/{id}` never produces a rendered field at all, and should not start. The conclusion is unchanged: leave the route as-is.

**Implementation.** Replace the misleading comment at `TaskViewerProvider.ts:12050` and `:12455` (*"Fallback handled natively by the frontend if renderedDescriptionHtml is empty"* — the frontend's fallback was `escapeHtml`, which handled nothing) and add the equivalent at the two `TicketsPanelProvider` sites, which have no comment: empty is an **expected** outcome on any host without `markdown.api.render`, and the webview renders the source markdown itself. Comment only — no behaviour change in these two files.

**Edge Cases.** None; this step is documentation.

## Verification Plan

### Automated Tests

1. **Unit — image survives the fallback.** Render a detail view with `renderedDescriptionHtml: ''` and a description containing `![](https://example.test/a.png)`. Assert the output contains an `<img src="https://example.test/a.png">` and no literal `![](`.
2. **Unit — formatting survives.** Same setup with headings, a list, a fenced code block and a link. Assert corresponding tags, not escaped text. Assert the link carries `target="_blank"` and `rel="noopener noreferrer"`.
3. **Unit — host HTML still wins.** With a non-empty `renderedDescriptionHtml`, assert the output is byte-identical to today's (`externalizeAnchors` applied, `renderMarkdown` not invoked).
4. **Unit — empty stays empty.** No rendered HTML and no source markdown → `No description provided.`, unchanged. Whitespace-only markdown takes the same branch.
5. **Unit — both providers.** Every case above run against the Linear branch as well as ClickUp. The two branches are separate code and will drift if only one is covered.
6. **Unit — ingestion normalisation.** Dispatch `clickupTaskDetailsLoaded` with `renderedDescriptionHtml: ''` and a markdown description. Assert the cached issue's `renderedDescriptionHtml` is the locally-rendered HTML, `descriptionMarkdown` is the raw source, and **`localDescription` is still `false`**. Mirror for Linear. The `localDescription` assertion is the regression guard for the "frozen description" failure.
7. **Unit — a later remote edit still lands.** After case 6, dispatch a second `clickupTaskDetailsLoaded` carrying changed description text. Assert the cache updates to the new content — proving the previous normalisation did not pin it.
8. **Unit — pre-fetch stub.** Build the card-click stub (`{ issue, detailsFetched: false }`, no `renderedDescriptionHtml`) and render. Assert formatted output, not escaped source — this is the case step 1 alone does not cover.
9. **Manual — standalone host.** Open a ClickUp ticket with an inline image in the standalone browser cockpit, where `markdown.api.render` is unreachable. Confirm the description renders formatted with the image visible. Before the fix this shows raw markdown source.
10. **Manual — edit round-trip.** On a ticket rendered through the new branch, enter edit mode, confirm the textarea holds raw markdown (not HTML), cancel, and confirm the description restores to the rendered view rather than blanking or reverting to source text.
11. **Manual — no redraw oscillation.** With a ticket open in the standalone host, leave the pane idle through at least one auto-refresh cycle and confirm the detail pane does not flicker or re-render repeatedly. This is the specific hazard the render-time-write approach carried; the ingestion approach exists to avoid it, so it must be observed once.

## Recommendation

Complexity 4 → **Send to Coder.**

## Completion Report

Implemented the markdown fallback in the webview. `src/webview/tickets.js` now locally renders `description` (Linear) or `markdownDescription/description` (ClickUp) into `renderedDescriptionHtml` at the two detail-loaded handlers when the host returns empty HTML, and the two detail renderers use `renderMarkdown` as the middle branch between host-rendered HTML and the empty-state paragraph. Added explanatory comments to the four provider `try/catch` blocks in `src/services/TicketsPanelProvider.ts` and `src/services/TaskViewerProvider.ts` replacing the misleading "frontend handles fallback" wording. No compilation or test run performed per the plan's skip directives; edits were verified by reading the modified blocks back.

## Review Findings

Two MAJOR issues fixed: (1) the ingestion handlers rendered the source untrimmed, and `renderMarkdown('\n')` returns a truthy `'<p><br></p>'`, so a whitespace-only description took the host-HTML branch and painted an empty paragraph instead of `No description provided.` (verification case 4) — both `_linearSrc` and `_clickUpSrc` now `.trim()`; (2) none of the plan's eight automated tests existed and no CI gate covered the change, so `src/test/tickets-description-markdown-fallback.test.js` was added (renderer three-branch shape, ingestion normalisation, the `localDescription`-stays-false and trim guards, provider catch comments, plus jsdom assertions that images/headings/lists/links survive and `javascript:` URLs do not) and wired as `test:contract:tickets-description-fallback` in `package.json` and `.github/workflows/integration-tests.yml`. Files changed this pass: `src/webview/tickets.js`, `src/test/tickets-description-markdown-fallback.test.js` (new), `package.json`, `.github/workflows/integration-tests.yml`. Verification: the new gate plus `rendermarkdown`, `tickets-auto-refresh`, `tickets-sidebar-scoping` and `tickets-cross-panel-scope` all pass, and `tsc -p tsconfig.test.json` reports no error in any file this plan touches (its two errors, `LocalApiServer.ts:2261` and `standingOrders.ts:29`, plus the red `tickets-subtasks` gate whose `stripImportedSubtasksBlock` count went 2→1, all belong to unrelated uncommitted work in the shared tree). Remaining risk, not fixed by design: `getTicketsHtml`'s headless CSP (`headlessPanelHtml.ts:427`) omits `https:` from `img-src`, so in the browser cockpit the description now renders *formatted* but provider-hosted images stay blocked — widening it is the wrong fix (Linear 401s without a bearer header, ClickUp pre-signs with a 60-minute expiry), the download-then-serve-over-loopback sibling plans are the real path, and manual verification step 9 should be read as "formatted, image still pending" rather than a failure of this change.
