# WITHDRAWN — unattended remote agents are an accepted category, not a problem this product introduces

**Status: withdrawn. Do not implement. Kept only so the two rejected approaches are not re-proposed.**

## Why this existed

`switchboard-as-a-local-app-and-a-self-hosted-remote.md` adds a host that dispatches agents while nobody is watching. The observation was that Switchboard's only force-push guard is prompt text — `agentPromptBuilder.ts:643` (`'…Do not force-push.'`) and the `GIT POLICY` lines at `TaskViewerProvider.ts:6271-6274` — so on an unattended host the operator is no longer the backstop.

## Why it is withdrawn

**Unattended agents with push credentials are a well-understood, widely-accepted category.** Cursor background agents, Devin, hosted Codex runners, Claude Code sessions on the web, and agents in CI all operate this way. Switchboard adding a remote host does not introduce the risk class; it joins it. An operator deliberately provisioning a dedicated agent host already understands what a push credential grants, and generic branch-protection advice from a kanban extension is noise they will correctly ignore.

The one candidate for genuine product-specific disclosure — that the `GIT POLICY` line is advisory rather than enforced — does not survive inspection either. Read plainly, it is an instruction to an agent and reads as exactly that. It never claimed enforcement.

## The two rejected approaches, recorded so they are not revived

1. **A managed `pre-push` hook installed via `core.hooksPath`.** Rejected as too invasive: that is a machine-wide git config change which silently overrides every repository's own hooks (husky, lefthook, pre-commit). An extension with ~4,000 installs must not write it, however carefully it chains. It was also *bypassable with `--no-verify`*, making it a weaker substitute for the forge-side control it was standing in for.
2. **Generated per-repository deploy keys and a host secret scan.** Rejected as invasive for a different reason: the first puts Switchboard inside the operator's credential management, the second is filesystem snooping whose false positives get ignored on first read.

A third, smaller version — one paragraph at the end of remote setup pointing at branch protection — was then also withdrawn as unwarranted, per the reasoning above.

## What remains true and needs no work

- Branch protection on the forge is the only control that actually prevents an agent rewriting a shared branch. It is the operator's to enable, it is outside Switchboard's footprint, and it does not need Switchboard's prompting.
- `MultiRepoScaffoldingService.ts:149` already refuses repository URLs with embedded credentials. That is the right boundary model: constrain what the product itself does, and do not reconfigure the operator's machine or manage their credentials.
- The `GIT POLICY` prompt lines stay exactly as they are. They cost nothing and an advisory line is worth having.

## Metadata

**Complexity:** 0
**Tags:** docs, security
