---
description: "Layer-1 completion for DesignPanelProvider ONLY (split from the former 3-provider plan). Finish the ~18 read arms that still break so Design reaches full return-in-body parity, and extend the headless Design test to cover them. Design already has DESIGN_VERB_SCHEMAS. Sibling: a2b-verb-engine-layer1-completion-return-schemas-tests.md (Setup), a2b-verb-engine-layer1-taskviewer.md."
---

# Verb Engine — Layer-1: DesignPanelProvider — Finish Return-in-Body + Tests

> **Split note:** the Design slice of the former 3-provider Layer-1 plan, broken out per-provider. This is the **smallest** of the three (Design is mostly done). Setup → `a2b-verb-engine-layer1-completion-return-schemas-tests.md`; TaskViewer → `a2b-verb-engine-layer1-taskviewer.md`.

## Metadata
- **Project:** browser-switchboard
- **Tags:** backend, refactor, api
- **Complexity:** 3
- **Release phase:** B1 headless prerequisite (Layer 1, Design provider). Parallel with the Setup/TaskViewer/Planning Layer-1 cards (different files). Gated by the return-contract ratchet.

## Goal

Bring `DesignPanelProvider` to genuine return-in-body parity: convert the remaining ~18 read arms that still `break` to `return` their data, and extend the headless Design suite to cover them. Design already carries per-verb schemas, so this card is the return-contract finish + test coverage only.

### Problem / root-cause analysis
Design is the furthest-along provider — its arm-level seam migration is done, dispatch is allowlist+schema-gated ([DesignPanelProvider.ts:65](../../src/services/DesignPanelProvider.ts#L65)), and `DESIGN_VERB_SCHEMAS` exists ([verbSchemas.ts:459](../../src/services/verbSchemas.ts#L459)). But `scripts/analyze-verb-migration2.js` measures `return=50 / break=65` across 68 arms — **~18 read arms still `break`**, so those verbs return `{success:true}` with no data to an HTTP caller. The existing headless suite (`verb-engine-headless-seams.test.js`) covers only ~13–18 arms and predates the migration, so the newly-returned arms are untested.

## User Review Required
- None.

## Scope
### ✅ IN SCOPE
- Convert the remaining ~18 Design read/query arms (`list*Folders`, `fetchPreview`, `renderMarkdownLive`, `stitchListProjects`/`stitchGetProjectScreens`/`stitchListDesignSystems`, and any arm computing a result) from trailing `break;` to `return { success: true, …<same pushed fields> };` (Kanban idiom; failure = `return { success:false, error }`).
- Extend `DESIGN_VERB_SCHEMAS` only where a converted arm has an untrusted write not yet covered (e.g. `stitchSaveApiKey`/`stitchSaveAuthConfig`, `saveFileContent`) — keep permissive/field-accurate.
- Extend the headless Design suite to drive the newly-returned arms and assert (a) in-body data, (b) push still emitted, (c) no `vscode`.

### ⚙️ OUT OF SCOPE
- Standalone bootstrap construction/wiring → B1 bootstrap plan.
- Setup / TaskViewer / Planning → their own Layer-1 cards.
- The terminal-bound `send*` tweak verbs' clipboard degrade — already shipped; unchanged.
- New verbs / behaviour changes.

## Implementation Steps
1. **One agent stream, `DesignPanelProvider.ts` only** (`verbSchemas.ts` shared — append to the Design block, serialise if others in flight).
2. `analyze-verb-migration2.js` to list the ~18 breaking arms; convert each.
3. Extend the Design headless suite over the converted arms.
4. **Lower the `design` ratchet ceiling to 0** in the same change; update `## Review Findings` in `a2b-verb-engine-02-design-panel.md`.

## Complexity Audit
### Routine
- Small, mostly-mechanical finish on an already-migrated provider.
### Complex / Risky
- **Side-effect ordering** on multi-push arms (Stitch list/generate return the model's commentary + follow-ups) — assemble the aggregate result, don't echo the first push.

## Dependencies
- A2b ·1 Foundations — present. Return-contract ratchet — land first/with.

## Verification Plan (Definition of Done — objective)
- `analyze-verb-migration2.js`: Design read arms fully `return`; **`design` ratchet ceiling lowered to 0**, `verb-returns:check` green.
- Design headless suite covers the newly-returned arms and **asserts payload fields, not just `success`**.
- `parity:check` / `push-routing:check` / `compile-tests` green.
- Manual: `POST /design/verb/<readVerb>` returns data in-body matching the push.
