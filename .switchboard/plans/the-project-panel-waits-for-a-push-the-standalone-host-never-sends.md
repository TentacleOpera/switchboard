# The Project Panel Waits for a Push the Standalone Host Never Sends

## Goal

Make clicking a subtask in the Project panel show its plan. Today it silently does nothing in the
standalone host.

### Problem analysis

**Reproduced from the operator's report:** click *Review feature* on the kanban → the Project panel
opens on the right feature file → expand subtasks → click a subtask → nothing. No preview, no error,
no toast.

**The request works; the reply is never delivered.**

- `project.js:2903` posts `fetchKanbanPlanPreview` on the subtask click.
- Routing is fine: `/project/verb/*` → `_handlePlanningVerb` (`LocalApiServer.ts:12326`), the verb is
  in `PLANNING_VERBS`, and it is handled at `PlanningPanelProvider.ts:4008`.
- `project.js:667` then waits for a **pushed** `kanbanPlanPreviewReady` message.
- In the extension host that push exists — `PlanningPanelProvider.ts:1797`, `:1823`, `:1834`.
- In the standalone host it does not: `kanbanPlanPreviewReady` appears **nowhere** in
  `bootstrap.ts` or `LocalApiServer.ts`. The verb returns its content in the HTTP response body, and
  `transport.js` only re-emits what arrives over the WebSocket (`:66`, `:232`) — never a verb's
  response body.

So the content is fetched and thrown away. The click handler is not at fault: it would have shown
*"This subtask has no plan file to preview"* had `planFile` been empty.

**This is the exact failure class the parity guard names.** `scripts/check-standalone-push-parity.js`:
*"Every parity audit that declared standalone 'done' checked verb reachability — which cannot fail…
The dead half is the READ-BACK path: the payload the standalone host pushes to the browser."*

## Metadata

**Complexity:** 3
**Tags:** bugfix, standalone, project-panel, parity
**Dependencies:** belongs with `Defects the Parity Audits Could Not See — Omitted Wiring, Orphan
Wires` (PLAN REVIEWED).

## User Review Required

None.

## Proposed Changes

### 1. Deliver the preview to the panel in standalone

- **Logic:** the panel must receive `kanbanPlanPreviewReady` however the host is running. Either the
  standalone host pushes it over the WebSocket like the extension does, or `transport.js` converts a
  verb's response body into the message shape the UI already handles (it does this for other calls —
  see the comment at `transport.js:268`).
- **Prefer the transport conversion** if other verbs already rely on it: one seam, and it fixes every
  request/reply verb of this shape at once rather than this one.

### 2. Find the others of this shape

- `fetchKanbanPlanPreview` is posted from **five** places in `project.js` and two in `planning.js`.
  Whatever fixes the subtask click should fix all of them; assert that rather than assuming.
- The general check: a webview that posts a verb and then waits for a pushed reply, where the
  standalone host only returns a body. Worth a ratchet in the parity guard.

## Verification Plan

- Clicking a subtask in the Project panel renders its plan in the standalone host.
- All five `fetchKanbanPlanPreview` call sites in `project.js` render.
- A verb whose reply is never delivered fails visibly rather than silently.

## Outstanding Questions

- Does the same gap affect other request/reply verbs the parity guard has not ratcheted yet? The guard
  measures pushed payloads; a reply that is *never* pushed may not register as a gap at all.
