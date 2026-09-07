# Panels Are Correct on Both Hosts and Both Browsers

**Complexity:** 6

## Goal

Four webview correctness plans that each fail on a host or browser nobody tested: Chrome-only scrollbars, an unsafe-inline CSP, two markdown renderers behind a seam, and an editor that drifts out of level with its preview.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Every panel styles its scrollbars for Chrome only, and the board has no Firefox rules at all](../plans/firefox-scrollbars-every-panel-styles-for-chrome-only.md) — **CREATED** — ID: bb24db76-7ea1-4b92-b0a3-2a8671fb201f
- [ ] [Harden panel CSP — remove `script-src-attr 'unsafe-inline'` from both hosts](../plans/harden-panel-csp-remove-script-src-attr-unsafe-inline.md) — **CREATED** — ID: 0f7e0260-c98c-4c1c-89de-5dfac68d33be
- [ ] [One markdown renderer for both hosts — retire the `markdown.api.render` seam](../plans/one-markdown-renderer-for-both-hosts.md) — **CREATED** — ID: d10540fd-8290-402b-9a6d-21e446368201
- [ ] [The Editor and the Preview Stay Level](../plans/the-editor-and-the-preview-stay-level.md) — **CREATED** — ID: be4aa5b1-95b9-48f6-b0d5-270ab00b0a13
<!-- END SUBTASKS -->
