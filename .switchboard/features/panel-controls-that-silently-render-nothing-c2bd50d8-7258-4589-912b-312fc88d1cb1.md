# Panel Controls That Silently Render Nothing

**Complexity:** 4

## Goal

Fix two panel surfaces that degrade to nothing without an error, both survivors of panel extraction and consolidation work.

Clicking Edit on a ticket gives a plain textarea instead of the shared markdown editor shell - no toolbar, no split live preview, no view-mode toggle. The wiring is all present in source: the script tag, the provider URI substitution in both hosts, the attach call and the CSS. The attach is guarded on the editor global being defined, and when that guard fails the panel falls through to the bare textarea silently rather than reporting anything.

Switching the Previews source dropdown in the design panel to HTML Previews gives an empty left sidebar - no file list, no folder headers, and no empty-state message either, so the user cannot tell a misconfiguration from a bug. It should list the configured HTML folders and the html files inside them, or say clearly that none are configured.

Neither is a missing feature. Both are shipped capabilities that stopped rendering, and in both cases the failure is silent, which is why they read as removed rather than broken.


## How the Subtasks Achieve This

- **Markdown Editor Missing From The Tickets Panel**: recovers the rich editor shell — toolbar, split live preview, view-mode toggle — instead of falling silently through the `window.SwitchboardMarkdownEditor` guard to a bare textarea. All the wiring is present in source in both hosts; the failure is that the guard's else-branch degrades without reporting anything.
- **HTML Previews Dropdown Shows An Empty Sidebar**: renders the configured HTML folders and their `.html`/`.htm` files in the design panel's Previews tab, or a clear empty state when none are configured, instead of a blank pane that cannot be told apart from a misconfiguration.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Fix: HTML Previews dropdown shows an empty sidebar in design.html](../plans/feature_plan_20260804090741_html-previews-empty-sidebar.md) — **PLAN REVIEWED** — ID: c5f9d9f4-c129-4d73-badc-3de44b8a6c5b
- [ ] [Markdown editor missing from the Tickets panel — recover the rich editor instead of silently degrading to a bare textarea](../plans/feature_plan_20260826123701_markdown-editor-missing-from-tickets-panel.md) — **PLAN REVIEWED** — ID: b1107c05-0b83-4258-8c53-0b11587662e0
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; different panels, independent fixes, both frontend-only.

They are grouped because they share a failure **shape** rather than a code path: a shipped capability that stopped rendering and reports nothing when it does. That shape is what makes both read as removed rather than broken, and it is the thing to fix in each — a visible failure state, not only the happy path.

One verification note that applies to both, from this workspace's history: `dist/` is not used during development or testing, all testing is done via an installed VSIX, and the live browser server serves the VSIX's `dist`, not local `src` edits. So neither fix can be confirmed by reading `src` or by diffing `dist` — both need the panel exercised in an installed build. Treat a green source read as no evidence at all here, since in the tickets case the source was already fully wired while the panel was visibly broken.
