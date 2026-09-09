# Auto-Archive Has Never Run: the Advertised Switch Is Not the One the Code Reads

## Goal

Make archiving actually happen, or admit it does not. Two settings look like the same switch: the one
the product advertises defaults to **on** and is never read; the one the service consults defaults to
**off** and has never been written. The result is a fully-built archive subsystem that has not
archived a single card.

### Problem analysis

**Nothing has ever been archived.** `kanban-archive.db` does not exist on either of the operator's
machines — `find /home/patrick -name 'kanban-archive.db*'` returns nothing on the tower and nothing
on the Pi. Meanwhile the hot board database holds **2,552 rows with `status='completed'`**, of which
440 no longer have a plan file on disk.

**Two switches, and they are not the same switch.**

| | key | store | default | read by the service? |
| :--- | :--- | :--- | :--- | :--- |
| Advertised | `switchboard.archive.autoArchiveCompleted` | VS Code contributed settings | **`true`** | **no** |
| Effective | `kanban.autoArchive` | the board DB `config` table | **`enabled: false`** | yes |

`AutoArchiveService.getConfig()` reads `AUTO_ARCHIVE_CONFIG_KEY = 'kanban.autoArchive'` from the
database. That row has never been written on this board — `SELECT … FROM config WHERE key LIKE
'%utoArchive%'` returns nothing — so the method takes its absence branch and returns
`DEFAULT_AUTO_ARCHIVE_CONFIG`:

```ts
export const DEFAULT_AUTO_ARCHIVE_CONFIG: AutoArchiveConfig = {
    enabled: false,
    triggerColumn: '',
    thresholdHours: 2,
};
```

`package.json` contributes a *different* key with the opposite default:

```json
"switchboard.archive.autoArchiveCompleted": {
    "default": true,
    "description": "Automatically archive plans when moved to COMPLETED column."
}
```

Nothing in `AutoArchiveService` reads it. So the setting the operator can see, and which reads as
enabled, has no effect; the setting that decides is invisible and off.

This is the standing fallback rule with the two halves swapped: the default is not merely quiet, it
**contradicts the advertised one**, and there is no surface on which the disagreement is visible. The
service is wired — `KanbanProvider` builds one per workspace (`_autoArchiveServices`) and the sweep
runs every 5 minutes — so every gate is green and the sweep dutifully does nothing.

#### The second database is a separate question, and it is already open

`kanban-archive.db` exists because of *Split kanban.db into Hot + Cold Stores* (`9a7d78eb`), which is
marked **SUPERSEDED**. Its own note says why the file split expired: the plan's goal was to bound the
`sql.js` per-write cost, `sql.js` has since been replaced by a real binding with WAL and page-level
writes, and "the premise is removed, so a second *file* is no longer the remedy."

*Storage topology: three stores, one operator choice* (`fbdddc53`, **PLAN REVIEWED**) supersedes it
and states the current mess plainly — "there are already two cold stores, in two technologies, and
one needs an external binary". It keeps an Archive, but for reasons the split could not have had
(bounding the board read; keeping dormant history out of a remote replica's sync volume), and demotes
DuckDB to opt-in analytics that is never load-bearing.

**So do not resolve the store question here.** This card is about a switch that does not work. Where
the archive lives is `fbdddc53`'s decision, and turning archiving on before that lands would start
filling a file whose placement is still being decided.

### The decision this card needs

Because the subsystem has never run, there is no installed behaviour to preserve and the safe order
is:

1. Make the two settings one setting, so the disagreement cannot recur.
2. Leave the effective default **off** until `fbdddc53` fixes where the archive lives — but make
   "off" *visible*, so the next person to look does not read the advertised `true` and conclude
   archiving is happening.

Turning it on today would write 2,552 rows into a store whose location is an open question.

## Metadata

**Complexity:** 3
**Tags:** archive, settings, database, standalone
**Dependencies:** the store's placement is decided by `fbdddc53` (Storage topology). This card must not pre-empt it.

## User Review Required

None.

## Proposed Changes

### 1. One setting, one default

- **Logic:** Delete one of the two keys. Whichever survives, the contributed default and the code
  default must be the same value, asserted by a test — the failure here is not the value, it is that
  two answers existed and nothing compared them.
- **Implementation:** The DB `config` row is the one the service actually reads and the one that works
  headless; the contributed VS Code setting is the one that does not exist on the Pi at all. Prefer
  the DB key, and have the contributed setting write it rather than shadow it.
- **Edge cases:** ~4,000 installs may have toggled the contributed setting believing it did something.
  Their intent was "archive my completed cards"; honour it when the single setting lands rather than
  silently resetting them to the code default.

### 2. The effective state must be visible

- **Logic:** Surface whether auto-archive is on, and when it last swept, where an operator looks —
  not only in a settings file. A subsystem that has run zero times in the lifetime of the board should
  be able to say so.
- **Rationale:** This defect survived because nothing reports it. The archive's absence is only
  discoverable by noticing a file that was never created.

### 3. Do not enable it in this card

- **Logic:** Land the setting fix with the effective default off, and let `fbdddc53` decide placement
  before anything sweeps. State the dependency in the code, not just here.
- **Edge cases:** If `fbdddc53` slips, the setting is still correct and still honest — it simply reads
  off, which is true.

## Verification Plan

### Automated Tests
- A test asserts the contributed default and the code default are the same value; it fails if either
  moves.
- With the setting on, a card past the dwell threshold is archived and the row leaves the hot store.
- With the setting off, the sweep runs and archives nothing — and says which setting stopped it.
- Reading the effective setting on the standalone host returns the same value as on the extension host.

### Goal Invariants
- Exactly one setting decides auto-archiving.
- No advertised default contradicts an effective one.
- "Never run" is reportable, not something you deduce from a missing file.

### Manual
- On the Pi, read the effective state and confirm it matches what the UI claims.

## Outstanding Questions

- None. Where the archive lives is `fbdddc53`'s question, deliberately not this card's.
