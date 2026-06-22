# Feature Plan — Ticket Comment Manager (planning.html Tickets tab)

**Date:** 2026-06-22
**Status:** Awaiting build approval
**Scope:** Switchboard extension — `planning.html` Tickets tab, ClickUp + Linear

---

## Goal

Replace the existing single-shot **Comment** button with a full **comment manager** for the
selected ticket. The current system has three gaps:

1. It does not fetch comment **threads** (replies to comments) — only top-level comments.
2. It does not let you **reply** to a comment.
3. It does not let you **tag (@mention)** another user.

**Core problem & root-cause analysis:** The existing comment infrastructure (`postTicketComment` at `TaskViewerProvider.ts:18187`, `addTaskComment` at `ClickUpSyncService.ts:1469`, `addIssueComment` at `LinearSyncService.ts:1074`) is a single-shot plain-text POST with no threading, no structured mentions, and no read-back. Comments are fetched flat (`getTaskComments` at `ClickUpSyncService.ts:1259`, `getComments` at `LinearSyncService.ts:914`) and displayed as a simple list (`planning.js:6560-6568`). A prior iteration tried to persist comments into the ticket `.md` body so agents could read them — that approach is abandoned (round-trip/push-corruption risk; agents don't need this data). The new approach uses a local JSON cache (`_comments.json`) as a UI store, with the provider remaining the source of truth.

Comments are stored in a **JSON file in the list folder**, which populates a UI for reading
threads, replying, and tagging people. **Agents do not need access to this data** — it is a
UI/workflow feature, deliberately kept out of the `.md` ticket files.

## Metadata

**Tags:** [frontend, backend, api, ui, ux, feature]
**Complexity:** 7

## User Review Required

Yes — before build starts, the user must confirm:
1. **Build order preference:** Option A (whole feature) or Option B (ClickUp end-to-end first, then Linear).
2. **Mention notification behavior:** Real mentions ping the tagged user on the provider. Confirm this is desired in all flows (reply + new comment).
3. **API verification gates:** The plan assumes ClickUp v2 returns `reply_count` on comments and supports structured `comment` array blocks for mentions. Linear's in-body mention encoding must be resolved against the live API. If either assumption fails, the feature degrades to flat comments without threading/mentions (current behavior). User must accept this fallback.

## Complexity Audit

### Routine
- Extending the existing `postTicketComment` message handler (`PlanningPanelProvider.ts:4616`) to pass `mentions` and `parentId` through to the command.
- Registering new commands (`loadTicketComments`, `postTicketReply`) in `extension.ts` following the existing `postTicketComment` pattern (`extension.ts:1523`).
- JSON read/write helpers for `_comments.json` — standard `fs.readFileSync`/`fs.writeFileSync` with atomic write pattern.
- Replacing the Comment button toggle (`planning.js:6012-6022`) with a manager panel open action.
- Rendering thread list HTML in `planning.js` following the existing comment rendering pattern (`planning.js:6560-6568`).

### Complex / Risky
- **ClickUp structured mention format:** `POST /task/{id}/comment` must switch from `comment_text` (string) to `comment` (array of text/tag blocks). The tag block's `assignee` field takes a user ID (integer), not a username. Getting this wrong means mentions silently fail or ping the wrong person.
- **Linear mention encoding:** Linear's exact in-body mention syntax (UUID-based user references) must be resolved against the live API before build. If guessed wrong, mentions post as plain text and nobody is notified.
- **Linear thread rebuild:** Comments return flat with `parent { id }`. Replies whose parent isn't in the batch (orphan replies) must be bucketed, not dropped.
- **`_comments.json` path derivation:** Must be `path.dirname(foundTicketFilePath)` — NOT a reconstructed path from config hierarchy. Ticket files land in nested hierarchies that can't be reconstructed from live space/folder/list names.
- **Optimistic insert + refetch race:** A second reply posted while the first refetch is in flight can be overwritten by the stale refetch response.
- **Real notification side effects:** Mentions ping real users on the provider. A misclick or autocomplete mis-selection has real-world impact.
- **ClickUp reply fetch:** `GET /comment/{commentId}/reply` is a per-comment API call. A task with N top-level comments with replies requires N+1 API calls. Must batch or parallelize with rate-limit awareness (existing `_rateLimitDelay: 1000ms` at `ClickUpSyncService.ts:144`).

## Edge-Case & Dependency Audit

### Race Conditions
- **Optimistic insert vs. refetch:** If the user posts reply #2 while the refetch for reply #1 is in flight, the refetch response for #1 arrives after optimistic #2 is inserted and overwrites it. **Mitigation:** Use a simple in-flight refetch guard — track a `_pendingRefetchTicketId`; if a new optimistic insert arrives while a refetch is pending, mark the refetch response as stale and trigger a fresh refetch after the current one completes.
- **Concurrent JSON writes:** Two rapid posts to the same ticket could race on `_comments.json` write. **Mitigation:** Serialize JSON writes through a per-file write queue (or use the existing `stateLockfile` pattern from `stateConfigBridge`).

### Security
- **Real mention notifications:** `@mentions` ping real users on ClickUp/Linear. The mention picker must show real names (not just email/ID) to prevent mis-selection. `notify_all: false` must be preserved on ClickUp to avoid pinging the entire list.
- **No credential exposure:** All API calls go through existing `httpRequest` (ClickUpSyncService.ts:1799) and `graphqlRequest` (LinearSyncService.ts:1330) which never log the Authorization header. New methods must follow the same pattern.

### Side Effects
- **Provider write-back:** Every reply/comment post hits the live provider API. Failures must surface natively (`vscode.window.showErrorMessage`, matching the existing `pushTicket` error pattern at `PlanningPanelProvider.ts:4194`) and the optimistic UI must roll back.
- **Rollback UX spec:** On error, remove the optimistic comment from the thread list, re-open the compose/reply box with the draft text preserved, and show a native error message. The textarea content is NOT cleared on failure.

### Dependencies & Conflicts
- **ClickUp v2 API shape:** `GET /task/{id}/comment` must return `reply_count` on each comment for the threading fetch to work. **Verification gate:** Test with a real task that has replies before implementing `getCommentThreads`.
- **ClickUp structured comment format:** `POST /task/{id}/comment` must accept `comment` as an array of `{ type: 'text', text: '...' }` and `{ type: 'tag', assignee: <userId> }` blocks. **Verification gate:** Test with a real task before implementing `postComment` with mentions.
- **Linear `parent { id }` field:** The `getComments` GraphQL query must be extended to include `parent { id }`. Linear's API supports this — it's a standard field on comment nodes.
- **Linear mention syntax:** Must be resolved from Linear API docs or live testing. **Verification gate:** Post a test comment with a mention and verify the mentioned user receives a notification.
- **No conflict with existing `## Subtasks` boundary:** `pushTicketEdits` (TaskViewerProvider.ts:17800) strips both `## Comments` and `## Subtasks` sections. Step 0 removes only the `## Comments` clause; `## Subtasks` must remain (subtasks are still embedded in `importTaskAsDocument` at lines 17638/17650).

## Dependencies

- None — this is a self-contained feature plan. No dependent plans or sessions required.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) ClickUp/Linear API shape assumptions for threading and mentions are unverified — if wrong, the feature degrades to flat comments (current behavior, safe fallback). (2) `_comments.json` path must be derived from the found ticket file directory, not reconstructed from config — getting this wrong means the JSON is written to the wrong location and never read back. (3) Real mention notifications have side effects on real users — the mention picker must show real names and `notify_all: false` must be preserved. Mitigations: explicit API verification gates before each service method, derive JSON path from `path.dirname(foundTicketFilePath)`, cache members with TTL, use in-flight refetch guard for optimistic insert races, and specify rollback UX (remove optimistic entry, preserve draft, show native error).

