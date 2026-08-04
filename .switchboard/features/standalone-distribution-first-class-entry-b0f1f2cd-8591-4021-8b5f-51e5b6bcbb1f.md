# Standalone Distribution & First-Class Entry

**Complexity:** 6

## Goal

Make standalone a real front door rather than a fallback. B4 publishes the standalone CLI to npm under a claimable name (the current name belongs to an unrelated third-party package, so npx fetches the wrong thing); the entry plan then makes the CLI attach to an already-running server instead of exiting 1, and inverts the /switchboard skill protocol so its first action is to bring a server up rather than telling the user to open VS Code. Strict order: publish first, then consume the published name — landing the entry plan first means building install-directory scavenging that publication largely obsoletes.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Feature B · B4 — npx Distribution (publish the standalone CLI to npm)](../plans/b4-npx-distribution-publish.md) — **PLAN REVIEWED**
- [ ] [Make standalone the first-class entry point: `/switchboard` launches or attaches instead of demanding an IDE](../plans/standalone-first-launch-instead-of-demanding-an-ide.md) — **PLAN REVIEWED**
- [ ] [Standalone CLI: attach to a running server, and give a detached server a way to die](../plans/standalone-cli-attach-and-lifecycle.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

