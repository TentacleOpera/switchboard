# Fix Remote Control Button Icon in kanban.html

## Goal

The Remote Control toolbar button in `kanban.html` displays the wrong icon. It currently uses `{{ICON_28}}` which maps to `25-1-100 Sci-Fi Flat icons-24.png`. The user wants it to use `icons/25-1-100 Sci-Fi Flat icons-28.png` instead. Because `{{ICON_28}}` is shared by three unrelated UI elements (the remote control button, the Jules button, and the Splitter button), a new dedicated icon token must be introduced for the remote control button to avoid changing the Jules and Splitter icons.

### Problem Analysis & Root Cause

**Root cause:** The icon token system in `KanbanProvider.ts` (lines 7408-7430) maps placeholder strings to icon file URIs. The placeholder `{{ICON_28}}` is misleadingly named — it does NOT map to icon file #28, but to `25-1-100 Sci-Fi Flat icons-24.png` (line 7411). This token is reused in three places in `kanban.html`:

1. **Remote Control button** (line 2494): `<img src="{{ICON_28}}" alt="Remote Control">`
2. **Jules button** (line 3816): `const ICON_JULES = '{{ICON_28}}';`
3. **Splitter button** (line 3817): `const ICON_SPLITTER = '{{ICON_28}}';`

The user wants only the Remote Control button to use icon file #28 (`25-1-100 Sci-Fi Flat icons-28.png`). Simply changing the `{{ICON_28}}` mapping would also change the Jules and Splitter icons, which is not desired. The fix requires a new dedicated token `{{ICON_REMOTE}}` mapped to the correct file, used only by the remote control button.

**Verified facts:**
- `{{ICON_28}}` maps to `icons-24.png` at `KanbanProvider.ts` line 7411 — confirmed.
- The remote control button at `kanban.html` line 2494 is the only static HTML usage of `{{ICON_28}}` for the remote control — confirmed.
- `ICON_JULES` (line 3816) is used dynamically at line 4554; `ICON_SPLITTER` (line 3817) is used dynamically at line 4564 — confirmed. These build HTML for card action menus.
- The remote control button's icon is never swapped dynamically — `applyRemoteControlButtonState()` (line 6819) only toggles the `is-active` CSS class, never touches `src`. So line 2494 is the single source of the remote control icon.
- Target icon file `25-1-100 Sci-Fi Flat icons-28.png` exists in `icons/` (14,335 bytes, dated Mar 24 08:33) — confirmed.
- The regex replacement loop (lines 7431-7433) escapes `{`/`}` and does a global replace across the entire HTML content, including inside `<script>` blocks. This is how JS string literals containing `{{ICON_...}}` placeholders get their URIs.

## Metadata

- **Tags:** ui, bugfix
- **Complexity:** 2/10
- **Files affected:** `src/services/KanbanProvider.ts`, `src/webview/kanban.html`
- **Shipped state:** The current icon mapping has shipped. This is a visual-only change with no config or data migration implications.

## User Review Required

No user review required. This is a purely cosmetic icon fix with no logic, data, or configuration impact. The change is reversible and isolated to a single new token and a single `src` attribute.

## Complexity Audit

### Routine
- Adding one new entry to the `iconMap` in `KanbanProvider.ts` (after line 7411).
- Changing one `src` attribute in `kanban.html` from `{{ICON_28}}` to `{{ICON_REMOTE}}` (line 2494).
- Both edits reuse the existing icon token pattern — no new patterns, no new logic.

### Complex / Risky
- None. This is a purely cosmetic change with no logic, data, or config impact.

## Edge-Case & Dependency Audit

### Race Conditions
- None. The iconMap is built synchronously before the HTML content is served to the webview. No async or concurrent access is involved.

### Security
- None. The new token maps to a static PNG asset bundled with the extension. No user input, no external URIs, no injection surface.

### Side Effects
- **Shared token safety:** `{{ICON_28}}` is used by Jules (line 3816, rendered at line 4554) and Splitter (line 3817, rendered at line 4564). These must NOT change — they keep using `{{ICON_28}}` (icon-24.png). Only the remote control button (line 2494) switches to the new token. Verified: the plan does not touch lines 3816-3817.
- **Global regex replacement:** The replacement loop (lines 7431-7433) replaces all occurrences of each placeholder across the entire HTML, including inside `<script>` blocks. Adding `{{ICON_REMOTE}}` to the iconMap is safe — it will only match the single occurrence at line 2494. No other string in the file contains `{{ICON_REMOTE}}`.

