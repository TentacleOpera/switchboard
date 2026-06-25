# Fix ClickUp Comment Text Blank in Tickets Detail Panel (UAT Failure of Prior Plan)

## Goal

The prior plan `feature_plan_20260623140500_tickets-comments-display-and-dates.md` was implemented and passed code review, but **failed UAT**: ClickUp comment text is still not showing in the Tickets tab detail panel. This plan diagnoses the remaining root cause and fixes it.

### Problem Analysis

The prior plan correctly identified that the three inline comment renderers in `src/webview/planning.js` read the wrong field names for ClickUp comments (`comment.body` / `comment.user?.name` / `comment.createdAt` instead of `comment_text` / `user.username` / `date`). It introduced shape-agnostic accessors (`commentAuthorName`, `commentBodyText`, `commentDateRaw` at `planning.js:698-707`) and rewired all three renderers to use them. That part is confirmed implemented and present in the live source (`planning.js:7465-7467`, `:7957-7959`, `:8434-8436`).

**So why is the body still blank?** The accessors read `comment.comment_text`, but for a class of ClickUp comments that field is **empty** — the actual text lives in a structured `comment` array that the detail-load path does not decode.

### Root Cause

ClickUp's `GET /task/{id}/comment` API returns comments in two shapes:

1. **Plain comments** — body in `comment_text` (a string).
2. **Structured comments** — body in a `comment` array of blocks: `[{ type: 'text', text: '...' }, { type: 'tag', assignee: <userId>, text: '@name' }, ...]`. This is the shape produced when a comment is posted with mentions via the structured format (`ClickUpSyncService._buildStructuredComment` at `:1699`, sent by `postComment` at `:1754`). For these, `comment_text` is empty or absent and only the `comment` array is populated.

The codebase already has logic to decode the structured array: `_normalizeClickUpComment` (`ClickUpSyncService.ts:1651-1690`) iterates `comment.comment` blocks, concatenating `block.text` for `type:'text'` and `@${block.text}` for `type:'tag'`. **But this logic is only used by the Comment Manager threading path** (`getCommentThreads` → `_normalizeClickUpComment`).

The **detail-load path** does not use it:
- `getTaskDetails` (`ClickUpSyncService.ts:1240-1250`) maps each comment to `{ id, comment_text: String(comment?.comment_text || comment?.text_content || '').trim(), user, date }` — it reads only `comment_text`/`text_content`, never the `comment` array.
- `getTaskComments` (`ClickUpSyncService.ts:1269-1278`) does the same.
- `_mapClickUpComment` (`TaskViewerProvider.ts:5647-5654`) passes `comment_text` through verbatim.
- The webview's `commentBodyText` accessor (`planning.js:702-704`) reads `comment.body || comment.comment_text` — both are empty for structured comments.

**Result:** any ClickUp comment posted with mentions (structured format) renders a blank body in the detail panel and edit-mode view, even though it renders correctly in the Comment Manager overlay (which uses the threaded/normalized path).

## Metadata
- **Complexity:** 3
- **Tags:** ui, bugfix, frontend, clickup, comments

## Complexity Audit

### Routine
- Extracting plain text from the structured `comment` array — the logic already exists in `_normalizeClickUpComment` and is proven.
- Applying it in the detail-load mapping (`getTaskDetails` / `getTaskComments`) and/or `_mapClickUpComment`.

### Complex / Risky
- **Where to fix:** Three candidate sites — (a) `getTaskDetails`/`getTaskComments` in `ClickUpSyncService.ts`, (b) `_mapClickUpComment` in `TaskViewerProvider.ts`, (c) the webview accessor `commentBodyText` in `planning.js`. Fixing at the source (`getTaskDetails`/`getTaskComments`) is cleanest: it ensures `comment_text` is always populated with readable plain text for every consumer (detail panel, edit mode, plan-import `_buildCommentsSection`, Comment Manager fallback). Fixing only in the webview would leave plan-import markdown with empty comment bodies.
- **Mentions rendering:** `_normalizeClickUpComment` renders tags as `@${block.text || userId}`. The detail panel is plain text (escaped HTML), so `@name` is the right representation. No markdown parsing needed.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Comment mapping is synchronous off already-fetched API data.

### Security
- **XSS:** all values stay wrapped in the existing `escapeHtml(...)` calls in the webview. The extracted plain text is inserted into `comment_text` (a string field) and rendered through the same escaped path. No new injection surface.

### Side Effects
- **Plan import:** `_buildClickUpImportPlanContent` (`TaskViewerProvider.ts:5156`) and `_buildCommentsSection` (`:5253-5260`) consume `details.comments[].comment_text`. With the fix, imported plan markdown will now include the real text for structured comments instead of empty lines — a beneficial side effect.
- **Comment Manager:** unaffected — it uses the threaded path (`getCommentThreads` → `_normalizeClickUpComment`) which already decodes the array. No double-decoding because the fix is in the detail-load path, not the threading path.
- **`text_content` fallback:** preserved — the fix adds the `comment` array as an additional fallback when `comment_text`/`text_content` are empty.

