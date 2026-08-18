# Planning Navigational Docs — Component Map, IPC Index, Search Scoping, File TOCs

## Goal

Spark (and any external planning agent) reads the docs zip to understand the product before writing plans. Today the docs zip contains behavioural docs (constitution, PRDs, README) but lacks navigational orientation: there is no map of what lives where, no index of the message-passing protocol, no guidance on where to search, and no in-file navigation aids for the largest source files. This makes every planning task start with broad codebase searches instead of targeted reads.

Spark identified four specific gaps in its response about what would make plan-writing easier. All four are documentation gaps, not feature gaps — the docs-zip pipeline already works, it just delivers an incomplete doc set.

### Root cause

The existing docs (`CONSTITUTION.md`, `README.md`, `docs/TECHNICAL_DOC.md`) cover rules, invariants, and runtime behaviour, but none of them provide a feature-to-file cross-reference or a message-protocol index. `docs/TECHNICAL_DOC.md` is stale (last audited March 19, 2026) and describes runtime architecture, not a navigational map. The large webview JS files (tickets.js ~8,400 lines, planning.js ~9,200 lines, terminals.js ~9,600 lines) have no top-of-file TOC, so an agent must scan the entire file to find the section it needs.

## Metadata

**Complexity:** 4
**Tags:** docs, feature
**Project:** Browser Switchboard

## User Review Required

None — these are additive documentation files. No existing behaviour changes.

## Complexity Audit

### Routine

- All four deliverables are pure documentation (markdown files and comment blocks). No logic changes, no API changes, no migrations.
- The component map and search-scoping note are low-churn: folder layout and panel structure are stable.
- The README "For AI agents" section is a 5-10 line addition to an existing file.

### Complex / Risky

- **IPC index accuracy**: requires reading and cross-referencing many files to build accurate tables. ~50-80 message types across all panels, each with file:line references that are stale-prone.
- **File TOCs require reading each large file end-to-end** to identify section boundaries. Nine files, several over 10k lines.
- **Staleness risk** is the main ongoing concern — these docs will rot as the codebase evolves. This plan creates them; the companion plan (Docs Health tab) provides the maintenance mechanism.
- **TOC placement shifts line numbers**: inserting a comment block at the top of a 26k-line file shifts every subsequent line number. No external tool in this codebase references source line numbers (the verb-return-contract ratchet counts `break` statements, not lines), so the impact is contained — but the TOC should be placed after any existing top-of-file banner/license/IIFE opening to minimize shift.

## Edge-Case & Dependency Audit

- **Which files get TOCs?** Files over ~1,500 lines in `src/webview/` and `src/services/`. Concretely (line counts verified Aug 2026): `tickets.js` (~8,400), `planning.js` (~9,200), `terminals.js` (~9,600), `design.js` (~5,570), `project.js` (~3,690), and on the backend side `KanbanProvider.ts` (~14,460), `TaskViewerProvider.ts` (~26,560), `KanbanDatabase.ts` (~10,670), `PlanningPanelProvider.ts` (~7,354). `LocalApiServer.ts` (~4,645) is dense but under the TOC threshold — skip it unless the coder judges it warrants one. The TOC is a comment block at the top of the file listing major regions with approximate line ranges.
- **TOC placement**: insert the comment block after the IIFE opening / imports / any existing file banner, before the first substantive code. This minimizes line-number shift for any existing references.
- **IPC index scope**: cover `postMessage` calls from webview→host and `addEventListener('message')` handlers in webview JS, plus the corresponding handler switch arms in the `*PanelProvider.ts` files.

  > **Superseded:** The IPC index covers only `postMessage` calls from webview→host and `case` arms in providers.
  > **Reason:** Providers also push unsolicited messages to the webview via `this.postMessageToWebview({ type: '...' })`. These host→webview pushes are part of the IPC protocol — an agent tracing a user action needs to see both directions. Omitting them leaves the index half-complete.
  > **Replaced with:** The IPC index covers both directions: (1) webview→host `postMessage` calls and their `case` arms in providers, and (2) host→webview pushes via `this.postMessageToWebview()` calls in providers. The table's Direction column already has `webview→host / host→webview` — populate both. Do not attempt to cover the browser-host WebSocket transport messages (`transport.js`) — that is a separate protocol layer.

