# Eliminate Redundant Switchboard Connectivity Checks in Dispatched Agent Prompts

## Goal

When Switchboard dispatches an agent (planner, coder, lead, intern, reviewer) into a terminal, the agent already knows Switchboard is running — it received the prompt *from* Switchboard. Yet the skill files these agents read instruct them to discover the API port from a file and run a `curl /health` check before doing anything. This is redundant, wastes tokens, and adds latency to every dispatch. The fix injects a liveness + port directive into the prompt at build time (the port is already available — `KanbanProvider` plumbs it as `apiPort` for all roles) and adds context-conditional skip notes to the skill bootstrap sections so internal agents skip the external-agent discovery dance.

## Metadata

**Complexity:** 3
**Tags:** backend, refactor, performance
**Project:** Browser Switchboard

## User Review Required

This plan changes the injection architecture from per-branch to shared-prefix. The approach supersession is documented below — review the Superseded callout in `## Proposed Changes` before implementation.

## Root Cause Analysis

Two layers combine to produce the redundancy:

### Layer 1 — Prompt builder doesn't inject liveness for planner/reviewer

`agentPromptBuilder.ts` receives `options.apiPort` for **all roles** (plumbed by `KanbanProvider` at line 5352: `apiPort: this._taskViewerProvider?.getLocalApiServerPort() ?? 0`). But only the coder/lead/intern branches consume it — via `phoneAFriendBlock` (line 1634). The **planner** branch (lines 1709–1818) and **reviewer** branch (lines 1820–1914) never reference `apiPort`. So the planner/reviewer prompt contains no port and no liveness signal — the agent must discover both from scratch.

There is already precedent for direct port injection: the dispatch-analysis path (`KanbanProvider` line 5316) writes `API_PORT=${apiPort}` directly into the prompt.

### Layer 2 — Skill files are dual-purpose and don't distinguish internal vs external agents

The skill bootstrap sections are written for **external agents** (Cursor/Zed/Antigravity connecting independently) but get applied to **internal agents** (dispatched by Switchboard) too:

| Skill file | Section | Redundant instruction |
|---|---|---|
| `switchboard-orchestration/SKILL.md` (lines 22–32) | §1 Bootstrap | `curl -s "$BASE/health"` — "Confirm Switchboard is up before anything else" |
| `terminal-coder-dispatch/SKILL.md` (lines 17–26) | §1 Addressing a terminal | `PORT=$(cat .switchboard/api-server-port.txt)` port discovery |
| `external-team-lead/SKILL.md` (lines 20–25) | §2 Port Discovery | `curl -s "$BASE/health"` health check |
| `improve-feature/SKILL.md` (lines 20–28) | Guardrails | "Detect remote by the absence of `.switchboard/api-server-port.txt`" |
| `kanban_operations/SKILL.md` (line 17) | Resolving Plan IDs | `cat .switchboard/api-server-port.txt` for HTTP calls |

### Layer 3 — Reviewer delegation prompt hardcodes the port file reference

The reviewer delegation fix-step (line 1824) says: `"against the port in .switchboard/api-server-port.txt"` — this should use the injected port directly when available, same as the liveness directive.

## Complexity Audit

### Routine
- Adding a `livenessBlock` variable and folding it into an existing array (`dispatchPrefixCore`).
- Adding a skip-note paragraph to five skill files (copy-paste pattern).
- Replacing a hardcoded file-reference string with a conditional port reference in the reviewer delegation fix-step.
- Writing test cases that assert prompt content for given `apiPort` values.

### Complex / Risky
- The custom-agent path (`buildCustomAgentPrompt`) bypasses `buildKanbanBatchPrompt` entirely and builds its own `dispatchContextPrefix` — the liveness directive must be injected separately there, following the existing Phone-a-Friend pattern in `KanbanProvider`'s custom branch.

## Edge-Case & Dependency Audit

- **`apiPort = 0` (server not running):** The liveness directive is omitted entirely — the prompt is byte-identical to today. The skill files' bootstrap sections still apply, so the agent can discover the port from the file if it exists. This preserves the edge case where the extension is running but the API server failed to start.
- **Worktree CWDs:** The port file lives only in the main workspace root's `.switchboard/`. Worktree agents currently can't read it (this is why Phone-a-Friend uses Option A — build-time injection). The liveness directive solves the same problem for planner/reviewer: the port is in the prompt, not in a file the worktree CWD can't see.
- **External agents (Cursor/Zed/Antigravity):** These agents don't receive a prompt from `agentPromptBuilder.ts` — they find the skill files independently. They will never see a `SWITCHBOARD STATUS: Live` line, so the skip-note doesn't trigger, and the bootstrap/health-check sections apply as before. No regression.
- **Custom agents:** The custom-agent path in `KanbanProvider` (line 5275) already plumbs `customApiPort` for Phone-a-Friend. `buildCustomAgentPrompt` (line 2395) builds its own `dispatchContextPrefix` (line 2402) from `dispatchContextBlock` only — it does NOT go through `buildKanbanBatchPrompt` and never sees `dispatchPrefixCore`. The custom branch returns early at line 5287. The liveness directive must be appended separately in `KanbanProvider`'s custom branch, following the same pattern as `customPhoneSuffix` (line 5280).
- **Token budget:** The liveness directive is ~50 tokens. It saves the agent from reading a skill file section (~200–400 tokens of context) and running a `curl /health` (1 tool call + response parsing). Net token savings per dispatch.
- **Existing tests:** No existing tests assert on the presence of `api-server-port.txt` or health-check instructions in prompts. The `minimal-prompt.test.js` and `agentPromptBuilder.test.ts` don't reference these patterns. No test breakage expected.

