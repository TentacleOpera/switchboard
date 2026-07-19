# Remote content-pull for all providers (Notion, ClickUp) — not just Linear

## Goal

Make plan **content** (the plan body/description) sync *back* from remote boards to the local plan file for **every** remote provider — Notion and ClickUp — the way it already does for Linear. Today a plan's content is effectively one-way after creation: it is pushed out to the remote, and pulled *in* only once (when a brand-new remote card is first imported). Edits made to an existing plan's body on the remote never return, and an outbound content push can silently overwrite them.

### Problem Analysis (background + root cause)

**Why this matters now.** The remote system was designed when the remote surface was a place a *human* moved cards and left comments — the plan text was authored locally and mirrored out, so one-way content was fine. Since then the SaaS boards (Linear, Notion, ClickUp) shipped their own AI agents that can *rewrite a plan body in place*. A remote agent that deepens a plan's spec now has nowhere for that work to land: the extension never reads it back.

**Root cause — it's a gate, not a missing feature.** The content-pull mechanism already exists and is complete:

- `RemoteControlService._pollDescriptions()` (`src/services/RemoteControlService.ts`, L594–675) is a full, correct implementation: a per-issue description cursor (`remote.descriptionCursor.${kind}`), sha256 hash-based loop prevention, an empty-body guard ("never clobber with empty"), a 100 KB size guard, and H1-title preservation when rewriting the file.
- It is invoked every poll from `_poll()` (L312), right after `_pollState` and `_pollComments`.
- The dependency wiring in `KanbanProvider.ts` (`_getDescriptionCursors`/`_setDescriptionCursor` L2080–2097, `onDescriptionPulled` hash registration L2119–2123) is already **kind-generic** — it takes a `RemoteProviderKind` argument.

Two things restrict it to Linear:

1. **A hard gate:** `_pollDescriptions` returns early with `if (provider.kind !== 'linear') { return; }` (L601).
2. **Provider data:** the method reads `d.description` and `d.updatedAt` off the state deltas. `LinearRemoteProvider.fetchStateDeltas` populates them (`LinearRemoteProvider.ts` L78–79, inline GraphQL `description` + `updatedAt`). `NotionRemoteProvider.fetchStateDeltas` sets neither (`NotionRemoteProvider.ts` L91–119 — only `remoteId`, `stateKey`, `parentRemoteId`, `isFeatureCandidate`; `last_edited_time` is read at L115 but only feeds `nextCursor`).

> **Superseded:** "ClickUp likewise" (the original Problem Analysis implied ClickUp also fails to populate `description`/`updatedAt`).
> **Reason:** Verified against code — `ClickUpRemoteProvider.fetchStateDeltas` **already populates both** (`ClickUpRemoteProvider.ts` L84-94: `updatedAt` from `task.dateUpdated`→ISO, `description` from `task.markdownDescription`). ClickUp is not missing provider data; it is only blocked by the kind gate.
> **Replaced with:** Only Notion lacks the provider-data wiring. ClickUp is gate-only.

So the work is **generalizing an existing feature to two more providers**, not building content-pull from scratch. The subtlety is entirely in *how each provider supplies the body*, in not re-introducing echo loops or mass-overwrites, and in the fact that **ClickUp is already wired for the inline path** — the work there is verification, not implementation.

## Metadata

**Tags:** backend, feature, api
**Complexity:** 6

## User Review Required

Two product decisions are baked into this plan as defaults; flag them for confirmation:

