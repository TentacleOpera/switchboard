# Plan: Fix Table Icon Shows Calendar Emoji

## Problem
The "Insert Table" button in the markdown editor toolbar shows a calendar emoji (📅) instead of a table icon.

## Root Cause
- `markdownEditor.js` line ~417: `createBtn('📅', 'Insert Table', ...)` — the emoji 📅 is a calendar, not a table.

## Fix
Replace the calendar emoji with a table-appropriate icon.

### Files to Change
1. **`src/webview/markdownEditor.js`** — `createBtn` call for table insertion (~line 417)

### Options
| Icon | Description |
|------|-------------|
| `⊞` | Grid/square plus |
| `▦` | Grid pattern |
| `▭` | Rectangle (table-like) |
| `≡` | Table rows |
| `⊞` | Best choice — visually represents a grid/table |

**Recommended**: `⊞` (U+229E) — clearly represents a grid structure.

### Change
```js
// Before
createBtn('📅', 'Insert Table', ...)

// After
createBtn('⊞', 'Insert Table', ...)
```

## Verification
- Open markdown editor → verify toolbar shows a grid/table icon, not a calendar.
- Click the button → verify table template is inserted.