- **Component map format**: a table with columns: Panel/Feature | HTML file | Client JS | Backend provider | Test files. One row per panel (Tickets, Kanban, Planning, Design, Setup, Project, Connections, Terminals, Memo). Plus a folder-layout section describing `src/webview/` vs `src/services/` vs `src/test/` vs `src/standalone/` vs `src/generated/` (build-generated allowlists) vs `.agents/` (workflow contracts and skills) vs `.switchboard/` (runtime data).
- **Search scoping note**: add to `README.md` a short "For AI agents" section stating that `src/` is the source of truth, `dist/` is a build artifact that is not used in development or testing, and searches should be scoped to `src/` to avoid stale generated bundles. Frame this section as guidance for AI planning agents, not human documentation — the README already says "The online docs are the single source of truth" for humans; the agent section is a complementary addendum, not a contradiction.
- **File naming**: `ARCHITECTURE.md` at repo root (conventional, discoverable). The IPC index as a separate `docs/IPC_PROTOCOL.md` — separate file is cleaner since the index is long.
- **CONSTITUTION.md overlap**: the constitution has an "Architecture & Layering Invariants" section (line 34). The new `ARCHITECTURE.md` is a map (what lives where), not rules (what must be true). They complement, not conflict. Add a cross-reference from the constitution to the new map.
- **Docs-zip pipeline dependency**: the navigational docs are only useful if they reach the planning agent. The docs-zip pipeline bundles `.md` files from a user-chosen folder. `ARCHITECTURE.md` (repo root) and `docs/IPC_PROTOCOL.md` will only be included if the user's chosen docs folder encompasses the repo root or the `docs/` directory. This is a pipeline concern, not a plan-level blocker — the docs are created in the correct conventional locations. The "For AI agents" section in README.md (which is typically included in the zip) points the agent to these files.

## Dependencies

- None. These are standalone documentation files.
- The companion plan (Docs Health tab) depends on these doc categories existing as the recommended set, but the tab can ship independently — it recommends doc types generically.

## Adversarial Synthesis

**Risk Summary:** Key risks: staleness of file:line references in the IPC index and TOCs (mitigated by agent-regenerable design + companion maintenance plan); IPC index scope ambiguity around host→webview pushes (resolved — index now covers both directions); README "For AI agents" section framing (minor — framed as agent-only guidance). Mitigations: mark all line references as approximate, include both IPC directions, frame README section as agent guidance addendum.

**Challenge: "These docs will be stale within a week of being written."**
True if hand-maintained and forgotten. Mitigated by: (1) the companion Docs Health plan provides a scheduled maintenance prompt, (2) the component map and search-scoping note change rarely (folder layout is stable), (3) the IPC index and file TOCs are higher-churn but an agent regenerating them from scratch is a 5-minute task. The docs are designed to be *regenerable by an agent*, not hand-maintained forever.

**Challenge: "Why not auto-generate the IPC index and TOCs with a script?"**
A script would be more durable but adds maintenance burden (the script itself must be maintained, tested, and shipped). For a first pass, hand-authored docs that an agent can regenerate are simpler and sufficient. A generator script could be a future enhancement if staleness becomes a real problem.

**Challenge: "ARCHITECTURE.md vs docs/TECHNICAL_DOC.md — redundant?"**
No. TECHNICAL_DOC.md is a deep runtime audit (stale, describes how things work internally). ARCHITECTURE.md is a navigational map (where things live, what file serves what panel). Different audiences: TECHNICAL_DOC is for someone debugging internals; ARCHITECTURE is for an agent orienting before a task.

