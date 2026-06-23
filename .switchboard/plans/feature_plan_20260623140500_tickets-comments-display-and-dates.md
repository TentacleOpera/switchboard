# Fix Tickets Tab Comments: Render Real Text/Author and Format Dates Readably

## Goal

Make the Tickets tab **detail panel** show real comment author and body text for ClickUp tickets (currently blank), and render comment dates readably for **both** ClickUp and Linear (currently a bare `YYYY-MM-DD` for Linear and an unusable raw epoch for ClickUp).

In `planning.html`'s Tickets tab, the ticket **detail panel** (the read-only / edit-mode view that shows a ticket's description, then a "Comments" section) does not display the actual comment text or author for ClickUp tickets, and shows dates in an unreadable form. This is a separate UI from the "Comment Manager" overlay (`#tickets-comment-manager`, rendered by `renderThreadHtml` at `src/webview/planning.js:617`), which is wired correctly. The bug lives in the **inline detail renderers**.

There are **three** inline comment renderers in `src/webview/planning.js`, all emitting `.tickets-comment-item` markup and all reading the field names `comment.user?.name`, `comment.body`, and `comment.createdAt`:

1. **Edit-mode renderer** — `src/webview/planning.js:7335-7341` (inside `enterTicketsEditMode`, defined at `:7305`; serves BOTH providers — `issue` is Linear or ClickUp per the `lastIntegrationProvider` branch).
2. **Linear detail renderer** — `src/webview/planning.js:7827-7833` (inside `renderTicketsLinearTaskDetail`, `:7691`).
3. **ClickUp detail renderer** — `src/webview/planning.js:8304-8310` (inside `renderTicketsClickUpTaskDetail`, `:8198`).

> **Line-number note:** All `file:line` references in this plan were re-verified against the live source on 2026-06-23. An earlier draft cited locations ~145 lines too low (e.g. `formatCommentDate` was cited at `:604`; it is actually at `:661`). The references below are current.

### Root cause 1 — ClickUp comments render blank author + blank body

The data these renderers consume comes from the detail-load path, NOT the comment manager:

- ClickUp: `getTaskDetails` returns comments shaped `{ id, comment_text, user: { username, email }, date }` (`src/services/ClickUpSyncService.ts:1199-1202` for the return type; `:1242-1250` for the mapping). The backend then passes each through `_mapClickUpComment`, which **preserves that same shape** — `{ id, comment_text, user, date }` (`src/services/TaskViewerProvider.ts:5409-5416`) — and posts it as `clickupTaskDetailsLoaded.comments` (`src/services/TaskViewerProvider.ts:8731`). The webview stores it as `selectedClickUpIssue.comments`.
- But the ClickUp renderer reads `comment.user?.name` (the field is `user.username`), `comment.body` (the field is `comment_text`), and `comment.createdAt` (the field is `date`) — `src/webview/planning.js:8306-8308`. **Every field name is wrong for the ClickUp shape**, so author resolves to `'Unknown'`, body renders empty, and the date renders empty. The same mismatch breaks ClickUp in the shared edit-mode renderer (`:7337-7339`).

Linear comments happen to render because `getComments` returns `LinearComment` = `{ id, body, user: { id, name, email }, createdAt, parentId, mentions }` (`src/services/LinearSyncService.ts:64-70` interface; normalized at `:382`/`:409`) which matches the field names the renderer already uses. So **Linear bodies/authors are fine; ClickUp ones are broken.**

### Root cause 2 — dates are not formatted readably (both providers)

Every inline renderer formats the date as `comment.createdAt ? comment.createdAt.slice(0, 10) : ''` (`:7338`, `:7830`, `:8307`):

- Linear: `createdAt` is an ISO string, so `.slice(0,10)` yields a bare `YYYY-MM-DD` with no time — crude, and produces `''` for ClickUp because ClickUp has no `createdAt`.
- ClickUp: `date` is an **epoch-milliseconds string** (e.g. `"1718000000000"`), confirmed by the backend's own dual-format handling in `_buildCommentsSection` (`src/services/TaskViewerProvider.ts:5038-5039`: `const epoch = Number(c.date); const ms = (Number.isFinite(epoch) && epoch > 0) ? epoch : Date.parse(c.date);`). A raw `.slice(0,10)` of an epoch string would show the first 10 digits of a number, not a date.