## Dependencies

- None. This is a self-contained change to the prompt builder and skill files.

## Adversarial Synthesis

Key risks: (1) the plan's original per-branch injection approach missed the `tester` and `analyst` roles — superseded by folding into `dispatchPrefixCore` which reaches all roles automatically; (2) the custom-agent path bypasses `buildKanbanBatchPrompt` entirely and needs separate injection in `KanbanProvider`; (3) the `apiPort = 0` edge case must produce byte-identical prompts to today. Mitigations: shared-prefix injection closes the role-coverage gap by construction; custom-agent injection follows the existing Phone-a-Friend pattern; the `apiPort > 0` guard ensures the directive is omitted when the server is down.

## Proposed Changes

### 1. `src/services/agentPromptBuilder.ts` — Add `SWITCHBOARD_LIVENESS_DIRECTIVE` and fold into `dispatchPrefixCore`

**New function** (near `PHONE_A_FRIEND_DIRECTIVE`, ~line 755):

```typescript
export const SWITCHBOARD_LIVENESS_DIRECTIVE = (port: number) =>
    `SWITCHBOARD STATUS: Live (port ${port}). You were dispatched by Switchboard — the LocalApiServer is running at http://127.0.0.1:${port}. Skip any port-discovery or health-check steps described in skill files; those are for external agents connecting independently. Use http://127.0.0.1:${port} for any API call.`;
```

**Build the block once** (near line 1634, where `phoneAFriendBlock` is built):

```typescript
const livenessBlock = (options?.apiPort && options?.apiPort > 0)
    ? SWITCHBOARD_LIVENESS_DIRECTIVE(options.apiPort)
    : '';
```

> **Superseded:** Inject `livenessBlock` into each role branch's `promptParts` array individually (planner line 1789, reviewer line 1901, lead line 2016, coder feature-mode line 2095, coder non-feature line 2141, intern line 2176).
>
> **Reason:** Per-branch injection requires 5+ modification points, misses the `tester` (line 1916) and `analyst` (line 2193) roles which also use `assembleSuffix` with `dispatchContextPrefix`, and contradicts the established pattern in the same file. Lines 1661–1666 explicitly document the "fold into shared prefix" pattern for directives that must reach every role: `remoteModeBlock` and `prdBlock` are both folded into `dispatchPrefixCore` with the comment "fold into the shared prefix so it reaches every role's suffixBlock without touching each role branch individually." The liveness directive is identical in character — build-time context, no role-specific logic, must reach all roles.
>
> **Replaced with:** Add `livenessBlock` to the `dispatchPrefixCore` array at line 1669. One array element. Reaches all seven built-in roles (planner, reviewer, tester, lead, coder, intern, analyst) automatically via `assembleSuffix` → `dispatchContextPrefix`. Self-maintaining — new roles added later inherit the directive without additional changes.

**Fold into `dispatchPrefixCore`** (line 1669):

```typescript
const dispatchPrefixCore = [dispatchContextBlock, worktreeBlock, livenessBlock, remoteModeBlock, prdBlock, dsReferencesBlock].filter(Boolean).join('\n\n');
```

Place `livenessBlock` before `remoteModeBlock` so the liveness/port info appears early in the dispatch context, before role-specific directives. The `.filter(Boolean)` ensures it is omitted when `apiPort = 0` (empty string filters out), preserving byte-identical prompts for the server-not-running edge case.

**Reviewer delegation fix** (line 1824): Replace `"against the port in .switchboard/api-server-port.txt"` with the actual port when `options.apiPort` is available:

```typescript
const portRef = (options?.apiPort && options?.apiPort > 0)
    ? `http://127.0.0.1:${options.apiPort}`
    : 'the port in .switchboard/api-server-port.txt';
```

Then use `portRef` in the `fixStep` string. When `apiPort` is 0 (server not running — edge case), the fallback to the file reference is preserved.

### 2. `src/services/KanbanProvider.ts` — Inject liveness directive into the custom-agent path

The custom-agent branch (line 5261) calls `buildCustomAgentPrompt` which builds its own `dispatchContextPrefix` and never goes through `buildKanbanBatchPrompt` / `dispatchPrefixCore`. The liveness directive must be appended separately, following the same pattern as `customPhoneSuffix` (line 5280).

**Add after `customPhoneSuffix` is built** (near line 5282):

```typescript
const customLivenessSuffix = (customApiPort > 0)
    ? `\n\n${SWITCHBOARD_LIVENESS_DIRECTIVE(customApiPort)}`
    : '';