**Challenge: "The IPC index only covers webview→host — what about host→webview pushes?"**
Providers call `this.postMessageToWebview({ type: '...' })` to push unsolicited messages to the webview (state updates, async results, notifications). These are part of the IPC protocol. The index now covers both directions: webview→host `postMessage` calls with their `case` arms, and host→webview `postMessageToWebview` calls. The table's Direction column distinguishes them.

## Proposed Changes

### 1. Create `ARCHITECTURE.md` at repo root

A concise (~200-300 line) navigational map:

- **Folder layout section**: `src/webview/` (frontend views: HTML + client JS), `src/services/` (backend providers and sync services), `src/test/` (test suites), `src/standalone/` (browser runtime), `src/generated/` (build-generated allowlists), `.agents/` (workflow contracts and skills), `.switchboard/` (runtime data).
- **Feature-to-file mapping table**: one row per UI panel, columns: Panel | HTML file | Client JS | Backend provider | Key test files. Covers: Tickets, Kanban, Planning, Design, Setup, Project, Connections, Terminals, Memo.
- **Service cross-reference**: a short table of the major services in `src/services/` (KanbanDatabase, KanbanProvider, LocalApiServer, ClickUpSyncService, LinearSyncService, ContinuousSyncService, etc.) with one-line descriptions.
- **Cross-reference to CONSTITUTION.md** for rules/invariants, and to `docs/TECHNICAL_DOC.md` for deep runtime detail.

### 2. Create `docs/IPC_PROTOCOL.md`

A message-protocol index covering the webview↔host `postMessage` layer in **both directions**:

- **Table format**: Message type | Direction (webview→host / host→webview) | Sent from (file:line) | Handled in (file:line) | Purpose (one line).
- Organized by panel (Tickets messages, Planning messages, Kanban messages, etc.).
- **Webview→host**: covers `postMessage` calls in the webview JS files and the corresponding `case 'messageType':` arms in the `*PanelProvider.ts` handlers.
- **Host→webview**: covers `this.postMessageToWebview({ type: '...' })` calls in the `*PanelProvider.ts` files and the corresponding `if (message.type === '...')` / `case` handlers in the webview JS message listeners.
- Does NOT cover the browser WebSocket transport (`transport.js`) — note this exclusion at the top.
- Approximate scope: ~50-80 webview→host message types plus ~30-50 host→webview push types across all panels.
- All file:line references are approximate (the docs are regenerable; exact line numbers will drift).

### 3. Add "For AI agents" section to `README.md`

A short section (5-10 lines) after the existing content, clearly labeled as guidance for AI planning agents:

- `src/` is the source of truth for all code.
- `dist/` is a webpack build artifact — not used in development or testing. Do not search or read it.
- `docs/` contains reference docs; `ARCHITECTURE.md` at the root is the navigational map.
- For planning agents: read `ARCHITECTURE.md` and `docs/IPC_PROTOCOL.md` before searching the codebase.

Frame this as a complementary addendum for agents, not a replacement for the human docs — the README already says "The online docs are the single source of truth" for human readers.

### 4. Add section TOC comment blocks to large files

For each file over ~1,500 lines in `src/webview/` and the largest `src/services/` files, add a top-of-file comment block **after the IIFE opening / imports / any existing file banner**, before the first substantive code, listing major regions with approximate line ranges:

```javascript
// ┌─ Section Map ──────────────────────────────────────────────────────
// │ State & Constants .......... lines XX–XX
// │ Renderers .................. lines XX–XX
// │ Event Handlers ............. lines XX–XX
// │ Message Dispatch ........... lines XX–XX
// │ Modal/Dialog Handlers ...... lines XX–XX
// │ Init ....................... lines XX–XX
// └────────────────────────────────────────────────────────────────────
```