The existing helper `formatCommentDate` (`src/webview/planning.js:661-670`) used by the Comment Manager is **also wrong for ClickUp**: it calls `new Date(dateStr)` directly. `new Date("1718000000000")` is `Invalid Date` (a pure-digit string is not parsed as epoch), so the helper falls through to `return dateStr` and shows the raw epoch string in the Comment Manager too. So the fix must also harden `formatCommentDate` to detect epoch-ms — mirroring the proven backend logic at `TaskViewerProvider.ts:5038-5039`.

## Metadata
- **Complexity:** 3
- **Tags:** ui, bugfix, frontend

## User Review Required
- None. This is a pure display correctness fix with a single sensible behavior (show the real author/body, show a readable local date-time). No product decisions are open.

## Complexity Audit

### Routine
- Correcting field-name reads in three inline renderers (identical markup, identical edit).
- Adding a small date helper / accessors and reusing them.
- Pure webview change. No migrations: this is a display-only bug, with no shipped state/schema/settings changes, so the CLAUDE.md migration rule does not apply (no persisted data shape changes).

### Complex / Risky
- Must handle BOTH comment shapes from a single shared renderer (edit-mode at `:7335` serves Linear and ClickUp). Reading provider-specific field names there is the trap that caused this bug; the fix uses a shape-agnostic accessor instead of branching on provider.
- Date formatting must accept ISO strings (Linear) AND epoch-ms strings (ClickUp) without misclassifying. Mirror the backend's proven logic at `TaskViewerProvider.ts:5038-5039`.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Rendering is synchronous off already-loaded `selectedClickUpIssue.comments` / `selectedLinearIssue.comments`. No new async paths, timers, or message round-trips are introduced.

### Security
- **XSS:** all values stay wrapped in the existing `escapeHtml(...)` calls; the new accessors and helper return plain strings that continue to be escaped at the call site. No new injection surface.

### Side Effects
- **Diff-cache re-render:** the Linear and ClickUp detail renderers diff the generated HTML against `_lastTicketsDetailContentHtml` (and its ClickUp equivalent) before re-assigning `innerHTML`. Because the generated HTML string now changes (real author/body/date appear), the diff naturally detects the change and re-renders. No cache-invalidation edit is needed.
- **Comment Manager:** hardening `formatCommentDate` also corrects ClickUp dates in the Comment Manager overlay (a beneficial side effect, covered in verification).

### Dependencies & Conflicts
- **ClickUp shape** `{ comment_text, user:{username,email}, date }` vs **Linear shape** `{ body, user:{name,email}, createdAt }`: the new accessors read all candidate fields (`body || comment_text`, `user.name || user.username || user.email`, `createdAt || date`) so one renderer serves both.
- **Null `user`:** `_mapClickUpComment` passes through what `getTaskDetails` guarantees as `{username, email}`; `commentAuthorName` additionally defaults to `{}` when `comment.user` is missing, so the optional access never throws.
- **Empty comments:** all three blocks already guard with `comments.length > 0` / truthy checks (`:7333`, `:7825`, `:8302`) — preserved. Empty/missing date → helper returns `''`.
- **Timezone:** use `toLocaleString()` (already the Comment Manager's choice at `:666`) so the user sees their local time.
- **Epoch vs ISO disambiguation:** treat as epoch-ms only when the trimmed string is all digits (`/^\d+$/`). ISO strings contain `-`/`T`/`:` and route to `new Date(str)`. Matches backend intent. **Known harmless edge:** a bare digit string like `"2026"` would be read as 2026 ms past the epoch (Jan 1 1970); comment timestamps are never bare years (ClickUp = 13-digit epoch, Linear = full ISO), so this cannot occur in practice.
- **No new dependencies.** Pure JS in `planning.js`. **No backend changes.**

## Dependencies
- None. (No prior session work is required; this fix is self-contained in the webview layer.)

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) stale `file:line` citations could misdirect the edit — *mitigated* by re-verifying every reference against the live source (done; references corrected). (2) Date misclassification between epoch-ms and ISO — *mitigated* by an all-digits regex gate mirroring the proven backend logic at `TaskViewerProvider.ts:5038-5039`. (3) A null `comment.user` throwing in the shared accessor — *mitigated* by a `{}` default. The engineering is otherwise low-risk: a localized, single-file, escape-preserving display fix with no migrations and no async changes.

