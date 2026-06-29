# Use Timed Auto-Vanishing Notifications for Webview Link/Copy Buttons

## Goal

Replace the persistent `vscode.window.showInformationMessage(...)` toasts triggered by the various link/copy buttons in the HTML webviews (e.g. image links in `design.html`, document/folder link buttons in both `design.html` and `planning.html`) with the extension's existing `showTemporaryNotification` utility so the toasts auto-vanish after a short timeout instead of lingering in the notification area until manually dismissed.

### Problem
When the user clicks the various "Link" / "Copy Link" buttons in the HTML webviews (for example the image link buttons in `design.html`), the resulting VS Code toast appears in the notification area and stays there forever — it never auto-dismisses. Other toasts in this extension (e.g. ClickUp task creation, database migration, plan claim, terminal registration) use a timed, auto-vanishing format. The link/copy toasts are inconsistent with that established UX.

### Root Cause
**Investigation finding**: The extension ships a dedicated utility, `src/utils/showTemporaryNotification.ts`, that wraps `vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, ... })` around a `setTimeout` so the notification disappears after `durationMs` (default 2500ms; `TaskViewerProvider` overrides to 1000ms). This utility is used extensively in `extension.ts` (13 call sites) and `TaskViewerProvider.ts` (36 call sites) — those are the "timed vanishing toasts" the user is comparing against.

However, the two providers that back the design and planning webviews — `DesignPanelProvider.ts` and `PlanningPanelProvider.ts` — do **not** import or use `showTemporaryNotification`. Their link/copy handlers call the raw `vscode.window.showInformationMessage(...)` API, which produces a standard VS Code notification that persists in the notification center until the user clicks it away. That is the source of the "stays in the left forever" behaviour.

The affected call sites (confirmed by investigation):

**`DesignPanelProvider.ts`:**
- Line 1605: `copyClaudeImportPrompt` → `'Copied Claude import prompt to clipboard.'`
- Line 1620: `linkToDocument` → `'Copied document path to clipboard: ${linkRef}'`
- Line 3255: `_handleLinkToFolder` → `'Folder path copied to clipboard: ${resolvedFolder}'`
- Line 2295: design-tokens download → `'Downloaded design tokens to ...'`
- Line 2855: stitch download → `'Downloaded ${safeFilename} to ...'`
- Line 1660: `stitchSaveApiKey` → `'Stitch API Key saved successfully.'`
- Line 1684: `stitchSaveAuthConfig` → `'Stitch Authentication settings saved successfully.'`

**`PlanningPanelProvider.ts`:**
- Line 6342: tuning-extract "no plans found" → `'No plans with adversarial review sections found.'` *(added during improve-plan review — missed by the original call-site enumeration)*
- Line 6582: `_handleLinkToDocument` → `'Document path copied to clipboard: ${docRef}'`
- Line 6646: `_handleLinkToFolder` → `'Folder path copied to clipboard: ${resolvedFolder}'`
- Line 5442: diagram prompt copy → `'Diagram prompt copied to clipboard'`
- Line 5499: refine prompt copy → `'Refine prompt copied to clipboard'`
- Line 5554: refine-epic prompt copy → `'Refine-epic prompt copied to clipboard. Paste it into your agent.'`
- Line 6371: tuning extract prompt copy → `'Tuning extract prompt copied to clipboard. Paste it into your agent chat.'`
- Line 6380: tuning governance prompt copy → `'Tuning governance prompt copied to clipboard. Paste it into your agent chat.'`

### Background
- `src/utils/showTemporaryNotification.ts` (lines 1-14): the utility. Signature: `showTemporaryNotification(message: string, durationMs: number = 2500): void`.
- `extension.ts` line 39: `import { showTemporaryNotification } from './utils/showTemporaryNotification';` — the canonical import path.
- `TaskViewerProvider.ts` line 10232: `private _showTemporaryNotification(message: string, durationMs: number = 1000): void` — a private wrapper that calls the shared utility with a 1000ms default. This is the precedent for a provider-local wrapper.
- `DesignPanelProvider.ts` and `PlanningPanelProvider.ts` have **no** import of `showTemporaryNotification` (confirmed via grep).
- The error-path toasts (`showErrorMessage` for failures such as line 3257, 6584) should remain as persistent `showErrorMessage` calls — errors need to stay visible so the user can read them. Only the success/informational toasts should become temporary.

