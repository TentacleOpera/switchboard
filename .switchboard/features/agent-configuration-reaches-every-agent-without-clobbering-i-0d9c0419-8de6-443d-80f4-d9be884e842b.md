# Agent Configuration Reaches Every Agent Without Clobbering Itself

**Complexity:** 5

## Goal

Make the configuration Switchboard pushes to agents both distributable and safe to save. MCP server configs are currently set up by hand once per CLI across several different config formats, so one push should reach them all. First, though, fix the save race that lets one panel's stale startup-command inputs overwrite what the other panel just wrote - adding a second distribution path over a store that loses writes multiplies the bug.

## How the Subtasks Achieve This

- **Cross-panel startup command overwrite** — stops saving startup commands from one panel letting the other panel's stale inputs overwrite what was just written.
- **Add MCP config distribution — push MCP server configs to all agents from terminals.html** — one push reaches every CLI's own config format, instead of the operator configuring each platform separately by hand.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add MCP config distribution — push MCP server configs to all agents from terminals.html](../plans/add-mcp-config-distribution.md) — **PLAN REVIEWED** — ID: 5f01c5dd-5e55-46e1-996e-1a6a67704b97
- [ ] [Cross-panel startup command overwrite](../plans/cross-panel-startup-command-overwrite.md) — **PLAN REVIEWED** — ID: 0c468f55-853b-48ca-a143-96e71177ea6a
<!-- END SUBTASKS -->

## Dependencies & sequencing

Fix the overwrite first. Adding a second distribution path over a configuration store that loses writes multiplies the bug and makes the resulting corruption harder to attribute to either mechanism.

