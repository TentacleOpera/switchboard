# ClickUp Image & Emoticon Comment Rendering in Comment Manager

## Goal

The Comment Manager overlay (`getCommentThreads` → `_normalizeClickUpComment` → `renderThreadHtml`/`renderReplyHtml`) currently decodes only `text` and `tag` (mention) blocks from ClickUp's structured `comment` array. All other block types — **emoticons** (emoji), and any future **attachment/image** blocks — are silently skipped. When a comment contains only these unrecognized block types, the body is blank (or falls back to `comment_text`, which ClickUp leaves empty for media-only comments).

This plan adds decoding for **emoticon blocks** (documented, known to exist) and **defensive handling for attachment/image blocks** (undocumented but possible), plus webview rendering changes to display emoji characters and inline images in the Comment Manager.

### Problem Analysis

ClickUp's `GET /task/{id}/comment` response includes a `comment` array of blocks. The ClickUp comment formatting docs (https://developer.clickup.com/docs/comment-formatting) document three block types:

1. **Text blocks** — `{"text": "...", "attributes": {...}}` (no `type` field). Already handled.
2. **Emoticon blocks** — `{"text": "U0001F60A", "type": "emoticon", "emoticon": {"code": "1f60a"}}`. **NOT handled** — skipped by the decoder.
3. **Tag blocks** — `{"type": "tag", "user": {"id": ...}}`. Already handled (fixed in prior plan).

The OpenAPI spec describes the `type` field as "text, mention, etc." — the "etc." implies additional undocumented types may exist. Images are uploaded to comments via multipart/form-data as task-level attachments, but the comment array may also contain undocumented block types referencing those attachments.

**Current behavior for an emoji-only comment:**
```json
{
  "comment_text": "",
  "comment": [
    {"text": "U0001F60A", "type": "emoticon", "emoticon": {"code": "1f60a"}}
  ]
}
```
- `_normalizeClickUpComment` enters the `if (Array.isArray(...))` branch.
- The emoticon block has `type: "emoticon"` — matches neither the text condition (`!block.type || block.type === 'text'` → false) nor the tag condition (`block.type === 'tag'` → false). Skipped.
- Loop ends, `body` is `''`. The empty-body fallback (added in prior plan review) fires: `body = String(comment?.comment_text || '').trim()` → `''`. **Still blank.**

**Current behavior for an image/attachment comment:**
- If ClickUp returns an undocumented `{"type": "attachment", ...}` or `{"type": "image", ...}` block, it's skipped for the same reason.
- `comment_text` is empty for media-only comments.
- Body is blank.

### Root Cause

The `_normalizeClickUpComment` decoder (`ClickUpSyncService.ts:1666-1685`) only handles `text` and `tag` block types. The webview renderer (`planning.js:644-686`) only renders escaped text — it has no mechanism to display emoji characters (which need to pass through un-escaped) or inline images (which need `<img>` tags).

Two layers need changes:
1. **Backend decoder** — extract emoji characters from `emoticon` blocks; extract URLs from `attachment`/`image` blocks if present.
2. **Webview renderer** — render emoji characters and inline images safely within the Comment Manager overlay.

## Metadata
- **Complexity:** 4
- **Tags:** ui, bugfix, frontend, api

## User Review Required

No — the emoticon block format is documented by ClickUp. The attachment block format is defensive (undocumented), but the fallback behavior (showing `[attachment]` placeholder) is safe.

## Complexity Audit

### Routine
- Adding `emoticon` block handling to `_normalizeClickUpComment` — same loop, new `else if` branch.
- Adding defensive `attachment`/`image` block handling — same loop, new `else if` branch.
- Adding CSS for inline images in the Comment Manager.
- Adding unit tests for emoticon and attachment block decoding.

