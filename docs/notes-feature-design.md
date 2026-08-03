# Notes Feature — Design Doc

**Author:** PLANNER (workspace `sb-notes-plan`)
**Status:** Design only — no implementation in this branch.
**Date:** 2026-08-03

---

## Goal

Give Switchboard a first-class **Notes** subsystem for jotting down plans and meeting
minutes during the day, that both humans **and agents** can read and write, and that
the periodic orchestrator tick consumes to take **note-driven actions** (prep an
upcoming meeting, summarize/reorganize stale notes, produce a daily briefing).

Three concrete deliverables:

1. **A persistent notes store** — dead-simple, file-based, mirroring `.switchboard/plans/`.
2. **Read + write access for agents** — new LocalApiServer verbs mirroring the
   `POST /planning/verb/<name>` rail, backed by a new `NotesService`.
3. **A tick hook** — on each orchestration wake, inject a compact **NOTES DIGEST**
   into the wake prompt and instruct the orchestrator to act on it.

### Problem / background / root-cause analysis

- **There is no notes subsystem today.** Verified: the repo has no notes store, no
  notes verbs, and **no MCP server** (MCP was deliberately removed 2026-05; the
  extension scrubs Switchboard MCP entries). This design **does not** add an MCP
  server — that would re-introduce the exact thing that was removed.
- **The proven agent-facing store pattern is `.switchboard/plans/`**: markdown files
  with `**Field:**` embedded metadata, parsed by regex (no YAML front-matter block,
  no markdown lib), watched on disk, and read/written over the LocalApiServer HTTP
  surface. Notes should mirror this pattern beat-for-beat so it is immediately legible
  to every existing agent and needs no new dependencies.
- **The orchestrator wake prompt is currently a fixed string** (`TaskViewerProvider._enqueueOrchestrationWake`,
  ~line 10768) — it carries no board/plan/notes context. That single line is the one
  hook point where a notes digest must be injected; without it the tick has no way to
  "consume" notes.
- **New feature ⇒ unreleased ⇒ no migrations.** Nothing here has ever shipped, so the
  store can take a clean design with no compat shims (per CLAUDE.md migration policy).

### Non-goals / hard constraints

- **No MCP.** No new npm dependencies (`uuid`, `crypto`, `fs`, `path`, `vscode` are
  already available and sufficient).
- **No confirmation dialogs anywhere** (hard project rule). Delete verbs and the UI
  delete button delete immediately — no `confirm()`, no `showWarningMessage` gate.
  (`window.confirm()` is a silent no-op in VS Code webviews anyway.)
- **No DB.** Notes are plain files, like memo/plans — not a `kanban.db` table. This
  keeps remote/DB-less agents able to read/write them and keeps the store trivially
  inspectable.
- Cohesive & reviewable: `NotesService` + LocalApiServer wiring + small sidebar UI +
  tick digest + SKILL.md/catalog docs + contract test.

---

## 1. Store layout + front-matter schema

### Directory layout

```
.switchboard/notes/
  plans/                     # day-to-day plan jottings
    <slug>-<uuid>.md
  meetings/                  # meeting minutes + scheduled meetings
    <slug>-<uuid>.md
  briefings/                 # agent-authored daily briefings (tick output)
    <slug>-<uuid>.md
```

- The store root is `path.join(workspaceRoot, '.switchboard', 'notes')`, resolved the
  same way `plans` is (`PlanIngestionEngine`/`PlanFileImporter` use
  `path.join(workspaceRoot, '.switchboard', 'plans')`).
- **Subdir = "kind".** Three seeded kinds: `plans`, `meetings`, `briefings`. `kind` is
  derived from the immediate subdir name, so adding a kind is just `mkdir` — no schema
  change. Unknown subdirs are tolerated and surfaced with their dir name as `kind`.
- Directories are created lazily on first write (`fs.mkdir(..., { recursive: true })`),
  exactly like the plans dir is tolerated-if-absent on read.

