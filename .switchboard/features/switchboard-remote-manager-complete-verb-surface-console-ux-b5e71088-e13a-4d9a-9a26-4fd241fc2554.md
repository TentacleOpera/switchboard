# Switchboard Remote Manager — Complete Verb Surface & Console UX

**Complexity:** 6

## Goal

Make /switchboard-manage a genuinely complete manager while VS Code runs minimised. Two stacked deliverables: a generic allowlist-gated verb passthrough that exposes all ~600 webview verbs over HTTP in five edits (the engine), and a UX overhaul of the Manage skill that replaces the entry wall-of-text and narrow action list with a concise snapshot and a broad categorized menu, while eliminating the sidebar Guided Setup button by subsuming onboarding and a guided tour into the skill (the interface).

## How the Subtasks Achieve This

- **Feature A · A2b — Generic Verb Passthrough (VS Code running)** (the engine): Exposes all ~600 catalogued webview verbs over HTTP by collapsing each of the 5 providers' `handleServiceVerb` switches into a generic, allowlist-gated passthrough into `_handleMessage` — five small edits, not 600. The allowlist is auto-generated from `protocol-catalog.json`, the shim twins are deleted, read-verb results are delivered over the WS hub, and the parity gate is rewritten to check real reachability instead of counting case-labels. This is what makes "advance a plan to coding," feature ops, design verbs, etc. actually callable from outside the webview while VS Code runs minimised.
- **/switchboard-manage — Skill UX Overhaul** (the interface): Makes the now-reachable surface usable. Kills the entry wall-of-text (concise one-line board snapshot, no recent-features dump), replaces the flat 6-item list with a broad categorized menu (Plan / Code / Design & Artifacts / Features & Board / External PM / Automation / Setup & Tour), and eliminates the sidebar Guided Setup button by subsuming onboarding + a guided tour into the skill itself, leaving the relabeled "Get Started / Manage" launcher as the single front door.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature A · A2b — Generic Verb Passthrough (VS Code running)](../plans/a2b-generic-verb-passthrough-vscode-running.md) — **PLAN REVIEWED**
- [ ] [/switchboard-manage — Skill UX Overhaul](../plans/switchboard-manage-skill-ux-overhaul.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ship **A2b (the passthrough) first** — it makes the verbs reachable. The **Manage UX overhaul** can be authored in parallel but must land with its Design & Artifacts / plan-actioning / settings menu items flagged as "gated until transport-parity lands"; once the passthrough ships, those gating flags come off. The UX plan is written to be honest before the passthrough exists, so it never offers an action the surface can't yet perform. Both are self-contained within this feature — no cross-feature dependency.
