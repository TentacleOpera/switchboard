---
description: 'Claude.ai Artifact Round-Trip Workflow'
---

# Claude.ai Artifact Round-Trip Workflow

**Complexity:** 6

## Goal

Enable a repeatable loop for stakeholder document artifacts hosted on claude.ai: pull an artifact down into a local HTML folder (where the existing previewer renders it), edit it with any agent, and push it back to the same URL. The webview cannot fetch or publish under its CSP sandbox, so the capability is delivered as a prompt bridge — the webview builds and copies (or sends) prompts that Claude Code executes. These two plans are grouped because the second is an explicit second layer on top of the first: one builds the prompt-generation foundation, the other adds a one-click send target.

## How the Subtasks Achieve This

- **Claude.ai Artifact Round-Trip in the planning.html HTML Tab**: Adds the foundational round-trip controls to the HTML tab — a URL input plus "Copy download prompt" and "Copy upload prompt" buttons that generate self-describing prompts (with an embedded source-marker comment for round-trip identity) and copy them to the clipboard. This is the prompt-bridge core; the downloaded file lands in a configured HTML folder and auto-renders in the existing previewer.
- **"Claude Artifacts" Terminal-Only Agent + Send-to-Terminal Buttons**: Adds a spawnable terminal-only "Claude Artifacts" agent (modeled on the no-column `analyst` precedent) and "⇨ Send to Claude" buttons beside the Copy buttons that push the same prompts directly into that terminal and submit them — find-or-spawn, no `/clear`, paced delivery. This removes the manual paste step and gives the round-trip a stable, always-there destination.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Claude.ai Artifact Round-Trip in the planning.html HTML Tab](../plans/feature_plan_20260629121023_artifact-roundtrip-in-html-tab.md) — **CODE REVIEWED**
- [ ] ["Claude Artifacts" Terminal-Only Agent + Send-to-Terminal Buttons](../plans/feature_plan_20260629125310_claude-artifacts-agent-and-send-to-terminal.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->