## Proposed Changes

### File: `src/webview/planning.js`

#### Change A — make `formatCommentDate` handle epoch-ms (fixes Comment Manager dates AND becomes the shared helper)

Current (`:661-670`):

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
            // Mirrors backend logic at TaskViewerProvider.ts:5038-5039.
            const d = /^\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
            if (isNaN(d.getTime())) return s;
            return d.toLocaleString();
        } catch {
            return String(dateStr);
        }
    }
```

#### Change B — shared, shape-agnostic comment accessor (add once, immediately after `formatCommentDate`)

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

#### Change C — edit-mode renderer (shared, `:7335-7341`, inside `enterTicketsEditMode`)

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

#### Change D — Linear detail renderer (`:7827-7833`, inside `renderTicketsLinearTaskDetail`)

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

#### Change E — ClickUp detail renderer (`:8304-8310`, the primary broken case, inside `renderTicketsClickUpTaskDetail`)

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

> Note on caching: the Linear and ClickUp detail renderers diff against `_lastTicketsDetailContentHtml` / its ClickUp equivalent before re-assigning `innerHTML`. Because the generated HTML string now changes (real author/body/date appear), the diff naturally detects the change and re-renders. No cache-invalidation edit is needed.

### No backend changes required
The data already reaches the webview with all needed fields — `_mapClickUpComment` preserves `comment_text`/`user`/`date` (`TaskViewerProvider.ts:5409-5416`) and Linear's normalize preserves `body`/`user`/`createdAt` (`LinearSyncService.ts:382`, `:409`). The fix is entirely consuming the right fields and formatting the date in the webview. (Leaving `_mapClickUpComment` as-is also keeps the Comment Manager / `_comments.json` and plan-import paths untouched.)

### Confirm (do not change): no confirmation dialogs introduced
This change adds no `confirm()`/modal/two-click patterns, per CLAUDE.md.

## Verification Plan

### Automated Tests
- No automated tests are added or required for this fix (it is a localized display-string change with no testable backend surface). Per this session's directives, the existing test suite is run separately by the user, not as part of this plan.

### Build (deferred this session)
- A webpack rebuild (`npm run compile`) is only needed to **produce a VSIX for installed testing** — per CLAUDE.md, `dist/` is NOT used during development/testing and nothing is served from the repo's `dist/`; `src/` is the source of truth. Compilation is **skipped this session** per directive and left for the user when cutting a VSIX.

### Static check
- Confirm no remaining inline reads of `comment.user?.name` / `comment.body` / `comment.createdAt` in the three `.tickets-comment-item` blocks:
  `grep -n "comment.user?.name\|comment\.body\|comment\.createdAt" src/webview/planning.js` — after the edit, the only legitimate remaining hits should be elsewhere (e.g. the Comment Manager's `thread.body`/`thread.author`, which use `cm-*` classes and are unaffected), not the `.tickets-comment-item` blocks at `:7335`/`:7827`/`:8304`.

### Manual (installed VSIX)
1. **ClickUp:** open a ClickUp ticket with comments in the Tickets tab detail panel. Verify each comment shows the real author (username), the real body text, and a readable local date-time (e.g. `6/22/2026, 3:40:00 PM`), not blank and not a raw epoch number.
2. **Linear:** open a Linear issue with comments. Verify author/body still render and the date now shows a full readable local date-time instead of bare `YYYY-MM-DD`.
3. **Edit mode:** click Edit on both a ClickUp and a Linear ticket that has comments; verify the Comments section under the editor shows correct author/body/date for both providers.
4. **Empty:** open a ticket with zero comments for each provider; verify no "Comments" header renders and no errors in the webview console.
5. **Comment Manager regression:** open the Comment Manager overlay on a ClickUp ticket; verify dates now render readably there too (was previously showing raw epoch via the old `formatCommentDate`).

---

**Recommendation:** Complexity 3 → **Send to Intern.**
