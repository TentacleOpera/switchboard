# Fix ClickUp Comment Text Blank in Comment Manager Overlay (UAT Failure of Prior Plan)

## Goal

The prior plan `feature_plan_20260623140500_tickets-comments-display-and-dates.md` was implemented and passed code review, but **failed UAT**: ClickUp comment text is still not showing in the Comment Manager overlay. This plan diagnoses the root cause and fixes it.

### Problem Analysis

The prior plan correctly identified that the inline comment renderers in `src/webview/planning.js` read the wrong field names for ClickUp comments. It introduced shape-agnostic accessors (`commentAuthorName`, `commentBodyText`, `commentDateRaw` at `planning.js:698-707`) and rewired the renderers to use them. That part is confirmed implemented and present in the live source (`planning.js:7465-7467`, `:7957-7959`, `:8434-8436`).

**So why is the body still blank?** The Comment Manager overlay is the only surface meant to show comments. It uses a separate code path — `getCommentThreads` → `_normalizeClickUpComment` — not the detail-load path that the prior plan fixed. The `_normalizeClickUpComment` decoder has bugs that cause it to skip every block in a structured comment, producing an empty body.

### Root Cause

ClickUp's `GET /task/{id}/comment` API returns comments in two shapes:

1. **Plain comments** — body in `comment_text` (a string).
2. **Structured comments** — body in a `comment` array of blocks, with `comment_text` also populated as a plain-text rendering. The `comment` array uses a different shape than what the codebase sends on POST.

The codebase has logic to decode the structured array: `_normalizeClickUpComment` (`ClickUpSyncService.ts:1651-1690`) iterates `comment.comment` blocks. **But the block iteration has two bugs that cause it to skip every block when processing GET responses:**

1. **Text blocks omit `type`** — The code checks `block?.type === 'text'` (`:1665`), but GET response text blocks are just `{"text": "..."}` with no `type` field. `undefined === 'text'` evaluates to **false** — text blocks are skipped.
2. **Tag blocks use `user`, not `assignee`** — The code checks `block?.type === 'tag' && block.assignee` (`:1667`), but GET response tag blocks have `{"type": "tag", "user": {...}}`, not `assignee`. `block.assignee` is `undefined` → **falsy** — tag blocks are skipped.

**Result:** `_normalizeClickUpComment` produces an **empty body** for any structured comment from a GET response. The `else` branch that falls back to `comment_text` is never reached because the `comment` array exists (the `if (Array.isArray(comment?.comment))` check passes), so the code enters the block iteration branch, skips all blocks, and returns `body = ''`.

The Comment Manager overlay (`getCommentThreads` → `_normalizeClickUpComment`) is the only surface meant to show comments. The prior plan's accessor fixes targeted the inline renderers in `planning.js`, which are a different code path and not the failing surface.

### Research Findings (GET vs POST shape mismatch)

Web research into ClickUp's REST API v2 confirmed the root cause. The GET response `comment` array has a different structure than what the codebase sends on POST:

**POST format (what `_buildStructuredComment` sends):**
```json
[
  {"type": "text", "text": "Hello "},
  {"type": "tag", "assignee": 123, "text": "John"}
]
```

**GET response format (what ClickUp returns):**
```json
[
  {"text": "Hello "},
  {"type": "tag", "user": {"id": 123, "username": "John Doe", "email": "...", ...}}
]
```

Two critical differences:
1. **Text blocks omit `type`** — GET text blocks are just `{"text": "..."}` with no `type: 'text'` field.
2. **Tag blocks use a `user` object** — GET tag blocks have `{"type": "tag", "user": {...}}`, not `{"type": "tag", "assignee": <int>}`.

Research also confirmed:
- `comment_text` IS populated by ClickUp for text+mention structured comments (e.g., `"Hello John Doe"`). It can be blank for media-only comments (images/files/emoticons without text).
- `text_content` is NOT a valid field on comment objects in REST API responses. It is a task-level field. The `comment?.text_content` fallback in `getTaskDetails` and `getTaskComments` is dead code.
- The `comment` array IS echoed back on GET — it is not write-only.

