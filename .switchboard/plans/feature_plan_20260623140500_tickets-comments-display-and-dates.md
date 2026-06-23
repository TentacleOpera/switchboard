# Fix Tickets Tab Comments: Render Real Text/Author and Format Dates Readably

## Goal (Problem analysis + Root Cause with cited file:line)

In `planning.html`'s Tickets tab, the ticket **detail panel** (the read-only / edit-mode view that shows a ticket's description, then a "Comments" section) does not display the actual comment text or author for ClickUp tickets, and shows dates in an unreadable form. This is a separate UI from the "Comment Manager" overlay (`#tickets-comment-manager`, rendered by `renderThreadHtml`), which is wired correctly. The bug lives in the **inline detail renderers**.

There are **three** inline comment renderers in `src/webview/planning.js`, all emitting `.tickets-comment-item` markup and all reading the field names `comment.user?.name`, `comment.body`, and `comment.createdAt`:

1. Edit-mode renderer — `src/webview/planning.js:7190-7196` (inside `enterTicketsEditMode`, serves BOTH providers; `issue` is Linear or ClickUp per `:7162`).
2. Linear detail renderer — `src/webview/planning.js:7682-7688`.
3. ClickUp detail renderer — `src/webview/planning.js:8159-8165` (inside `renderTicketsClickUpTaskDetail`, `:8053`).

### Root cause 1 — ClickUp comments render blank author + blank body

The data these renderers consume comes from the detail-load path, NOT the comment manager:

- ClickUp: `getTaskDetails` returns comments shaped `{ id, comment_text, user: { username, email }, date }` (`src/services/ClickUpSyncService.ts:1199` and `:1238-1250`). The backend then passes each through `_mapClickUpComment`, which **preserves that same shape** — `{ id, comment_text, user, date }` (`src/services/TaskViewerProvider.ts:5188-5195`) — and posts it as `clickupTaskDetailsLoaded.comments` (`src/services/TaskViewerProvider.ts:8510`). The webview stores it as `selectedClickUpIssue.comments` (`src/webview/planning.js:4490` / `:4627`).
- But the ClickUp renderer reads `comment.user?.name` (the field is `user.username`), `comment.body` (the field is `comment_text`), and `comment.createdAt` (the field is `date`) — `src/webview/planning.js:8161-8163`. **Every field name is wrong for the ClickUp shape**, so author resolves to `'Unknown'`, body renders empty, and the date renders empty. The same mismatch breaks ClickUp in the shared edit-mode renderer (`:7192-7194`).

Linear comments happen to render because `getComments` returns `LinearComment` = `{ id, body, user: { id, name, email }, createdAt, parentId, mentions }` (`src/services/LinearSyncService.ts:63-70`, `:935-966`) which matches the field names the renderer already uses. So **Linear bodies/authors are fine; ClickUp ones are broken.**

### Root cause 2 — dates are not formatted readably (both providers)

Every inline renderer formats the date as `comment.createdAt ? comment.createdAt.slice(0, 10) : ''` (`:7193`, `:7685`, `:8162`):

- Linear: `createdAt` is an ISO string, so `.slice(0,10)` yields a bare `YYYY-MM-DD` with no time — crude, and produces `''` for ClickUp because ClickUp has no `createdAt`.
- ClickUp: `date` is an **epoch-milliseconds string** (e.g. `"1718000000000"`), confirmed by the backend's own dual-format handling in `_buildCommentsSection` (`src/services/TaskViewerProvider.ts:4816-4818`: `Number(c.date)` first, else `Date.parse`). A raw `.slice(0,10)` of an epoch string would show the first 10 digits of a number, not a date.

The existing helper `formatCommentDate` (`src/webview/planning.js:604-613`) used by the Comment Manager is **also wrong for ClickUp**: it calls `new Date(dateStr)` directly. `new Date("1718000000000")` is `Invalid Date` (a pure-digit string is not parsed as epoch), so the helper falls through to `return dateStr` and shows the raw epoch string in the Comment Manager too. So the fix must also harden `formatCommentDate` to detect epoch-ms.