1. **Conflict resolution = last-write-wins by timestamp**, no merge dialog. The owner has stated conflicts are expected to be rare and acceptable. The existing hash check already prevents *no-op* clobbers; a genuine divergence resolves in favour of whichever side changed more recently (remote pull overwrites local only when the remote's `updatedAt`/`last_edited_time` is newer than the per-issue cursor). No 3-way UI in this plan. **Forward-compatibility:** implement the resolution behind a **named seam** — a `ContentConflictResolver` interface (`shouldPull(remoteUpdatedAt, cursor, remoteBody, localBody): boolean`) with a single `LastWriteWinsResolver` implementation today, injected into the `RemoteControlService` deps alongside `getDescriptionCursors`/`setDescriptionCursor`. The follow-on `cross-platform-agent-collaboration` plan swaps in a locking/turn-taking resolver without touching `_pollDescriptions`. Concurrent edits are rare for one remote human but become the *normal* case once multiple agents collaborate on one plan.
2. **Gating:** content-pull rides the existing **Full** remote mode plus a new **"Poll content from remote"** toggle (parallel to the existing "Poll comments from remote" at `setup.html` L1471-1474 / `RemoteConfig.comments`), default **on** for new setups. Alternative: no toggle, always-on in Full mode. Recommend the toggle for symmetry and an escape hatch.

## Complexity Audit

### Routine
- Remove the `provider.kind !== 'linear'` gate in `_pollDescriptions` (`RemoteControlService.ts` L601).
- Populate `updatedAt` on Notion state deltas from `row.last_edited_time` (the value is already in hand at `NotionRemoteProvider.ts` L115, currently only feeding `nextCursor`).
- **Verify** (not implement) that ClickUp state deltas already carry `description` + `updatedAt` — `ClickUpRemoteProvider.ts` L84-94 already sets both from `task.markdownDescription` and `task.dateUpdated`. No code change unless the verification fails.
- Add the "Poll content from remote" setting + Setup Panel checkbox (`setup.html` + `RemoteConfig` + `setConfig`/`getConfig`), mirroring the `comments` toggle.
- Add the `ContentConflictResolver` seam + `LastWriteWinsResolver` default (small interface, one implementation, one injection point in `KanbanProvider._getRemoteControl`).

### Complex / Risky
- **Notion body fetch is not a single field.** A Notion page body must be assembled via `fetchBlocksRecursive` + `convertBlocksToMarkdown` (one+ extra API call per page). Inlining that into `fetchStateDeltas` would fetch every changed page's blocks on every poll. Introduce a **lazy** provider method `fetchDescription(remoteId)` (optional on `RemoteProvider`) that `_pollDescriptions` calls *only* for rows whose `updatedAt` is past that issue's description cursor. The implementation reuses the existing `importRemotePlan` path (`NotionRemoteProvider.ts` L415-417: `fetchPageTitle` + `fetchBlocksRecursive` + `convertBlocksToMarkdown`).
- **Notion round-trip fidelity → loop risk.** `markdown → Notion blocks → markdown` is lossy, so the existing sha256 echo guard (`newHash === existingHash` at `_pollDescriptions` L648-653, comparing the would-be-pulled content against the current local file) can mismatch even when nothing meaningfully changed, causing a pull↔push ping-pong.

  > **Superseded:** "Mitigation: compare against the **hash registered at push time** via the existing `onDescriptionPulled` loop-prevention registry (register the pushed content's hash on `pushContent`, not only on pull), rather than trusting a byte-identical re-render."
  > **Reason:** This does not solve the lossy case. Push markdown M → remote stores blocks B → next poll renders M' ≠ M → `hash(M') !== hash(M)` (the registered pushed hash) → the guard still fires → overwrite local with M' → watcher pushes M' → remote stores B' → poll renders M'' → ping-pong. The proposed comparison point moves but the inequality persists. The `ContinuousSyncService._externallyWrittenHashes` registry (L48, L64-65, push-side check L919-923/L982-986) already exists and is keyed by issueId→hash; it cannot make a lossy re-render match.
  > **Replaced with:** A **semantic** echo guard for Notion: query `last_edited_by` on the page in `fetchStateDeltas` (research-confirmed: Notion API returns `last_edited_by` directly on database-query page objects — no extra call; the provider already resolves `botId` at L127 and reads `created_by?.id` for comments at L151) and set a `selfEdited` flag on the delta when `last_edited_by?.id === botId`. In `_pollDescriptions`, skip the pull (advance cursor, write nothing) when `d.selfEdited` is true. Keep the existing `newHash === existingHash` byte guard as a second line for **Linear only** — research confirmed ClickUp's `markdownDescription` does NOT round-trip byte-identically (ClickUp normalizes on write), so the byte guard is unreliable for ClickUp echo prevention (see the next bullet for the ClickUp cursor-advance-on-push mitigation). This makes the bot's own push invisible to the Notion puller regardless of round-trip lossiness.

- **Cursor advance on push is Linear-only today — and ClickUp NEEDS it.** `ContinuousSyncService` calls `_onDescriptionSynced` only for Linear (`ContinuousSyncService.ts` L1001-1003 and L931-933). For ClickUp/Notion pushes, the description cursor is not advanced. **Research confirmed ClickUp's `markdownDescription` does NOT round-trip byte-identically** — ClickUp parses markdown to an internal rich-text format on write and reconstructs it on read, normalizing whitespace, stripping HTML, and adding extra paragraph spacing around headings/lists (Canny bug report: `markdown_description` paragraph spacing). The byte guard (`newHash === existingHash` at L648-653) WILL MISMATCH on ClickUp after every push → spurious pull → local file reformatted to ClickUp's normalized markdown → watcher pushes normalized version → ClickUp normalizes again → if normalization is idempotent, the loop settles after one spurious pull; if not, it ping-pongs. **AND ClickUp's v2 task object exposes NO `last_edited_by` / "last editor" field** (only `creator` + `date_updated`) — so the Notion `selfEdited` semantic guard is NOT available for ClickUp. **Mitigation:** extend `_onDescriptionSynced` to ClickUp (cursor advance on push, using the actual `date_updated` from the push response or a re-fetch — NOT `new Date().toISOString()` since ClickUp's `date_updated` may differ from local clock by seconds). With the cursor advanced to the post-push `date_updated`, the next poll's `d.updatedAt <= cursor` check skips the pull. Residual risk: if `date_updated` has sub-second skew relative to the cursor, one spurious pull may occur — accepted as a one-time reformat, not a ping-pong. Notion survives via the `selfEdited` semantic guard (the `selfEdited` skip advances the cursor). The coder must verify the cursor advances on every skip branch.

## Edge-Case & Dependency Audit

### Race conditions / data-loss
- **First-enable mass overwrite.** When content-pull turns on for an existing Notion/ClickUp remote, there is no description cursor yet. It MUST **seed-on-first-poll to "now"** (no history replay), exactly as the state and comment cursors already do (`_pollState`/`_pollComments` baseline when `!cursor`). **Mechanism — must be explicit:** `KanbanProvider._getDescriptionCursors` returns `{}` for both "never set" and "set but empty map" (via `getConfigJson` default `{}`). To distinguish them, `_pollDescriptions` must null-check the raw `db.getConfig(\`remote.descriptionCursor.${kind}\`)` directly: if it returns `null`/empty-string, this is a first-enable → baseline every current row's cursor to its `updatedAt` (or "now" if `updatedAt` is absent), persist, and pull nothing this cycle. If it returns a non-empty JSON object (even `{}`), proceed normally. Without this distinction, either (a) first-enable still mass-overwrites, or (b) every poll re-baselines and never pulls. This is the single most dangerous edge case.
- **Concurrent local agent write.** Plan files are "write-once-at-the-end" by the coding agent. A remote pull mid-run could overwrite an agent's fresh write (or vice-versa). Accepted as rare per the owner; last-write-wins via the `ContentConflictResolver` seam. The empty-body guard (`_pollDescriptions` L626) already prevents wiping a plan with a blank remote.
- **Echo guard on our own push.** `pushContent` bumps the remote `updatedAt`/`last_edited_time`; the next poll must not treat that as an inbound edit. Linear: handled by the existing `newHash === existingHash` byte guard (L648-653) + cursor advance on the skip branch. Notion: handled by the new `selfEdited` semantic guard (`last_edited_by === botId`, confirmed available on database-query page objects per Notion API reference). ClickUp: handled by cursor-advance-on-push (extending `_onDescriptionSynced` to ClickUp, using the actual `date_updated` from the push response — see Complex section above). The `ContinuousSyncService._externallyWrittenHashes` registry continues to gate the push side for all providers.

### Rate limits / cost
- Notion: use the **Markdown API** (`GET /v1/pages/{page_id}/markdown`) for `fetchDescription` — confirmed GA per Notion API reference ("Working with Markdown Content"). This is a single call per changed page (no block-fetch recursion), respects the existing `LIMITER_MS` pacing. The `last_edited_by` field rides the same `fetchStateDeltas` query (no extra call); the lazy `fetchDescription` only fires for rows past their cursor AND not `selfEdited`. Pages >20K blocks return `truncated: true` with `unknown_block_ids` — the coder should handle truncation (log + skip, or fall back to block-fetch for those rare cases).
- ClickUp: description arrives with the task query already used for state — no extra call (already shipped at L84-94). The cursor-advance-on-push mitigation may require a re-fetch of the task after `pushContent` to get the actual post-push `date_updated` (one extra GET per push) — OR the push response itself may include `date_updated` (verify the ClickUp API `PUT /v2/task/{task_id}` response shape).

### Dependencies & conflicts
- `RemoteStateDelta` (`RemoteProvider.ts` L19-34) already carries optional `description?`/`updatedAt?` (Linear and ClickUp populate them) — no type change needed for the inline path. Add two new optional fields: `selfEdited?: boolean` (Notion echo guard) and a `fetchDescription?(remoteId: string): Promise<{ body: string; updatedAt: string } | null>` method on the `RemoteProvider` interface (L107-182) for the lazy path.
- Cursor storage reuses `db.getConfig`/`setConfig` under `remote.descriptionCursor.${kind}` — new keys, unreleased for notion/clickup, so **no migration required** (clean addition). The first-enable null-check (above) reads the raw key, not the parsed JSON.
- ClickUp lacks the comment bus but that is orthogonal; content-pull is independent of comments.
- `RemoteConfig` (`RemoteControlService.ts` L40-55) gains a new `content: boolean` field (default true, parsed `parsed.content !== false` to mirror `comments` at L192). `DEFAULT_REMOTE_CONFIG` (L57-65) gains `content: true`. `setConfig` (L199-211) normalizes it. Clean addition, no migration.

## Dependencies

None blocking. Builds on the existing `_pollDescriptions` machinery and the per-kind cursor/hash wiring already in `KanbanProvider.ts` (L2080-2097, L2119-2123). Should land after any in-flight remote-sync work to avoid churn in `RemoteControlService.ts`.

## Adversarial Synthesis

**Key risks:** (1) Notion lossy round-trip ping-pong — the original hash-registration fix does not work and must be replaced with a `last_edited_by === botId` semantic echo guard (research-confirmed: `last_edited_by` is available on database-query page objects); (2) **ClickUp has the SAME lossy round-trip problem as Notion but NO `last_edited_by` field** — research confirmed `markdownDescription` does not round-trip byte-identically (ClickUp normalizes whitespace/spacing on write) and the v2 task object exposes no "last editor" identity; the byte guard will mismatch and the `selfEdited` guard is unavailable, so cursor-advance-on-push (extending `_onDescriptionSynced` to ClickUp) is the only mitigation, with a residual one-time-reformat risk if `date_updated` skews from the cursor; (3) first-enable mass-overwrite if the seed-on-first-poll null-check confuses "never set" with "empty map" — the raw `db.getConfig(key)` must be null-checked, not the parsed JSON; (4) ClickUp Phase 2 inline-data is already shipped — treat as verification, not new work, or the coder will "fix" already-correct code. **Mitigations:** Notion semantic echo guard (confirmed available) + Markdown API for clean body fetch; ClickUp cursor-advance-on-push using actual `date_updated`; explicit raw-key null-check for seeding; verify ClickUp inline path against L84-94 before touching it.

## Proposed Changes

### Phase 1 — Ungate the poller, add the conflict-resolver seam, keep Linear green
**File: `src/services/RemoteControlService.ts`**
- Remove `if (provider.kind !== 'linear') { return; }` from `_pollDescriptions` (L601).
- Replace the "read `d.description` off the delta" assumption with a resolver: use `d.description` when present (Linear/ClickUp inline path); otherwise, if `provider.fetchDescription` exists, call it lazily for rows where `d.updatedAt > cursors[d.remoteId]` AND `d.selfEdited !== true`.
- Add the **seed-on-first-poll** null-check: distinguish "no `remote.descriptionCursor.${kind}` key" from "empty map" by calling `db.getConfig(key)` directly (not `getDescriptionCursors`). On first-enable, baseline every current row's cursor to its `updatedAt` (or "now"), persist, and pull nothing this cycle.
- Add the `selfEdited` skip: when `d.selfEdited === true`, advance the cursor and continue (no write, no fetch). This is the Notion echo guard.
- Gate the whole method on the new `config.content` flag (mirror `_pollComments` L513: `if (!config.content) { return; }`).
- Add `contentConflictResolver?: ContentConflictResolver` to the deps interface (L~108). Use it for the pull/no-pull decision; fall back to `LastWriteWinsResolver` if absent.
- Regression check: Linear path must behave identically (inline description, `selfEdited` undefined → byte guard + resolver both pass, existing tests green).

**File: `src/services/KanbanProvider.ts`**
- Wire `contentConflictResolver: new LastWriteWinsResolver()` into `_getRemoteControl` deps (L2108-2126).

**File: `src/services/remote/RemoteProvider.ts`**
- Add `selfEdited?: boolean` to `RemoteStateDelta` (L19-34).
- Add optional `fetchDescription?(remoteId: string): Promise<{ body: string; updatedAt: string } | null>` to `RemoteProvider` (after L163 / `pushContent`).

**New file: `src/services/remote/ContentConflictResolver.ts`** (or co-locate in `RemoteControlService.ts` if small)
- `interface ContentConflictResolver { shouldPull(remoteUpdatedAt: string, cursor: string, remoteBody: string, localBody: string): boolean; }`
- `class LastWriteWinsResolver implements ContentConflictResolver { shouldPull(...) { return remoteUpdatedAt > cursor; } }`

### Phase 2 — ClickUp: verify inline data + add cursor-advance-on-push
**File: `src/services/remote/ClickUpRemoteProvider.ts`**
- **Verify** `fetchStateDeltas` (L84-94) already sets `updatedAt` (from `task.dateUpdated`→ISO) and `description` (from `task.markdownDescription`). No code change expected. If verification fails, fix to match. Do not introduce `text_content`/`date_updated` — those field names are wrong; the actual ClickUp API fields are `markdownDescription` and `dateUpdated`.
- No `fetchDescription` method needed (inline path).

**File: `src/services/ContinuousSyncService.ts`**
- **Extend `_onDescriptionSynced` to ClickUp.** Today the cursor-advance-on-push only fires for Linear (L1001-1003, L931-933). Research confirmed ClickUp's `markdownDescription` does NOT round-trip byte-identically (ClickUp normalizes whitespace/spacing on write — Canny bug report), so the byte guard (`newHash === existingHash`) WILL mismatch after every push. AND ClickUp's v2 task object has NO `last_edited_by` field, so the Notion `selfEdited` guard is unavailable. **Cursor-advance-on-push is the only ClickUp echo mitigation.** After `provider.pushContent` succeeds for ClickUp, call `_onDescriptionSynced(remoteId, <post-push date_updated>)`. Do NOT use `new Date().toISOString()` — ClickUp's `date_updated` may differ from the local clock by seconds, causing a timing-skew pull. Instead: either (a) read `date_updated` from the `PUT /v2/task/{task_id}` response body if it returns the updated task, or (b) re-fetch the task (`GET /v2/task/{task_id}`) immediately after push to get the authoritative `date_updated`. The extra GET is acceptable (one per push, not per poll). Set the description cursor to that value so the next poll's `d.updatedAt <= cursor` check skips the echo.
- **Residual risk (accepted):** if `date_updated` has sub-second skew relative to the stored cursor, one spurious pull may occur after a push — writing ClickUp's normalized markdown to the local file. This is a one-time reformat, not a ping-pong (the next poll's byte guard settles: local is now the normalized version, pulled is the same normalized version, `newHash === existingHash` → skip). Document this in the docs (Phase 6) as a known ClickUp behavior.

