# The Markdown Editor's Live Preview Renders With a Different Engine Than the View It Predicts

## Goal

Make the split-view live preview in the markdown editor show what the panel will actually display after Save. On the three panels whose view mode renders through `renderMarkdown`, the preview must render through `renderMarkdown` too — so the preview is a prediction of the saved result rather than a second, differently-formatted opinion of the same text.

*Clarification (strictly implied by the above; grounded in code below):* on the **standalone / browser host** the same change is not cosmetic — it is the difference between a live preview that works and one that shows "Nothing to preview" for every non-empty document. The two goals share one fix; see *"In the browser host this is a dead surface, not a spacing bug"*.

### The problem

The editor shell (`src/webview/markdownEditor.js`) defaults to split view (`globalViewMode = 'split'`, `:218`), so every edit session shows a live preview beside the textarea whether the user asked for one or not. That preview is produced by a **different markdown engine** than the view it is previewing.

The user-reported workflow that exposed it: write a flat bullet list, then insert blank lines at chosen points to break it into sections *before* writing the headers in. The blank lines are working scaffolding — the operator is using the gaps to find where the section boundaries belong.

- **View mode** renders through `renderMarkdown` (`src/webview/sharedUtils.js`), which as of the loose-list work marks **per-item** looseness: only the bullet that follows a blank line gets `<li class="md-li-loose">`, because the operator typed a blank line where they wanted *that* gap.
- **The live preview** renders through VS Code's CommonMark renderer, where looseness is a property of the **whole list**: one blank line anywhere wraps *every* item in `<p>` and spaces all of them.

So for `- a\n- b\n\n- c`, view mode shows one gap (before `c`) and the preview shows two (before `b` and `c`). The preview cannot show the operator where their break landed — which is the single thing they opened the editor to do.

### Root cause — two engines, one surface

`renderPreview` is a callback each panel supplies to `SwitchboardMarkdownEditor.attach()`. All five call sites implement it the same way: post `renderMarkdownLive`, await `markdownLiveRendered`, resolve with the returned HTML.

`handleRenderMarkdownLive` (`src/services/sharedUtilityVerbs.ts:86`) optionally rewrites relative image paths, then renders:

```ts
const html = await deps.seams().commands.executeCommand<string>('markdown.api.render', content);   // :102
```

`markdown.api.render` is VS Code's own CommonMark implementation. `renderMarkdown` is this repo's hand-rolled renderer. They were never the same engine; the loose-list change simply made one of their disagreements visible, because before it view mode rendered every list tight and the divergence read as "the preview is just roomier".

The five call sites are **not** uniform in what they should do, and this is the load-bearing distinction in this plan:

| Call site | View mode of the same content | Action |
| :--- | :--- | :--- |
| `src/webview/tickets.js:3093` | `renderMarkdown` (9 sites) | switch |
| `src/webview/planning.js:6282` (plan/doc editor) | `renderMarkdown` (`:3508`, `:3524`, `:4618`, `:5050`, `:6160`) | switch |
| `src/webview/planning.js:7632` (duplicated tickets editor) | `renderMarkdown` | switch |
| `src/webview/design.js:1882` | `renderMarkdown` (`:1645`, `:1835`, `:3773`) | switch |
| `src/webview/project.js:3108` | **`markdown.api.render`** — `project.js:559` sets `projectsPreviewContent.innerHTML` from backend HTML with the comment *"HTML from markdown.api.render"*, same at `:606` and `:619` | **leave alone** |

The Project panel is CommonMark end to end. Its preview and its view already agree. Switching it would *create* the divergence this plan exists to remove. `project.js` has no `renderMarkdown` call site at all — verify that with a grep before touching anything, because it is the one place where "make them all consistent" is the wrong instinct.

*Verified during the improve pass:* `grep -c 'renderMarkdown(' src/webview/project.js` → **0**. `tickets.js` → 9, `planning.js` → 8, `design.js` → 3. The table's counts and the `project.js` exception both hold. The three `project.js` line numbers (`559`, `606`, `619`) are exact.

### In the browser host this is a dead surface, not a spacing bug