## Metadata
- **Tags:** [ui, ux, feature]
- **Complexity:** 4

## User Review Required
No — this aligns the link/copy toasts with the extension's existing auto-vanishing notification convention. No behavioural change to the underlying clipboard/link logic.

## Complexity Audit

### Routine
- Add `import { showTemporaryNotification } from '../utils/showTemporaryNotification';` to both `DesignPanelProvider.ts` (after line 5, the `vscode` import) and `PlanningPanelProvider.ts` (after line 1, the `vscode` import).
- Replace each success-path `vscode.window.showInformationMessage(...)` call in the link/copy/prompt handlers with `showTemporaryNotification(...)`.
- Leave all `vscode.window.showErrorMessage(...)` calls untouched (errors must persist).

### Complex / Risky
- None — the utility is already battle-tested across 49+ call sites in the extension. This is a mechanical swap of one notification API for another in two files.
- **Clarification (not new scope):** The implementer MUST re-grep `showInformationMessage` in both files immediately before editing — line numbers in this plan were verified at planning time but will drift as the files evolve. The plan author's own grep initially missed one call site (PlanningPanelProvider line 6342, since added), so a fresh grep is mandatory to catch any further drift.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — `showTemporaryNotification` is fire-and-forget; multiple rapid link clicks will stack independent `withProgress` notifications that each self-dismiss. This matches the existing behaviour in `TaskViewerProvider` where rapid actions (e.g. batch claim) stack temporary toasts.
- **Security:** None — no change to message content or clipboard handling.
- **Side Effects:** The success toasts will now vanish after ~2.5s instead of persisting. This is the desired behaviour and matches the rest of the extension. Users who previously relied on the persistent toast to copy/read a long path from the notification will no longer be able to — but the path is already on the clipboard, so the toast is purely confirmatory. **Visual note:** `showTemporaryNotification` uses `vscode.window.withProgress`, which renders a progress-spinner notification rather than a plain info toast. This is the established extension-wide convention (49+ existing call sites including the `TaskViewerProvider` toasts the user referenced as the "good" pattern), so matching it is correct — but the implementer should be aware the toast will show a spinner, not just text.
- **Dependencies & Conflicts:**
  1. **Import path**: `DesignPanelProvider.ts` and `PlanningPanelProvider.ts` live in `src/services/`, so the import is `'../utils/showTemporaryNotification'`. Confirmed `extension.ts` (in `src/`) uses `'./utils/showTemporaryNotification'` — the relative path is correct.
  2. **Duration choice**: The shared utility defaults to 2500ms; `TaskViewerProvider` uses 1000ms via a private wrapper. The link/copy success messages are short confirmations ("Copied document path to clipboard: ..."), so the 2500ms default is appropriate. A path string can be long, but 2500ms is enough to register the confirmation. No wrapper needed — call the shared utility directly. **Rationale for 2500ms over 1000ms:** `TaskViewerProvider`'s 1000ms override targets high-frequency batch actions; the link/copy/download toasts here are lower-frequency and some carry file paths the user may want to glance at, so the longer default is the safer uniform choice.
  3. **Error toasts preserved**: The `showErrorMessage` calls in the catch blocks (e.g. `DesignPanelProvider.ts` lines 1644, 1662, 1686, 2297, 2642, 2865, 3257; `PlanningPanelProvider.ts` line 6584) must remain as persistent error notifications. Only `showInformationMessage` success calls are converted.
  4. **Non-link informational toasts**: The `stitchSaveApiKey` (line 1660), `stitchSaveAuthConfig` (line 1684), design-tokens download (line 2295), and stitch download (line 2855) success messages in `DesignPanelProvider.ts` are also persistent `showInformationMessage` calls. They are not strictly "link buttons" but they suffer the same inconsistency. Converting them in the same pass keeps the provider's notification UX uniform. The diagram/refine/tuning prompt-copy toasts in `PlanningPanelProvider.ts` (lines 5442, 5499, 5554, 6371, 6380) are direct copy-to-clipboard confirmations — same class of UX inconsistency, same fix.
  5. **Missed "no results" toast (added during review)**: `PlanningPanelProvider.ts` line 6342 — `vscode.window.showInformationMessage('No plans with adversarial review sections found.')` — sits in the same `runTuningExtract` case block as the line 6371 copy-prompt toast and suffers the identical linger-forever defect. It is a transient action result, not an error, so it should be converted alongside its sibling. This was missed in the original plan's call-site enumeration and is now included below.

