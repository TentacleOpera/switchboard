# PTY Fleet: Report Each Terminal's Parent Workspace

## Goal

Make `ptyListTerminals` say which configured parent workspace each terminal is in, and list every configured parent whether or not it holds terminals. This is the data the Terminals sidebar needs to stop labelling everything `Workspace Root`. No UI change ships here.

### Problem & Background

The Terminals page groups its sidebar by `worktreePath`, and every terminal without one falls into a single bucket whose header is the hardcoded string `'Workspace Root'` (`src/webview/terminals.js:713`, label at `:718`). With two configured parents the operator sees `Workspace Root 3 (3a/0x)` and cannot tell which repo any of those three terminals is in.

Worse, the label is not merely unhelpful — it is frequently wrong. Terminals opened before a parent switch are still running in the previous parent's directories, under a header implying the current one.

### Root Cause

`ptyListTerminals` returns `friendlyName, role, status, pid, startTime, worktreePath` and nothing else (`src/standalone/bootstrap.ts:1007-1019`, mirrored in `src/standalone/ptyHost.ts:66-78`). There is no field the client could group by, and no source anywhere on the wire for the list of configured parents.

The fleet does hold the answer to the first half and throws it away: `create()` computes `effectiveCwd` (`ptyFleetService.ts:81`), spawns the shell there, and never records it. The handle keeps `worktreePath` but not the directory the terminal is actually in.

> **Superseded:** the original plan's approach — ship the full configured parent set into the pty child as a `--parents` JSON boot argument, add a `ptySetParents` verb wired to `switchboard.mappingsChanged` to keep it fresh, add a `resolveParent()` longest-prefix matcher inside `PtyFleetService`, and have the child return a resolved `parentRoot` per terminal.
> **Reason:** it makes the child process responsible for a mapping lookup, which forces the entire mapping set across a process boundary and then forces a refresh channel to keep it current. The child does not need to know. It only needs to report the directory it already chose; the extension host — which holds the mappings natively via `getMappingsFromIndex()` — can resolve that directory to a parent name on the way out. That deletes the boot argument, the verb, the refresh wiring, the normalisation helper and every staleness concern.
> **Replaced with:** the child reports `cwd`; the extension resolves and enriches the response in the proxy it already owns.

## Implementation

### 1. Record the directory the terminal is actually in

In `PtyFleetService`:

- Add `cwd: string` to `ExtendedTerminalHandle` (`:28`) and `FleetTerminalInfo` (`:16`).
- In `create()`, set `cwd: effectiveCwd` on the handle literal at `:86`. The value is already computed one line above.

Record at creation only, never recomputed — a terminal's directory is a fact about where its shell was launched, and must not shift when mappings are edited.

### 2. Report it

Add `cwd: t.cwd` to the per-terminal map in both `ptyListTerminals` copies — `bootstrap.ts:1010-1017` and `ptyHost.ts:69-77`. These two are hand-duplicated and drift silently; changing one and not the other gives a sidebar that works in one host and not the other.

No new verb. No change to the route surface, `verbSchemas.ts` or the verb allowlist, so `pty-route-surface-contract.test.js` is unaffected.

### 3. Resolve to a parent in the extension proxy

In `TaskViewerProvider.handlePtyVerb` (`:1930`), after `_ptyHostVerb` returns and when `verb === 'ptyListTerminals'`, enrich the response:

- For each terminal, set `parentRoot` = the `parentFolder` of the mapping that owns its `cwd`, or `null` if none owns it.
- Attach a top-level `parents: [{ id, name, parentFolder, workspaceFolders }]` — **every configured mapping, whether or not it holds terminals**, because the sidebar must render an empty accordion for a parent with none.

Source both from `getMappingsFromIndex()` (`WorkspaceIdentityService.ts:95`), which this file already requires at `:2491`.

**Ownership test.** A mapping owns a directory when the directory equals, or sits inside, its `parentFolder` or any of its `workspaceFolders`. Compare resolved **path segments**, not string prefixes — a raw `startsWith` makes `/…/Gitlab-archive` a child of `/…/Gitlab`. When two mappings both match, the longer match wins. Expand `~` and `path.resolve` both sides first; stored mappings may be `~`-relative, and `resolveEffectiveWorkspaceRootFromMappings` already does this expansion at `:135-170` — reuse that handling rather than writing a second one.