*(Clarification — new evidence found during the improve pass. It does not change the plan's approach; it raises the stakes and adds two verification steps.)*

`markdown.api.render` is a **VS Code built-in with no standalone implementation**:

- `src/standalone/vscodeShim.ts:244` — `executeCommand` warns once per command id and returns `undefined`. Its own comment: *"the calling arm's side effect did not happen"*.
- `src/services/hostSeams.ts:327` (`VscodeHostCommands`) swallows the failure and returns `undefined` rather than throwing.
- `src/standalone/hostServices.ts:412` (`createHeadlessHostSeams`) does the same — and per its `:361` docstring is **not currently wired** anyway; `bootstrap.ts` injects `createVscodeHostSeams`.

So under `npx switchboard` today, `handleRenderMarkdownLive` reaches `executeCommand` and gets `undefined`. It does **not** throw, so the success branch runs and pushes `{ html: undefined, htmlContent: undefined }`. Every call site resolves `msg.html || msg.htmlContent || ''` → `''`, and `markdownEditor.js:572` turns `''` into the `Nothing to preview` placeholder. **The live preview is blank in the browser cockpit for every non-empty document, on all five call sites.**

This is a live breach of PRD contract #6 (*capability-gating honesty — no dead surfaces*). Moving the four `renderMarkdown` sites off the round trip repairs it as a direct consequence, because they stop depending on a command the host does not have. That makes the browser-host behaviour a stated goal of this plan, not an accident — and it is why the acceptance test below is host-qualified.

The pattern to copy already exists: `tickets.js:7644` and `:7677` do `message.renderedDescriptionHtml || renderMarkdown(_linearSrc)` with the comment *"markdown.api.render … is unreachable in the standalone host, where it yields ''. Render locally rather than letting the view fall back to escaped source text."* This plan applies the same reasoning to the preview surface.

### Why the preview must move to `renderMarkdown`, and not the reverse

The preview is the subordinate surface. Its only job is to predict the saved result. Anything CommonMark can render that `renderMarkdown` cannot is not a capability the preview should advertise — the user will not get it after Save. Showing richer output than the destination is the preview lying, not the preview being better.

The reverse direction — teaching `renderMarkdown` CommonMark's all-or-nothing rule — is explicitly rejected. It is the behaviour the loose-list work deliberately chose against (that plan's edge case 3: *"users are asking for the specific gaps they typed, so per-item spacing is the chosen behaviour... state this in the code comment so a future 'correctness' refactor to all-or-nothing does not silently erase it"*). This plan is that future refactor arriving, and it must be turned away.

### Rejected approach — post-process the CommonMark HTML

The obvious fix is to transform `markdown.api.render`'s output in `handleRenderMarkdownLive`: unwrap `<li><p>x</p></li>` back to `<li>x</li>` and add `md-li-loose` to the right items. **It cannot be done from the HTML alone.** CommonMark's output for `- a\n- b\n\n- c` is three identically-shaped `<li><p>` elements; the information about *which* item followed the blank line is destroyed by the all-or-nothing rule. Recovering it means walking the source markdown and the rendered HTML in parallel and correlating list-item ordinals across two parsers — a new, fragile HTML-mangling pass on a verb shared by three providers, to reconstruct information the correct renderer never loses. Do not build it. It also does nothing for the browser host, where there is no HTML to post-process.

### Rejected approach — port `renderMarkdown` to the host

Running a Node copy of `renderMarkdown` behind the verb so both hosts render server-side would give parity too. Rejected: it creates a second implementation of the renderer that must be kept in lockstep with `sharedUtils.js` forever — the exact defect class PRD contract #1 (*anti-divergence — reuse verbatim*) exists to prevent. The webview already has the renderer in scope; shipping it twice to avoid calling it once is negative-value work.

### Deferred alternative — move image rewriting client-side and delete the round trip entirely

The two ticket call sites keep the round trip only for `rewriteLocalImagePaths`. If the backend sent the ticket file's rewrite **base URI** once at edit-entry (on `readLocalTicketFile`, which already returns both rewritten `content` and raw `rawContent`), the webview could rewrite locally and all four sites would render with no host call at all — host-independent by construction, and one fewer message per keystroke-debounce.