Files to add TOCs to (line counts approximate, verified Aug 2026):
- `src/webview/tickets.js` (~8,400 lines)
- `src/webview/planning.js` (~9,200 lines)
- `src/webview/terminals.js` (~9,600 lines)
- `src/webview/design.js` (~5,570 lines)
- `src/webview/project.js` (~3,690 lines)
- `src/services/KanbanProvider.ts` (~14,460 lines)
- `src/services/TaskViewerProvider.ts` (~26,560 lines)
- `src/services/KanbanDatabase.ts` (~10,670 lines)
- `src/services/PlanningPanelProvider.ts` (~7,354 lines)

The TOC is a comment block only — no code changes, no logic changes. Line ranges are approximate (±20 lines) and marked as such. Place the block after any existing top-of-file banner/license/IIFE opening to minimize line-number shift for existing references.

## Verification Plan

- [ ] `ARCHITECTURE.md` exists at repo root, has a feature-to-file table covering all 9 panels, and a folder-layout section.
- [ ] `docs/IPC_PROTOCOL.md` exists, has a message-type table organized by panel covering both webview→host and host→webview directions, and explicitly notes the transport.js exclusion.
- [ ] `README.md` has a "For AI agents" section mentioning `src/` as source of truth and `dist/` as build artifact.
- [ ] Each of the 9 large files listed above has a section-map comment block near the top (after banners/imports) with region names and approximate line ranges.
- [ ] `npm run lint` passes (comment blocks should not affect linting, but verify).
- [ ] `npm run compile` passes (no code changes, but verify the comment blocks don't break anything).
- [ ] Spot-check: pick 3 message types from `docs/IPC_PROTOCOL.md` and verify the file:line references are accurate.
- [ ] Spot-check: pick 2 section TOCs and verify the line ranges are approximately correct.
- [ ] Spot-check: verify at least 2 host→webview push types (e.g. `createPlansState`, `remoteConfig`) are in the IPC index with correct direction.

---

## Completion Summary

Implemented all four navigational-docs deliverables. Created `ARCHITECTURE.md` at repo root (folder-layout table, 9-panel feature-to-file mapping, major-services cross-reference, cross-refs to CONSTITUTION/TECHNICAL_DOC/IPC_PROTOCOL) and added a cross-reference block at the top of `CONSTITUTION.md`'s "Architecture & Layering Invariants" section pointing to it. Created `docs/IPC_PROTOCOL.md` — a both-directions webview↔host `postMessage` index organised by panel (Kanban, Planning, Project, Design, Setup, Tickets, Connections, Terminals, Memo, TaskViewer shared pushes), with the `transport.js` exclusion and the `terminals.js` HTTP-verb exception noted up front, plus a regeneration recipe. Added a "For AI agents" section to `README.md` framing `src/` as source of truth, `dist/` as build artifact, and pointing to `ARCHITECTURE.md` / `docs/IPC_PROTOCOL.md`. Added section-map TOC comment blocks (after IIFE/imports, before first substantive code) to all 9 large files: `tickets.js`, `planning.js`, `terminals.js`, `design.js`, `project.js`, `KanbanProvider.ts`, `TaskViewerProvider.ts`, `KanbanDatabase.ts`, `PlanningPanelProvider.ts`.

Files changed: `ARCHITECTURE.md` (new), `docs/IPC_PROTOCOL.md` (new), `README.md`, `CONSTITUTION.md`, and the 9 source files above. Verification: `npm run lint` passes with 0 errors (2583 pre-existing warnings, unchanged); compilation and tests skipped per run directives. Spot-checks: `linearLoadTaskDetails` (tickets.js ~3176), `fetchKanbanPlans` (planning.js ~1740), `moveCards` (KanbanProvider ~6183) file:line refs verified; tickets.js and KanbanProvider.ts TOC ranges verified approximately correct; host→webview push types `createPlansState` (PlanningPanelProvider ~3113) and `remoteConfig` (KanbanProvider ~2723) confirmed present with correct direction. No issues encountered; all changes are additive documentation / comment-only — no logic touched.