### Phase 3 — Notion Markdown API + semantic echo guard
**Files: `src/services/remote/NotionRemoteProvider.ts`, `src/services/RemoteControlService.ts`**
- In `fetchStateDeltas` (`NotionRemoteProvider.ts` L91-119): set `updatedAt` on each delta from `row.last_edited_time` (already read at L115). Also set `selfEdited: String(row.last_edited_by?.id || '') === botId` — research confirmed `last_edited_by` is returned directly on page objects from `POST /v1/databases/{id}/query` (no extra API call needed; Notion API reference — "The Page Object"). `botId` is already resolved at L127 for comments — hoist it so `fetchStateDeltas` can use it.
- Add `fetchDescription(remoteId)` using the **Notion Markdown API** (`GET /v1/pages/{page_id}/markdown`) — research confirmed this is GA (Notion API reference — "Retrieve a Page as Markdown" / "Working with Markdown Content"). This replaces the block-fetch + `convertBlocksToMarkdown` round-trip with a single API call that returns the page body as Notion-flavored markdown directly. Return `{ body, updatedAt }` where `updatedAt` is the page's `last_edited_time` (from the same response or a lightweight page retrieve). Handle `truncated: true` responses (pages >20K blocks) — log and skip, or fall back to `fetchBlocksRecursive` for those rare cases.
- **Migrate `pushContent` to the Markdown API too** (`PATCH /v1/pages/{page_id}/markdown`) — research confirmed this endpoint is GA ("Update a Page's Content as Markdown"). This replaces the current block-append push path at `NotionRemoteProvider.ts` L400-405 with a direct markdown write. The `selfEdited` guard is still required: the bot's own push bumps `last_edited_time` and sets `last_edited_by = botId`, so the next poll's `selfEdited` skip catches it regardless of whether the markdown round-trip is lossy (Notion-flavored markdown may also normalize).
- **Fallback:** if the Markdown API is unavailable for a specific workspace/page (e.g. integration lacks content capabilities), fall back to the existing `fetchBlocksRecursive` + `convertBlocksToMarkdown` path (the one `importRemotePlan` uses at L415-417). The `selfEdited` guard works either way.
- On `pushContent`: no special hash registration needed — the `selfEdited` semantic guard on the pull side handles the echo. The existing `ContinuousSyncService._externallyWrittenHashes` push-side check (L919-923) stays as-is.