Not taken here: it changes the tickets edit-entry payload contract on a shipped provider for a benefit the retained round trip already delivers correctly. Record it as the natural follow-up if preview latency ever becomes the complaint.

### What is NOT in scope

- `renderMarkdown` itself: no behaviour change. This plan changes *which* surfaces call it.
- The `pushTicketEdits` / save path: already verbatim (`tickets.js:5186` — *"The editor now holds raw markdown — use it verbatim, no lossy HTML round-trip"*), and `saveLocalTicketFile` writes `frontmatter + content` with no whitespace pass. Files and remote descriptions are unaffected by this plan in either direction.
- `project.js`, per the table above.
- The `renderMarkdownLive` verb's existing contract: the change to it is purely additive (one new reply field). No allowlist, schema, or catalog change; no `break`-count movement, so the return-contract ratchet is untouched.
- **The Project panel's blank previews in the browser host.** `PlanningPanelProvider` sends `markdown.api.render` output with **no client-side fallback** at `:1653` (`kanbanPlanPreviewReady`), `:4081` (`constitutionFileRead`), `:4211` (`projectPrdContent`) and `:5108` (`insightContent`), so in the browser cockpit the Project panel's PRD, plan, feature, constitution and insight preview panes are all empty — *view* mode as well as preview. That is a real defect and a separate plan; folding it in here would mean changing `project.js`'s view mode, which is the very thing this plan's `project.js` decision is conditioned on. **Sequencing note:** if that plan lands and moves the Project panel's view mode onto `renderMarkdown`, then `project.js:3108` must switch too — the "leave alone" verdict here is conditional on its view mode staying `markdown.api.render`, not unconditional.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4
> **Reason:** The improve pass added a sixth touched file's worth of judgement and two non-obvious traps that a 4 ("routine single-file change") does not signal: the edit must land on the *pushed* object rather than only the returned one (a silent-failure trap of the same class as the CSS trap already documented), and the four call sites split into two different treatments that are not interchangeable. Scope is still small and localised — 1 `.ts` + 4 `.js` + a stylesheet rule + tests — which is a 5 ("multi-file changes, moderate logic"), not a 7.
> **Replaced with:** **Complexity:** 5

## User Review Required

None.

## Complexity Audit

### Routine

- Replacing four `renderPreview` bodies with a `renderMarkdown` call.
- Adding one field to `handleRenderMarkdownLive`'s reply object.
- Adding one CSS rule to the editor's injected stylesheet.

### Complex / Risky

- **The CSS trap — this is the one that makes the change silently do nothing.** The preview mounts as `div.md-live-preview.markdown-body` (`markdownEditor.js:251`), inside the panel's *edit* container. Every `.md-li-loose` rule added by the loose-list work is ID-scoped (`planning.html:1250-1255`, `tickets.html:1268-1273`, `design.html:1234-1240`) and **none of those selectors reach `.md-live-preview`** — verified: the three rule blocks list only `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#kanban-preview-pane`, `#markdown-preview-tickets` (plus `#stitch-html-markdown-preview` in `design.html`), and there is no generic `ul`/`ol`/`li` rule in any of the three stylesheets. Switch the renderer without adding a rule and the preview emits the class, styles nothing, and looks exactly as it does today — at which point someone concludes the renderer swap did not land and starts debugging `sharedUtils.js`. This is the same trap the loose-list plan's root cause 3 documented, one surface over.

- **The new field must go on the object that is *pushed*, not only on the object that is *returned*.** `handleRenderMarkdownLive` builds `okRes`, calls `deps.push(okRes)`, then returns `{ ...okRes, success: true }`. Every webview call site reads the **push** (`window.addEventListener('message', …)`), never the HTTP return body. Add `markdown` to the spread at the `return` instead of to `okRes` and all four switched sites see `msg.markdown === undefined`, fall back to the un-rewritten local source, and render with broken images — with no error anywhere. Second silent-failure trap in the same change; it is why the verification below asserts on the pushed payload specifically.

