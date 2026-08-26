# Per-Terminal Controls in the Terminals Panel

**Complexity:** 5

## Goal

Let the operator act on a terminal from where the terminals are, instead of detouring through the board. A chat button on the pane header pastes the composed chat prompt in place, a notification toggle installs a completion-reminder standing order scoped to that terminal, and Link-up tells both ends about the relationship instead of leaving the child unaware it has a parent.

## How the Subtasks Achieve This

- **Chat button on terminal pane header pastes the chat prompt in place** — unwires the composed chat prompt from its board-only button so the operator does not have to leave the terminals view to use it.
- **Terminal notification toggle — per-terminal completion-reminder standing order** — installs a pair-scoped standing order on that terminal from its card in the sidebar.
- **Bidirectional Link-Up — both terminals get instructions** — makes the child learn about the relationship instead of only the parent, so the link is real from both ends.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Chat button on terminal pane header pastes the chat prompt in place](../plans/feature_plan_20260819111109_chat-button-on-terminal-pane-header.md) — **PLAN REVIEWED** — ID: 920a3f7b-02ee-480b-8466-2723c66646af
- [ ] [Bidirectional Link-Up — Both Terminals Get Instructions](../plans/feature_plan_20260819143000_bidirectional-link-up-both-terminals-get-instructions.md) — **PLAN REVIEWED** — ID: 697c1180-3516-4574-a68d-78b2023d5328
- [ ] [Terminal Notification Toggle — Per-Terminal Completion-Reminder Standing Order](../plans/feature_plan_20260820080022_terminal-notification-toggle-button.md) — **PLAN REVIEWED** — ID: 38271e23-9ad1-46a9-860b-8e5b9895b790
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering; three independent controls on the same panel. All three touch the terminal card template and its listeners, so landing them in one sweep avoids three passes over the same code.