### Complex / Risky
- **Webview rendering of mixed content** — the Comment Manager currently renders body as `escapeHtml(thread.body)`. Emoji characters survive `escapeHtml` fine (they're not `<`, `>`, or `&`), but inline images require `<img>` tags which can't go through `escapeHtml`. The renderer needs a structured body format (not just a string) to safely mix text and images. This is the main architectural change.
- **XSS surface** — introducing `<img>` tags into the comment body creates a potential injection vector. The image URL must be sanitized (only `https:` and `data:` schemes per CSP; no `javascript:` or `vbscript:`). The `alt` text must be escaped.

## Edge-Case & Dependency Audit

### Race Conditions
- None. Comment normalization is synchronous off already-fetched API data.

### Security
- **XSS via image URLs:** the webview CSP allows `img-src https: data:` (`planning.html:6`). Image URLs must be validated to start with `https://` or `data:` before rendering. Any other scheme (`javascript:`, `file:`, etc.) is blocked by CSP but should also be filtered in code as defense-in-depth.
- **XSS via alt text:** the `alt` attribute on `<img>` must be escaped via `escapeAttr()`.
- **Emoji injection:** emoji characters are Unicode codepoints, not HTML. They pass through `escapeHtml` safely. No injection risk.

### Side Effects
- **Comment Manager (primary fix):** emoji-only and image-containing comments will now render visible content instead of blank bodies.
- **Mentions:** unaffected — tag block handling is unchanged.
- **Plain comments:** unaffected — no `comment` array, takes the `else` branch.
- **Linear comments:** unaffected — Linear uses a separate decoder (`_normalizeLinearComment`) and doesn't have structured block arrays.

### Dependencies & Conflicts
- **No new dependencies.** Pure TS + JS + CSS changes.
- **No migrations.** Display-only fix, no persisted state shape changes.
- **Backward compat:** comments without emoticon/attachment blocks are unaffected.
- **Depends on:** prior plan `feature_plan_20260625105934` (which fixed the text/tag block iteration and added the empty-body fallback). This plan extends the same decoder.

## Dependencies

- `feature_plan_20260625105934_fix-clickup-comment-text-blank-in-detail-panel.md` — prior plan that fixed text/tag block iteration in `_normalizeClickUpComment`. This plan extends the same function with `emoticon` and `attachment` block handling.

## Uncertain Assumptions

1. **Emoticon block `text` field format** — ClickUp docs show `"text": "U0001F60A"` for emoticon blocks. This appears to be a Unicode escape representation. Research needed: is this always `U` + 4-6 hex digits, or can it vary? The `emoticon.code` field (e.g., `"1f60a"`) is the raw hex codepoint and is more reliable for constructing the emoji character.
   - **Resolution:** Use `emoticon.code` (hex codepoint) as the primary source. Construct the emoji character via `String.fromCodePoint(parseInt(code, 16))`. Fall back to the `text` field if `emoticon.code` is absent.

2. **Attachment/image block shape** — undocumented. ClickUp may return `{"type": "attachment", "url": "...", "title": "..."}` or `{"type": "image", "image": "...", "url": "..."}` or something else entirely. The plan handles this defensively: look for common URL fields (`url`, `image`, `src`, `attachment`) on any block with `type` matching `attachment`/`image`/`file`.
   - **Resolution:** Defensive extraction. If no URL is found, show `[attachment]` placeholder text.

3. **Whether attachment blocks exist at all** — ClickUp may handle image comments purely as task-level attachments with no block in the `comment` array. In that case, the comment would have `comment_text: ""` and `comment: []` (empty array), and the empty-body fallback from the prior plan would produce blank. The `[attachment]` placeholder would not fire because there are no blocks to iterate.
   - **Resolution:** After the block loop, if `body` is still empty AND the comment has a non-empty `comment_text` fallback, use `comment_text`. If `comment_text` is also empty, show `[media comment]` as a last-resort placeholder so the user sees *something* rather than blank.

## Adversarial Synthesis

Key risks: (1) introducing `<img>` tags into the webview creates XSS surface — mitigated by URL scheme validation and `escapeAttr` on alt text; (2) the emoticon `text` field format is ambiguous (`"U0001F60A"` vs raw emoji) — mitigated by using `emoticon.code` as the primary source with `String.fromCodePoint`; (3) the attachment block shape is undocumented and may not exist — mitigated by defensive extraction with `[attachment]`/`[media comment]` placeholders; (4) the webview renderer currently expects `body` as a string and escapes it — this plan introduces a structured `bodyParts` array that allows safe mixing of text and images, with the renderer building HTML from typed parts instead of a single `escapeHtml` call.

The structured `bodyParts` approach is preferred over "just concatenate HTML" because it keeps the security boundary clear: text parts are escaped, image parts are URL-validated, and the renderer assembles them. This avoids the temptation to inject raw HTML into the body string.

## Proposed Changes

### File: `src/services/ClickUpSyncService.ts`

#### Change A — extend `_normalizeClickUpComment` with emoticon and attachment block handling

The thread shape currently has `body: string`. We add an optional `bodyParts: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>` field. The `body` string remains for backward compat (plain-text rendering, fallback, and any consumer that doesn't understand `bodyParts`).

Update the return type signature (`:1651-1658`) to include `bodyParts`:

```ts
  private _normalizeClickUpComment(comment: any): {
    id: string;
    author: { id: string; name: string; email: string };
    body: string;
    bodyParts?: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>;
    date: string;
    mentions: Array<{ id: string; name: string }>;
    replies: any[];
  } {
```

Update the block iteration (`:1666-1685`) to handle `emoticon` and `attachment`/`image` blocks:

```ts
    const mentions: Array<{ id: string; name: string }> = [];
    let body = '';
    const bodyParts: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }> = [];

    if (Array.isArray(comment?.comment)) {
      for (const block of comment.comment) {
        if (typeof block?.text === 'string' && (!block.type || block.type === 'text')) {
          body += block.text;
          bodyParts.push({ type: 'text', text: block.text });
        } else if (block?.type === 'tag') {
          const userId = String(block?.user?.id || block?.assignee || '').trim();
          const name = String(block?.user?.username || block?.text || '').trim();
          mentions.push({ id: userId, name });
          const mentionText = `@${name || userId}`;
          body += mentionText;
          bodyParts.push({ type: 'text', text: mentionText });
        } else if (block?.type === 'emoticon') {
          // ClickUp emoticon block: { type: "emoticon", text: "U0001F60A", emoticon: { code: "1f60a" } }
          // Construct the emoji character from the hex codepoint.
          const hexCode = String(block?.emoticon?.code || '').trim();
          let emoji = '';
          if (hexCode && /^[0-9a-fA-F]+$/.test(hexCode)) {
            try {
              emoji = String.fromCodePoint(parseInt(hexCode, 16));
            } catch { emoji = ''; }
          }
          if (!emoji && typeof block?.text === 'string') {
            // Fallback: try to decode "U0001F60A" format
            const m = block.text.match(/^U0*([0-9a-fA-F]+)$/);
            if (m) {
              try { emoji = String.fromCodePoint(parseInt(m[1], 16)); } catch { emoji = ''; }
            }
          }
          if (emoji) {
            body += emoji;
            bodyParts.push({ type: 'emoji', text: emoji });
          }
        } else if (block?.type === 'attachment' || block?.type === 'image' || block?.type === 'file') {
          // Defensive: undocumented block type. Extract URL from common fields.
          const url = String(block?.url || block?.image || block?.src || block?.attachment || '').trim();
          const alt = String(block?.title || block?.filename || block?.name || 'attachment').trim();
          if (url && (url.startsWith('https://') || url.startsWith('data:'))) {
            body += `[${alt}]`;
            bodyParts.push({ type: 'image', url, alt });
          } else {
            // No valid URL — show placeholder text
            body += `[${alt}]`;
            bodyParts.push({ type: 'text', text: `[${alt}]` });
          }
        }
      }
      // Fallback: if the structured array yielded no text, use comment_text.
      if (!body) {
        const fallback = String(comment?.comment_text || '').trim();
        if (fallback) {
          body = fallback;
          bodyParts.push({ type: 'text', text: fallback });
        } else {
          // Last-resort placeholder for media-only comments with no decodable blocks.
          body = '[media comment]';
          bodyParts.push({ type: 'text', text: '[media comment]' });
        }
      }
    } else {
      body = String(comment?.comment_text || '').trim();
      if (body) { bodyParts.push({ type: 'text', text: body }); }
    }
```

Update the return object (`:1687-1693`) to include `bodyParts`:

```ts
    return {
      id: String(comment?.id || '').trim(),
      author: {
        id: String(comment?.user?.id || '').trim(),
        name: String(comment?.user?.username || '').trim(),
        email: String(comment?.user?.email || '').trim()
      },
      body,
      bodyParts,
      date: String(comment?.date || '').trim(),
      mentions,
      replies: []
    };
```

Also update the `getCommentThreads` return type signature (`:1570-1585`) to include `bodyParts` on both the thread and reply shapes:

```ts
  public async getCommentThreads(taskId: string): Promise<{
    threads: Array<{
      id: string;
      author: { id: string; name: string; email: string };
      body: string;
      bodyParts?: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>;
      date: string;
      mentions: Array<{ id: string; name: string }>;
      replies: Array<{
        id: string;
        author: { id: string; name: string; email: string };
        body: string;
        bodyParts?: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>;
        date: string;
        mentions: Array<{ id: string; name: string }>;
      }>;
    }>;
    threadingSupported: boolean;
  }>
```

#### Change B — update `getTaskDetails` and `getTaskComments` comment shape (optional, defense-in-depth)

These methods (`:1242-1250`, `:1271-1278`) return comments in a simpler shape (`{ id, comment_text, user, date }`) that doesn't include structured blocks. They're used by the detail-load path, not the Comment Manager. Leave them as-is for now — they already read `comment_text` which ClickUp populates for text+emoji comments. If a comment is media-only, `comment_text` is empty and the detail view shows blank, but that's a pre-existing issue not introduced by this plan.

**Decision: Skip Change B.** The Comment Manager is the target surface. The detail-load path can be addressed in a future plan if needed.

### File: `src/webview/planning.js`

#### Change C — update `renderThreadHtml` and `renderReplyHtml` to render `bodyParts`

The current renderers (`:644-686`) do `escapeHtml(thread.body || '')`. We need to render `bodyParts` when available, falling back to `escapeHtml(body)` when not (backward compat for Linear and optimistic inserts).

Add a helper function near `renderThreadHtml`:

```js
    function renderCommentBodyHtml(thread) {
        // If bodyParts is available, render structured content (text + emoji + images).
        // Otherwise, fall back to escaped body string (Linear, optimistic inserts, old data).
        if (Array.isArray(thread.bodyParts) && thread.bodyParts.length > 0) {
            let html = '';
            for (const part of thread.bodyParts) {
                if (part.type === 'text') {
                    html += escapeHtml(part.text || '');
                } else if (part.type === 'emoji') {
                    // Emoji characters are Unicode — safe to render directly.
                    // escapeHtml won't mangle them (they're not <, >, or &), but
                    // we escape anyway for consistency in case of unexpected content.
                    html += escapeHtml(part.text || '');
                } else if (part.type === 'image') {
                    // Only allow https: and data: schemes (matches CSP img-src).
                    const url = part.url || '';
                    if (url.startsWith('https://') || url.startsWith('data:')) {
                        html += `<img src="${escapeAttr(url)}" alt="${escapeAttr(part.alt || 'attachment')}" class="cm-comment-image" />`;
                    } else {
                        html += escapeHtml(`[${part.alt || 'attachment'}]`);
                    }
                }
            }
            return html;
        }
        return escapeHtml(thread.body || '');
    }
```

Update `renderThreadHtml` (`:648`):

```js
        const bodyHtml = renderCommentBodyHtml(thread);
```

Update `renderReplyHtml` (`:677`):

```js
        const bodyHtml = renderCommentBodyHtml(reply);
```

### File: `src/webview/planning.html`

#### Change D — add CSS for inline comment images

Add after the `.cm-reply-body` rule (`:2918`):

```css
        .cm-comment-image {
            max-width: 100%;
            max-height: 300px;
            border-radius: 4px;
            margin: 4px 0;
            display: block;
            border: 1px solid var(--border-color);
        }
```

### File: `src/test/integrations/clickup/clickup-sync-service.test.js`

#### Change E — add unit tests for emoticon and attachment block decoding

Add two new test comments to the existing `getCommentThreads` test block (after the empty-array case at `:577`):

```js
                    {
                        // 5. Emoji-only comment:
                        id: 'comment-emoji-1',
                        comment_text: '',
                        comment: [
                            { text: 'U0001F60A', type: 'emoticon', emoticon: { code: '1f60a' } }
                        ],
                        user: { id: 'author-5', username: 'Author Five', email: 'author5@example.com' },
                        date: '1710000004000'
                    },
                    {
                        // 6. Image attachment comment (defensive — undocumented shape):
                        id: 'comment-image-1',
                        comment_text: '',
                        comment: [
                            { type: 'image', url: 'https://example.com/screenshot.png', title: 'screenshot.png' }
                        ],
                        user: { id: 'author-6', username: 'Author Six', email: 'author6@example.com' },
                        date: '1710000005000'
                    }
```

Update the thread count assertion from 4 to 6, and add assertions:

```js
            // 5. Emoji-only comment:
            assert.strictEqual(threads[4].id, 'comment-emoji-1');
            assert.strictEqual(threads[4].body, '😊');  // U+1F60A = 😊
            assert.strictEqual(threads[4].bodyParts[0].type, 'emoji');
            assert.strictEqual(threads[4].bodyParts[0].text, '😊');

            // 6. Image attachment comment:
            assert.strictEqual(threads[5].id, 'comment-image-1');
            assert.strictEqual(threads[5].body, '[screenshot.png]');
            assert.strictEqual(threads[5].bodyParts[0].type, 'image');
            assert.strictEqual(threads[5].bodyParts[0].url, 'https://example.com/screenshot.png');
            assert.strictEqual(threads[5].bodyParts[0].alt, 'screenshot.png');
```

### No backend message-passing changes required

The `PlanningPanelProvider.ts` (`:4966-4976`) passes `threads` through as-is via `postMessage`. The `bodyParts` array will be serialized automatically. No changes needed to the message shape.

### Confirm (do not change): no confirmation dialogs introduced
This change adds no `confirm()`/modal/two-click patterns, per CLAUDE.md.

## Verification Plan

> **Session directives:** Compilation and automated tests are skipped for this session. The test suite will be run separately by the user.

### Static checks
- `grep -n "type === 'emoticon'" src/services/ClickUpSyncService.ts` — should find the new emoticon branch.
- `grep -n "type === 'image'" src/services/ClickUpSyncService.ts` — should find the new image branch.
- `grep -n "bodyParts" src/services/ClickUpSyncService.ts` — should find bodyParts in the return type, the variable declaration, the push calls, and the return object.
- `grep -n "bodyParts" src/webview/planning.js` — should find bodyParts in `renderCommentBodyHtml`.
- `grep -n "cm-comment-image" src/webview/planning.html` — should find the CSS rule.
- `grep -n "renderCommentBodyHtml" src/webview/planning.js` — should find the helper function and its two call sites in `renderThreadHtml` and `renderReplyHtml`.

### Automated Tests
- **Extend the existing unit test** in `src/test/integrations/clickup/clickup-sync-service.test.js` with cases 5 (emoji-only) and 6 (image attachment) as described in Change E. Update thread count assertion. This test should be written as part of implementation but will be run by the user separately.

### Manual (installed VSIX)
1. **Emoji-only comment:** in ClickUp, post a comment on a task that contains only an emoji (no text). Open the Comment Manager overlay. Verify the emoji character renders (not blank, not `U0001F60A`).
2. **Text + emoji comment:** post a comment with text and an emoji. Verify both the text and emoji render in sequence.
3. **Text + mention + emoji:** post a comment with text, an @mention, and an emoji. Verify all three render in sequence.
4. **Image comment (if reproducible):** attach an image to a ClickUp comment. Open the Comment Manager. Verify either the inline image renders, or a `[attachment]`/`[media comment]` placeholder shows (depending on whether ClickUp returns a block in the `comment` array).
5. **Plain comment (regression):** open the Comment Manager on a task with a plain text comment. Verify body still renders correctly.
6. **Linear (regression):** open the Comment Manager on a Linear issue with comments. Verify author/body/date still render correctly (Linear path doesn't produce `bodyParts`, so `renderCommentBodyHtml` falls back to `escapeHtml(body)`).

---

**Recommendation:** Complexity 4 → **Send to Mid-level.** The backend decoder changes are straightforward (new `else if` branches), but the webview rendering change introduces a structured body format that requires careful XSS handling.