## Metadata
- **Complexity:** 3
- **Tags:** ui, bugfix, frontend, api

## User Review Required

No — the root cause is confirmed by research and code inspection. The fix is a targeted correction to the block iteration logic in `_normalizeClickUpComment`.

## Complexity Audit

### Routine
- Fixing the block iteration in `_normalizeClickUpComment` to handle the actual GET response shape (text blocks without `type`, tag blocks with `user` object). The logic structure stays the same — only the condition checks change.
- Removing the dead `text_content` fallback from the `else` branch (confirmed not a comment-level REST field).

### Complex / Risky
- **None.** Single-file, single-function change. No new patterns, no data consistency risks, no breaking changes. The fix only affects structured comments (which were already broken — producing empty bodies). Plain comments are unaffected because they don't have a `comment` array and take the `else` branch.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Comment normalization is synchronous off already-fetched API data.

### Security
- **XSS:** all values stay wrapped in the existing `escapeHtml(...)` calls in the webview. The extracted plain text is inserted into the `body` field and rendered through the same escaped path. No new injection surface.

### Side Effects
- **Comment Manager (primary fix):** structured comments will now render their real text instead of blank bodies. This is the UAT fix.
- **Mentions:** the corrected decoder extracts the username from `block.user.username` (GET response) instead of `block.text` (POST format). This means mentions will show the full display name (e.g., `@John Doe`) rather than the short text label that was sent on POST.
- **`text_content` fallback removed:** the `else` branch in `_normalizeClickUpComment` (`:1675`) drops `comment?.text_content` — confirmed not a comment-level REST field. Only `comment_text` is used as the plain-text fallback.

### Dependencies & Conflicts
- **No new dependencies.** Pure TS change.
- **No migrations.** This is a display correctness fix with no persisted state shape changes (CLAUDE.md migration rule does not apply).
- **Backward compat:** plain comments (no `comment` array) are unaffected — they take the `else` branch which reads `comment_text`. Structured comments were already broken (empty body), so the fix can only improve things.

## Dependencies

- `feature_plan_20260623140500_tickets-comments-display-and-dates.md` — prior plan that introduced the shape-agnostic webview accessors. That plan fixed the inline renderers in `planning.js`, which are a different code path from the Comment Manager overlay. This plan fixes the Comment Manager's decoder (`_normalizeClickUpComment`), which the prior plan did not touch.

## Uncertain Assumptions

Research has been completed. All assumptions are resolved:
1. ~~`comment_text` is empty/absent for structured comments~~ — **REFUTED.** ClickUp populates `comment_text` for text+mention comments. The root cause is not empty `comment_text`; it's the buggy block iteration that skips all blocks when the `comment` array exists, preventing the `comment_text` fallback from ever being reached.
2. `comment` array is echoed back on GET — **CONFIRMED.**
3. `text_content` is not a comment-level REST field — **CONFIRMED.** Removed from `_normalizeClickUpComment`'s `else` branch only. It remains in `getTaskDetails`/`getTaskComments` (`:1244`, `:1273`) because Change B (which would have replaced those usages) was optional and not implemented. The task-level `text_content` at `:735` (`_normalizeClickUpTask`) is valid and was correctly left in place.

## Adversarial Synthesis

Key risks: (1) the original plan misidentified the failing surface — it targeted the inline renderers in `planning.js` (detail-load path) when the actual failing surface is the Comment Manager overlay (`getCommentThreads` → `_normalizeClickUpComment`); (2) the original plan assumed `comment_text` was empty for structured comments — research refuted this, and the real bug is that the block iteration skips all blocks due to GET/POST shape mismatch, preventing the `comment_text` fallback from being reached; (3) the corrected decoder must handle both GET and POST block shapes to avoid breaking the POST path (which `_buildStructuredComment` uses). Mitigations: the fix uses `!block.type || block.type === 'text'` for text blocks (handles both GET no-type and POST type-text) and `block?.user?.id || block?.assignee` for tag blocks (handles both GET user-object and POST assignee-int).