- **Image rewriting is why the round trip cannot simply be deleted.** Two of the four call sites pass `provider`/`id` (`tickets.js:3105`, `planning.js:7644`); for those, `handleRenderMarkdownLive` resolves the ticket file and calls `rewriteLocalImagePaths` (`sharedUtilityVerbs.ts:95-101`) so relative image refs in the *in-progress* text resolve. The webview knows the rewritten form of the *saved* document (`readLocalTicketFile` returns rewritten `content` alongside raw `rawContent`) but not of text being typed. So those two sites must keep the round trip and render the **rewritten markdown** the backend returns. The other two (`planning.js:6298`, `design.js:1898`) send no `provider`/`id`, so no rewrite happens and they can render locally with no round trip at all.

- **`externalizeAnchors` is applied to whatever `renderPreview` resolves** (`markdownEditor.js:572`). Verified idempotent: `sharedUtils.js:64` is `html.replace(/<a\s+(?![^>]*\btarget=)/gi, …)` and `renderMarkdown` emits `<a href="…" target="_blank" rel="noopener noreferrer">` at `sharedUtils.js:48` and `:380`, so the negative lookahead sees `target=` before the `>` and skips every anchor it already produced. No double-applied attributes. Keep the assertion in the test set as a regression guard, not as an open question.

  > **Superseded:** *"Confirm the helper is idempotent on already-externalised anchors rather than assuming it."*
  > **Reason:** It was an open question in the original plan; the improve pass read both implementations and resolved it. Leaving it phrased as a task makes a coder re-derive a settled fact.
  > **Replaced with:** Verified idempotent by the lookahead in `sharedUtils.js:64` against the anchor shape emitted at `:48`/`:380`; the test below pins it.

- **Three providers carry this verb, but only two share an implementation.**

  > **Superseded:** *"Three providers route this verb (`DesignPanelProvider.ts:2494`, `PlanningPanelProvider.ts:2541`, `TicketsPanelProvider.ts:4290`), all delegating to the one shared handler. The reply-field addition therefore lands on all three at once."*
  > **Reason:** Factually wrong. `DesignPanelProvider.ts:2494-2514` is an **inline copy** — it calls `this._seams().commands.executeCommand('markdown.api.render', …)` and posts `markdownLiveRendered` itself; it never touches `sharedUtilityVerbs.ts`. Only `PlanningPanelProvider.ts:2541` and `TicketsPanelProvider.ts:4290` delegate. A coder told "all three gain the field" would go looking for a delegation in Design that does not exist.
  > **Replaced with:** The `markdown` field lands on **two** providers — Planning and Tickets — via the one shared handler. Design's inline arm does not gain it and does not need it: `design.js:1882` is a *local-render* site after this change and stops posting the verb entirely. Leave the Design arm exactly as it is — `DESIGN_VERBS` is generated from the provider's `switch` arms, and `verb-engine-headless-seams.test.js:232` asserts it returns html, so removing it would move the allowlist and break a green test for no gain.

- **`project.js` is served by `PlanningPanelProvider`, not a provider of its own.** The arm at `PlanningPanelProvider.ts:2541` picks its push target with `const mdTargetPanel = isProject ? this._projectPanel : this._panel;`. So the Project panel *does* receive the new `markdown` field — harmlessly, since `project.js:3108` keeps reading `msg.html`. No separate Project-panel wiring exists or is needed.

- **`planning.js` holds a duplicated copy of the tickets editor** (`:7631`). It is extraction residue, not a second feature. Both planning call sites change; they are not the same code and a fix applied to one does not reach the other.

## Edge-Case & Dependency Audit

### Race Conditions

- **Stale-response guard is already correct and must stay.** `markdownEditor.js:569-573` stamps `const reqId = ++currentRequestId` and drops any resolution where `reqId !== currentRequestId`. The two local-render sites resolve synchronously and can never be stale; the two round-tripping sites keep the existing `requestId` correlation in their message handler. Do not remove either guard while "simplifying" the local sites.
- **The browser host fans every WS push out to all panel surfaces**, so a single `markdownLiveRendered` can arrive more than once at the same listener. Existing behaviour, already tolerated: each handler calls `window.removeEventListener('message', handler)` on first match, so duplicates after the first are dropped. Preserve that `removeEventListener` line verbatim when rewriting the two round-tripping bodies — deleting it turns a tolerated duplicate into a repeated re-render.

### Security