## Dependencies
- None — `showTemporaryNotification` already exists and is exported from `src/utils/showTemporaryNotification.ts`.

## Adversarial Synthesis

Key risks: (1) The original plan's call-site grep missed one `showInformationMessage` (PlanningPanelProvider line 6342, since added) — the implementer must re-grep before editing since line numbers drift. (2) `showTemporaryNotification` renders a `withProgress` spinner notification, visually distinct from a plain info toast — but this is the established extension-wide convention the user explicitly referenced as the desired pattern. (3) Converting an error toast by mistake — mitigated by an explicit allowlist: only the `showInformationMessage` calls listed in Proposed Changes are touched; every `showErrorMessage` remains. Mitigations: fresh grep before editing, 2500ms uniform duration (longer than `TaskViewerProvider`'s 1000ms but appropriate for path-bearing confirmations), and the expanded scope (save/download toasts) is retained because all are pure success confirmations with no action buttons. No research needed.

## Proposed Changes

### File 1: `src/services/DesignPanelProvider.ts`

**1a. Add the import** (after line 5, the `import * as vscode from 'vscode';` line, in the existing import block):
```ts
import { showTemporaryNotification } from '../utils/showTemporaryNotification';
```

**1b. `copyClaudeImportPrompt` handler (line 1605):**
```ts
// Before:
vscode.window.showInformationMessage('Copied Claude import prompt to clipboard.');
// After:
showTemporaryNotification('Copied Claude import prompt to clipboard.');
```

**1c. `linkToDocument` handler (line 1620):**
```ts
// Before:
vscode.window.showInformationMessage(`Copied document path to clipboard: ${linkRef}`);
// After:
showTemporaryNotification(`Copied document path to clipboard: ${linkRef}`);
```

**1d. `_handleLinkToFolder` success (line 3255):**
```ts
// Before:
vscode.window.showInformationMessage(`Folder path copied to clipboard: ${resolvedFolder}`);
// After:
showTemporaryNotification(`Folder path copied to clipboard: ${resolvedFolder}`);
```
(Line 3257 `showErrorMessage` stays unchanged.)

**1e. `stitchSaveApiKey` success (line 1660):**
```ts
// Before:
vscode.window.showInformationMessage('Stitch API Key saved successfully.');
// After:
showTemporaryNotification('Stitch API Key saved successfully.');
```
(Line 1662 `showErrorMessage` stays unchanged.)

**1f. `stitchSaveAuthConfig` success (line 1684):**
```ts
// Before:
vscode.window.showInformationMessage('Stitch Authentication settings saved successfully.');
// After:
showTemporaryNotification('Stitch Authentication settings saved successfully.');
```
(Line 1686 `showErrorMessage` stays unchanged.)

**1g. Design-tokens download success (line 2295):**
```ts
// Before:
vscode.window.showInformationMessage(`Downloaded design tokens to ${path.basename(outputDir)}/design-tokens.json`);
// After:
showTemporaryNotification(`Downloaded design tokens to ${path.basename(outputDir)}/design-tokens.json`);
```
(Line 2297 `showErrorMessage` stays unchanged.)

**1h. Stitch download success (line 2855):**
```ts
// Before:
vscode.window.showInformationMessage(`Downloaded ${safeFilename} to ${path.basename(outputDir)}/`);
// After:
showTemporaryNotification(`Downloaded ${safeFilename} to ${path.basename(outputDir)}/`);
```
(Line 2865 `showErrorMessage` stays unchanged.)

**Note**: The `serveAndOpenHtml` failure at line 1644 (`showErrorMessage`) is an error path — leave it as `showErrorMessage`.

### File 2: `src/services/PlanningPanelProvider.ts`

**2a. Add the import** (after line 1, the `import * as vscode from 'vscode';` line, in the existing import block):
```ts
import { showTemporaryNotification } from '../utils/showTemporaryNotification';
```

**2b. Tuning-extract "no plans found" (line 6342) — *added during review*:**
```ts
// Before:
vscode.window.showInformationMessage('No plans with adversarial review sections found.');
// After:
showTemporaryNotification('No plans with adversarial review sections found.');
```