### Phase 4 — Setting + UI
**Files: `src/services/RemoteControlService.ts` (`RemoteConfig` L40-55, `DEFAULT_REMOTE_CONFIG` L57-65, `getConfig` L180-197, `setConfig` L199-211), `src/webview/setup.html` (beside L1471-1474)**
- Add `content: boolean` to `RemoteConfig` (default true, parsed `parsed.content !== false`).
- Add "Poll content from remote" checkbox beside "Poll comments from remote" in `setup.html`; wire it into the config save/load (mirror the `remote-comments` handling at L5487/L5510).
- Persist in the Kanban DB under `remote.config` like the other remote flags. No `settings.json`.

### Phase 5 — Tests (skipped per session directive — listed for completeness)
- Unit: ClickUp `fetchStateDeltas` populates `updatedAt` + `description` (verify existing behavior); Notion `fetchStateDeltas` populates `updatedAt` + `selfEdited` (bot vs. human editor); Notion `fetchDescription` via Markdown API returns body + handles `truncated: true`; seed-on-first-pull pulls nothing on first enable (raw-key null-check); `selfEdited` skip advances cursor without writing; `newHash === existingHash` byte guard no-ops an own-push round-trip (Linear); ClickUp cursor-advance-on-push prevents echo pull (mock `date_updated` skew); `LastWriteWinsResolver` pulls on genuine divergence, skips when remote is older. Extend `src/test/integrations/notion/*` and add a ClickUp equivalent.
- **Note:** Per the session directive for this plan, automated tests are NOT run as part of the verification plan. They are listed here so a follow-on session can pick them up; the coder should still write them.

