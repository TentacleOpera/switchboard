# Column UI labels are invisible to agents: "what's in the New column?" → "there is no New column"

## Goal

Make a column's **UI label** a first-class, agent-readable alias of its **stored column ID**, so an
agent asked about "the New column" answers about `CREATED` instead of denying the column exists. The
label already exists in code and is already what the board renders — it is simply never emitted on any
surface an agent reads, and never accepted on any surface an agent writes. Fix that in both directions.

**No schema change and no data migration.** Column IDs stay exactly as stored (`CREATED`,
`PLAN REVIEWED`, …) and the webview keeps rendering exactly the labels it renders today. The whole
change is *exposure* — publish the existing mapping onto the read surfaces, accept it on the write
surfaces, and delete the stale hardcoded copy of it from the agent skill.

### The observed failure

A user on the board asks "organise the plans in the new column into features". The agent replies
*"No column is literally named New on this board"* and then guesses. The user is looking at a column
header that says **New**. The agent is looking at a state file whose header says `## CREATED`.

Both are correct. Neither can see the other's name.

### Root cause — one authoritative map, published nowhere

`src/services/agentConfig.ts:132-143` holds the single source of truth, `DEFAULT_KANBAN_COLUMNS`,
where every column carries both an `id` and a `label`:

```ts
export const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED',           label: 'New',               order: 0,    kind: 'created', ... },
    { id: 'RESEARCHER',        label: 'Researcher',        order: 90,   ... },
    { id: 'PLAN REVIEWED',     label: 'Planned',           order: 100,  ... },
    { id: 'LEAD CODED',        label: 'Lead Coder',        order: 180,  ... },
    { id: 'CODER CODED',       label: 'Coder',             order: 190,  ... },
    { id: 'INTERN CODED',      label: 'Intern',            order: 200,  ... },
    { id: 'CODE REVIEWED',     label: 'Reviewed',          order: 300,  ... },
    { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', order: 350,  ... },
    { id: 'TICKET UPDATER',    label: 'Ticket Updater',    order: 9000, ... },
    { id: 'COMPLETED',         label: 'Completed',         order: 9999, ... },
];
```

The webview renders `def.label` (`src/webview/kanban.html:5565`, `src/webview/project.js:1904`,
`src/webview/planning.js:5922`). The exported markdown and the state files render `plan.kanbanColumn`
— the ID. So the divergence is not a bug in either renderer; it is that **three columns have labels
that are not derivable from their IDs by any string transform**:

| Stored column ID | UI label | Derivable from ID? |
|---|---|---|
| `CREATED` | **New** | **No** |
| `PLAN REVIEWED` | **Planned** | **No** |
| `CODE REVIEWED` | **Reviewed** | **No** |
| `LEAD CODED` | Lead Coder | No (but close) |
| `CODER CODED` | Coder | No (but close) |
| `INTERN CODED` | Intern | No (but close) |
| `RESEARCHER` | Researcher | Yes |
| `ACCEPTANCE TESTED` | Acceptance Tested | Yes |
| `TICKET UPDATER` | Ticket Updater | Yes |
| `COMPLETED` | Completed | Yes |

This is why title-casing the ID — the workaround every agent-facing doc currently reaches for — cannot
work. `CREATED` title-cases to "Created", and the user's word is "New".

There are also **two stored column IDs with no label at all**. `BACKLOG` (seeded at
`src/services/KanbanDatabase.ts:800` and `:8730`) and `CODED` both hold real cards and both get their
own `kanban-state-<slug>.md` file, but neither appears in `DEFAULT_KANBAN_COLUMNS`. `BACKLOG` is
stranger still: `src/webview/kanban.html:5565` renders it as a *display mode of the `CREATED` column*
rather than a column of its own —

```js
const columnDisplayLabel = (isCreated && showingBacklog) ? 'BACKLOG' : def.label;
```

— so the same column header reads "New" or "BACKLOG" depending on a toggle, while the DB stores them
as two distinct column values. Any mapping this plan publishes must represent that honestly instead of
pretending `BACKLOG` is a peer column with a tidy label.

### Root cause, third nameless label — `AUTOCODE` (found during this review)

A **fourth** kind of nameless-to-agents label exists, and it is the inverse problem: a label with no
column ID at all. When *Collapse coders* is enabled, `renderColumns` replaces the three `kind: 'coded'`
definitions with one synthetic entry (`src/webview/kanban.html:5434-5442`):

```js
const syntheticCol = { id: 'CODED_AUTO', label: 'AUTOCODE', role: null, order: coderDefs[0].order || 180, kind: 'coded', ... };
renderDefs = columnDefinitions.filter(d => d.kind !== 'coded').concat([syntheticCol]).sort(...);
```