### File format (mirror plans — `**Field:**` regex metadata, NOT YAML)

The plans store deliberately uses **embedded `**Field:**` lines parsed by regex**
(`planMetadataUtils.extractEmbeddedMetadata`, regex
`/^(?:>\s+)?\*\*${label}:\*\*\s*(.+)$/im`) rather than a YAML front-matter block or a
markdown library. Notes use the identical convention so the same parser style applies
and no dependency is added.

A note file:

```markdown
# Weekly sync with Platform team

**Note ID:** 6b1e...-uuid
**Kind:** meeting
**Created:** 2026-08-03T09:12:00.000Z
**Updated:** 2026-08-03T09:40:12.000Z
**Tags:** platform, sync
**When:** 2026-08-05T15:00:00.000Z

## Body

- Agenda item 1 …
- Action: follow up with …
```

Schema (all metadata via embedded `**Field:**` lines; the H1 is the title):

| Field | Where | Required | Notes |
|---|---|---|---|
| Title | H1 `# …` (first line) | yes | Mirrors plans' topic extraction (`/^#\s+(.+)$/m`). |
| `**Note ID:**` | metadata line | generated | `uuidv4()` if absent (mirrors `**Plan ID:**`). Also encoded in filename. |
| `**Kind:**` | metadata line | derived | Redundant with subdir; subdir wins on conflict. `plan` \| `meeting` \| `briefing` \| `<dir>`. |
| `**Created:**` | metadata line | on write | ISO-8601. Set once at create. |
| `**Updated:**` | metadata line | on write | ISO-8601. Rewritten on every write/append. |
| `**Tags:**` | metadata line | optional | Comma-separated free text (notes do NOT enforce the plans `ALLOWED_TAGS` whitelist — notes are free-form). |
| `**When:**` | metadata line | meetings only | ISO-8601 datetime of the meeting. Drives the tick's "upcoming meetings" lookahead. Ignored/absent for non-meeting kinds. |
| Body | everything after metadata | optional | Free markdown. |