- Rendering moves from VS Code's sanitising CommonMark renderer to `renderMarkdown` on four surfaces. This is not a new exposure: those same four surfaces already render *view* mode through `renderMarkdown` on the same content, and `renderMarkdown`'s escaping is the subject of an existing CI contract test (`.github/workflows/integration-tests.yml:194-198`, *"renderMarkdown feeds webview HTML, so its output is an XSS surface"*). The change reduces the number of distinct renderers touching user content from two to one.
- `externalizeAnchors` continues to run on the result (`markdownEditor.js:572`), and `renderMarkdown` emits `rel="noopener noreferrer"` itself. No `target`/`rel` regression — see the idempotence note above.

### Side Effects

1. **Tight lists.** Both engines render them identically today (CommonMark emits no `<p>` for a tight list; `renderMarkdown` emits no class). The switch must be a visual no-op for every ticket and plan without a blank line inside a list — that is the large majority, and it is the non-regression this change is judged on.
2. **The preview's other markup.** `.md-live-preview` sits outside every panel's ID-scoped `pre`/`table`/`li p` rule, so the preview was *already* unstyled by them under CommonMark. Switching engines therefore loses no styling it ever had. Verify by eye rather than assuming, but do not pre-emptively port panel CSS into the editor stylesheet.
3. **Markdown `renderMarkdown` does not support.** Reference links, footnotes, setext headings and raw HTML blocks may render differently or literally. This is correct: view mode will do the same thing after Save. Do not add features to `renderMarkdown` to close the gap — that is a separate decision with its own blast radius across four panels.
4. **Empty content.** `markdownEditor.js:565` substitutes a "Nothing to preview" placeholder before `renderPreview` is called, so a `renderMarkdown('')` path is not reached on empty input. Confirm the guard still fires first after the change.
5. **The large-document pause.** `markdownEditor.js:556` swaps in "Live preview paused (large doc)" above a 30 000-character threshold. Client-side rendering is cheaper than a round trip, but do NOT raise or remove that threshold in this plan — it is a separate tuning decision and bundling it hides a perf change inside a correctness fix.
6. **Reject path — removed on the two round-tripping sites.**

   > **Superseded:** *"The two round-tripping sites still `reject(msg.error)` on a backend failure; that behaviour is unchanged."*
   > **Reason:** It is no longer the right behaviour once the backend stops doing the rendering. After this change the round trip's **only** contribution is rewriting relative image paths; the rendering happens client-side and cannot fail. So a backend error means "images will not resolve", not "the preview cannot be produced" — and rejecting turns a degraded preview into `Render error: …` (`markdownEditor.js:576`). Worse, on the standalone host there is no error at all: `executeCommand` returns `undefined` without throwing, so the reject branch would not even fire — the site would silently render the local fallback. Keeping a reject path that is wrong where it fires and dead where it matters is strictly worse than removing it.
   > **Replaced with:** Both round-tripping sites resolve unconditionally with `renderMarkdown(msg.markdown ?? localMarkdown)`. The local source is always available, so there is no reachable failure mode; drop the `reject` parameter rather than leaving an unused one. The two local sites resolve synchronously and never had an error path.

7. **`renderMarkdown` availability.** It is a global from `sharedUtils.js`, injected into design, planning, tickets and project by `headlessPanelHtml.ts` (four `{{SHARED_UTILS_URI}}` rewrites at `:251`, `:287`, `:324`, `:433` — verified). `markdownEditor.js` is injected alongside it by the same four blocks (`{{MARKDOWN_EDITOR_URI}}` at `:252`, `:288`, `:325`, `:434`), which is what makes the browser-host claim above concrete rather than theoretical. All four affected call sites already have `renderMarkdown` in scope — the same file already calls it in view mode. No new script injection.
8. **Project panel non-regression — host-qualified.** In the **VS Code editor host**, open a Project panel doc in the editor and confirm its preview is byte-identical to before; it is the control case. In the **browser host** this check proves nothing: the Project panel's preview is blank before *and* after (see *What is NOT in scope*), so "unchanged" is trivially true there. Run the control case in the editor host only.
9. **No confirm dialogs** (repo rule).
10. **The runtime-surface test is not disturbed by the new CSS rule.** `src/test/webview-panel-runtime-surface.test.js:298-305` locates rules with `src.indexOf('.md-live-preview {')` — the literal selector followed by a space and a brace. The new rule is `.md-live-preview .md-li-loose { … }`, which does not contain that substring, and `indexOf` returns the first match (`markdownEditor.js:112`) regardless of placement. Stated so nobody moves the rule out of `markdownEditor.js` chasing a test failure that will not occur.