## Proposed Changes

### File: `src/services/ClickUpSyncService.ts`

#### Change A (PRIMARY) — fix block iteration in `_normalizeClickUpComment`

> **Research finding:** The existing `_normalizeClickUpComment` (`:1651-1690`) has two bugs that cause it to skip every block in a structured comment from a GET response. Text blocks omit the `type` field (GET returns `{"text": "..."}` not `{"type": "text", "text": "..."}`), and tag blocks use a `user` object (GET returns `{"type": "tag", "user": {...}}` not `{"type": "tag", "assignee": <int>}`). Both conditions fail, all blocks are skipped, and the body stays empty.

Fix the block iteration in `_normalizeClickUpComment` (`:1662-1673`):

```ts
    // ClickUp structured comment: array of blocks.
    // GET response shape: text blocks are {"text": "..."} (no type field),
    //   tag blocks are {"type": "tag", "user": {id, username, ...}}.
    // POST shape (for reference): text blocks have type:"text", tag blocks use assignee.
    if (Array.isArray(comment?.comment)) {
      for (const block of comment.comment) {
        if (typeof block?.text === 'string' && (!block.type || block.type === 'text')) {
          body += block.text;
        } else if (block?.type === 'tag') {
          const userId = String(block?.user?.id || block?.assignee || '').trim();
          const name = String(block?.user?.username || block?.text || '').trim();
          mentions.push({ id: userId, name });
          body += `@${name || userId}`;
        }
      }
    } else {
      body = String(comment?.comment_text || '').trim();
    }
```

Changes from the original code (`:1662-1676`):
- Text block check: `block?.type === 'text' && typeof block.text === 'string'` → `typeof block?.text === 'string' && (!block.type || block.type === 'text')` — handles GET text blocks that omit `type`.
- Tag block check: `block?.type === 'tag' && block.assignee` → `block?.type === 'tag'` — removes the `assignee` truthiness gate (GET uses `user`, not `assignee`).
- Tag user ID: `String(block.assignee)` → `String(block?.user?.id || block?.assignee || '')` — reads from `user.id` (GET) with `assignee` (POST) as fallback.
- Tag name: `String(block?.text || '')` → `String(block?.user?.username || block?.text || '')` — prefers the hydrated `username` from GET, falls back to `text` from POST.
- `else` branch: drops `comment?.text_content` (confirmed not a comment-level REST field).

#### Change B (OPTIONAL) — add `_extractClickUpCommentText` helper for detail-load path

> **Not needed for the UAT failure.** The Comment Manager is the only surface meant to show comments, and it uses `_normalizeClickUpComment` (fixed by Change A). This helper improves the detail-load path (`getTaskDetails`/`getTaskComments`) as defense-in-depth for the media-only edge case where `comment_text` is genuinely blank. Include only if belt-and-suspenders coverage is desired.

Add near `_normalizeClickUpComment` (after `:1690`):

```ts
  /**
   * Extract plain text from a raw ClickUp comment, decoding the structured
   * `comment` array when present. Handles the GET response shape where text
   * blocks omit `type` and tag blocks use a `user` object (not `assignee`).
   * Falls back to comment_text (which ClickUp typically populates) first.
   */
  private _extractClickUpCommentText(comment: any): string {
    const direct = String(comment?.comment_text || '').trim();
    if (direct) { return direct; }
    if (Array.isArray(comment?.comment)) {
      let body = '';
      for (const block of comment.comment) {
        if (typeof block?.text === 'string' && (!block.type || block.type === 'text')) {
          body += block.text;
        } else if (block?.type === 'tag') {
          const name = block?.user?.username || block?.text || block?.user?.id || block?.assignee || '';
          body += `@${name}`;
        }
      }
      return body.trim();
    }
    return '';
  }
```