`CODED_AUTO` is never stored on a card and `AUTOCODE` appears in no definition list, yet a user with
that setting on is **looking at a column header that says AUTOCODE** and will ask about it by that
name. Worse, label→ID is **not injective** here: "AUTOCODE" corresponds to three real IDs
(`LEAD CODED`, `CODER CODED`, `INTERN CODED`). The write path must not silently pick one. See User
Review decision 5.

### Root cause, second half — the read surfaces are label-free and the write surface is ID-only

**Read surfaces an agent actually uses, all of them ID-only:**

| Surface | Written at | Carries label? |
|---|---|---|
| `.switchboard/kanban-state-<slug>.md` — `## CREATED` header, `**Column:** CREATED` per plan | `KanbanDatabase.ts:8753-8783` | No |
| `.switchboard/kanban-board.md` — Column/File table | `KanbanDatabase.ts:8798` | No |
| `.switchboard/kanban-board.md` — Manager Snapshot table + `Board:` line | `KanbanDatabase.ts:8810-8828` | No |
| `.agents/scripts/kanban-list.js` — per-column plan lister an agent shells out to | `:26`, `:35` | No |
| `GET /kanban/columns` → `builtIn` | `LocalApiServer.ts:2465-2484` | **Yes** — returns full definitions |
| `GET /kanban/columns` → `custom` | `LocalApiServer.ts:2472-2481` | No — bare `string[]` of IDs |

So the mapping *is* already reachable over HTTP for built-ins via `GET /kanban/columns`. Two things
stop that from helping: `custom` is an unlabelled ID list, and — decisively — nothing in the
agent-facing documentation tells an agent that this endpoint is where column *names* come from. The
entry protocol reads the local markdown files by design (they are always current and cost no network
call), and those files have no labels in them.

**Write surface.** `LocalApiServer._canonicalColumnId` (`:1080-1099`) already solves half the problem
— it accepts case, slug and underscore variants, so `lead-coded`, `Lead Coded` and `LEAD_CODED` all
resolve to `LEAD CODED`. But it canonicalizes **only against `c.id`**; it never consults `c.label`.
So `{"targetColumn": "New"}` returns 400, and the error text lists IDs only (`:1189`, `:1292`) — the
user's own vocabulary is rejected with a message that does not mention it.

### Root cause, third half — the skill ships a stale copy of the map, and it is wrong

`.claude/skills/switchboard/SKILL.md` (and its `.agents` twin) instructs the agent to
"humanize column names for display — never print raw backend column IDs", then hardcodes the mapping:

```
BACKLOG → Backlog · CREATED → Created · PLAN REVIEWED → Plan Reviewed ·
CODED → Coded · LEAD CODED → Lead Coder · CODER CODED → Coder · INTERN CODED → Intern ·
CODE REVIEWED → Code Reviewed · ACCEPTANCE TESTED → Acceptance Tested · COMPLETED → Completed
Custom columns: title-case the slug.
```

Three of those are **wrong against the real UI**: `CREATED → Created` (really "New"),
`PLAN REVIEWED → Plan Reviewed` (really "Planned"), `CODE REVIEWED → Code Reviewed` (really
"Reviewed"). This is the worst of the three causes, because a hardcoded table does not fail loudly —
it makes the agent *confidently* print a column name the user has never seen, and *confidently* reject
the name the user is reading off their screen. It also cannot cover custom columns, whose labels are
user-authored and unguessable, and it rots silently the moment anyone edits `agentConfig.ts`.

The fix is not to correct this table. It is to **delete it** and have the agent resolve labels from the
one place that cannot go stale.

> **Superseded:** *the `.agents/skills` copy* (as the second location of the stale table).
> **Reason:** Verified by grep — `.agents/skills/switchboard/SKILL.md` **does not exist**. The table
> lives in exactly two files: `.claude/skills/switchboard/SKILL.md:91-96` and
> `.agents/workflows/switchboard.md:89-96` (the `.agents` copy is a *workflow*, not a skill). A change
> aimed at a non-existent path would have left the workflow copy stale — the copy the Antigravity host
> actually reads.
> **Replaced with:** The two verified paths above. See Proposed Changes #5.

