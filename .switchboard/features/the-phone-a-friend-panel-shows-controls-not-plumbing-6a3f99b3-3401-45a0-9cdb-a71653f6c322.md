# The Phone a Friend Panel Shows Controls, Not Plumbing

**Complexity:** 3

## Goal

The TEAMS tab's Phone a friend panel renders roleConfig.addons.phoneAFriendTargets as UI: an origin-to-target map behind an Advanced disclosure, and a one-word 'Target' text box that reads as a reply address. Both are storage keys with a placeholder attached. This feature deletes both surfaces and their resolver branches so the panel is a role select, an enable checkbox, and one line of copy naming which terminal gets called. Stored map keys are preserved on disk in both subtasks; neither deletes operator config.

## How the Subtasks Achieve This

- **Strip the Phone-a-Friend Panel to Controls, Not Plumbing**: Deletes the Advanced per-terminal-override disclosure and its `agentsTabPhoneRow` editor, deletes the unlabelled Target box, replaces both with one line of copy naming the `phone_a_friend` role registration as who gets called, and removes the per-origin and `'*'` resolver branches in `_dispatchPhoneAFriend` so stored keys become inert. Rewrites the now-false `originTerminal` comment in `agentPromptBuilder.ts`. Preserves every stored map key on disk. (Merged from the two original subtasks — per-terminal-override editor deletion + target-box replacement — which touched the same files, same render function, same resolver chain, and same help-text line.)

## Dependencies & sequencing

Single subtask — no internal ordering.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Strip the Phone-a-Friend Panel to Controls, Not Plumbing](../plans/feature_plan_20260818120000_phone-a-friend-panel-strip-to-controls.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