If added, update `getTaskDetails` (`:1242-1250`) and `getTaskComments` (`:1271-1278`) to use `this._extractClickUpCommentText(comment)` instead of `String(comment?.comment_text || comment?.text_content || '').trim()`.

### No webview changes required

The Comment Manager overlay renders comments from `getCommentThreads` output, which is produced by `_normalizeClickUpComment`. Change A fixes the decoder — no webview changes are needed.

### Confirm (do not change): no confirmation dialogs introduced
This change adds no `confirm()`/modal/two-click patterns, per CLAUDE.md.

## Verification Plan

> **Session directives:** Compilation (`npm run compile`) and automated test runs are skipped for this session per user directive. The test suite will be run separately by the user. The steps below are for the implementing agent to follow; the unit test should be written but not executed during implementation.

### Static check
- `grep -n "block?.type === 'text'" src/services/ClickUpSyncService.ts` — after the edit, no remaining strict `type === 'text'` checks in `_normalizeClickUpComment` (should use the `!block.type || block.type === 'text'` pattern).
- `grep -n "block.assignee" src/services/ClickUpSyncService.ts` — `assignee` should only appear as a fallback (`block?.user?.id || block?.assignee`), not as a primary check or truthiness gate.

### Automated Tests
- **Add a unit test** in `src/test/integrations/clickup/clickup-sync-service.test.js` with three cases:
  1. **Structured comment (GET response shape):** mock `GET /task/{id}/comment` to return a comment with `comment_text: "Hello John Doe"` and `comment: [{text: "Hello "}, {type: "tag", user: {id: 123, username: "John Doe"}}]`. Call `getCommentThreads`, assert `threads[0].body` equals `"Hello @John Doe"` (the decoder should extract from the array, not `comment_text`, because the array exists).
  2. **Plain comment:** mock a comment with `comment_text: "Looks good"` and no `comment` array. Assert `threads[0].body` equals `"Looks good"` (regression check — takes the `else` branch).
  3. **Structured comment with empty `comment_text` (media-only edge case):** mock a comment with `comment_text: ""` and `comment: [{text: "Check this out"}]`. Assert `threads[0].body` equals `"Check this out"`.
  This test should be written as part of implementation but will be run by the user separately.

### Manual (installed VSIX)
1. **Structured comment (with mention):** in ClickUp, post a comment on a task that @-mentions a user. Open the Comment Manager overlay on that task. Verify the comment body shows the real text including `@name`, not blank.
2. **Plain comment:** open the Comment Manager on a task with a plain (no-mention) comment. Verify the body still renders correctly (regression check).
3. **Linear (regression):** open the Comment Manager on a Linear issue with comments. Verify author/body/date still render correctly (Linear path is untouched).

---

**Recommendation:** Complexity 3 → **Send to Intern.**

## Reviewer Notes

This plan supersedes the field-name fix from `feature_plan_20260623140500` (which was correct but targeted the wrong code path). The prior plan fixed the inline renderers in `planning.js`; the actual failing surface is the Comment Manager overlay, which uses `getCommentThreads` → `_normalizeClickUpComment` — a separate code path the prior plan did not touch.

**Root cause:** `_normalizeClickUpComment` has two bugs in its block iteration that cause it to skip every block when processing GET responses: (1) text blocks in GET responses omit the `type` field, failing the `block?.type === 'text'` check; (2) tag blocks in GET responses use a `user` object, failing the `block?.type === 'tag' && block.assignee` check. Both blocks are skipped, the body stays empty, and the `comment_text` fallback in the `else` branch is never reached because the `comment` array exists.

**Research confirmed:** ClickUp's GET response `comment` array uses a different shape than the POST format the codebase sends. Text blocks are `{"text": "..."}` (no `type`), tag blocks are `{"type": "tag", "user": {...}}` (not `assignee`). The fix handles both GET and POST shapes with fallback chains.

---

## Reviewer Pass (2026-06-26)