### Dependencies & Conflicts
- **No new dependencies.** Pure TS/JS change.
- **No migrations.** This is a display/data-fetch correctness fix with no persisted state shape changes (CLAUDE.md migration rule does not apply).
- **Backward compat:** comments that already have `comment_text` populated are unaffected — the array extraction only runs when `comment_text` and `text_content` are both empty.

## Proposed Changes

### File: `src/services/ClickUpSyncService.ts`

#### Change A — decode structured `comment` array in `getTaskDetails`

Extract a shared helper and use it in both `getTaskDetails` and `getTaskComments`. Add the helper near `_normalizeClickUpComment` (after `:1690`):

```ts
  /**
   * Extract plain text from a raw ClickUp comment, decoding the structured
   * `comment` array when present (comments posted with mentions). Mirrors the
   * text-extraction logic in _normalizeClickUpComment but returns only the
   * body string (no author/mentions), for the detail-load path.
   */
  private _extractClickUpCommentText(comment: any): string {
    const direct = String(comment?.comment_text || comment?.text_content || '').trim();
    if (direct) { return direct; }
    if (Array.isArray(comment?.comment)) {
      let body = '';
      for (const block of comment.comment) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          body += block.text;
        } else if (block?.type === 'tag' && block.assignee) {
          body += `@${block?.text || block.assignee}`;
        }
      }
      return body.trim();
    }
    return '';
  }
```

Update `getTaskDetails` mapping (`:1242-1250`):

```ts
    const comments = Array.isArray(commentsResult.data?.comments)
      ? commentsResult.data.comments.map((comment: any) => ({
          id: String(comment?.id || '').trim(),
          comment_text: this._extractClickUpCommentText(comment),
          user: {
            username: String(comment?.user?.username || '').trim(),
            email: String(comment?.user?.email || '').trim()
          },
          date: String(comment?.date || '').trim()
        }))
      : [];
```

Update `getTaskComments` mapping (`:1271-1278`) identically — replace `String(comment?.comment_text || comment?.text_content || '').trim()` with `this._extractClickUpCommentText(comment)`.

### File: `src/services/TaskViewerProvider.ts`

#### Change B — harden `_mapClickUpComment` as a defense-in-depth fallback

`_mapClickUpComment` (`:5647-5654`) passes `comment_text` through. With Change A, `comment_text` is already populated. As defense-in-depth (in case any other call path bypasses `getTaskDetails`), decode the array here too:

```ts
    private _mapClickUpComment(comment: any): any {
        const text = String(comment?.comment_text || '').trim()
            || this._extractClickUpCommentBodyFromArray(comment?.comment);
        return {
            id: comment.id,
            comment_text: text,
            user: comment.user,
            date: comment.date
        };
    }
```

Add the small helper (or inline the same logic). If keeping `TaskViewerProvider` free of ClickUp-specific decoding, this change is **optional** — Change A is sufficient for the reported UAT failure. Include only if the team wants belt-and-suspenders coverage.

### No webview changes required

The accessors `commentBodyText` (`planning.js:702-704`) already read `comment.body || comment.comment_text`. With Change A, `comment_text` is now populated for structured comments, so the existing accessor works without modification.

### Confirm (do not change): no confirmation dialogs introduced
This change adds no `confirm()`/modal/two-click patterns, per CLAUDE.md.

## Verification Plan

### Static check
- `grep -n "_extractClickUpCommentText" src/services/ClickUpSyncService.ts` — confirm the helper exists and is called in both `getTaskDetails` and `getTaskComments`.
- `grep -n "comment_text || comment?.text_content" src/services/ClickUpSyncService.ts` — after the edit, no remaining raw reads in the two mapping sites (they should all go through the helper).

### Manual (installed VSIX)
1. **Structured comment (with mention):** in ClickUp, post a comment on a task that @-mentions a user (so it uses the structured `comment` array format). Open the task in the Tickets tab detail panel. Verify the comment body shows the real text including `@name`, not blank.
2. **Plain comment:** open a task with a plain (no-mention) comment. Verify the body still renders correctly (regression check).
3. **Edit mode:** click Edit on a ClickUp task with a structured comment. Verify the Comments section under the editor shows the real text.
4. **Comment Manager:** open the Comment Manager overlay on the same task. Verify it still renders correctly (no double-decoding / no regression).
5. **Plan import:** import a ClickUp task with structured comments as a plan. Verify the imported plan markdown includes the comment text (not empty lines).
6. **Linear (regression):** open a Linear issue with comments. Verify author/body/date still render correctly (Linear path is untouched).

---

**Recommendation:** Complexity 3 → **Send to Intern.**

## Reviewer Notes

This plan supersedes the field-name fix from `feature_plan_20260623140500` (which was correct but incomplete). The prior plan's accessors remain in place and are still needed (they handle the Linear/ClickUp shape difference). This plan fixes the upstream data gap that left `comment_text` empty for structured comments. The two fixes are complementary, not redundant.