**When mappings are disabled or empty** — `getMappingsFromIndex()` returns `{ enabled: false, mappings: [] }` for any operator who has never configured multi-workspace mappings, which is the common case. Emit one synthetic parent for the extension's own effective root so the sidebar has something to render:

```json
[{ "id": "workspace-root", "name": "<basename>", "parentFolder": "<effectiveRoot>", "workspaceFolders": [] }]
```

Every terminal then resolves to it, and the single-workspace operator gets their repo's real name in the header instead of `Workspace Root`.

### 4. Standalone host parity

`bootstrap.ts` serves `ptyListTerminals` from its own switch (`:1007`) with no extension proxy in front of it, but it does hold a `db` (`:1287`). Do the same enrichment there, sourcing mappings from `await db.getWorkspaceMappings()` (`KanbanDatabase.ts:924`).

Put the resolver in one exported function so both hosts call the same code — two implementations of one matching rule is how the two hosts drift.

### Out of scope

- Any sidebar rendering change — that is the hierarchy plan.
- Choosing where a terminal opens — that is the spawn plan.
- Changing the `${role}-${n}` naming scheme. It is a flat namespace across parents, so `coder-1` and `coder-2` may sit in different repos. The UI supplies the grouping; renaming would invalidate every persisted `paneAssignments` array, the dispatch map and the `runtime.terminals` registry.

## Metadata

**Complexity:** 3
**Tags:** backend, api, refactor

## User Review Required

No. This adds fields to a response payload. No existing field changes meaning, no caller changes behaviour, and no UI consumes the new fields until the hierarchy plan lands.

## Complexity Audit

### Routine

- One field added to two interfaces and two response maps.
- A path-containment helper.
- An enrichment block in a proxy that already post-processes this verb's response.

### Complex / Risky

- **Two hosts must produce the same response shape** from two different mapping sources. A shared resolver is the only thing enforcing it.
- **Path comparison done wrong is silent.** A prefix test rather than a segment test mis-files terminals into a neighbouring directory's parent; nothing crashes, the label is just wrong — which is the exact class of bug this plan exists to fix.
- The disabled-mappings case is the majority case and produces an empty `parents[]` if forgotten.

## Edge-Case & Dependency Audit

**Race Conditions**
- Mappings edited while terminals are running. Resolution happens per list call, so the new labels appear on the next refresh with no extra wiring — this is a direct benefit of resolving extension-side rather than shipping a cached set into the child.

**Security**
- None. Read-only enrichment of a response, from the extension's own configuration.

**Side Effects**
- `ptyListTerminals` gains `cwd` and `parentRoot` per terminal and a top-level `parents`. The registry mirror at `TaskViewerProvider.ts:1901-1922` copies named fields and ignores extras.
- `cwd` exposes a filesystem path to the browser panel. The panel already displays full worktree paths in group headers.

**Dependencies & Conflicts**
- Touches `ptyFleetService.ts`, `ptyHost.ts`, `bootstrap.ts`, `TaskViewerProvider.ts`, `WorkspaceIdentityService.ts`.
- The spawn plan also edits `ptyFleetService.ts:95` and `handlePtyVerb`. Different lines; trivial merge either order.

## Dependencies

- Independent of the spawn plan.
- The hierarchy plan consumes everything this one produces and must land after it.

## Adversarial Synthesis

Key risks: the two hosts diverging because they resolve mappings from different sources; a prefix rather than segment containment test mis-attributing sibling directories; and an empty `parents[]` for the majority of operators, who have no mappings configured at all. Mitigations: one exported resolver called by both hosts, a segment comparison with longest-match selection reusing the `~`-expansion the existing resolver already performs, and an explicit synthetic single-parent entry whenever mappings are disabled or empty.

## Proposed Changes

### `src/services/WorkspaceIdentityService.ts`

