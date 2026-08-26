# The Sidebar Becomes a Launcher and a Status Board

**Complexity:** 5

## Goal

Stop the narrow sidebar column trying to be everything. Restructure it into named sections that launch well and report honestly - what is running, never what should run - and give Memo the editor tab it currently lacks, since it is the one surface that exists only in the cramped column. A cheap spike answers whether an editor-area terminal grid is even viable before the restructure commits to it, and the browser cockpit learns to say when the host it was served from is gone instead of polling a corpse forever.

## How the Subtasks Achieve This

- **The sidebar becomes a launcher and a status board** — the four-section restructure of the sidebar so the narrow column launches well and reports honestly instead of cramming everything.
- **A read-only Status section in the sidebar** — answers whether the host is alive, whether the fleet is up, what teams exist and who is seated, without the browser cockpit being open; reports what is running, never what should run.
- **Memo gets an editor tab panel** — gives Memo a real editor tab, since it is the one surface that exists only in the cramped column; the sidebar keeps Memo as a launcher.
- **Spike: find out whether a VS Code editor-area terminal grid is actually usable** — answers with working code, not assumption, whether the grid the restructure assumes is viable.
- **The cockpit polls a dead host forever without saying so** — gives the browser cockpit a visible host-offline state and a recovery path, instead of showing stale terminals against a host that is gone.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Memo Is the One Surface That Exists Only in the Cramped Column — Give It an Editor Tab](../plans/memo-gets-an-editor-tab-panel.md) — **CREATED** — ID: 42981110-e662-4ef4-9386-454daf0a3f1a
- [ ] [The Sidebar Becomes a Launcher and a Status Board, Not a Cramped Column of Everything](../plans/sidebar-becomes-launcher-and-status-board.md) — **CREATED** — ID: c335a73d-6724-48d3-9d35-cf1813640c3c
- [ ] [A Read-Only Status Section in the Sidebar: What Is Running, Never What Should Run](../plans/sidebar-read-only-status-section.md) — **CREATED** — ID: 665c24e0-2077-4b4b-a2b9-161b66c001ed
- [ ] [Spike: Find Out Whether a VS Code Editor-Area Terminal Grid Is Actually Usable](../plans/vscode-editor-grid-spike.md) — **CREATED** — ID: dc574a6d-a593-480d-8ba1-7bf778bb8b68
- [ ] [The Cockpit Polls a Dead Host Forever Without Saying So](../plans/cockpit-must-say-when-the-host-is-gone.md) — **CREATED** — ID: 046e5e5c-7fa3-47c3-b364-cbb4f8b42bc0
<!-- END SUBTASKS -->

## Dependencies & sequencing

The spike runs first: it is cheap, and its answer changes what the restructure should target. Then the restructure, then the Status section inside it — the restructure defines the section the Status work fills. The Memo tab and the cockpit offline state are independent of all three and can proceed in parallel.