### Phase 6 — Docs (REQUIRED — do not skip; cross-repo)

**This lands in the `switchboard-site` repo, on the same branch name.** Edit `src/pages/docs/integrations/remote-boards.md` — the coder must make these exact edits as part of this change:

1. **Provider table (`## Choosing a provider`, L21-25).** The "Full two-way" claims were only ever true for *state + comments* — content was push-only. Make them accurate now that content pulls back:
   - **Linear** row (L23) — after "mirror, dispatch, comments, and push", add that **plan content now syncs both ways** (remote body edits pull back, last-write-wins).
   - **Notion** row (L24) — same addition: content is now bidirectional, not just state + comments.
   - **ClickUp** row (L25) — it currently says "Two-way for card state"; extend to note **content also syncs both ways** now (it still lacks the comment bus — keep that caveat).
2. **Options section (`### Options`, L38-43).** Add a new bullet beside "Poll comments from remote" (L41):
   - **Poll content from remote** — ingest remote edits to a plan's body and write them to the local plan file (last-write-wins; off by default until seeded to "now" on first enable).
3. **Add a one-line conflict note** under the options: content sync is **last-write-wins by timestamp** — whichever side edited more recently wins; concurrent edits are assumed rare.
4. **Add a ClickUp normalization caveat** under the options or the ClickUp provider row: ClickUp normalizes markdown on write (whitespace, paragraph spacing) — a local push may cause one spurious pull that reformats the local plan file to ClickUp's normalized markdown; this is a one-time reformat, not a loop. Notion and Linear do not have this issue (Notion uses the Markdown API with a `last_edited_by` echo guard; Linear round-trips byte-identically).
5. **DO NOT change L58** ("Switchboard is the source of truth: remote edits to the **context page** are overwritten"). That's the Project Context page (PRDs/constitution/dev docs), which stays push-only — it is a *different* thing from plan content. Leave it exactly as is.