- **Context:** already owns `getMappingsFromIndex` (`:95`) and `resolveEffectiveWorkspaceRootFromMappings` (`:111`), and is imported from both host sides.
- **Logic:** One resolver, shared.
- **Implementation:** `export function resolveParentsForTerminals(cfg, fallbackRoot, terminals)` returning `{ parents, byCwd }` — builds the normalised parent list (with the synthetic fallback entry when disabled/empty) and maps each terminal `cwd` to an owning `parentFolder` by longest segment match.
- **Edge Cases:** `enabled: false`; empty `parentFolder` (fall back to `workspaceFolders[0]`, as `:158-161` already does); `~`-prefixed entries; overlapping mappings; a `cwd` under none of them → `null`.

### `src/standalone/ptyFleetService.ts`

- **Context:** `effectiveCwd` at `:81`; handle literal at `:86-96`; `FleetTerminalInfo` at `:16`.
- **Logic:** Keep the directory it already chose.
- **Implementation:** add `cwd: string` to both types; `cwd: effectiveCwd` on the handle.
- **Edge Cases:** none — the value always exists.

### `src/standalone/ptyHost.ts` and `src/standalone/bootstrap.ts`

- **Context:** `ptyListTerminals` at `ptyHost.ts:66` and `bootstrap.ts:1007`.
- **Logic:** Report `cwd`; in the standalone host only, also enrich.
- **Implementation:** add `cwd: t.cwd` to both maps; in `bootstrap.ts`, wrap the response with `resolveParentsForTerminals(await db.getWorkspaceMappings(), workspaceRoot, …)`.
- **Edge Cases:** `getWorkspaceMappings()` on a fresh DB returns the disabled default — the synthetic parent covers it.

### `src/services/TaskViewerProvider.ts`

- **Context:** `handlePtyVerb` at `:1930`; `getMappingsFromIndex` already required at `:2491`.
- **Logic:** Enrich the child's response on the way back.
- **Implementation:** for `ptyListTerminals`, run the shared resolver over `result.terminals` using `getMappingsFromIndex()` and `effectiveRoot`, attach `parentRoot` per terminal and `parents` at top level.
- **Edge Cases:** the child returned `success: false` → pass through untouched; a terminal predating the `cwd` field (impossible after a host restart, but cheap to guard) → `parentRoot: null`.

## Verification Plan

### Automated Tests

1. **Reporting:** `ptyListTerminals` returns `cwd` per terminal, `parentRoot` per terminal, and a top-level `parents[]`.
2. **Attribution:** a terminal in `Gitlab/be` resolves to the Gitlab parent; one in `GitHub/switchboard-site` to the Switchboard parent; one in an unmapped directory to `null`.
3. **Segment comparison:** a terminal in `/…/Gitlab-archive` does **not** resolve to the `/…/Gitlab` parent.
4. **Longest match:** with overlapping mappings `/x` and `/x/y`, a terminal in `/x/y/z` resolves to `/x/y`.
5. **Empty parent:** a configured parent holding zero terminals still appears in `parents[]`.
6. **Disabled mappings:** with `{ enabled: false, mappings: [] }`, `parents[]` holds exactly one synthetic entry and every terminal resolves to it — not an empty array.
7. **`~` expansion:** a mapping stored with a `~`-prefixed `parentFolder` still matches an absolute `cwd`.
8. **Live mapping edit:** change mappings, call `ptyListTerminals` again with no reload — the new labels appear.
9. **Host parity:** the responses from the standalone path and the extension proxy path have identical top-level keys.
10. **Regression:** the existing terminal contract suites still pass, and `pty-route-surface-contract` in particular is untouched because no verb was added.

## Recommendation

Complexity 3 → **Send to Intern**.

## Completion Report

Implemented terminal directory recording and parent attribution resolution across both standalone host and extension host proxy. Terminals now record their execution `cwd`, which is matched via segment containment against workspace mappings in `resolveParentsForTerminals` to attach `parentRoot` per terminal and a `parents` list in `ptyListTerminals`.
Files changed: `src/services/WorkspaceIdentityService.ts`, `src/standalone/ptyFleetService.ts`, `src/standalone/ptyHost.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`.
No issues encountered during implementation.

