# Board Collapse 05 — Apply the Host and Infrastructure Decisions

## Goal

Apply five of the sixteen signed conflict decisions, all concerning host seams, transport trust and configuration storage: the command seam, the CSRF guard against the tailnet board, the SQL write guardrail, where startup commands live, and the fleet-flag ratchet count.

### Problem analysis

Five conflicts in the layer beneath the panels. Two are dangerous rather than merely duplicated: the CSRF guard as written would reject every request from the tailnet board, and the command-seam throw would convert a silently skipped step into a half-completed verb across 196 call sites. The decisions were taken by the operator on 2026-09-04 and are settled.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Rescoping preserves the plan id and filename.
3. **No git working-tree operation** while this runs. Commits are fine — one per decision.
4. Deleting a card uses the board's delete path so the `.md` goes with it.
5. Do not touch `src/`.

## Metadata

- **Complexity:** 5
- **Tags:** board-hygiene, host-seams, security, storage

## Proposed Changes

### Decision 3 — the command seam reports, it does not throw

**Signed: per-occurrence reporting.** The 196 `commands.executeCommand` call sites were written against a seam that never throws and almost none sit in a `try`. Throwing turns a skipped step into an unhandled rejection mid-verb, so a handler that saves state and then calls a command fails after the save, half done. Reporting lets the verb finish and names the step that did not run.

- Keep *Audit the command seam — unbridged commands are dead and their failures are swallowed*. Its compiler-based inventory (196 sites, 77 ids, 11 bridged) is the complete one.
- Delete *The headless host answers `success: true` for commands it never runs*. Its grep-based inventory is short by 70 sites and 39 ids; its `SWITCHBOARD_HEADLESS_LENIENT` escape hatch restores the silent fallback, which the project's fallback rule forbids; and its claim that no other plan blocks it is false.
- Before deleting, carry two things into the surviving plan: its concrete bridge list of roughly 20 state-changing commands mapped to the service methods `extension.ts` already calls, which become the audit's "dead, bridge it" rows; and its explicit inert-command set, which becomes the audit's editor-only class.

### Decision 7 — the CSRF allow-set is loopback plus the tailnet hosts

**Signed: keep the guard, widen its allow-set to the hosts the server already trusts.**

A page served at the machine's tailnet name sends that name as `Origin` on every fetch. The guard as written rejects any present, non-loopback `Origin`, so it would 403 every verb from the tailnet board — the one remote path that works — and would do so invisibly, since a failed verb currently looks like a hung one.

- Rescope *The browser board is served unauthenticated by the extension host* so its `Origin` check accepts loopback **or** any host in the tailnet bind policy, the same set the existing Host-header guard consults. One list, two guards, no second copy to drift. State that IPv6 literals need bracket handling in the comparison.
- Create feature **Tailnet** from four cards, in this order: *Tailnet Mode Accepts The Node's Own MagicDNS Names* (finish the IPv6 listener, its only remaining change), *The tailnet URL is chosen for reachability, never for origin trust*, *`switchboard tailnet` prints the credential-free URL and then opens the credentialed one*, then the CSRF plan. The MagicDNS plan must land first because it is what populates the bind policy with names.
- *A verb POST has no timeout* stays loose and independent; it is the reason a 403 would be invisible, and it is worth having either way.

### Decision 11 — the SQL write guardrail is deleted

**Signed: drop it.** Verified at HEAD: layer 4 is already done (`move-card.js` has no database fallback left; the `kanban_operations` scripts route through `_lib/cli-call.js`). Layer 1's three remaining bare `sqlite3` calls are the exact `manage-features/SKILL.md` lines the POSIX subtask rewrites away. Layer 3 adds a warning toast inside `KanbanDatabase._reloadIfStale`, a function the sidecar plan deletes outright — a single owner over HTTP makes an external writer impossible by construction, so the warning is either premature or wrong.

- Delete *SQL Write Guardrail — Prevent Agents from Writing to kanban.db Directly*.
- Carry its one live idea into *Three skills instruct agents to use POSIX-only tooling* as a single line: narrow the Claude Code permission from `Bash(sqlite3 *)` to `Bash(sqlite3 -readonly *)` in `.claude/settings.json` and its source in `ClaudeCodeMirrorService.ts:103`.
- Do not write the "silent overwrite" wording into the four skill files; that premise dies with `_reloadIfStale`.
- Feature *Eliminate Manual Card Moves* now has no subtasks (its other one was re-homed by Board Collapse 03). Remove it.

### Decision 12 — startup commands: provenance now, database after the real binding

**Signed: the provenance plan lands first and the JSON is interim, not canonical.**

The settings move waits only on the **real SQLite binding**, not on the single global database. sql.js holds the whole database in memory and writes the entire image back on each persist, so two processes writing it lose each other's updates exactly as they do with the JSON file; moving the settings into a sql.js database today changes the file extension and nothing else. Row-per-block granularity only protects writers inside one process.

- *Two stores hold agent startup commands* lands first, unchanged in substance, except that its `source` provenance tag takes three legal values: global file, workspace database, global database — so "which store answered" stays answerable under either regime. It alone retires the stale per-workspace `agents.*` rows.
- Rescope *Global settings are a JSON file two boards can both write* — change its hard prerequisite from *Consolidate to one global database* to *Move the database behind a single sidecar owner and replace sql.js with a real SQLite binding*. Move it from Backlog to Planned behind that one plan. Delete its own row-retirement step (the provenance plan owns it). The JSON is archived as `.migrated.bak` on import, never retained as a fallback.
- Add cross-references in both directions; neither currently names the other.

### Decision 14 — the ratchet pins a measured count

**Signed: route lands first; the ratchet pins the per-file count measured at HEAD when it lands.**

- *Agent Terminals Must Open on the Surface the Operator Is Actually Using* is the root of its feature and two subtasks wait on it; it goes first. It already promises to update the two regex-pinned tests in lockstep.
- Rescope *Dispatch-Surface Ratchet — Stop `apiOriginated` Growing Back*: replace "`allowPtyFleet` pinned to its exact count, 4 legitimate sites" with "the per-file count measured at HEAD when this lands, with a reason recorded beside each site". The flag must still never be pinned to zero — it is live API and four contract tests assert it present.
- Add the cross-reference; neither plan names the other today.

## Verification Plan

- Five commits, one per decision.
- No active plan proposes throwing from `VscodeHostCommands.executeCommand`; the surviving audit plan carries the bridge list and the inert set.
- The CSRF plan's text names the tailnet bind policy as its allow-set source; a feature named **Tailnet** exists with four subtasks in the stated order.
- No active plan proposes a warning inside `_reloadIfStale`; the POSIX plan carries the read-only permission line; feature *Eliminate Manual Card Moves* no longer exists.
- The global-settings plan's prerequisite names the sidecar plan and it sits in Planned, not Backlog.
- The ratchet plan contains no literal count for `allowPtyFleet`.
- `git status` shows only `.switchboard/` changes.