Match the final toggle name and default to whatever Phase 4 actually ships, so the doc matches the UI.

## Verification Plan

### Automated Tests
Per the session directive for this plan, **automated tests are NOT run as part of the verification plan.** The tests described in Phase 5 above are the intended coverage and should be written by the coder, but they are not a verification gate for this plan. A follow-on session may run them.

### Manual Verification
1. **Linear regression (must stay green).** With `provider.kind === 'linear'` and the gate removed: edit a Linear issue description on the remote → within one poll cycle the local plan file updates. Edit the local plan file → it pushes to Linear and does NOT ping-pong (the `newHash === existingHash` byte guard advances the cursor on the next poll's skip branch).
2. **ClickUp inline path + cursor-advance-on-push.** With the gate removed: edit a ClickUp task's `markdownDescription` on the remote as a *human* → within one poll cycle the local plan file updates. Confirm `ClickUpRemoteProvider.fetchStateDeltas` L84-94 is the source (no new code for inline data). Edit local → pushes to ClickUp → `_onDescriptionSynced` fires with the actual post-push `date_updated` → next poll's `d.updatedAt <= cursor` skips the echo. **Accepted residual:** if `date_updated` skews from the cursor by sub-seconds, one spurious pull may occur — writing ClickUp's normalized markdown to local. Verify this is a one-time reformat, NOT a ping-pong (the second poll's byte guard must settle: local is now normalized, pulled is the same normalized, `newHash === existingHash` → skip).
3. **Notion Markdown API pull + semantic echo guard.** Edit a Notion plan page body as a *human* → within one poll cycle the local plan file updates (lazy `fetchDescription` fires via `GET /v1/pages/{id}/markdown`, `selfEdited` is false because `last_edited_by !== botId`). Edit the local plan file → it pushes to Notion via `PATCH /v1/pages/{id}/markdown` → on the next poll, `last_edited_by === botId` → `selfEdited` true → cursor advances, **no write**, no ping-pong. Research confirmed `last_edited_by` is present on database-query page objects (no extra API call).
4. **First-enable seed (the dangerous one).** On a Notion/ClickUp remote with existing cards and NO `remote.descriptionCursor.${kind}` key in the DB: enable "Poll content from remote" → first poll must baseline all cursors to "now" and pull **nothing**. Confirm via the raw `db.getConfig(key)` null-check that the second poll proceeds normally (only genuinely-changed-since-seed rows pull). A mass-overwrite here is a release blocker.
5. **Setting toggle.** Untick "Poll content from remote" → `_pollDescriptions` returns early (mirror `_pollComments` L513). Retick → resumes.
6. **Conflict-resolver seam.** Confirm `LastWriteWinsResolver` is injected and that swapping it for a stub that always returns `false` blocks all pulls (proves the seam is real, not vestigial).
7. **Docs (cross-repo).** `switchboard-site` `remote-boards.md` edits land on the same branch; L58 (context page) is untouched.