## Decisions (confirmed with user)

1. **JSON granularity:** one `_comments.json` per **list folder** (leaf ticket folder), keyed by ticket id.
2. **Direction:** **two-way** — replies/mentions post to ClickUp/Linear, then the JSON is updated.
3. **Mentions:** **real mentions** — structured comment that notifies the tagged user on the provider.
4. **Providers:** **both** ClickUp and Linear.

## Step 0 — Revert the dead approach (prerequisite)

A prior iteration tried to persist comments into the ticket `.md` body so agents could read them.
That approach is abandoned (round-trip/push-corruption risk; agents don't need this data).

- **Revert** in `src/services/TaskViewerProvider.ts`:
  - `importTaskAsDocument` ClickUp branch (line 17647) — stop passing `details.comments` to `_buildClickUpImportPlanContent`. Pass `undefined` or remove the third argument.
  - `importTaskAsDocument` Linear branch (line 17625) — remove the `node.comments = await linear.getComments(id)` fetch and the surrounding try/catch (lines 17624-17628). Set `node.comments = []` or remove the `comments` field from the node object.
  - `pushTicketEdits` (line 17800) — remove only the `|| trimmed === '## Comments'` clause from the boundary check. **Keep** `## Subtasks` — subtasks are still embedded in `importTaskAsDocument` (lines 17638, 17650).
- **Keep** in `src/webview/planning.js`: the `detailsFetched` cache fix (lines 3502, 4005, 4139-4141) — separate, real bug. It's what makes the preview pane reliably display fetched comments rather than a stale empty stub.
- **Delete** `_mapClickUpComment` (TaskViewerProvider.ts:5185-5192) — it is dead code (defined but never called; `getTaskDetails` and `getTaskComments` both map comments inline).
- **Clarification:** `_buildCommentsSection` (TaskViewerProvider.ts:4804) and `_buildLinearImportPlanContent`'s call to it (line 4516) — after Step 0, `_buildClickUpImportPlanContent` no longer receives comments, so its `_buildCommentsSection` call (line 4791) will produce an empty section (harmless). `_buildLinearImportPlanContent` still calls it (line 4516) with `node.comments` — after Step 0, `node.comments` is `[]` or absent, so it also produces nothing. Both are harmless; leave them as safety nets.

## Data model — `_comments.json`

Location: **the directory of the found ticket file** — derived via `path.dirname(foundTicketFilePath)`.
The ticket file path is resolved by `_findTicketFilePath` (`PlanningPanelProvider.ts:1489`) or
`_findTicketDocument` (`TaskViewerProvider.ts:17738`), both of which recursively scan for the
`${provider}_${id}_` prefix. **Never reconstruct the path from config hierarchy** — tickets land
in nested folder hierarchies (sprints, custom save locations) that can't be rebuilt from live
space/folder/list names.

- ClickUp: `…/<space>/<folder>/<list>/_comments.json`
- Linear: `…/<team>/<project>/_comments.json`

Keyed by ticket id:

```json
{
  "version": 1,
  "provider": "clickup",
  "tickets": {
    "86d3cz53f": {
      "fetchedAt": "2026-06-22T05:32:42.477Z",
      "threads": [
        {
          "id": "<commentId>",
          "author": { "id": "", "name": "", "email": "" },
          "body": "",
          "date": "2026-06-22T…",
          "mentions": [ { "id": "", "name": "" } ],
          "replies": [
            {
              "id": "<replyId>",
              "author": { "id": "", "name": "", "email": "" },
              "body": "",
              "date": "2026-06-22T…",
              "mentions": [ { "id": "", "name": "" } ]
            }
          ]
        }
      ]
    }
  }
}
```

Replies are one level deep (matches both providers' threading model). The JSON is a cache/store —
the provider remains the source of truth; the JSON is refreshed on open/refresh and after each write.

**JSON write safety:** Use `fs.writeFileSync` with a temp-file-then-rename pattern (atomic write)
to prevent partial writes. Serialize writes per-file through a simple queue or the existing
`stateLockfile` pattern.

## Backend — service methods

### ClickUp (`src/services/ClickUpSyncService.ts`)

- `getCommentThreads(taskId)` — `GET /task/{id}/comment` for top-level comments (reuse existing `getTaskComments` at line 1259 as the base). **Verification gate:** Confirm the response includes `reply_count` on each comment. For each comment with `reply_count > 0`, `GET /comment/{commentId}/reply`; normalize into the thread shape above. Parallelize reply fetches with `Promise.all` but respect the existing `_rateLimitDelay` (1000ms, line 144) — use a simple concurrency limiter (e.g., batch of 5).
- `postComment(taskId, { commentText, mentions })` — extend or replace `addTaskComment` (line 1469). **Verification gate:** Confirm ClickUp v2 accepts `comment` as an array of `{ type: 'text', text: '...' }` and `{ type: 'tag', assignee: <userIdInteger> }` blocks. If verified, send the structured array; if not, fall back to `comment_text` with `@username` plain-text mentions (no notification, but visible). `notify_all: false` must be preserved.
- `replyToComment(commentId, { commentText, mentions })` — `POST /comment/{commentId}/reply` with the same structured format as `postComment`.
- `getListMembers(listId)` — `GET /list/{list_id}/member` to drive the mention picker. The `listId` is available from the task object (`task.list.id`, ClickUpTask interface line 82). Cache results per `listId` with a 5-minute TTL (matching the existing `_cachedProjects` pattern in LinearSyncService.ts:126).

### Linear (`src/services/LinearSyncService.ts`)

- Extend `getComments` (line 914) GraphQL to include `parent { id }` on each comment node. Comments return flat; rebuild threads client-side by `parentId`. **Orphan handling:** Replies whose `parent.id` isn't in the current batch go into an orphan bucket with a `console.warn`. Don't drop them.
- Extend `addIssueComment` (line 1074) to accept optional `parentId` and `mentions`. `commentCreate(input: { issueId, body, parentId? })` — add `parentId` for threaded replies. **Verification gate:** Confirm Linear's `commentCreate` mutation accepts `parentId` in the input.
- **Mention encoding (verification gate):** Linear's in-body mention syntax must be resolved from the Linear API docs or live testing. Historically Linear uses `<@uuid>` or `@name` syntax in comment bodies. Test with a real workspace: post a comment with a mention and verify the mentioned user receives a notification. If the encoding can't be resolved, fall back to plain `@name` text (visible but no notification).
- Members via the `users` query (workspace/team), to drive the mention picker. Cache with a 5-minute TTL (add a `_cachedMembers` field, matching the existing `_cachedProjects` pattern at line 126).

## Backend — message handlers + JSON store (`src/services/PlanningPanelProvider.ts`)

- `loadTicketComments` (new message handler) — fetch threads + members from the provider → write/update `_comments.json` in `path.dirname(foundTicketFilePath)` → post threads + members back to the webview. Resolve the ticket file path via `_findTicketFilePath` (line 1489). If the ticket file doesn't exist (not yet imported), skip JSON write and return threads + members directly.
- `postTicketReply` (new message handler) — write-back to the provider (reply with mentions) → refetch the affected thread → update `_comments.json` → notify webview. On error: return `{ success: false, error }` so the webview can roll back the optimistic insert and preserve the draft.
- `postTicketComment` (extend existing handler at line 4616) — add `mentions` to the message payload and pass through to the command. The command (`switchboard.postTicketComment`, extension.ts:1523) must be extended to accept `mentions` and pass to `TaskViewerProvider.postTicketComment` (line 18187), which in turn calls the service's `postComment` with mentions.
- JSON read/write helpers keyed by ticket id. **Path derivation:** Always use `path.dirname(this._findTicketFilePath(workspaceRoot, provider, id))` as the JSON directory. If the ticket file isn't found, fall back to `_getTicketDocumentDirs` (line 1413) first entry (the expected write location for new tickets).

## Backend — command registration (`src/extension.ts`)

- Register `switchboard.loadTicketComments` — calls `taskViewerProvider.loadTicketComments(workspaceRoot, data)`.
- Register `switchboard.postTicketReply` — calls `taskViewerProvider.postTicketReply(workspaceRoot, data)`.
- Extend `switchboard.postTicketComment` (line 1523) to accept `mentions` in the data payload.
- Follow the existing registration pattern (lines 1498-1526).

## Backend — TaskViewerProvider methods (`src/services/TaskViewerProvider.ts`)

- `loadTicketComments(workspaceRoot, { provider, id })` — fetch threads + members from the service, write `_comments.json`, return `{ threads, members }`.
- `postTicketReply(workspaceRoot, { provider, id, commentId, commentText, mentions })` — call service `replyToComment`, refetch thread, update JSON, return result.
- Extend `postTicketComment` (line 18187) to accept `mentions` and pass to service `postComment`.

## UI — Comment button → manager panel (`src/webview/planning.html` + `planning.js`)

- The **Comment** button (`planning.html:3381`, `planning.js:6012-6022`) opens a comment-manager panel (not a one-shot textarea). Replace the toggle behavior with a `vscode.postMessage({ type: 'loadTicketComments', provider, id, workspaceRoot })` call.
- Thread list: top-level comments, each with author + date + body, expandable to show replies. Render following the existing comment rendering pattern (`planning.js:6560-6568`) but with thread/reply nesting.
- Per-comment **Reply** affordance with a reply box (inline, below the comment).
- `@`-mention autocomplete in the compose/reply boxes, fed by the members list. Trigger on `@` keypress; show a dropdown of matching members (name + email); insert the mention as a structured token (not plain text) so the backend can map it to the provider's mention format.
- Posting calls `postTicketReply` or `postTicketComment` (extended); optimistic insert into the thread list, then reconcile from the provider refetch.
- **Optimistic insert + refetch guard:** Track a `_pendingRefetchTicketId` in the webview state. If a new optimistic insert arrives while a refetch is pending, mark the pending refetch as stale (set `_refetchStale = true`). When the refetch response arrives, if `_refetchStale` is true, discard it and trigger a fresh refetch. This prevents stale overwrites.
- **Rollback UX:** On `postTicketCommentResult` or `postTicketReplyResult` with `success: false`, remove the optimistic comment from the thread list, re-open the compose/reply box with the draft text preserved (store the draft before posting), and show the error. The existing `postTicketCommentResult` handler is at `planning.js:3643`.
- Read path is populated from the JSON store (fast), refreshed from the provider on open/refresh.
- Replace the existing `tickets-comment-input-area` (`planning.html:3389-3395`) with the manager panel container. The existing `btn-post-comment-cancel` and `btn-post-comment-submit` handlers (`planning.js:6090-6105`) are replaced by the manager panel's compose/reply handlers.

## Build order (user to choose)

- **Option A — whole feature** (ClickUp + Linear together).
- **Option B — ClickUp end-to-end first** (service → store → handlers → UI → write-back), verify,
  then replicate for Linear.

**Recommended:** Option B — ClickUp first. ClickUp's structured mention format is better documented
than Linear's, and the threading API (`GET /comment/{id}/reply`) is explicitly documented. Linear's
mention encoding is the highest-risk unknown; building ClickUp first validates the architecture
before tackling Linear's API quirks.

## Out of scope

- Agent access to comments (explicitly not needed; comments stay out of `.md` files).
- Editing/deleting existing comments (read + reply + mention only, unless requested later).

## Risks / notes

- Two-way write-back means UI actions hit the live provider — ensure failures surface natively and
  the optimistic UI rolls back on error.
- Mention notifications are real (they ping the tagged user); confirm this is desired in all flows.
- `_comments.json` is local cache; provider stays source of truth — never block the UI on a write.
- ClickUp reply fetch is N+1 API calls (one per top-level comment with replies). Parallelize with
  concurrency limiting to avoid rate-limit issues.

## Proposed Changes

### `src/services/ClickUpSyncService.ts`
- **Context:** Existing flat comment fetch (`getTaskComments` line 1259) and plain-text post (`addTaskComment` line 1469) need threading and structured mentions.
- **Logic:** Add `getCommentThreads(taskId)` (fetch top-level + parallelized reply fetches), `postComment(taskId, { commentText, mentions })` (structured `comment` array format), `replyToComment(commentId, { commentText, mentions })`, `getListMembers(listId)` (cached with TTL). Extend `addTaskComment` or replace it with `postComment`.
- **Implementation:** New methods after `getTaskComments` (line 1278). Use existing `httpRequest` (line 1799) and `retry` patterns. Add `_cachedListMembers: Map<string, { data: any[], fetchedAt: number }>` field with 5-minute TTL.
- **Edge Cases:** `reply_count` field absence (verification gate — fall back to flat). Rate limiting on parallel reply fetches (batch of 5). Mention `assignee` must be integer user ID, not username.

### `src/services/LinearSyncService.ts`
- **Context:** Existing flat comment fetch (`getComments` line 914) and plain-text post (`addIssueComment` line 1074) need threading and mentions.
- **Logic:** Extend `getComments` GraphQL to include `parent { id }`. Rebuild threads client-side with orphan bucket. Extend `addIssueComment` to accept `parentId` and `mentions`. Add `getTeamMembers()` (cached with TTL).
- **Implementation:** Modify `getComments` query (line 925-937) to add `parent { id }`. Add thread rebuild helper. Add `_cachedMembers` field with 5-minute TTL (matching `_cachedProjects` pattern at line 126).
- **Edge Cases:** Orphan replies (parent not in batch — bucket and warn). Mention encoding (verification gate — fall back to plain `@name` text if unresolved). `commentCreate` `parentId` support (verification gate).

### `src/services/TaskViewerProvider.ts`
- **Context:** Step 0 revert (lines 17625, 17647, 17800) + new `loadTicketComments`/`postTicketReply` methods + extend `postTicketComment` (line 18187).
- **Logic:** Remove comment embedding from `importTaskAsDocument`. Remove `## Comments` clause from `pushTicketEdits` (keep `## Subtasks`). Delete `_mapClickUpComment` (line 5185). Add `loadTicketComments` and `postTicketReply` methods. Extend `postTicketComment` to accept `mentions`.
- **Implementation:** JSON path derived from `path.dirname(await this._findTicketDocument(resolvedRoot, provider, id))`. JSON helpers: `_readCommentsJson(dir)`, `_writeCommentsJson(dir, data)` with atomic temp-file-rename.
- **Edge Cases:** Ticket file not found (not yet imported) — skip JSON write, return threads + members directly. JSON write race — serialize per-file. Refetch race — handled in webview (see UI section).

### `src/services/PlanningPanelProvider.ts`
- **Context:** New message handlers for `loadTicketComments` and `postTicketReply`; extend `postTicketComment` handler (line 4616).
- **Logic:** Add `loadTicketComments` case (fetch via command, post result to webview). Add `postTicketReply` case (call command, post result). Extend `postTicketComment` case to pass `mentions`.
- **Implementation:** Follow existing handler pattern (lines 4616-4642). Use `_findTicketFilePath` (line 1489) for JSON path derivation.
- **Edge Cases:** Missing workspace root or ID — return error result. Command failure — surface error to webview for rollback.

### `src/extension.ts`
- **Context:** Register new commands following existing pattern (lines 1498-1526).
- **Logic:** Register `switchboard.loadTicketComments` and `switchboard.postTicketReply`. Extend `switchboard.postTicketComment` (line 1523) to accept `mentions`.
- **Implementation:** One-line command registrations calling `taskViewerProvider` methods.
- **Edge Cases:** None — thin pass-through.

### `src/webview/planning.html`
- **Context:** Replace `tickets-comment-input-area` (lines 3389-3395) with manager panel container.
- **Logic:** New container `tickets-comment-manager` with thread list area, compose box, reply boxes, and mention autocomplete dropdown.
- **Implementation:** Replace the `tickets-comment-input-area` div with a richer structure. Add CSS for thread nesting, reply boxes, and autocomplete dropdown (following existing `.tickets-comment-item` styles at lines 2791-2812).
- **Edge Cases:** Theme compatibility — use CSS variables (`var(--border-color)`, `var(--panel-bg2)`, etc.) matching existing patterns. Cyber theme support (line 2849).

### `src/webview/planning.js`
- **Context:** Replace Comment button toggle (lines 6012-6022) and post handlers (lines 6090-6105) with manager panel logic. Extend `postTicketCommentResult` handler (line 3643).
- **Logic:** Comment button sends `loadTicketComments` message. New `ticketCommentsLoaded` message handler renders threads. Reply box per comment. Mention autocomplete on `@` keypress. Optimistic insert with refetch stale guard. Rollback on error.
- **Implementation:** New functions: `renderCommentManager(threads, members)`, `openReplyBox(commentId)`, `handleMentionAutocomplete(textarea)`, `optimisticInsertComment(comment)`, `rollbackOptimisticComment(comment)`. Track `_pendingRefetchTicketId` and `_refetchStale` for race guard.
- **Edge Cases:** Empty threads (show "No comments yet" placeholder). Member list empty (disable mention autocomplete, show hint). Refetch stale (discard and re-fetch). Draft preservation on error (store draft before post, restore on rollback).

## Verification Plan

### Automated Tests
- **Skipped per session directive.** The test suite will be run separately by the user.
- **Recommended test coverage (for user's separate run):**
  - `getCommentThreads` correctly fetches top-level + replies (mock ClickUp API with `reply_count`).
  - Linear thread rebuild from flat comments with `parent { id }` — including orphan replies.
  - `_comments.json` read/write helpers — atomic write, keyed by ticket id.
  - JSON path derivation from `path.dirname(foundTicketFilePath)`.
  - Optimistic insert + refetch stale guard logic.
  - Rollback UX — optimistic comment removed on error, draft preserved.
  - Mention autocomplete — `@` trigger, member filtering, token insertion.

### Manual Verification
- **ClickUp API verification gates:**
  1. `GET /task/{id}/comment` response includes `reply_count` on comments.
  2. `POST /task/{id}/comment` accepts `comment` array with `{ type: 'tag', assignee: <userIdInt> }` blocks.
  3. `POST /comment/{commentId}/reply` accepts the same structured format.
  4. `GET /list/{list_id}/member` returns member list with IDs and names.
- **Linear API verification gates:**
  1. `getComments` with `parent { id }` returns parent references.
  2. `commentCreate` with `parentId` creates a threaded reply.
  3. Mention encoding produces a real notification (test with a real workspace).
  4. `users` query returns team members with IDs, names, and emails.
- **End-to-end (ClickUp first, Option B):**
  1. Open a ticket with existing comments → threads render correctly.
  2. Post a new comment with `@mention` → comment appears, mentioned user is notified.
  3. Reply to a comment → reply appears nested under the parent.
  4. Post fails (disconnect network) → optimistic comment removed, draft preserved, error shown.
  5. `_comments.json` written to the correct directory (same as ticket `.md` file).
  6. Close and reopen the ticket → threads load from JSON cache, then refresh from provider.

---

**Recommendation:** Complexity is 7 (High) — **Send to Lead Coder**. This involves new API patterns (structured mentions, threaded replies), real notification side effects, multi-file coordination across 6 files, and a new UI panel with autocomplete. The API verification gates add uncertainty that a lead coder can navigate with fallback strategies.