```

**Append to both return paths** (lines 5285 and 5287):

```typescript
// Feature path
return `${prefix}${customBuilt}${customPhoneSuffix}${customLivenessSuffix}`;
// Non-feature path
return `${customBuilt}${customPhoneSuffix}${customLivenessSuffix}`;
```

`SWITCHBOARD_LIVENESS_DIRECTIVE` is already exported from `agentPromptBuilder.ts` (same as `PHONE_A_FRIEND_DIRECTIVE` which is already imported in `KanbanProvider`). Add it to the existing import.

### 3. Skill files in `.agents/skills/` — Add context-conditional skip notes

Add a short note at the top of each bootstrap/port-discovery section. The note is the same pattern in each file:

> **If your prompt includes a `SWITCHBOARD STATUS: Live` line, skip this port-discovery/health-check section — you already know the port and that the server is up. Use the port from that line directly. This section is for external agents connecting independently.**

Files to update (`.agents/skills/` only — canonical source):

| File | Location | Change |
|---|---|---|
| `switchboard-orchestration/SKILL.md` | §1 Bootstrap (before line 21) | Add skip-note before the bash block |
| `terminal-coder-dispatch/SKILL.md` | §1 Addressing a terminal (before line 17) | Add skip-note before the port-discovery paragraph |
| `external-team-lead/SKILL.md` | §2 Port Discovery (before line 20) | Add skip-note before the bash block |
| `improve-feature/SKILL.md` | Guardrails, "Route set changes" (line 24 area) | Add skip-note: if `SWITCHBOARD STATUS: Live` is present, you are local — use the injected port for `kanban_operations` calls; skip the `.switchboard/api-server-port.txt` file-existence detection |
| `kanban_operations/SKILL.md` | Near line 17 (HTTP reference) | Add skip-note: if `SWITCHBOARD STATUS: Live` is present, use the injected port instead of `cat .switchboard/api-server-port.txt` |

### 4. Tests — `src/services/__tests__/agentPromptBuilder.test.ts`

Add test cases:

- **Liveness directive present when `apiPort > 0`**: For each of the seven built-in roles (planner, reviewer, tester, lead, coder, intern, analyst), assert the prompt contains `SWITCHBOARD STATUS: Live (port <port>)` when `apiPort` is set to a positive number. The `dispatchPrefixCore` folding means all roles get the directive automatically — test all of them, not just the five the original plan listed.
- **Liveness directive absent when `apiPort = 0`**: For each role, assert the prompt does NOT contain `SWITCHBOARD STATUS` when `apiPort` is 0 or undefined (preserves byte-identical backward compatibility for the server-not-running edge case).
- **Reviewer delegation uses injected port**: When `apiPort > 0` and `reviewerDelegationMode` is active, assert the `fixStep` contains `http://127.0.0.1:<port>` and does NOT contain `api-server-port.txt`.
- **Reviewer delegation falls back to file reference when `apiPort = 0`**: Assert `api-server-port.txt` appears in the delegation fix-step when `apiPort` is 0.
- **Custom-agent prompt includes liveness directive**: When `customApiPort > 0`, assert the custom-agent prompt (built via `KanbanProvider.generateUnifiedPrompt` with a custom role) contains `SWITCHBOARD STATUS: Live`. When `customApiPort = 0`, assert it does not.

## Verification Plan

### Automated Tests
- Run `npm test` — the new test cases in `agentPromptBuilder.test.ts` should pass, and no existing tests should break.
- Specifically verify: `src/test/minimal-prompt.test.js` (which checks prompt structure) still passes — the liveness directive is additive and only present when `apiPort > 0`.

### Manual Verification
- Dispatch a planner from the Kanban board (PLAN REVIEWED column with autoban). Verify the prompt in the terminal starts with `SWITCHBOARD STATUS: Live (port <port>)` and the agent does NOT run `curl /health` or `cat .switchboard/api-server-port.txt`.
- Dispatch a coder with Phone-a-Friend enabled. Verify both the liveness directive and the Phone-a-Friend directive appear, and the agent uses the injected port for both.
- Dispatch a reviewer in delegation mode. Verify the fix-step references `http://127.0.0.1:<port>` directly, not the port file.
- Dispatch a tester and an analyst. Verify both prompts contain `SWITCHBOARD STATUS: Live` — these roles were missed by the original per-branch approach and are covered by the `dispatchPrefixCore` folding.
- Test the `apiPort = 0` edge case (stop the API server, dispatch an agent) — verify the liveness directive is absent and the agent falls back to file-based port discovery.
- Dispatch a custom agent (custom role column) with the API server running — verify the prompt contains `SWITCHBOARD STATUS: Live`.

Send to Intern