## Definition of Done
- Editing an existing plan's body in Notion or ClickUp updates the local plan file within one poll cycle, on par with Linear.
- Enabling the feature on an existing remote does not retroactively overwrite local plans (seed-on-first-poll verified via the raw-key null-check).
- No pull↔push loop on any provider. Notion: semantic `last_edited_by === botId` guard (research-confirmed available). ClickUp: cursor-advance-on-push using actual `date_updated` (byte guard alone is insufficient — research confirmed `markdownDescription` does not round-trip byte-identically). Linear: byte guard (unchanged).
- **ClickUp accepted residual:** a push may cause one spurious pull that reformats the local file to ClickUp's normalized markdown; the second poll must settle (no ping-pong). Document this in the docs.
- Notion `fetchDescription` + `pushContent` use the Markdown API (`GET`/`PATCH /v1/pages/{id}/markdown`), with block-fetch fallback for `truncated: true` or missing content capabilities.
- Linear behaviour unchanged; existing remote tests green (when run).
- `ContentConflictResolver` seam is in place with `LastWriteWinsResolver` as the default; the follow-on `cross-platform-agent-collaboration` plan can swap resolvers without touching `_pollDescriptions`.
- **`switchboard-site` `remote-boards.md` updated per Phase 6** (provider table + "Poll content from remote" option + last-write-wins note + ClickUp normalization caveat; context-page line untouched), committed on the same branch.

## Research Findings (web-research confirmed)

All three assumptions flagged in the initial plan were resolved via web research. No remaining uncertainties:

1. **Notion `last_edited_by` on database queries — CONFIRMED.** The Notion API returns `last_edited_by` (Partial User object with `id`) and `last_edited_time` directly in the root of page objects returned by `POST /v1/databases/{id}/query`. No separate retrieve call needed. The `selfEdited` semantic echo guard works as designed with zero extra API calls. (Citation: Notion API Reference — "The Page Object", "Query a Database".)
2. **Notion Markdown API — CONFIRMED GA.** Notion supports reading/writing page content as "Enhanced Markdown" via `GET /v1/pages/{page_id}/markdown` (read), `PATCH /v1/pages/{page_id}/markdown` (update), and `POST /v1/pages` with `markdown` body (create). Standard Bearer auth, requires read/write content capabilities. Pages >20K blocks return `truncated: true` + `unknown_block_ids`. Covers database pages/rows (database rows are pages in the Notion API). The plan now uses this as the PRIMARY path for `fetchDescription` and `pushContent`, replacing the block-fetch + `convertBlocksToMarkdown` round-trip. The `selfEdited` guard is still required (bot's push bumps `last_edited_time`). (Citation: Notion API Reference — "Working with Markdown Content", "Retrieve a Page as Markdown", "Update a Page's Content as Markdown".)
3. **ClickUp `markdownDescription` round-trip fidelity — REFUTED (does NOT round-trip byte-identically).** ClickUp parses incoming markdown to an internal rich-text format on write and reconstructs it on read, normalizing whitespace, stripping HTML, and adding extra paragraph spacing around headings/lists (Canny bug report). AND the ClickUp v2 task object does NOT expose a "last editor" user id (only `creator` + `date_updated`). The byte guard (`newHash === existingHash`) WILL mismatch after every push, and the `selfEdited` semantic guard is NOT available for ClickUp. The plan now uses cursor-advance-on-push (extending `_onDescriptionSynced` to ClickUp, using the actual post-push `date_updated`) as the primary echo mitigation, with an accepted one-time-reformat residual. (Citation: ClickUp API Reference — "Get Task", "Update Task"; Canny bug report — `markdown_description` paragraph spacing.)

---

**Recommendation:** Complexity 6 → **Send to Coder**. The shape is right; the real work is the Notion Markdown API migration + semantic echo guard, the ClickUp cursor-advance-on-push (the byte guard alone is insufficient — research confirmed), the seed-on-first-poll null-check, the conflict-resolver seam, and the docs. All three research questions are resolved — no remaining uncertainties. The coder can proceed directly on all phases.

---

## Completion Summary

Implemented bidirectional plan-content pull for all three remote providers (Linear, Notion, ClickUp), generalizing the existing Linear-only `_pollDescriptions` machinery. The `provider.kind !== 'linear'` gate is removed; a `ContentConflictResolver` seam (`LastWriteWinsResolver` default) is injected via `RemoteControlService` deps so a follow-on plan can swap resolvers without touching the poller. A `content` boolean (default on) is added to `RemoteConfig` with a matching "Poll content from remote" checkbox in `setup.html`. Seed-on-first-poll uses a raw `db.getConfig(key)` null-check to distinguish "never set" from "empty map", preventing mass-overwrite on first enable. Notion uses the GA Markdown API (`GET`/`PATCH /v1/pages/{id}/markdown`) for `fetchDescription` + `pushContent` with a `last_edited_by === botId` semantic echo guard (block-fetch fallback for truncated/missing-capability cases). ClickUp's inline `description`+`updatedAt` (already shipped at L84-94) was verified; cursor-advance-on-push was added by extending `_onDescriptionSynced` to a kind-routed callback and using the authoritative post-push `date_updated` (returned from `syncPlanContent`'s PUT response on the legacy path, and via a lightweight `getTaskDateUpdated` re-fetch on the unified `_syncToRemote` path). Tests (Phase 5) were not written per the session's SKIP TESTS directive — listed in the plan for a follow-on session.

**Files changed (switchboard):** `src/services/remote/ContentConflictResolver.ts` (new), `src/services/remote/RemoteProvider.ts` (`selfEdited` on delta + `fetchDescription?` on interface), `src/services/RemoteControlService.ts` (ungate, `content` config, resolver dep, seed-on-first-poll, selfEdited skip, lazy fetch), `src/services/KanbanProvider.ts` (wire resolver + kind-routed callback), `src/services/ContinuousSyncService.ts` (kind-routed `_onDescriptionSynced`, ClickUp cursor-advance, `_fetchClickUpDateUpdated`), `src/services/ClickUpSyncService.ts` (`dateUpdated` from PUT response + `getTaskDateUpdated`), `src/services/remote/NotionRemoteProvider.ts` (`updatedAt`+`selfEdited` on deltas, `fetchDescription` via Markdown API, `pushContent` via Markdown API with fallback), `src/services/NotionFetchService.ts` (`fetchPageMarkdown` + `updatePageMarkdown`), `src/webview/setup.html` (toggle + wiring).

**Files changed (switchboard-site, same branch name):** `src/pages/docs/integrations/remote-boards.md` (provider table + "Poll content from remote" option + last-write-wins note + ClickUp normalization caveat; context-page line L63 untouched).

**Issues encountered:** None blocking. The `_onDescriptionSynced` callback signature changed from `(issueId, ts)` to `(kind, issueId, ts)` — all call sites updated. ClickUp's `syncPlanContent` return type widened to include optional `dateUpdated`. No compilation or tests were run per the session directives (SKIP COMPILATION, SKIP TESTS).
