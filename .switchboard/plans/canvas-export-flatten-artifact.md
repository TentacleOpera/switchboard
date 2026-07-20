# Canvas — Export / Flatten to a shareable single HTML (Claude Artifacts)

## Goal

Let a Canvas be **exported as one self-contained HTML file** that can be uploaded to claude.ai Artifacts for team sharing — since the live canvas (N localhost iframes) can't be shared as-is. Ship two flatten modes: a deterministic one-click default, and an agent-driven escape hatch.

### Context

The live canvas is localhost iframes (needed for editing/isolation); claude.ai Artifacts require one self-contained file, strict CSP, no localhost/relative assets. So sharing is a distinct Export step that feeds the existing **Upload to Claude Artifacts** path (single-file, already used by HTML Previews). Empirically confirmed (2026-07-20, published probe artifact): claude.ai artifacts enforce `frame-src 'self' blob: data:` — `data:` and `srcdoc` iframes render; external frames are blocked; inlined `data:` assets load.

## Metadata

**Tags:** frontend, feature
**Complexity:** 6

## Proposed Changes
- **Deterministic flatten (default) — `data:` URI iframes.** New `canvas/flatten` handler composes one outer HTML: a positioned container per frame (absolute `x/y/w/h` from the layout JSON) holding `<iframe src="data:text/html;base64,…">`, the screen's full document base64-embedded. Preserves each screen's own `<head>`/`<style>` with true isolation — no CSS merge. Feed the result to the existing **Upload to Claude Artifacts** path; also offer **Save flattened HTML** to disk.
  - **Asset inlining is the crux** — before base64-embedding a screen, walk its `<img src>`/CSS `url(...)` refs, read the referenced files, inline them as `data:` URIs so the embedded doc has zero external/relative refs (the artifact CSP blocks all external requests, even inside a `data:` frame). Skip/placeholder unresolvable assets (log it; no silent drops).
  - **Sandbox note** — the nested `data:` iframe is sandboxed (parent is `sandbox="allow-scripts"`); static screens render fine, heavily-scripted screens may be limited → use the agent-flatten path.
  - **Fallback** — Shadow-DOM mounting (inline each screen's HTML+CSS into a shadow root) only if `data:` iframes ever misbehave.
- **Flatten agent prompt (escape hatch).** A **Copy Prompt** / **Send to Agent** that hands the frame source paths + layout to an agent to merge into one cohesive self-contained HTML (unify tokens, clean markup, embed assets) — matching the hand-authored board style. Reuses the existing agent-dispatch + Copy-Prompt plumbing; output drops into the same Save/Upload actions.

## Complex / Risky
- **Flatten asset-inlining fidelity** — the highest-risk correctness area. Every local `<img>`/`url()` must resolve and inline; missing/oversized assets logged + placeholdered, never silently dropped. (Isolation mechanism itself is settled: `data:` iframes, CSP-confirmed empirically.)

## Dependencies
Depends on **canvas-foundation-tab-panzoom-frames** (frames + layout JSON). Independent of Stitch-add and Inspect Mode.

## Verification Plan
1. Deterministic flatten of a multi-frame canvas → one self-contained HTML that renders correctly standalone AND uploaded to claude.ai Artifacts (screens isolated, assets inlined, layout preserved, zero external refs).
2. Flatten a canvas with a missing image → logged + placeholdered, not a silent drop or crash.
3. Agent-flatten prompt → its output also uploads and renders.
4. The claude.ai Artifacts CSP is **already confirmed** (see Resolved Assumptions) — no re-research or re-test required. The live probe is still at https://claude.ai/code/artifact/6e376b9c-abe9-4813-9bed-ed79ec8886e7 if you want to eyeball it; otherwise proceed on `data:` iframes.

## Definition of Done
- Export/Flatten produces a single self-contained HTML (no localhost/relative/external refs) that uploads to claude.ai Artifacts via the existing path — deterministic (`data:` iframes + inlined assets) by default, with an agent-flatten alternative. Unresolvable assets degrade gracefully and are logged.

## Resolved Assumptions (do NOT re-research — this is settled)
- **claude.ai Artifacts CSP for `data:` iframes — CONFIRMED (2026-07-20), not open.** Established two ways this session: (1) **web research** — the artifact sandbox enforces `frame-src 'self' blob: data:` (Anthropic MCP-Apps issue #40 + the Artifacts architecture write-ups); (2) **a live published probe** — https://claude.ai/code/artifact/6e376b9c-abe9-4813-9bed-ed79ec8886e7 — **visually verified by the owner**: `data:` and `srcdoc` iframes render, inlined `data:` assets load, external (`https://`) frames are blocked. So the deterministic `data:`-iframe flatten is a green light — build on it directly.
- An earlier automated `advise-research` pass re-flagged this as "uncertain" and generated a web-research prompt; **that prompt is redundant — ignore it.** The only thing that would reopen this is a *future* change to the Artifacts CSP; the named **Shadow-DOM fallback** is the escape hatch if that ever happens. (Recorded in memory: `reference_claude_artifact_iframe_csp`.)

## Review Findings

Reviewed commit `ad17f99` against this plan. The deterministic flatten (`_flattenCanvas`, `DesignPanelProvider.ts:1836`) composes positioned `data:text/html;base64` iframes with `_inlineLocalAssets` walking `<img src>`, single/double-quote variants, CSS `url()`, `<link href>`, and `<script src>` — unresolvable refs are left in place (not silently dropped), missing frames emit an HTML comment. The flattened surface preserves the user's live pan/zoom transform (`translate(pan) scale(zoom)`), matching the plan's "turns the **live** multi-iframe canvas" wording. **MAJOR (fixed):** the agent-flatten escape hatch had provider handlers (`canvas/copyFlattenPrompt`, `canvas/sendFlattenPrompt`) but NO UI entry point — unreachable; added a `✦` toolbar button (`design.html`) wired to `canvas/copyFlattenPrompt` (`design.js`) so the Copy-Prompt escape hatch is now reachable. **MAJOR (fixed):** the plan requires "Feed the result to the existing Upload-to-Claude-Artifacts path" but the implementation only saved the flattened HTML to disk — the upload path was unreachable from the Canvas tab; added `⇗` (Send to Agent) and `ⓒ` (Copy Prompt) toolbar buttons that build `CLAUDE_ARTIFACT_UPLOAD_PROMPT` from the flattened file's path and send via the existing `sendClaudeArtifactPrompt` / `copyClaudeArtifactPrompt` messages (same path the HTML Previews tab uses). The buttons are hidden until a flatten completes. Files changed: `src/webview/design.js`, `src/webview/design.html`. Validation: `node --check src/webview/design.js` passes. **Remaining risks:** `_inlineLocalAssets` does not handle `<source srcset>`/`<picture>`, CSS `@import`, or unquoted `<img src=x>` (edge cases — common quoted forms are covered); the upload buttons act on the *last* flattened path — if the user switches canvases after flattening, the buttons still reference the old file (acceptable: re-flatten to refresh).