### Dependencies & Conflicts

- **No conflict with the return-contract ratchet.** The change adds a field to an existing return/push payload; it converts no `break` to `return` and touches no provider's arm count. `scripts/verb-return-contract-baseline.json` ceilings are unaffected.
- **No conflict with the parity or push-routing gates.** No allowlist entry, catalog entry, verb name, or raw `postMessage` count changes. Two `renderMarkdownLive` *senders* are removed from the webview side, which cannot raise any counted total.
- **No verb-schema change.** The request payload is byte-identical; only the reply gains a field, and `verbSchemas.ts` validates requests.
- **One-stream discipline (PRD "Orchestration discipline").** `planning.js` receives two independent edits (`:6282`, `:7632`) — same file, so they serialise into one agent stream. `tickets.js`, `design.js`, `markdownEditor.js` and `sharedUtilityVerbs.ts` are separate files and may proceed in parallel with each other.
- **Follow-up, not a blocker:** the Project-panel browser-host blank-preview defect described in *What is NOT in scope* wants its own plan. This plan does not depend on it, but it inverts this plan's `project.js` decision if it lands.

## Dependencies

- None.

## Adversarial Synthesis

**Risk summary.** The change is small but carries two silent-failure traps that look identical to "the change did not land": the `.md-li-loose` rule must be added where the preview actually lives (`.md-live-preview`, since every existing rule is ID-scoped to the view-mode containers), and the new `markdown` field must be attached to the object `handleRenderMarkdownLive` *pushes*, not only to the one it returns — the webview reads the push. The third risk is over-reach: sweeping `project.js` into a "make them consistent" pass would create the exact divergence this plan removes, and folding in the Project panel's separate browser-host blank-preview defect would change the view mode this plan's `project.js` decision is conditioned on. Mitigations: a source-level assertion per trap, an explicit no-change entry for `project.js` with the grep that proves it, and host-qualified manual checks so a green editor-host pass cannot hide a dead browser-host surface.

## Proposed Changes

### `src/services/sharedUtilityVerbs.ts` — return the markdown alongside the HTML

Additive only. Existing consumers that read `html`/`htmlContent` are untouched. **The field goes on `okRes` — the object passed to `deps.push(...)` — not on the `return` spread.**

Hoist `content` out of the `try` so the error branch can carry it too:

```ts
export async function handleRenderMarkdownLive(
    deps: SharedUtilityVerbDeps,
    msg: any
): Promise<any> {
    // Hoisted: the catch branch below returns this too, so a render failure still
    // hands the caller the image-rewritten source to render client-side.
    let content = msg.content || '';
    try {
        // Tickets edit-preview: resolve the ticket file's directory and rewrite
        // relative image paths to webview URIs (mirrors the view-mode path).
        // Non-ticket editor mounts send no provider/id → no rewrite.
        if (msg.provider && msg.id) {
            const wsRoot = deps.resolveWorkspaceRoot(msg.workspaceRoot) || deps.fallbackWorkspaceRoot || '';
            const ticketFilePath = wsRoot ? await deps.findTicketFilePath(wsRoot, msg.provider, msg.id) : null;
            if (ticketFilePath) {
                content = deps.rewriteLocalImagePaths(content, path.dirname(ticketFilePath));
            }
        }
        const html = await deps.seams().commands.executeCommand<string>('markdown.api.render', content);
        const okRes = {
            type: 'markdownLiveRendered',
            requestId: msg.requestId,
            html: html,
            htmlContent: html,
            // The image-rewritten SOURCE. Callers whose view mode renders through
            // sharedUtils' renderMarkdown re-render from this client-side, so the preview
            // uses the same engine as the view it predicts. The HTML above stays for the
            // Project panel, whose view mode IS markdown.api.render.
            //
            // MUST live on okRes, not only on the `return` spread below: every webview
            // call site reads the PUSH, never the HTTP body. Put it only on the return
            // and all four callers see undefined, fall back to un-rewritten source, and
            // render with broken images — with no error raised anywhere.
            //
            // Also load-bearing off VS Code: `markdown.api.render` is a VS Code built-in,
            // so on the standalone host `html` above is undefined (vscodeShim warns and
            // returns undefined; it does not throw). This field is what keeps the live
            // preview working there at all.
            markdown: content
        };
        deps.push(okRes);
        return { ...okRes, success: true };
    } catch (err) {
        const errRes = {
            type: 'markdownLiveRendered',
            requestId: msg.requestId,
            html: '',
            htmlContent: '',
            markdown: content,
            error: String(err)
        };
        deps.push(errRes);
        return { ...errRes, success: false };
    }
}
```