### Dependencies & Conflicts
- **Icon file existence:** The target icon file `25-1-100 Sci-Fi Flat icons-28.png` already exists in the `icons/` directory (confirmed: 14,335 bytes, dated Mar 24 08:33). No new asset needs to be added.
- **Token naming:** The new token `{{ICON_REMOTE}}` follows the existing naming convention used by other semantic tokens like `{{ICON_CHAT}}`, `{{ICON_CLI}}`, `{{ICON_CODE_MAP}}`, etc. No naming conflict — `{{ICON_REMOTE}}` does not appear anywhere else in the codebase.
- **Pre-existing tech debt (out of scope):** The token `{{ICON_28}}` is misleadingly named (maps to icon-24, not icon-28). Renaming it would touch 3 call sites including 2 shipped buttons and is explicitly out of scope. The comment on line 3817 (`// Reuses ICON_JULES token; replace with dedicated token if available`) is a pre-existing TODO, also out of scope.

## Dependencies

- None. This plan has no dependencies on other plans or sessions.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) accidentally changing the Jules/Splitter icons by modifying `{{ICON_28}}` instead of adding a new token — mitigated by introducing `{{ICON_REMOTE}}` and leaving `{{ICON_28}}` untouched; (2) the misleading `{{ICON_28}}` naming remaining as tech debt — accepted as out of scope. Mitigations: the plan makes exactly two edits (one iconMap entry, one `src` attribute) and explicitly preserves lines 3816-3817. No logic, data, or config changes are involved.

## Proposed Changes

### 1. Add new icon token in `src/services/KanbanProvider.ts`

Add a new entry to the `iconMap` object (after line 7411):

```typescript
'{{ICON_REMOTE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),
```

Full context of the edit location (`KanbanProvider.ts` lines 7408-7412):
```typescript
const iconMap: Record<string, string> = {
    '{{ICON_22}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-78.png')).toString(),
    '{{ICON_COLLAPSE_CODERS}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-66 copy.png')).toString(),
    '{{ICON_28}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-24.png')).toString(),
    '{{ICON_REMOTE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),  // NEW
    '{{ICON_53}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
    // ... rest unchanged
```

- **Context:** The iconMap is a flat dictionary of placeholder-to-URI mappings. Adding a new key is a pure additive change with no effect on existing entries.
- **Logic:** The regex replacement loop (lines 7431-7433) iterates over all entries and does a global replace. The new entry will be picked up automatically.
- **Implementation:** Insert the new line immediately after line 7411 (the `{{ICON_28}}` entry).
- **Edge Cases:** None. The token `{{ICON_REMOTE}}` is unique in the codebase.

### 2. Update the Remote Control button in `src/webview/kanban.html`

Change line 2494 from:
```html
<img src="{{ICON_28}}" alt="Remote Control">
```
to:
```html
<img src="{{ICON_REMOTE}}" alt="Remote Control">
```

- **Context:** This is the static HTML for the remote control toolbar button (`id="btn-remote-control"`). The button's icon is never swapped dynamically — `applyRemoteControlButtonState()` (line 6819) only toggles the `is-active` CSS class.
- **Logic:** After the regex replacement runs, `{{ICON_REMOTE}}` will be replaced with the webview URI for `icons-28.png`.
- **Implementation:** Replace the single `src` attribute value on line 2494.
- **Edge Cases:** None. This is the only occurrence of `{{ICON_REMOTE}}` in the file.

### 3. Leave Jules and Splitter unchanged

Lines 3816-3817 remain as-is:
```typescript
const ICON_JULES = '{{ICON_28}}';
const ICON_SPLITTER = '{{ICON_28}}'; // Reuses ICON_JULES token; replace with dedicated token if available
```

These continue to use icon-24.png (via `{{ICON_28}}`). The JS string literals are replaced by the regex loop, so `ICON_JULES` and `ICON_SPLITTER` resolve to the icon-24.png URI at runtime. No change needed.

## Verification Plan

### Automated Tests

No automated tests required. This is a visual-only icon change with no logic to test. Per session directives, compilation and automated tests are skipped — the user will run the test suite separately.

### Manual Verification

1. **Visual check:** Open the Kanban panel in VS Code. Verify the Remote Control toolbar button (tooltip "Start or stop remote control") now displays the icon from `25-1-100 Sci-Fi Flat icons-28.png`.
2. **Jules/Splitter unchanged:** Verify the Jules and Splitter buttons still display their original icon (icon-24.png) — they should look the same as before.
3. **No console errors:** Open the VS Code Developer Tools console and verify there are no 404 errors for missing icon URIs or unresolved `{{ICON_REMOTE}}` placeholders.
4. **Token resolution:** Inspect the rendered HTML (via Developer Tools → Elements) and confirm the `src` attribute of the remote control button `<img>` is a valid `vscode-webview://` URI pointing to `icons-28.png`.

---

**Recommendation:** Complexity is 2/10 → **Send to Intern**. This is a trivial two-line change with no logic, no data migration, and no risk to existing functionality.