## Metadata
- **Tags:** bugfix, api, agent-protocol, docs, kanban
- **Complexity:** 5
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4 · **Repo:** `switchboard`
> **Reason:** Two corrections. (1) The `Repo:` line is dropped — this workspace is single-repo, so a
> sub-repo pin is meaningless here. (2) Complexity 4 undercounted the file spread: the work now touches
> `agentConfig.ts` (new resolver + legacy map), `LocalApiServer.ts` (two call sites + two error
> messages + the `custom` payload shape), `KanbanDatabase.ts` (three export surfaces), two agent-doc
> files, and one test — six files, one of which (`LocalApiServer`) has a shipped-install API contract on
> `GET /kanban/columns` whose `custom` field changes shape from `string[]` to `{id,label}[]`. That is a
> textbook 5 ("multi-file changes, moderate logic"), not a 4. It stays in Coder range either way.
> **Replaced with:** **Complexity:** 5, no `Repo:` line.

## User Review Required (decisions, with defaults)

1. **How should `BACKLOG` be labelled, given it is a display mode of `CREATED` rather than a peer
   column?** Default: give it the explicit label `Backlog` in the published mapping *and* mark it
   `displayModeOf: 'CREATED'`, so an agent can name it correctly without concluding the board has an
   eleventh independent column. Alternative: label it `New (Backlog)`. Rejected default: leaving it
   unlabelled, which is the status quo that caused this bug.

2. **Should `CODED` be labelled or retired?** It holds 0 plans on the reference board but is a
   recognised post-code column in `KanbanDatabase.ts:8811`'s `POST_CODE` set. Default: label it
   `Coded` and leave it in place — retiring a column that may hold cards on other boards is out of
   scope for a naming fix.

   > **Superseded:** *"a recognised post-code column"* — the framing that `CODED` is a live peer column.
   > **Reason:** `CODED` is a **legacy alias actively normalized to `LEAD CODED`** in five places:
   > `KanbanProvider.ts:3232` and `TaskViewerProvider.ts:3593`
   > (`return normalized === 'CODED' ? 'LEAD CODED' : normalized`), `agentPromptBuilder.ts:1817`,
   > `autobanState.ts:239` (`legacyCodedRule`, then filtered out at `:249`), and `KanbanMigration.ts:23,53`
   > (a migration whose whole job is moving cards off it). `implementation.html:2534` already carries
   > `{ id: 'CODED', label: 'Coded' }`. So the decision's *conclusion* (label it, don't retire it) is
   > right, but its *reason* is wrong, and the wrong reason led change 4 to propose adding it to
   > `DEFAULT_KANBAN_COLUMNS` — which would render a board column for a column the codebase is
   > migrating away from.
   > **Replaced with:** `CODED` is labelled `Coded` in the **legacy** map only (see change 4), never in
   > `DEFAULT_KANBAN_COLUMNS`. Retiring it stays out of scope.

3. **When an agent prints a column, label-only or label + ID?** Default: **label only** in prose, with
   the ID used silently for API calls — this matches the existing skill rule that raw backend IDs are
   never shown to the user. Alternative for ambiguity-prone contexts: `New (CREATED)`.

4. **Should the label be accepted on write, or only emitted on read?** Default: **both**. Read-only
   fixes the "there is no New column" denial but still 400s when the agent then tries to act on the
   user's word.

5. **NEW — what should `AUTOCODE` resolve to on the write path?** It is a display-only label for three
   real IDs (`LEAD CODED`, `CODER CODED`, `INTERN CODED`) shown when *Collapse coders* is on
   (`kanban.html:5434-5442`). Default: **publish it as a display-only alias and reject it on write with
   a message that names the three IDs** — `"AUTOCODE" is the collapsed view of LEAD CODED | CODER CODED
   | INTERN CODED; pick one`. Rejected alternative: silently resolving it to `LEAD CODED` — that puts a
   card in a column the user did not choose and fires the wrong agent, which is worse than a 400.
   Second alternative: resolve it to whichever coder column the board's collapse setting dispatches to,
   if such a setting exists — needs confirming before it can be chosen.

## Dependencies

None. `DEFAULT_KANBAN_COLUMNS` already carries every label this plan publishes; no other plan needs to
land first.

Adjacent but explicitly *not* a dependency: `Standalone: GET /catalog 404s for every workspace except
the switchboard repo` also touches agent-facing discovery, but the catalog describes verbs, not
columns, and the two changes do not share a file.

**Orchestration note** (PRD "one agent stream per provider file"): this plan edits
`src/services/LocalApiServer.ts` in three places and `src/services/KanbanDatabase.ts` in three. Neither
file may be edited by a concurrent stream while this lands.

## Complexity Audit

### Routine

- Adding a `resolveColumnLabel(id)` / `LEGACY_COLUMN_LABELS` export to `agentConfig.ts` — pure
  function, no state, no host coupling.