**2c. `_handleLinkToDocument` success (line 6582):**
```ts
// Before:
vscode.window.showInformationMessage(`Document path copied to clipboard: ${docRef}`);
// After:
showTemporaryNotification(`Document path copied to clipboard: ${docRef}`);
```
(Line 6584 `showErrorMessage` stays unchanged.)

**2d. `_handleLinkToFolder` success (line 6646):**
```ts
// Before:
vscode.window.showInformationMessage(`Folder path copied to clipboard: ${resolvedFolder}`);
// After:
showTemporaryNotification(`Folder path copied to clipboard: ${resolvedFolder}`);
```

**2e. Diagram prompt copy (line 5442):**
```ts
// Before:
vscode.window.showInformationMessage('Diagram prompt copied to clipboard');
// After:
showTemporaryNotification('Diagram prompt copied to clipboard');
```

**2f. Refine prompt copy (line 5499):**
```ts
// Before:
vscode.window.showInformationMessage('Refine prompt copied to clipboard');
// After:
showTemporaryNotification('Refine prompt copied to clipboard');
```

**2g. Refine-epic prompt copy (line 5554):**
```ts
// Before:
vscode.window.showInformationMessage('Refine-epic prompt copied to clipboard. Paste it into your agent.');
// After:
showTemporaryNotification('Refine-epic prompt copied to clipboard. Paste it into your agent.');
```

**2h. Tuning extract prompt copy (line 6371):**
```ts
// Before:
vscode.window.showInformationMessage('Tuning extract prompt copied to clipboard. Paste it into your agent chat.');
// After:
showTemporaryNotification('Tuning extract prompt copied to clipboard. Paste it into your agent chat.');
```

**2i. Tuning governance prompt copy (line 6380):**
```ts
// Before:
vscode.window.showInformationMessage('Tuning governance prompt copied to clipboard. Paste it into your agent chat.');
// After:
showTemporaryNotification('Tuning governance prompt copied to clipboard. Paste it into your agent chat.');
```

## Verification Plan

### Automated Tests
- None for this session (test suite will be run separately by the user). Compilation is skipped per session directive — the implementer should still re-grep `showInformationMessage` in both files before editing to catch line-number drift.

1. **Design panel — Claude import prompt copy**: Open the design panel, trigger the "Copy Claude import prompt" action. Confirm the "Copied Claude import prompt to clipboard" toast auto-vanishes within ~2.5s instead of persisting.
2. **Design panel — document link**: In the Design System tab, click a document's "Link" button. Confirm the "Copied document path to clipboard" toast auto-vanishes.
3. **Design panel — folder link**: Click a folder "Link" button. Confirm the "Folder path copied to clipboard" toast auto-vanishes.
4. **Design panel — Stitch API key / auth save**: Save a Stitch API key and auth config. Confirm both success toasts auto-vanish.
5. **Design panel — design-tokens & stitch download**: Trigger a design-tokens download and a stitch download. Confirm both success toasts auto-vanish.
6. **Design panel — error path**: Point a link button at a missing folder/path to trigger the error branch. Confirm the error toast still persists (not auto-vanished) — errors must remain visible.
7. **Planning panel — document & folder links**: Repeat steps 2-3 in the planning panel to confirm both `_handleLinkToDocument` and `_handleLinkToFolder` success toasts auto-vanish.
8. **Planning panel — prompt copies**: Trigger a "Copy Refine prompt" / "Copy Diagram prompt" / "Copy Refine-epic prompt" action. Confirm each confirmation toast auto-vanishes.
9. **Planning panel — tuning extract "no plans found"**: With no plans containing adversarial review sections, trigger the tuning extract action. Confirm the "No plans with adversarial review sections found." toast auto-vanishes (this is the call site added during review).
10. **Planning panel — tuning extract/governance prompt copy**: Trigger tuning extract and governance prompt copies. Confirm both confirmation toasts auto-vanish.
11. **Rapid-click stacking**: Click a link button several times quickly. Confirm multiple temporary toasts stack and each self-dismisses independently (matches existing `TaskViewerProvider` behaviour).

---

**Recommendation:** Complexity 4 → **Send to Coder**. This is a mechanical swap across 2 files and 16 call sites, but the original plan's own grep missed one call site — a fresh grep and careful per-site verification are warranted, which makes it a Coder task rather than an Intern one.