`DesignPanelProvider.ts:2494` keeps its inline arm unchanged — `design.js` stops calling the verb, and the arm must stay for `DESIGN_VERBS` generation and `verb-engine-headless-seams.test.js:232`.

### `src/webview/markdownEditor.js` — style the class where the preview actually lives

Add to the injected stylesheet, immediately after the existing `.md-live-preview.markdown-body` block (`:125-130`):

```css
/* The panels' `.md-li-loose` rules are ID-scoped to their view-mode preview
   containers (#markdown-preview, #markdown-preview-tickets, …) and do not reach
   `.md-live-preview`. Without this the preview emits the class and renders no gap —
   indistinguishable from the renderer swap not having landed. Same 0.65em as
   planning.html / tickets.html / design.html; keep them in step. */
.md-live-preview .md-li-loose { margin-top: 0.65em; }
```

Living here rather than in three panel stylesheets keeps it with the element it styles and covers every panel that mounts the editor. The Project panel gets the rule too and is unaffected — its preview never emits the class.

### `src/webview/tickets.js:3093` and `src/webview/planning.js:7632` — render the returned markdown

Keep the round trip (image rewriting), change what is rendered and drop the now-unreachable reject path. Both bodies are byte-identical duplicates; apply the same edit to each.

```js
renderPreview: (markdown) => new Promise((resolve) => {
    const requestId = Date.now() + Math.random();
    const handler = (event) => {
        const msg = event.data;
        if (msg.type === 'markdownLiveRendered' && msg.requestId === requestId) {
            window.removeEventListener('message', handler);
            // The round trip's only remaining job is rewriting relative image paths to
            // webview URIs — the RENDER happens here, with the same engine view mode
            // uses (sharedUtils' renderMarkdown), so the preview predicts the saved
            // result instead of offering CommonMark's all-or-nothing list spacing.
            // Falling back to the local source covers an older host that does not send
            // the field, and the standalone host, where markdown.api.render is absent:
            // images do not resolve, the preview still renders. There is no reachable
            // failure mode left, so there is no reject.
            resolve(renderMarkdown(typeof msg.markdown === 'string' ? msg.markdown : markdown));
        }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({
        type: 'renderMarkdownLive',
        requestId,
        content: markdown,
        provider,
        id: task.id,
        workspaceRoot: ticketsWorkspaceRoot
    });
}),
```

Keep `window.removeEventListener('message', handler)` exactly where it is — the browser host mirrors a single push to every panel surface, and that line is what makes the duplicate arrivals harmless.

### `src/webview/planning.js:6282` and `src/webview/design.js:1882` — render locally

Neither sends `provider`/`id`, so no rewrite occurs and the round trip buys nothing — and on the standalone host it returns nothing at all:

```js
// No provider/id is sent here, so the host performs no image-path rewrite and the
// round trip's only product was CommonMark HTML — the wrong engine for this panel,
// and absent entirely off VS Code. Render with the view-mode renderer, in-process.
renderPreview: (markdown) => Promise.resolve(renderMarkdown(markdown)),
```

After this edit `design.js` no longer posts `renderMarkdownLive` anywhere; leave `DesignPanelProvider`'s arm in place regardless (see above).

### `src/webview/project.js:3108` — no change

