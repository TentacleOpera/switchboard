# Copy-Link Buttons Should Produce Agent-Safe Paths (Prepend `@`)

## Goal

The **Copy Link** buttons in `design.html`, `planning.html`, and `project.html` copy an absolute filesystem path that begins with `/` (e.g. `/Users/patrickvuleta/Documents/GitHub/patrickwork/docs/amplitude-dashboard-overview.md`). Pasting that into an agent chat or a terminal triggers an error because a leading `/` reads as a root path / command. The copied value should be an agent-safe file reference (prefixed with `@`), matching the `@/Users/...` convention already used throughout Switchboard plans.

### Problem Analysis

Five independent copy paths all write a raw absolute path to the clipboard:

1. **Planning Kanban "Copy Link"** — [planning.js:4880](src/webview/planning.js#L4880): `navigator.clipboard.writeText(planFile)` where `planFile` is an absolute path.
2. **Project Kanban "Copy Link"** — [project.js:764](src/webview/project.js#L764): `navigator.clipboard.writeText(path)`.
3. **Project Insights "Copy Link"** — [project.js:562-564](src/webview/project.js#L562) builds `${_tuningSelectedWorkspaceRoot}/.switchboard/insights/${_tuningSelectedInsight}` and posts `copyInsightLink`; the provider writes it verbatim at [PlanningPanelProvider.ts:5350](src/services/PlanningPanelProvider.ts#L5350): `await vscode.env.clipboard.writeText(link)`. *(Added during improve-plan: original plan missed this site — same bug, same panel family, same button label.)*
4. **Design panel "Copy Link" (HTML Previews / Images / Stitch assets)** — routed through the `linkToDocument` message handled in [DesignPanelProvider.ts:1529-1540](src/services/DesignPanelProvider.ts#L1529): `vscode.env.clipboard.writeText(linkPath)`. All Design-tab Copy Link buttons (HTML, Images, Stitch PNG) funnel through this single handler via `copyStitchAssetLink` ([design.js:1563](src/webview/design.js#L1563)) and the `btn-copy-link-html` / `btn-copy-link-images` wiring ([design.js:862-872](src/webview/design.js#L862), [design.js:896-907](src/webview/design.js#L896)).
5. **Planning Local/Online Docs "Copy Link"** — routed through `linkToDocument` → `_handleLinkToDocument` in [PlanningPanelProvider.ts:5460-5519](src/services/PlanningPanelProvider.ts#L5460): `vscode.env.clipboard.writeText(docPath)`.

All five emit a bare absolute path with a leading `/`.

### Root Cause

The clipboard write uses the resolved absolute path verbatim. Agent chats and terminals interpret a leading `/` as the start of a path/command, so the pasted reference errors instead of being recognized as a file mention. Switchboard's own plan format references files as `@/absolute/path`, which agents resolve correctly.

The defect recurs piecemeal because the prefix logic is duplicated across two webview JS files and two TS providers. The empirical proof: the original plan enumerated four sites and missed the fifth (`copyInsightLink`). The structural fix is a single `toAgentRef(absPath)` helper used by every copy site, so the bug cannot reappear one site at a time.

## Metadata

**Complexity:** 3
**Tags:** frontend, backend, ux, bugfix

## User Review Required

Yes — confirm that (a) the Insights-tab "Copy Link" button (site #3) is in scope (it is a file path under `.switchboard/insights/`), and (b) folder-link copy (`_handleLinkToFolder`, which copies a directory path) is intentionally **out of scope** for this plan (see Edge-Case audit). No code changes until these are confirmed.

## Complexity Audit

### Routine
- Prepending a constant `@` prefix at five well-isolated copy sites.
- Adding a tiny `toAgentRef(absPath)` helper to `sharedUtils.js` (already globally loaded in all three webviews) and a matching private method/inline prefix in the two TS providers.
- Updating two TS-provider toast messages to echo the `@`-prefixed value.

### Complex / Risky
- Must apply consistently across **all five** copy sites so behavior is uniform; missing one re-introduces the bug. The "keeps breaking" risk is duplication across two webview JS files and two TS providers — mitigated by routing all webview sites through `toAgentRef` in `sharedUtils.js`.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — each copy is a synchronous single clipboard write triggered by a user click.
- **Security:** None — the path is the same; only a prefix character is added. No path traversal or disclosure change.
- **Side Effects:** Any consumer that previously pasted these paths into a non-agent context (e.g. Finder) now sees a leading `@`. This is acceptable; the buttons are explicitly for agent/terminal hand-off. TS-provider toast messages echo the `@`-prefixed value for honesty; webview buttons keep their existing "Copied" affordance (no path echo) — consistent with current UX.
- **Dependencies & Conflicts:** Windows paths (`C:\...`) do not start with `/`, but `@C:\...` is still a valid agent reference and avoids the leading-slash issue on POSIX; applying `@` uniformly is safe on all platforms. `toAgentRef` must be idempotent against already-prefixed inputs (guard: return as-is if the string already starts with `@`).
- **Out of scope (explicit decision):** `_handleLinkToFolder` ([PlanningPanelProvider.ts:5564](src/services/PlanningPanelProvider.ts#L5564)) copies a bare folder path with a leading `/`. Folder links have a different intent (often pasted into Finder / `cd`) and the plan's Goal is explicitly *file* references. Recorded here as a conscious exclusion; a separate plan can address folder refs if needed.
- **Observation (not in scope):** [project.js:573](src/webview/project.js#L573) uses `confirm('Delete this insight?')` — a confirm gate that is a silent no-op in VS Code webviews (per `CLAUDE.md`). Unrelated to this plan; flagged for a separate fix.

## Dependencies

None — no other plan or session is required to complete this work.

## Adversarial Synthesis

Key risks: (1) the original plan missed a fifth copy site (`copyInsightLink`), proving the piecemeal-duplication risk is real; (2) tag hygiene was wrong (`clipboard`/`dx` not in the allowed vocabulary); (3) the "optional" helper is the only structural defense against site #6 and should be the primary path, not optional. Mitigations: route all five sites through a single `toAgentRef` helper in `sharedUtils.js` (webviews) and a matching prefix in the TS providers; fix tags to `frontend, backend, ux, bugfix`; explicitly record folder-link copy as out of scope.

## Proposed Changes

### 0. `src/webview/sharedUtils.js` — add `toAgentRef` helper (primary source of truth)
Add near the top of `sharedUtils.js` (which is injected globally into all three webviews via `{{SHARED_UTILS_URI}}` — confirmed in `DesignPanelProvider.ts:333-336` and `PlanningPanelProvider.ts:384-387,1265-1268`):
```js
// Convert an absolute filesystem path into an agent-safe file reference.
// Idempotent: returns the input unchanged if it already starts with '@'.
function toAgentRef(absPath) {
    if (!absPath) return absPath;
    return absPath.startsWith('@') ? absPath : '@' + absPath;
}
```
All webview copy sites below call `toAgentRef(...)` instead of inlining `'@' + ...`.

### 1. `src/webview/planning.js` — Kanban Copy Link
At [planning.js:4880](src/webview/planning.js#L4880):
```js
navigator.clipboard.writeText(toAgentRef(planFile)).then(() => {
    const originalText = copyLinkBtn.textContent;
    copyLinkBtn.textContent = 'Copied';
    setTimeout(() => { copyLinkBtn.textContent = originalText; }, 2000);
}).catch(err => { /* ...unchanged... */ });
```

### 2. `src/webview/project.js` — Kanban Copy Link
At [project.js:764](src/webview/project.js#L764):
```js
navigator.clipboard.writeText(toAgentRef(path)).then(() => {
    copyLinkBtn.textContent = 'Copied';
    setTimeout(() => copyLinkBtn.textContent = 'Copy Link', 2000);
});
```

### 3. `src/webview/project.js` + `src/services/PlanningPanelProvider.ts` — Insights Copy Link
Two equivalent options; pick **one** (recommended: provider-side, for uniformity with the other TS-provider fixes):

**Option A (provider-side, recommended):** At [PlanningPanelProvider.ts:5347-5353](src/services/PlanningPanelProvider.ts#L5347), prefix at the write site:
```ts
case 'copyInsightLink': {
    const rawLink = String(msg.link || '');
    if (rawLink) {
        const linkRef = rawLink.startsWith('@') ? rawLink : '@' + rawLink;
        await vscode.env.clipboard.writeText(linkRef);
        this._projectPanel?.webview.postMessage({ type: 'insightLinkCopied' });
    }
    break;
}
```

**Option B (webview-side):** At [project.js:563](src/webview/project.js#L563), construct with `@`:
```js
const link = toAgentRef(`${_tuningSelectedWorkspaceRoot}/.switchboard/insights/${_tuningSelectedInsight}`);
```

### 4. `src/services/DesignPanelProvider.ts` — linkToDocument
At [DesignPanelProvider.ts:1538-1539](src/services/DesignPanelProvider.ts#L1538):
```ts
const linkRef = linkPath.startsWith('@') ? linkPath : '@' + linkPath;
vscode.env.clipboard.writeText(linkRef);
vscode.window.showInformationMessage(`Copied document path to clipboard: ${linkRef}`);
```
This single change covers all Design-tab Copy Link buttons (HTML Previews, Images, Stitch PNG) because they all route through this handler.

### 5. `src/services/PlanningPanelProvider.ts` — _handleLinkToDocument
At [PlanningPanelProvider.ts:5514-5515](src/services/PlanningPanelProvider.ts#L5514):
```ts
const docRef = docPath.startsWith('@') ? docPath : '@' + docPath;
await vscode.env.clipboard.writeText(docRef);
vscode.window.showInformationMessage(`Document path copied to clipboard: ${docRef}`);
```

> **TS-provider helper (optional refinement):** If preferred over inline guards, add a private `private toAgentRef(absPath: string): string { return absPath.startsWith('@') ? absPath : '@' + absPath; }` to both `DesignPanelProvider` and `PlanningPanelProvider` and call it in sites #4 and #5. Functionally identical to the inline guard; choose whichever matches house style.

## Verification Plan

> Session directives: **skip compilation** (do NOT run `npm run compile` / webpack) and **skip automated tests** (unit / integration / e2e). The user will run build and tests separately.

### Automated Tests
- Deferred to the user. A regression assertion extending `src/test/planning-copy-labels-regression.test.js` (or a new test) verifying the webview copy handlers prepend `@` is recommended but **out of scope for this session** per the skip-tests directive.

### Manual Verification (after the user rebuilds)
1. Planning → Kanban tab: click **Copy Link** on a plan card; paste into a terminal — confirm it reads `@/Users/.../plan.md` and does not error.
2. Project panel → Kanban tab: same check on a plan card.
3. Project panel → Insights tab: select an insight, click **Copy Link**; confirm clipboard reads `@/Users/.../.switchboard/insights/<file>` and the button flips to "Copied!".
4. Design panel → HTML Previews / Images: click **Copy Link**; confirm clipboard and toast both show the `@`-prefixed path.
5. Design panel → Stitch tab: click **Copy Link** on a screen PNG; confirm `@`-prefixed path.
6. Planning → Local Docs / Online Docs: click the link/copy action; confirm `@`-prefixed path and toast.
7. Sanity: confirm no copy site regresses to a bare `/...` path (grep `clipboard.writeText` after edits to confirm every file-path write site is prefixed).

## Recommendation

Complexity is 3 (routine, but the missed-site discovery shows it needs an exhaustive, careful pass). **Send to Intern.**