- Adding a `**Label:** <label>` line to the per-column state file, mirroring the `**Agent:**` line the
  same loop already emits from `_resolveAgentForColumn` (`KanbanDatabase.ts:8755-8765`).
- Adding a `Label` column to the two markdown tables and rendering the `Board:` line with labels.
- Rewriting the humanization block in two agent-doc files.
- Widening the two 400 messages to `ID (Label)` form.

### Complex / Risky

- **`GET /kanban/columns`'s `custom` field changes shape** from `string[]` to `{id,label}[]`. This is a
  published HTTP contract on ~4,000 shipped installs (PRD contract #2). Any in-repo or external caller
  doing `custom.includes(id)` or `custom.map(String)` breaks silently. Every in-repo consumer must be
  found before landing, and the shape change belongs in the same commit as its consumers.
- **Label-shadowing on the write path.** `_canonicalColumnId` gains a second matching pass; getting
  the precedence wrong lets a user-authored custom column named `New` capture moves intended for
  `CREATED`. ID-first ordering is the entire safety property.
- **Ambiguous labels are now possible.** `Coder` is the label of `CODER CODED`, but `CODED`'s new
  legacy label `Coded` canonicalizes to `CODED` — distinct, fine — while `AUTOCODE` maps to three IDs
  and `BACKLOG` maps to a display mode. The resolver must be many→one **or refuse**, never
  arbitrary-pick.
- **The webview must not gain a column.** Confirmed hazard, see change 4.
- **Reading a stale `**Label:**` line.** The state files are rewritten on every board move, but a repo
  checked out mid-change (or a workspace whose extension version differs from its `.switchboard`
  files) can show a label that no longer matches. Labels on disk are a cache; `GET /kanban/columns`
  stays authoritative, and the skill text must say so in that order.

## Edge-Case & Dependency Audit

### Race Conditions

- **Export vs read.** `kanban-state-<slug>.md` is written atomically per column
  (`tmp` + `rename`, `KanbanDatabase.ts:8787-8790`), so a reader never sees a half-written file — but
  the *set* of files is not written atomically. An agent reading during a re-export can see column A
  with its new `**Label:**` line and column B without it. The skill rule must therefore tolerate a
  **missing** `**Label:**` line (fall back to `GET /kanban/columns`), never assume it is present.
- **Label edited between read and write.** A user renaming a custom column's label after the agent
  read the state file makes the agent's next `targetColumn: "<old label>"` 400. Acceptable: the 400 is
  correct and now self-teaching. Do **not** add retry-with-refresh machinery for it.

### Security

- The new 400 message enumerates every column ID **and** label, including user-authored custom labels.
  That is board metadata already returned by `GET /kanban/columns` behind the same auth, so it leaks
  nothing new — but keep the message a plain string with no path or plan data interpolated.
- `**Label:** ${label}` lands in a markdown file. Custom labels are user-authored free text; a label
  containing a newline would corrupt the state file's structure. Sanitize to a single line
  (strip `\r\n`) — `_columnSlug` already handles the filename side, not the body.

### Side Effects

- Every board move rewrites all state files, so the labels self-heal with no migration. Nothing on
  disk needs converting.
- Adding a line to the state files changes their byte content, which the export test asserts against —
  `src/test/kanban-auto-export.test.ts` must be updated in the same change (it is also where change 6
  lands).
- `.switchboard/*.md` files are gitignored/un-ignored by `WorkspaceExcludeService` (`:169`); adding a
  line does not change that.
- No plan file, no DB row, and no `**Column:**` per-plan line changes — those stay ID-valued and
  machine-parsed.

### Dependencies & Conflicts

- **No code parses `kanban-state-*.md`.** Verified by grep across the repo: the only readers are
  `src/test/kanban-auto-export.test.ts` (which lists and greps the files) and the agent-facing
  skills/docs (which use `awk`/`grep`). `src/extension.ts`'s `kanban-state-backup.json` and
  `setup.html`'s reference to it are a different artifact entirely. This retires uncertain assumption 2.
- `.agents/scripts/kanban-list.js` is an ID-only read surface (`:26`, `:35`) that an agent shells out
  to. It is **not** changed by this plan; if it should carry labels too, that is a one-line follow-up,
  and the plan states that explicitly rather than leaving it as an unnoticed gap. Listed under Out of
  Scope.
- Existing suites that already assert `{ id: 'CREATED', label: 'New' }` —
  `planning-copy-labels-regression`, `kanban-prompt-generation-unit`, `KanbanProvider` — are the
  closest existing coverage and must stay green.

## Adversarial Synthesis

**Risk Summary.** The plan's read/write exposure model is right, but its riskiest step was wrong:
adding `BACKLOG` and `CODED` to `DEFAULT_KANBAN_COLUMNS` would have rendered two extra board columns,
because `renderColumns` maps the definition list straight to column DOM (`kanban.html:5430`,
`:5443-5450`) with no `displayModeOf`/legacy filter. That step is now replaced by a separate
`LEGACY_COLUMN_LABELS` map with zero webview reach. The remaining risks are the `GET /kanban/columns`
`custom` shape change against shipped installs, and label-shadowing on the write path; both are
contained by finding every `custom` consumer in the same commit and by strict ID-before-label
precedence. The parity test (change 6) is what stops the mapping rotting again.

## Proposed Changes

### 0. NEW — one label resolver, in `src/services/agentConfig.ts`

The original changes 1–3 each resolved labels independently (LocalApiServer's canonicalizer,
KanbanDatabase's exporter, LocalApiServer's `/kanban/columns`). Three hand-merges of
`DEFAULT_KANBAN_COLUMNS` + `customKanbanColumns` + a fallback is three places to drift — the exact
failure mode this plan exists to end. Add one exported resolver and have all three consume it:

```ts
/** Display labels for stored column IDs that are NOT peer columns and MUST NOT
 *  appear in DEFAULT_KANBAN_COLUMNS (the webview renders one column per entry).
 *  - BACKLOG: rendered as a display mode of CREATED (kanban.html:5565).
 *  - CODED:   legacy alias normalized to LEAD CODED (KanbanProvider.ts:3232 et al). */
export const LEGACY_COLUMN_LABELS: Record<string, { label: string; displayModeOf?: string; legacyAliasOf?: string }> = {
    'BACKLOG': { label: 'Backlog', displayModeOf: 'CREATED' },
    'CODED':   { label: 'Coded',   legacyAliasOf: 'LEAD CODED' },
};

/** Display-only labels with no stored column ID — an agent may be asked about
 *  these by name but can never write to them. */
export const DISPLAY_ONLY_COLUMN_LABELS: Record<string, { aliasOf: string[] }> = {
    'AUTOCODE': { aliasOf: ['LEAD CODED', 'CODER CODED', 'INTERN CODED'] },  // kanban.html:5434
};

export function resolveColumnLabel(
    id: string,
    customKanbanColumns: CustomKanbanColumnConfig[] = []
): { label: string; labelSource: 'built-in' | 'custom' | 'legacy' | 'fallback' } { … }
```

`resolveColumnLabel` checks, in order: `DEFAULT_KANBAN_COLUMNS` → `customKanbanColumns` →
`LEGACY_COLUMN_LABELS` → `{ label: id, labelSource: 'fallback' }`. `agentConfig.ts` is the right home:
it already owns `DEFAULT_KANBAN_COLUMNS`, `buildKanbanColumns` and `BUILT_IN_AGENT_LABELS`, has no host
coupling, and is imported by both `LocalApiServer` and `KanbanDatabase` today. This is also what makes
change 6's parity test a single-function assertion instead of a three-surface crawl.

### 1. Accept labels on the write path — `src/services/LocalApiServer.ts`

Extend `_canonicalColumnId` (`:1080`) to match against `label` as well as `id`, keeping ID precedence
so a label can never shadow a real column ID:

- Build the candidate list as today (built-in IDs, then custom IDs discovered from the board).
- Add a second pass that matches the canonicalized input against each built-in's `canon(c.label)`,
  **only if** the ID pass found nothing. ID-first ordering is load-bearing: if a future custom column
  were ever *named* `New`, the built-in `CREATED` must still win, exactly as the existing comment at
  `:1095-1096` argues for rogue stored variants.
- Include custom columns' labels, and `LEGACY_COLUMN_LABELS` labels, via `resolveColumnLabel`
  (change 0) — so `Backlog` resolves to `BACKLOG` and `Coded` to `CODED`.
- **Reject `AUTOCODE` explicitly** rather than falling through to a generic "unknown column": return
  the three candidate IDs (decision 5). A many→one label must refuse, never pick.
- Keep the function's existing `Promise<string | null>` signature and its `catch` that leaves
  built-ins as the floor — a DB failure must not make label resolution worse than ID resolution.

Update both 400 messages (`:1189`, `:1292`) to list ID **and** label per column, e.g.
`CREATED (New) | PLAN REVIEWED (Planned) | …`, so a rejected call teaches the caller the vocabulary
instead of just restating IDs.

### 2. Emit labels on the exported markdown — `src/services/KanbanDatabase.ts`

Resolve each column's label once per export via `resolveColumnLabel` (change 0), then:

- **Per-column state file** (`:8753`): keep the header as `## ${col}` and add a
  `**Label:** ${label}` line directly beneath, mirroring how `**Agent:**` is already emitted at
  `:8762-8765` from `_resolveAgentForColumn` — same loop, same shape, same `agentConfig` inputs. Leave
  the per-plan `**Column:** ${plan.kanbanColumn}` lines untouched: they are ID-valued by contract.
  Sanitize the label to a single line (see Security).
- **Board table** (`:8798`): add a `Label` column → `| CREATED | New | [kanban-state-created.md](…) |`.
- **Manager Snapshot** (`:8810`): add a `Label` column to the counts table, and render the `Board:`
  line (`:8829`) with labels rather than IDs, since that line is written expressly for the entry
  snapshot a human reads. Keep the existing comment's promise intact — the *table* still carries
  canonical uppercase IDs so API calls built from it cannot strand a card.
- For a column with `labelSource: 'fallback'` (no definition anywhere), emit the ID as the label rather
  than omitting the line, so the shape is uniform for parsers.

These files are rewritten on every board move, so the labels stay current with zero extra machinery
and no migration of anything already on disk.

### 3. Label custom columns on `GET /kanban/columns` — `src/services/LocalApiServer.ts:2465`

Change `custom` from `string[]` to `{ id, label, labelSource }[]`, resolved through
`resolveColumnLabel`: user-authored custom columns show their authored label; `CODED`/`BACKLOG` show
their legacy labels tagged `labelSource: 'legacy'`; a column stored on cards with no definition
anywhere returns the ID as the label tagged `labelSource: 'fallback'` so a caller can tell a real
label from a stand-in. Keep `builtIn` as-is — it already returns full definitions. Additionally return
`displayOnly` (the `DISPLAY_ONLY_COLUMN_LABELS` entries) so `AUTOCODE` is discoverable rather than
mysterious.

**Shipped-install guard (PRD contract #2).** This is a response-shape change on a published endpoint.
Before landing: grep every in-repo consumer of `/kanban/columns` (webviews, skills, `.agents/scripts`,
tests) and update them in the same commit. If any consumer cannot be updated in lockstep, keep `custom`
as `string[]` and add a **new** sibling field (`customDetailed`) instead — additive beats breaking on
4,000 installs. Decide this by inspection, not assumption.

### 4. Label `BACKLOG` and `CODED` without touching `DEFAULT_KANBAN_COLUMNS`

> **Superseded:** *Add both to `DEFAULT_KANBAN_COLUMNS` (`src/services/agentConfig.ts:132`) so no
> stored column is nameless — `BACKLOG` with a new optional `displayModeOf?: 'CREATED'` field, `CODED`
> with label `Coded` — "verify the render path keys off `kind`/`displayModeOf` and not merely 'is in
> `DEFAULT_KANBAN_COLUMNS`' before landing this", with a `LEGACY_COLUMN_LABELS` fallback if it cannot
> be made clean.*
>
> **Reason:** The verification the plan deferred has now been done, and it fails. The render path keys
> off **exactly** "is in the definition list": `buildKanbanColumns` returns
> `[...defaultColumns, ...userColumns]` sorted (`agentConfig.ts:386-406`, no filtering), and
> `renderColumns` does `let renderDefs = columnDefinitions` then
> `kanbanBoard.innerHTML = renderDefs.map(def => …)` (`kanban.html:5430`, `:5450`). The only filter in
> that path is the *collapse-coders* branch (`:5443-5445`, `d.kind !== 'coded'`). So adding `BACKLOG`
> and `CODED` renders **two extra board columns** on every install — and `CODED`'s would be a column
> the codebase actively migrates cards **off** (see decision 2's callout). No new `displayModeOf` field
> can prevent that without editing the render loop, which is webview blast radius on a naming fix.
>
> **Replaced with:** The fallback becomes the primary approach. `DEFAULT_KANBAN_COLUMNS` is **not
> touched**; the `KanbanColumnDefinition` interface is **not** extended. Both labels live in
> `LEGACY_COLUMN_LABELS` (change 0), consumed by changes 1–3 only. `AUTOCODE` lives in
> `DISPLAY_ONLY_COLUMN_LABELS` alongside it. Net effect: every stored column ID resolves to a label on
> every agent-facing surface, the board renders exactly the ten columns it renders today, and the
> change has **zero** webview reach. Change 6's parity test asserts the ten-column count so a future
> edit cannot quietly reintroduce this.

### 5. Delete the hardcoded humanization table — the two files that actually carry it

Replace the mapping block with a resolution rule in **both**:

- `.claude/skills/switchboard/SKILL.md:91-96` (the Claude Code skill)
- `.agents/workflows/switchboard.md:89-96` (the Antigravity workflow — the `.agents/skills/switchboard/`
  path named in the original plan does not exist)

The rule:

- Column labels come from the `**Label:**` line in the state file the agent already reads at entry —
  no extra call. If that line is absent (older export, mid-rewrite), `GET /kanban/columns` is
  authoritative; it always is on conflict.
- Never title-case an ID to produce a name: `CREATED` is **New**, not "Created".
- Accept the user's label as input and pass it straight to the API, which now canonicalizes it.
- When a user's word matches no ID and no label, say which labels *do* exist rather than asserting the
  column does not exist.
- `BACKLOG` is a view of **New**, not an eleventh column; `AUTOCODE` is the collapsed view of the three
  coder columns and cannot be written to directly.

Then sync the **installed** extension copy — per house rule the running extension loads `.agents` from
its install folder, so a dev-repo-only edit is not live.

> **Superseded:** *"Also sweep `docs/switchboard_user_manual.md` §4 and `docs/how_to_use_switchboard.md`
> for ID-as-name prose introduced by the same assumption."*
> **Reason:** Neither file exists in this repo (verified by `find`). `docs/` has no user manual and no
> how-to-use document; the user-manual content lives outside this repo.
> **Replaced with:** Sweep is scoped to the two verified files above — they are the **only** two files
> in the repo containing the "Humanize column names" block (verified by repo-wide grep). Other agent
> docs (`switchboard-orchestration`, `kanban-operations`, `query-switchboard-kanban`,
> `rearrange-feature`, `group-into-features`) mention column **IDs**, which is correct for API calls
> and must NOT be relabelled.

### 6. Parity guard — new test

Add a test asserting that for every column ID appearing in `kanban_column` on the board **or** in
`DEFAULT_KANBAN_COLUMNS` **or** in `LEGACY_COLUMN_LABELS`:

- a label resolves via `resolveColumnLabel` with `labelSource !== 'fallback'` for built-ins and legacy
  entries,
- the label appears in the exported `kanban-state-<slug>.md` and in `kanban-board.md`,
- `_canonicalColumnId(label)` round-trips back to the ID,
- `_canonicalColumnId(id)` still returns the ID (no label-shadowing regression),
- **`DEFAULT_KANBAN_COLUMNS` still has exactly ten entries and contains neither `BACKLOG` nor
  `CODED`** — the guard that keeps change 4's supersede from being silently undone,
- `_canonicalColumnId('AUTOCODE')` returns `null` (or the explicit refusal), never a single coder ID.

Extend `src/test/kanban-auto-export.test.ts`, which already walks every `kanban-state-*.md` and knows
the slug convention. This is the change that stops the bug recurring: today nothing fails when a label
is added, renamed, or omitted.

## Verification Plan

1. **Reproduce first.** On the reference board, `grep -c "New" .switchboard/kanban-state-created.md`
   → 0 before the change. `curl -s -X POST "$BASE/kanban/move" -d '{"planId":"<id>","targetColumn":"New"}'`
   → 400 listing IDs only. Both must flip after.
2. **Labels on disk.** Move any card to force a re-export; confirm `kanban-state-created.md` carries
   `**Label:** New`, `kanban-state-plan-reviewed.md` carries `**Label:** Planned`, and
   `kanban-state-code-reviewed.md` carries `**Label:** Reviewed`. Confirm `kanban-board.md`'s Column
   table, Manager Snapshot and `Board:` line all show labels, and that the Column table still carries
   canonical uppercase IDs alongside them.
3. **Write path.** `POST /kanban/move` with `targetColumn` of `New`, `new`, `Planned`, `Reviewed`,
   `CREATED`, `created`, `lead-coded`, `Backlog` and `Coded` — all nine resolve.
   `targetColumn: "Nonsense"` still 400s, and the message now names both IDs and labels.
   `targetColumn: "AUTOCODE"` 400s with a message naming the three coder IDs (decision 5).
4. **No shadowing.** With a custom column labelled `New` present, `targetColumn: "New"` still resolves
   to built-in `CREATED`.
5. **Custom columns.** `GET /kanban/columns` returns `custom` as `{id,label,labelSource}` objects; a
   user-authored custom column shows its authored label; `CODED` shows `Coded` with
   `labelSource: 'legacy'`; a card-only column with no definition shows the ID with
   `labelSource: 'fallback'`; `displayOnly` includes `AUTOCODE`. Every in-repo consumer of the endpoint
   still works (the grep from change 3 is the checklist).
6. **Webview unregressed — the change-4 hazard.** Open the board: **ten** column headers, exactly as
   before. `New` still reads "New"; the backlog toggle still swaps that header to "BACKLOG"; **no
   eleventh or twelfth column appears**. Enable *Collapse coders* and confirm the synthetic `AUTOCODE`
   header still renders and the coder columns still collapse into it. Check `project.js:1904` and
   `planning.js:5922` meta bars still render labels.
7. **Agent end-to-end — the actual bug.** In a fresh session on this board, ask *"what is in the new
   column?"*. The agent must answer about `CREATED`'s contents without denying the column exists, and
   must print "New", not "Created". Repeat for "planned" and "reviewed". Then ask about "backlog" and
   confirm the agent names it as a view of New rather than an independent column.
8. **Missing-label tolerance.** Delete the `**Label:**` line from one state file by hand and confirm
   the agent falls back to `GET /kanban/columns` instead of title-casing the ID or claiming the column
   is unnamed. (This is the mid-rewrite race from the Edge-Case audit.)
9. **Guard bites.** Rename one label in `agentConfig.ts` without re-exporting and confirm the new
   parity test fails. Separately, add `BACKLOG` to `DEFAULT_KANBAN_COLUMNS` and confirm the
   ten-entry/no-legacy assertion fails. Revert both.

### Automated Tests

> Not executed during this planning pass — session directives were "skip compilation" and "skip tests".
> These are for the implementing coder.

- New: the parity guard in `src/test/kanban-auto-export.test.ts` (change 6), including the ten-entry
  `DEFAULT_KANBAN_COLUMNS` assertion and the `AUTOCODE` refusal.
- Must stay green: `kanban-auto-export`, `KanbanProvider`, `planning-copy-labels-regression`,
  `kanban-prompt-generation-unit` — the last three already assert `{ id: 'CREATED', label: 'New' }` and
  are the closest thing to existing coverage.
- `npm run lint`. The PRD's ratchets (`verb-returns:check`, `parity:check`, `push-routing:check`) are
  untouched by this plan — no verb arm's return shape changes — but they must still pass, since
  `LocalApiServer.ts` is edited.

## Uncertain Assumptions

The user was advised to run web research before implementation only if any item below remains open;
the first two are now **resolved by direct code inspection during this review** and need no research.

- ~~**That the webview column loop can tolerate a `BACKLOG` entry in `DEFAULT_KANBAN_COLUMNS`.**~~
  **RESOLVED — it cannot.** `buildKanbanColumns` returns all definitions unfiltered
  (`agentConfig.ts:386-406`) and `renderColumns` maps them one-to-one to columns
  (`kanban.html:5430`, `:5443-5450`). Change 4 was rewritten accordingly; no assumption remains.
- ~~**That no consumer parses `## <ID>` as the first line of a state file.**~~ **RESOLVED — no code
  parses these files at all.** The only readers are `src/test/kanban-auto-export.test.ts` and the
  agent-facing skills/docs' `awk`/`grep`. `**Label:**` after the header is safe; the test is updated in
  change 6.
- **That `CODED` is genuinely unused** rather than holding cards on other workspaces. Only the
  reference board was checked. Low impact now: `CODED` is labelled from `LEGACY_COLUMN_LABELS`, so a
  board that does hold `CODED` cards gets a correct label either way.
- **That no external (out-of-repo) caller depends on `GET /kanban/columns`'s `custom` being a bare
  `string[]`.** In-repo consumers can be enumerated by grep; external ones (a user's own script against
  the local API) cannot. The additive `customDetailed` escape hatch in change 3 exists for this.
- **That no board-level setting already defines which coder column a collapsed `AUTOCODE` dispatch
  targets.** If one exists, decision 5's second alternative becomes viable; it was not found in this
  review but the collapse feature's dispatch path was not read end-to-end.

## Out of Scope

- Renaming any column ID, or any DB migration. IDs are stable by design and this plan depends on that.
- Changing any UI label. The labels the board shows today are correct; only their visibility to agents
  is broken.
- Making labels editable per workspace for built-in columns.
- Localisation of labels.
- The `BACKLOG`-as-display-mode-of-`CREATED` architecture itself. This plan documents and names it;
  reconciling it into a real column (or removing it) is separate work.
- Retiring the legacy `CODED` column, or the `CODED → LEAD CODED` normalizations in `KanbanProvider`,
  `TaskViewerProvider`, `agentPromptBuilder`, `autobanState` and `KanbanMigration`.
- Adding labels to `.agents/scripts/kanban-list.js`. It is inventoried as an ID-only read surface above
  so the gap is visible; changing it is a separate one-line follow-up.

---

**Recommendation: Send to Coder** (complexity 5).