Leave it posting `renderMarkdownLive` and resolving with `msg.html`. Its view mode is `markdown.api.render` (`project.js:559`, `:606`, `:619`), so this call site is already at parity and changing it would break that. `grep -c 'renderMarkdown(' src/webview/project.js` returns `0` — run it before touching the file, and stop if it does not.

## Verification Plan

### Automated Tests

Per session directive (SKIP TESTS / SKIP COMPILATION), **this pass authors the assertions but does not execute them, and runs no build step**. CI is the gate: `test:contract:rendermarkdown` is already wired at `.github/workflows/integration-tests.yml:198`, and the extended file runs there on push.

Extend `src/test/sharedUtils-renderMarkdown.test.js` (script: `package.json:865`) with source-level assertions — the four switched bodies are webview globals, so reading the sources and asserting on call shape is the practical form:

1. **Engine parity per call site.** Each of the four switched `renderPreview` bodies resolves through `renderMarkdown`, and `project.js`'s resolves through `msg.html`. This is what stops a later "consistency" sweep from converting the fifth.
2. **The field is on the pushed object.** In `sharedUtilityVerbs.ts`, `markdown:` appears inside the `okRes` object literal — the one handed to `deps.push(...)` — not merely in the `return` spread. Assert `html`, `htmlContent` and `markdown` are all present on `okRes`, and that `markdown` is the image-rewritten `content` (not `msg.content`) when `provider`/`id` are supplied. This is the guard on the second silent-failure trap.
3. **The error branch carries the source too.** `errRes` includes `markdown: content`, and `content` is declared outside the `try` so the catch can reach it.
4. **The CSS rule exists where the preview lives.** `markdownEditor.js` contains a `.md-live-preview .md-li-loose` rule whose value matches the `0.65em` used by `planning.html`, `tickets.html` and `design.html`. Guard on the first silent-no-op trap; without it every other check passes while the preview looks unchanged.
5. **`externalizeAnchors` idempotence.** Feed it `renderMarkdown` output containing a link and assert exactly one `target` and one `rel` attribute.
6. **No reject path on the round-tripping sites.** Neither `tickets.js:3093` nor `planning.js:7632` still calls `reject(` inside its `markdownLiveRendered` handler, and both still call `removeEventListener` before resolving.

CI additionally re-runs the existing suites unchanged: `test:contract:tickets-subtasks`, `test:contract:tickets-sidebar-scoping`, `test:contract:verb-engine-tickets`, `test:contract:browser-panel-verb-routing`, `test:contract:panel-runtime-surface`, plus `parity:check` and `verb-returns:check` — all expected green and unmoved, since the verb's shape did not change and only its payload gained a field.

### Manual

7. **The reported workflow (VS Code editor host).** Open a ticket with a flat bullet list, Edit, and insert one blank line mid-list. The preview must space **only** the bullet after that line — not every bullet. Save, and confirm view mode shows the identical single gap. This is the acceptance test; everything else is a non-regression.
8. **The reported workflow (browser host, `npx switchboard`).** Same steps. Before the change the preview reads "Nothing to preview" for any non-empty document; after it, it renders and matches view mode. This is the PRD contract-#6 acceptance check and it cannot be substituted by the editor-host run — the two hosts fail differently.
9. **Tight-list non-regression.** Open two documents whose lists carry no blank lines and confirm the preview is pixel-identical to before on each of Tickets, Planning and Design (editor host).
10. **Images.** In the Tickets editor, with a description referencing a relative image, confirm the image still renders in the preview while typing — this is what the retained round trip buys and the first thing a "just render it locally everywhere" simplification breaks. Then confirm that in the browser host the same document previews with text intact and images unresolved rather than failing outright, which is the deliberate degradation chosen in edge case 6.
11. **Project panel control case — editor host only.** Open a plan/PRD in the Project panel editor and confirm its preview is unchanged, including a loose list rendering CommonMark-style with every item spaced. A change here means `project.js` was swept up. Do not run this in the browser host, where the Project preview is blank before and after for unrelated reasons.
12. **Rebuild first.** The browser panels are served from the installed VSIX's `dist/`, not from `src/` — rebuild and reinstall (or verify in the editor webview) before concluding the change did not land.

---

**Recommendation: Send to Coder** (complexity 5).
