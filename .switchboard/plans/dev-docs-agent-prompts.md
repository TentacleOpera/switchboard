# Dev Docs — Agent-Assist Prompts

**Plan ID:** 8b1e4d90-6c2a-47f3-a5e1-2d9f0c7b3a11

## Goal

Define the "Draft/Improve with agent" prompts for the Dev Docs tab (fix 4 of the Dev Docs in-place fixes) and how they are wired in. This is the authoring hand-off: a per-doc button copies a ready-to-paste prompt to the clipboard so an agent can write or improve the doc and write it back to disk.

### Problem & background

The Dev Docs tab has no way to ask an agent for help writing a doc. Switchboard already has ~15 "copy prompt → paste into agent" hand-offs (e.g. refine-ticket at `PlanningPanelProvider.ts:6197`, tuning at `:7098`), all following the same shape: *"You are …"* → `##` context sections → write-to-path instruction → *"report back"*. These prompts adopt that house style so the behaviour is consistent with the rest of the extension.

## The prompts

Two variants, chosen by whether the selected doc already has content.

### Draft — new / empty doc

```
You are writing a developer document for the project at <workspaceRoot>.

## Document
- **Title:** <title>
- **Type:** <Docs | README | Wiki>
- **File path (write the finished doc here):** <docPath>

The file is currently empty (or contains only a title heading). Research the
codebase as needed to write an accurate, useful developer doc for this topic.
Write the finished markdown directly to the file path above. Report back with a
short summary of what you covered.
```

### Improve — existing doc

```
You are improving an existing developer document for the project at <workspaceRoot>.

## Document
- **Title:** <title>
- **Type:** <Docs | README | Wiki>
- **File path (write the improved doc back here):** <docPath>

## Current content
<current markdown>

Read the current content above and the relevant parts of the codebase. Fill
gaps, correct anything out of date, and improve clarity and structure without
discarding accurate existing material. Write the improved markdown back to the
file path, preserving any YAML frontmatter. Report back with a summary of what
you changed.
```

## Wiring

- Add a per-doc strip button (e.g. "Draft with agent" / "Improve with agent", label toggled by whether the doc has content) to the Dev Docs controls strip (`planning.html:3825`).
- On click, the webview posts a message with the selected doc's path; the backend builds the appropriate prompt and calls `vscode.env.clipboard.writeText(prompt)` + `showTemporaryNotification(...)`, mirroring the refine flow (`PlanningPanelProvider.ts:6211-6212`).
- The `<Type>` token is the source type from the fix-3 dropdown (README / Docs / Wiki).
- All source types are writable (git-backed sources write via their clone + commit/push), so the button applies to every type — no read-only exclusion.

## Edge cases

- **Large docs:** the Improve prompt inlines current content; apply the same 200 KB guard already used by clipboard import (`PlanningPanelProvider.ts:8648`) so the clipboard payload stays sane.
- **No doc selected:** the button is disabled until a doc is selected (same gating as Edit/Delete).
- **YAML frontmatter:** the Improve prompt explicitly tells the agent to preserve frontmatter, matching the refine-ticket instruction.

## Metadata

**Complexity:** 2
**Tags:** frontend, ux, agent-assist
**Repo:** switchboard
