# Fix Remote Control Button Icon in kanban.html

## Goal

The Remote Control toolbar button in `kanban.html` displays the wrong icon. It currently uses `{{ICON_28}}` which maps to `25-1-100 Sci-Fi Flat icons-24.png`. The user wants it to use `icons/25-1-100 Sci-Fi Flat icons-28.png` instead. Because `{{ICON_28}}` is shared by three unrelated UI elements (the remote control button, the Jules button, and the Splitter button), a new dedicated icon token must be introduced for the remote control button to avoid changing the Jules and Splitter icons.

### Problem Analysis & Root Cause

**Root cause:** The icon token system in `KanbanProvider.ts` (lines 7408-7430) maps placeholder strings to icon file URIs. The placeholder `{{ICON_28}}` is misleadingly named — it does NOT map to icon file #28, but to `25-1-100 Sci-Fi Flat icons-24.png` (line 7411). This token is reused in three places in `kanban.html`:

1. **Remote Control button** (line 2494): `<img src="{{ICON_28}}" alt="Remote Control">`
2. **Jules button** (line 3816): `const ICON_JULES = '{{ICON_28}}';`
3. **Splitter button** (line 3817): `const ICON_SPLITTER = '{{ICON_28}}';`

The user wants only the Remote Control button to use icon file #28 (`25-1-100 Sci-Fi Flat icons-28.png`). Simply changing the `{{ICON_28}}` mapping would also change the Jules and Splitter icons, which is not desired. The fix requires a new dedicated token `{{ICON_REMOTE}}` mapped to the correct file, used only by the remote control button.

## Metadata

- **Tags:** kanban, ui, icon, remote-control, toolbar
- **Complexity:** 2/10
- **Files affected:** `src/services/KanbanProvider.ts`, `src/webview/kanban.html`
- **Shipped state:** The current icon mapping has shipped. This is a visual-only change with no config or data migration implications.

## Complexity Audit

### Routine
- Adding one new entry to the `iconMap` in `KanbanProvider.ts`.
- Changing one `src` attribute in `kanban.html` from `{{ICON_28}}` to `{{ICON_REMOTE}}`.

### Complex / Risky
- None. This is a purely cosmetic change with no logic, data, or config impact.

## Edge-Case & Dependency Audit

1. **Shared token safety:** `{{ICON_28}}` is used by Jules (line 3816) and Splitter (line 3817). These must NOT change — they should keep using `{{ICON_28}}` (icon-24.png). Only the remote control button (line 2494) switches to the new token.
2. **Icon file existence:** The target icon file `25-1-100 Sci-Fi Flat icons-28.png` already exists in the `icons/` directory (confirmed: 14,335 bytes, dated Mar 24 08:33). No new asset needs to be added.
3. **Token naming:** The new token `{{ICON_REMOTE}}` follows the existing naming convention used by other semantic tokens like `{{ICON_CHAT}}`, `{{ICON_CLI}}`, `{{ICON_CODE_MAP}}`, etc.
4. **Regex replacement:** The icon replacement loop at line 7431-7433 uses a global regex replace, so the new token will be replaced correctly as long as it's added to the `iconMap`.

## Proposed Changes

### 1. Add new icon token in `src/services/KanbanProvider.ts`

Add a new entry to the `iconMap` object (after line 7411):

```typescript
'{{ICON_REMOTE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),
```

Full context of the edit location:
```typescript
const iconMap: Record<string, string> = {
    '{{ICON_22}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-78.png')).toString(),
    '{{ICON_COLLAPSE_CODERS}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-66 copy.png')).toString(),
    '{{ICON_28}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-24.png')).toString(),
    '{{ICON_REMOTE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),  // NEW
    '{{ICON_53}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
    // ... rest unchanged
```

### 2. Update the Remote Control button in `src/webview/kanban.html`

Change line 2494 from:
```html
<img src="{{ICON_28}}" alt="Remote Control">
```
to:
```html
<img src="{{ICON_REMOTE}}" alt="Remote Control">
```

### 3. Leave Jules and Splitter unchanged

Lines 3816-3817 remain as-is:
```typescript
const ICON_JULES = '{{ICON_28}}';
const ICON_SPLITTER = '{{ICON_28}}'; // Reuses ICON_JULES token; replace with dedicated token if available
```
These continue to use icon-24.png. No change needed.

## Verification Plan

1. **Visual check:** Open the Kanban panel in VS Code. Verify the Remote Control toolbar button (the one with tooltip "Start or stop remote control") now displays the icon from `25-1-100 Sci-Fi Flat icons-28.png`.
2. **Jules/Splitter unchanged:** Verify the Jules and Splitter buttons still display their original icon (icon-24.png) — they should look the same as before.
3. **No console errors:** Open the VS Code Developer Tools console and verify there are no 404 errors for missing icon URIs or unresolved `{{ICON_REMOTE}}` placeholders.
4. **Token resolution:** Inspect the rendered HTML (via Developer Tools → Elements) and confirm the `src` attribute of the remote control button `<img>` is a valid `vscode-webview://` URI pointing to `icons-28.png`.