### Stage 1 — Adversarial Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| 1 | **CRITICAL** | `ClickUpSyncService.ts:1666-1676` (pre-fix) | Missing empty-body fallback in the `if (Array.isArray(comment?.comment))` branch. If the `comment` array exists but is empty (or contains only unrecognized block types), the for loop runs zero times, `body` stays `''`, and the `comment_text` fallback in the `else` branch is never reached. This is the **same structural failure class** as the original UAT bug — the `comment` array's existence blocks the fallback. |
| 2 | NIT | `ClickUpSyncService.ts:1674` | Dangling `@` if a tag block has no `user`, no `text`, and no `assignee` — `name` and `userId` both `''`, body gets `@`. Unlikely in practice (ClickUp tag blocks always carry a user). Deferred. |
| 3 | NIT | Plan `:102` (Uncertain Assumptions) | Wording claimed `text_content` is "Dead code, removed" — it was only removed from `_normalizeClickUpComment`'s else branch. Still present in `getTaskDetails`/`getTaskComments` (`:1244`, `:1273`) because Change B was optional and not implemented. Doc corrected. |

### Stage 2 — Balanced Synthesis

- **Finding 1 (CRITICAL):** Fix now. One-line addition after the for loop: `if (!body) { body = String(comment?.comment_text || '').trim(); }`. This closes the structural vulnerability that allowed the original UAT failure to occur. Without this, any future ClickUp block type the decoder doesn't recognize would re-introduce blank bodies.
- **Finding 2 (NIT):** Defer — not worth the complexity for a malformed-data edge case.
- **Finding 3 (NIT):** Fix the plan wording (done above).

### Fixes Applied

1. **`src/services/ClickUpSyncService.ts:1677-1682`** — Added empty-body fallback inside the `if (Array.isArray(...))` branch: after the for loop, if `body` is still empty, fall back to `comment_text`. This prevents blank bodies when the `comment` array is empty or contains only unrecognized block types.
2. **`src/test/integrations/clickup/clickup-sync-service.test.js:568-577, 582, 602-605`** — Added a 4th test case: structured comment with an empty `comment` array and populated `comment_text`. Asserts `threads[3].body === 'Fallback text here'`. Updated thread count assertion from 3 to 4.
3. **Plan file `:102`** — Corrected the `text_content` wording in Uncertain Assumptions to accurately reflect what was removed and what remains.

### Files Changed

- `src/services/ClickUpSyncService.ts` — empty-body fallback in `_normalizeClickUpComment` (`:1677-1682`)
- `src/test/integrations/clickup/clickup-sync-service.test.js` — 4th test case + count update
- `.switchboard/plans/feature_plan_20260625105934_fix-clickup-comment-text-blank-in-detail-panel.md` — this reviewer pass section + wording correction

### Validation Results

- **Static check 1** (`grep "block?.type === 'text'"`): PASS — zero matches, no strict type checks remain.
- **Static check 2** (`grep "block?.assignee"`): PASS — single match at `:1671`, used only as `|| block?.assignee` fallback.
- **Empty-body fallback verification**: PASS — `if (!body)` guard present at `:1680`, reads `comment?.comment_text`.
- **Test file structure**: PASS — 4 cases, count = 4, assertions cover structured/plain/media-only/empty-array.
- **Compilation**: Skipped per session directive.
- **Automated tests**: Skipped per session directive — to be run separately by user.

### Remaining Risks

1. **Dangling `@` on malformed tag blocks** (NIT, deferred) — `ClickUpSyncService.ts:1674`. If a tag block lacks `user`, `text`, and `assignee`, body gets a bare `@`. Unlikely in practice; not fixed to avoid over-engineering.
2. **`text_content` in detail-load paths** (INFO) — `ClickUpSyncService.ts:1244` and `:1273` still reference `comment?.text_content` as a fallback. Confirmed not a comment-level REST field, but harmless (always `undefined` → falls through to `''`). Would be cleaned up if Change B is ever implemented.
3. **Manual UAT still required** — the structured-comment-with-mention and plain-comment scenarios need verification on an installed VSIX against a real ClickUp task with mentions.