## Metadata
- **Complexity:** 3
- **Tags:** webview, tickets, clickup, linear, bugfix, date-formatting

## Complexity Audit

### Routine
- Correcting field-name reads in three inline renderers.
- Adding a small date helper and reusing it.
- Pure webview change; rebuild with webpack; no migrations (this is a display-only bug, no shipped state/schema changes — see CLAUDE.md migration rule, which does not apply here).

### Complex/Risky
- Must handle BOTH comment shapes from a single shared renderer (edit-mode at `:7190` serves Linear and ClickUp). Reading provider-specific field names there is the trap that caused this bug; the fix uses a shape-agnostic accessor instead of branching on provider.
- Date formatting must accept ISO strings (Linear) AND epoch-ms strings (ClickUp) without misclassifying a 13-digit-looking ISO. Mirror the backend's proven logic at `TaskViewerProvider.ts:4816-4818`.

## Edge-Case & Dependency Audit
- **ClickUp shape** `{ comment_text, user:{username,email}, date }` vs **Linear shape** `{ body, user:{name,email}, createdAt }`: the new accessors read all candidate fields (`body || comment_text`, `user.name || user.username || user.email`, `createdAt || date`) so one renderer serves both.
- **Empty comments:** all three blocks already guard with `comments.length > 0` / truthy checks (`:7188`, `:7680`, `:8157`) — preserved. Empty/missing date → helper returns `''`.
- **Timezone:** use `toLocaleString()` (already the Comment Manager's choice at `:609`) so the user sees their local time. Date-only fallback uses local components, not UTC, to avoid off-by-one-day from `toISOString()`.
- **Epoch vs ISO disambiguation:** treat as epoch-ms only when the trimmed string is all digits (`/^\d+$/`). ISO strings contain `-`/`T`/`:` and route to `new Date(str)`. Matches backend behavior.
- **XSS:** all values stay wrapped in the existing `escapeHtml(...)` calls; the new helper returns a plain string that continues to be escaped at the call site. No new injection surface.
- **No new dependencies.** Pure JS in `planning.js`.

## Proposed Changes

### File: `src/webview/planning.js`

#### Change A — make `formatCommentDate` handle epoch-ms (fixes Comment Manager dates AND becomes the shared helper)

Current (`:604-613`):

```js
    function formatCommentDate(dateStr) {
        if (!dateStr) return '';
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return dateStr;
            return d.toLocaleString();
        } catch {
            return dateStr;
        }
    }
```

Replace with:

```js
    function formatCommentDate(dateStr) {
        if (dateStr === null || dateStr === undefined || dateStr === '') return '';
        try {
            const s = String(dateStr).trim();
            // ClickUp dates are epoch-millisecond strings; Linear dates are ISO strings.
            const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
            if (isNaN(d.getTime())) return s;
            return d.toLocaleString();
        } catch {
            return String(dateStr);
        }
    }
```

#### Change B — shared, shape-agnostic comment accessor (add once, near `formatCommentDate`)

Add immediately after `formatCommentDate`:

```js
    // Read a comment's display fields regardless of provider shape.
    // Linear: { body, user:{name,email}, createdAt }
    // ClickUp: { comment_text, user:{username,email}, date }
    function commentAuthorName(comment) {
        const u = comment && comment.user ? comment.user : {};
        return u.name || u.username || u.email || 'Unknown';
    }
    function commentBodyText(comment) {
        return (comment && (comment.body || comment.comment_text)) || '';
    }
    function commentDateRaw(comment) {
        return (comment && (comment.createdAt || comment.date)) || '';
    }
```

#### Change C — edit-mode renderer (shared, `:7190-7196`)

Before:

```js
            html += comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(comment.user?.name || comment.user?.email || 'Unknown')}</span>
                    <span class="tickets-comment-date">${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</span>
                    <div class="tickets-comment-body">${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
```

After:

```js
            html += comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(commentAuthorName(comment))}</span>
                    <span class="tickets-comment-date">${escapeHtml(formatCommentDate(commentDateRaw(comment)))}</span>
                    <div class="tickets-comment-body">${escapeHtml(commentBodyText(comment)).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
```

#### Change D — Linear detail renderer (`:7682-7688`)

Before:

```js
            contentHtml += selectedLinearIssue.comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(comment.user?.name || comment.user?.email || 'Unknown')}</span>
                    <span class="tickets-comment-date">${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</span>
                    <div class="tickets-comment-body">${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
```

After:

```js
            contentHtml += selectedLinearIssue.comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(commentAuthorName(comment))}</span>
                    <span class="tickets-comment-date">${escapeHtml(formatCommentDate(commentDateRaw(comment)))}</span>
                    <div class="tickets-comment-body">${escapeHtml(commentBodyText(comment)).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
```

#### Change E — ClickUp detail renderer (`:8159-8165`, the primary broken case)

Before:

```js
            contentHtml += selectedClickUpIssue.comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(comment.user?.name || comment.user?.email || 'Unknown')}</span>
                    <span class="tickets-comment-date">${escapeHtml(comment.createdAt ? comment.createdAt.slice(0, 10) : '')}</span>
                    <div class="tickets-comment-body">${escapeHtml(comment.body || '').replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
```

After:

```js
            contentHtml += selectedClickUpIssue.comments.map(comment => `
                <div class="tickets-comment-item">
                    <span class="tickets-comment-author">${escapeHtml(commentAuthorName(comment))}</span>
                    <span class="tickets-comment-date">${escapeHtml(formatCommentDate(commentDateRaw(comment)))}</span>
                    <div class="tickets-comment-body">${escapeHtml(commentBodyText(comment)).replace(/\n/g, '<br>')}</div>
                </div>
            `).join('');
```

> Note on caching: the Linear and ClickUp detail renderers diff against `_lastTicketsDetailContentHtml` (`:7700`) / its ClickUp equivalent before re-assigning `innerHTML`. Because the generated HTML string now changes (real author/body/date appear), the diff naturally detects the change and re-renders. No cache-invalidation edit is needed.

### No backend changes required
The data already reaches the webview with all needed fields — `_mapClickUpComment` preserves `comment_text`/`user`/`date` (`TaskViewerProvider.ts:5188`) and Linear's normalize preserves `body`/`user`/`createdAt`. The fix is entirely consuming the right fields and formatting the date in the webview. (Leaving `_mapClickUpComment` as-is also keeps the Comment Manager / `_comments.json` and plan-import paths untouched.)

### Confirm (do not change): no confirmation dialogs introduced
This change adds no `confirm()`/modal/two-click patterns, per CLAUDE.md.

## Verification Plan

1. **Build:** `npm run compile` — must succeed (webpack bundles `src/webview/planning.js` into `dist/webview/`). The extension serves webviews from `dist/`, so this rebuild is mandatory.
2. **Static check:** confirm no remaining inline reads of `comment.user?.name` / `comment.body` / `comment.createdAt` in the three blocks:
   `grep -n "comment.user?.name\|comment.body\|comment.createdAt" src/webview/planning.js` — the only legitimate remaining hits should be the Comment Manager's `thread.body`/`thread.author` (which use `cm-*` classes, unaffected), not the `.tickets-comment-item` blocks.
3. **Manual — ClickUp:** open a ClickUp ticket with comments in the Tickets tab detail panel. Verify each comment shows the real author (username), the real body text, and a readable local date-time (e.g. `6/22/2026, 3:40:00 PM`), not blank and not a raw epoch number.
4. **Manual — Linear:** open a Linear issue with comments. Verify author/body still render and the date now shows a full readable local date-time instead of bare `YYYY-MM-DD`.
5. **Manual — edit mode:** click Edit on both a ClickUp and a Linear ticket that has comments; verify the Comments section under the editor shows correct author/body/date for both providers.
6. **Manual — empty:** open a ticket with zero comments for each provider; verify no "Comments" header renders and no errors in the webview console.
7. **Manual — Comment Manager regression:** open the Comment Manager overlay on a ClickUp ticket; verify dates now render readably there too (was previously showing raw epoch via the old `formatCommentDate`).