- **Filename:** `<slug>-<uuid>.md`, where `slug` is the title lowercased,
  non-alphanumerics → `-`, trimmed, capped at 60 chars (identical to
  `importRemotePlan.ts`'s slug logic), and `uuid` is the note id. This makes the id
  recoverable from the filename (mirrors how feature files embed a uuid in the name).
- **ID generation:** `uuidv4()` from the already-present `uuid` dep (or
  `crypto.randomUUID()`), matching plan-id generation.
- **Parsing:** a `parseNoteMetadata(content, kind)` helper in the notes module, built
  in the style of `planMetadataUtils.parsePlanMetadata` — regex for the H1 title and
  each `**Field:**` line. No YAML, no markdown lib.

---

## 2. API surface — `POST /notes/verb/<name>` → `NotesService`

Mirrors the plans/verb rail exactly: a single prefix route on `LocalApiServer`,
dispatched to a `notesVerb` callback option, wired in `TaskViewerProvider` to
`NotesService.handleServiceVerb(verb, payload)`.

### Envelope conventions (unchanged from the rest of the server)

- Request body is JSON. `workspaceRoot` optional in body (defaults to the server's
  workspace root — same as `_handlePlanningVerb`). `type` and `bypassTriggerGate` are
  stripped by the server before dispatch; `apiOriginated: true` is stamped.
- Response: `{ success: true, ... }` on success (HTTP 200), `{ success: false, error }`
  on failure (HTTP 502 for a handled failure, 500 for a thrown error) — identical to
  `_handlePlanningVerb`.

### Verb list

All verbs are `POST /notes/verb/<name>` with a JSON body.

| Verb | Request body | Response `data` | Purpose |
|---|---|---|---|
| `list` | `{ kind?, limit?, workspaceRoot? }` | `{ notes: NoteMeta[] }` | List note metadata (no body), newest-`Updated` first. `kind` filters to one subdir; omit for all. `limit` caps count. |
| `read` | `{ id, workspaceRoot? }` | `{ note: NoteFull }` | One note including full markdown `content`. |
| `search` | `{ query, kind?, limit?, workspaceRoot? }` | `{ notes: NoteMeta[] }` | Case-insensitive substring match over title + tags + body. |
| `write` | `{ id?, kind, title, body?, tags?, when?, workspaceRoot? }` | `{ note: NoteMeta }` | Create (no `id`) or full-replace (with `id`) a note. Sets `Created` on create, always refreshes `Updated`. Returns the stored metadata incl. assigned `id`/`file`. |
| `append` | `{ id, text, workspaceRoot? }` | `{ note: NoteMeta }` | Append `text` (a paragraph) to the note body and refresh `Updated`. Cheap "add a line" path for agents and the tick. |
| `delete` | `{ id, workspaceRoot? }` | `{ deleted: true, id }` | Delete the note file immediately. **No confirmation.** |
| `upcoming` | `{ withinMinutes?, workspaceRoot? }` | `{ meetings: NoteMeta[] }` | Meetings whose `When` falls within `now .. now+withinMinutes` (default 1440 = 24h), soonest first. Powers the digest and agent meeting-prep. |
| `digest` | `{ lookaheadMinutes?, recentLimit?, workspaceRoot? }` | `{ digest: string, recentCount, upcomingCount }` | Returns the compact plain-text NOTES DIGEST block (see §4). Single source of truth so the tick and any agent produce the identical digest. |

**Shapes:**

```jsonc
// NoteMeta
{
  "id": "6b1e…",
  "kind": "meeting",
  "title": "Weekly sync with Platform team",
  "file": ".switchboard/notes/meetings/weekly-sync-…-6b1e….md",
  "created": "2026-08-03T09:12:00.000Z",
  "updated": "2026-08-03T09:40:12.000Z",
  "tags": ["platform", "sync"],
  "when": "2026-08-05T15:00:00.000Z"   // omitted when absent
}

// NoteFull = NoteMeta + { "content": "<full markdown file>" }
```

### Where routing plugs in

`src/services/LocalApiServer.ts`, in the `_handleRequest` dispatch chain
(~line 3392–3413, right after the `/memo/verb/` and `/design/verb/` branches):

```typescript
} else if (pathname.startsWith('/notes/verb/') && req.method === 'POST') {
    const verb = decodeURIComponent(pathname.slice('/notes/verb/'.length));
    await this._handleNotesVerb(verb, req, res);
```

`_handleNotesVerb` is a **near-verbatim copy of `_handlePlanningVerb`** (~line 1722):
auth check → resolve `this._options.notesVerb` (503 if unwired) → parse JSON body →
strip `type`/`bypassTriggerGate` → `_stampHttpSurface(body)` → resolve `workspaceRoot`
→ `await notesVerb(verb, body, workspaceRoot)` → 200 if `success !== false` else 502;
catch → 500. No new response helpers required.

A new option on `LocalApiServerOptions` (~line 14–341):

```typescript
notesVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
```

---

## 3. File-by-file implementation plan

| # | File | Change |
|---|---|---|
| 1 | **`src/services/NotesService.ts`** *(new)* | The store + verb engine. Class `NotesService` with `handleServiceVerb(verb, payload): Promise<any>` switching over the §2 verbs. Owns: root resolution (`.switchboard/notes/`), lazy `mkdir`, filename/slug/id generation, `parseNoteMetadata`/`serializeNote` (mirroring `planMetadataUtils`), list/read/search/write/append/delete/upcoming, and `buildDigest()` (used by both the `digest` verb and the tick). Pure `fs`/`path`/`uuid` — no vscode import so it stays unit-testable and reusable from standalone bootstrap. |
| 2 | **`src/services/LocalApiServer.ts`** | (a) Add `notesVerb?` to `LocalApiServerOptions`. (b) Add the `/notes/verb/` branch to the dispatch chain. (c) Add `_handleNotesVerb` (copy of `_handlePlanningVerb`). |
| 3 | **`src/services/TaskViewerProvider.ts`** | (a) Instantiate a `NotesService` (field `_notesService`, constructed alongside the other providers). (b) Wire the `notesVerb` option in the `LocalApiServer` construction block (~line 2111 area), delegating to `this._notesService.handleServiceVerb(verb, p)` with the same `wsRoot`-injection guard the other verbs use. (c) In `_enqueueOrchestrationWake` (~line 10768), compose and inject the NOTES DIGEST into `wakePrompt` (see §4). (d) Add webview message handlers for the sidebar Notes sub-tab: `notesList`, `notesRead`/`notesOpen`, `notesCreate`, `notesDelete` — each thin wrappers over `_notesService`, replying via `this.postMessage`. Mirrors the existing memo handlers (~line 12387–12503). |
| 4 | **`src/webview/notes.html`** *(new)* | Minimal sub-tab: a list pane (title + kind + updated), a "New note" form (title, kind dropdown, optional `when` for meetings, body), and an open/edit view. Modeled on `src/webview/memo.html`. Delete button deletes immediately (no confirm). |
| 5 | **`src/webview/notes.js`** *(new)* | `vscode.postMessage({ type: 'notesList' \| 'notesRead' \| 'notesCreate' \| 'notesDelete', … })` and render responses. Modeled on `src/webview/memo.js` (debounced save on edit is optional; explicit Save is fine for v1). |
| 6 | **`src/extension.ts`** | Register a `switchboard.openNotes` command + optional status-bar button and sub-tab activation, mirroring the memo registration (~lines 69, 1171–1174, 2259–2263). Add `'notes'` as a valid sub-tab id where `'agents' \| 'terminals' \| 'memo'` are enumerated. |
| 7 | **`src/standalone/bootstrap.ts`** | Wire a `notesVerb` in the standalone bootstrap's option set (~line 1324 area, next to `planningVerb`) so `npx switchboard` / headless sessions get the same notes rail. Delegates to a `NotesService` instance rooted at the bootstrap workspace root. |
| 8 | **`.agents/skills/switchboard-orchestrator/SKILL.md`** | Add a **Notes-driven actions** step to the **Wake Protocol** "Act, in priority order" section (see §4). |
| 9 | **`.agents/skills/switchboard-orchestration/SKILL.md`** | Add a "Notes endpoints" section documenting `POST /notes/verb/<name>` and each verb's body/response, in the existing table+curl style. |
| 10 | **`protocol-catalog.json`** | Regenerate via `node scripts/generate-protocol-catalog.js --write` after the provider arms exist. **Note:** the generator scans provider `switch(msg.type)`/`switch(data.type)` blocks (see `PROVIDERS` in the script). To have the notes verbs appear automatically, either (a) route them through the existing TaskViewer `switch(data.type)` (the sub-tab handlers already do this for the UI verbs), or (b) add a `NotesService` entry to the generator's `PROVIDERS` list pointing at `handleServiceVerb`'s switch. Plan: add the `NotesService` file to `PROVIDERS` so the HTTP verbs are catalogued as their own provider. |
| 11 | **`src/test/notes-service-contract.test.js`** *(new)* | Contract test (see §6). |
| 12 | **`package.json`** | Add `"test:contract:notes"` script and include it in the CI test aggregation, mirroring the existing `test:contract:*` entries. |

No other files are touched. `dist/` is intentionally ignored (per CLAUDE.md, `dist/`
is not used in dev/test).

---

## 4. Tick digest design

### What composes the digest

`NotesService.buildDigest({ lookaheadMinutes = 1440, recentLimit = 5 })` returns a
compact plain-text block. It is the single source of truth: the `digest` verb returns
it, and the tick calls the same method. Contents:

- **Upcoming meetings** within the lookahead window (`When` in `now .. now+lookahead`),
  soonest first: `• <when local> — <title> (id <shortId>)`.
- **Recently changed notes** (top `recentLimit` by `Updated`): `• <kind>: <title> (id <shortId>, updated <rel time>)`.
- **Stale plan-notes** (kind `plan`, `Updated` older than N days) flagged for
  summarize/reorganize.
- Counts line: `N upcoming meeting(s), M recent note(s)`.

If the store is empty/absent, `buildDigest` returns `''` (empty) so the tick injects
nothing — graceful, no error, exactly how the memo/plan reads tolerate absence.

### Where it hooks into the wake path

`TaskViewerProvider._enqueueOrchestrationWake` (~line 10764–10768). Today:

```typescript
const wakePrompt = `${recoveryPreamble}You are the Switchboard orchestrator. …begin with the Wake Protocol. When done, report "wake complete, sleeping" and STOP.`;
```

Change to prepend a best-effort digest block (never throws — wrapped in try/catch that
falls back to `''`, matching the batch-complete/last-wake reads already in this method):

```typescript
let notesDigest = '';
try { notesDigest = await this._notesService.buildDigest({ workspaceRoot: root }); }
catch (err) { console.error('[Autoban] notes digest failed:', err); }
const digestBlock = notesDigest
    ? `NOTES DIGEST (act on these via the /notes/verb/* rail):\n${notesDigest}\n\n`
    : '';
const wakePrompt = `${recoveryPreamble}${digestBlock}You are the Switchboard orchestrator. …begin with the Wake Protocol. When done, report "wake complete, sleeping" and STOP.`;
```

Digest injection is additive and cannot regress the existing wake behavior: on any
failure or empty store the prompt is byte-identical to today's.

### SKILL.md instruction (orchestrator)

In `.agents/skills/switchboard-orchestrator/SKILL.md`, **Wake Protocol → "Act, in
priority order"**, add a step:

> **Notes-driven actions.** If the wake prompt carries a `NOTES DIGEST`, act on it via
> the `POST /notes/verb/<name>` rail:
> - **Imminent meeting** (upcoming within the window): if no prep note exists for it,
>   `write` a `kind: meeting` prep note (agenda skeleton + linked context) and `append`
>   a one-line "prepped" marker to the source note.
> - **Stale/scattered plan-notes:** `read` them, then `write` a consolidated summary
>   note and/or reorganize (re-`write` with cleaned body). git is the undo.
> - **Daily briefing:** once per day, `write` a `kind: briefing` note summarizing
>   recent notes + today's meetings.
> These are best-effort and never block merge-back. Never add confirmation gates.

---

## 5. UI plan

**Pattern:** a sidebar **sub-tab** (like the memo tab), NOT a full editor panel —
keeps it modest and cheap. The memo sub-tab is the reference implementation.

- **Registration:** `switchboard.openNotes` command → `taskViewerProvider.openNotesTab()`,
  which persists `activeSubTab = 'notes'` to `workspaceState`, focuses
  `switchboard-view`, and posts `{ type: 'openNotesTab' }` — a direct mirror of
  `openMemoTab()` (`TaskViewerProvider` ~line 4547) and the memo command registration
  in `extension.ts` (~line 1171).
- **Webview:** `src/webview/notes.html` + `notes.js`, loaded into the existing sidebar
  webview the same way memo's assets are.
- **Interactions (message contract, webview → host → webview):**
  - `notesList {kind?}` → host lists via `NotesService` → `notesListResult {notes}`.
  - `notesRead {id}` / `notesOpen {id}` → `noteContent {note}`.
  - `notesCreate {kind,title,body?,when?,tags?}` → host `write` → `noteSaved {note}` →
    webview refreshes list.
  - `notesDelete {id}` → host `delete` (immediately, no confirm) → `noteDeleted {id}` →
    webview drops the row.
  - Errors surface as `notesError {message}` (mirrors `memoError`).
- **Scope:** list + open/edit + create + delete. No search box required in v1 (the
  `search` verb still exists for agents); can be added later. Meetings get a `when`
  datetime input; other kinds hide it.

The UI is deliberately not the centerpiece — it's a thin human on-ramp over the same
store the agents drive.

---

## 6. Test plan

The repo's contract-test convention (see `package.json` `test:contract:*` and
`src/test/pty-route-surface-contract.test.js`): construct a `LocalApiServer` with the
verb hook wired to the real service, `server.start()` on `port: 0`, drive it over
`http.request`, assert on the JSON envelope, `server.stop()` in `finally`. Sandboxed
via `--require ./src/test/bootstrap/sandboxStateHome.js`.

**`src/test/notes-service-contract.test.js`** (new) covers:

1. **Routing reachability** — each verb (`list/read/search/write/append/delete/upcoming/digest`)
   at `POST /notes/verb/<verb>` returns 200 and the in-body `success: true`, wired to a
   real `NotesService` rooted at a temp dir.
2. **write → read round-trip** — `write` a note, assert returned `id`/`file`; `read`
   it back and assert title/kind/body and that `Created`/`Updated` are ISO strings; a
   real file exists at the returned path with the `**Field:**` metadata lines.
3. **write-with-id replaces; append appends** — `append` adds a paragraph and bumps
   `Updated` without touching `Created`.
4. **list ordering + kind filter** — newest-`Updated` first; `kind` filters to one
   subdir.
5. **search** — substring hit over title/tags/body; miss returns `[]`.
6. **upcoming** — a meeting with `When` inside the window appears; one outside doesn't;
   soonest-first ordering.
7. **digest** — with a seeded upcoming meeting + recent notes, `buildDigest` returns a
   non-empty block naming the meeting; with an empty store returns `''`.
8. **delete removes immediately** — `delete` unlinks the file; subsequent `read`
   returns `success: false` (not-found). Asserts **no** confirmation path exists.
9. **empty/absent store tolerance** — `list`/`digest` against a missing
   `.switchboard/notes/` return empty results, not errors (mirrors plans' absent-dir
   tolerance).

Plus a **unit test** `src/services/__tests__/NotesService.test.ts` (Mocha + Sinon, the
`KanbanProvider.test.ts` style) for `parseNoteMetadata`/`serializeNote` round-trips,
slug/id generation, and `buildDigest` window math — pure functions, no server needed.

Wire `"test:contract:notes": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/notes-service-contract.test.js"` into `package.json` and the CI aggregation, matching the sibling `test:contract:*` entries.

---

## 7. Catalog + docs

- **`protocol-catalog.json`:** add `NotesService` (or its `handleServiceVerb` switch)
  to `scripts/generate-protocol-catalog.js`'s `PROVIDERS` list, then
  `node scripts/generate-protocol-catalog.js --write`. The notes verbs then appear
  under a `Notes` provider and in `apiEndpoints` (as the `/notes/verb/` prefix route),
  discoverable via `GET /catalog`.
- **`.agents/skills/switchboard-orchestration/SKILL.md`:** new "Notes endpoints"
  section — a table of `POST /notes/verb/<name>` verbs with body/response + `curl`
  examples, in the exact style of the existing plan-lifecycle section.
- **`.agents/skills/switchboard-orchestrator/SKILL.md`:** the Wake-Protocol
  notes-action step from §4.

---

## Summary of the change surface

New: `NotesService.ts`, `notes.html`, `notes.js`, one contract test, one unit test.
Edited: `LocalApiServer.ts` (option + route + handler), `TaskViewerProvider.ts`
(service + verb wiring + digest injection + UI handlers), `extension.ts` (command +
sub-tab id), `standalone/bootstrap.ts` (notes rail), two SKILL.md files,
`protocol-catalog.json`, `package.json`. No new dependencies, no MCP, no migrations, no
confirmation dialogs, no DB — a file-based store that is a faithful sibling of
`.switchboard/plans/`, reachable over the same HTTP verb rail every agent already
speaks, and consumed by the orchestrator tick through a single additive digest hook.
