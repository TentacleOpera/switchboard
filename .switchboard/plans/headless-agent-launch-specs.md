# Headless Agent Launch Specs: Per-Role Provider & Cost Configuration

## Goal

Add a per-role **headless launch spec** — command, argv, prompt-delivery mode, non-interactive flags, and environment — so a user can route bulk agent work to a specific CLI under a specific subscription, and can see which provider each batch will bill.

### The problem

Switchboard's existing per-role launch configuration is `GlobalIntegrationConfigService.getAgentStartupCommands()`: a `Record<role, string>` of shell text that `PtyFleetService.injectStartupCommand` (`src/standalone/ptyFleetService.ts:121`) **types into an interactive shell** via `sendText` after a 750ms readiness delay.

That representation cannot drive a headless launch:

- It is shell text, not argv. Values may be aliases, shell functions, or multi-command lines that will not survive `exec`.
- It carries no prompt-delivery contract. Interactive flow types the startup command, then types the prompt as a second `sendText`. A headless process needs the prompt delivered deterministically at launch — stdin, argv, or a file.
- It carries no non-interactive contract. Every agent CLI has its own flag for "don't stop to ask me" (`claude -p`, and per-tool equivalents for approval and sandbox modes). Omit it and the process hangs; with no TTY and nobody watching, it hangs silently.
- It carries no environment scoping, which is exactly where per-provider auth lives (a different API key, config dir, or profile is what makes the agent bill a different subscription).

The codebase already knows this distinction: `KanbanProvider.SCHEDULER_TARGET_CONTRACTS['local-terminal']` documents its target as *"interactive, subscription-authed... **Never headless — prompts go via sendText, never `claude -p`**."* The headless mode is understood; it is simply not configurable per role.

### Root cause

Roles were designed for one launch mode. Adding a second mode is a schema and configuration problem, and it must not disturb the first — interactive terminals are the product's primary surface and thousands of installs depend on `startupCommands` behaving exactly as it does today.

### Why this is a first-class deliverable

Cost control is the point of the whole feature. Being able to say "improvers run on provider X, which my other subscription covers; nothing in this batch bills Claude credits" — and to *verify* it before spending — is the user-visible value. Burying it as an undocumented field inside the spawn engine would deliver the mechanism without the control.

## Metadata

**Complexity:** 5
**Tags:** backend, ui, cli, infrastructure, feature

## Reconcile Before Building

Unpushed local work may already have extended the agent config schema. Before coding, inspect the current `agentConfig` keys via `GlobalIntegrationConfigService.getAgentConfig` call sites and the Setup panel's agent section. Extend the existing schema; do not introduce a parallel config store.

## Design

### Schema — a new, additive config key

Store under a **new** agent-config key (e.g. `headlessLaunch`), read via the existing `GlobalIntegrationConfigService.getAgentConfig<T>()` accessor pattern alongside `startupCommands`. Do not overload or reinterpret `startupCommands`.

```
Record<role, {
  command: string
  args: string[]                                  // may contain the {prompt} / {promptFile} placeholder
  promptDelivery: 'stdin' | 'arg' | 'file'        // default 'stdin'
  env?: Record<string, string>                    // per-provider auth/profile scoping
  requiresTty?: boolean                           // default false
  timeoutSeconds?: number                         // per-role hard cap override
  label?: string                                  // human name shown in digests, e.g. "Gemini CLI (personal sub)"
}>
```

`label` is not cosmetic — it is what makes "which provider did this batch bill?" answerable in the digest without the user reverse-engineering it from a command string.

### Migration and compatibility

Per the project's migration rule, `startupCommands` **shipped** and must keep working untouched: absent a `headlessLaunch` entry, interactive launches behave exactly as today. Preserve unknown keys on write rather than dropping them.

`headlessLaunch` has only ever existed in unreleased work, so it needs no migration of its own — but it must be **additive**: a config file written by a newer version must not break an older install's interactive launch, which means never moving or rewriting `startupCommands` values as part of this change.

When a role has no `headlessLaunch` entry, offer to **seed** one from its `startupCommands` value as a pre-filled suggestion in the UI. Seed it as a suggestion the user confirms — never silently derive and use it at launch time, because shell text that works when typed can fail or, worse, half-work when exec'd.

### Validation — fail loudly at configuration time

The spawn engine rejects unresolvable roles before spawning; this plan makes that rejection rare by validating at config time:

- `command` resolves on `PATH` (or is an existing absolute path).
- `promptDelivery: 'arg'` requires a `{prompt}` placeholder in `args`; `'file'` requires `{promptFile}`; `'stdin'` must have neither.
- Warn when `args` contains no recognizable non-interactive flag — the single most common cause of a silently-hanging headless agent.
- A "Test launch" action that runs the spec against a trivial throwaway prompt and reports exit code, duration, and captured output. **This is the highest-value item in the plan.** Discovering a bad spec on one test run costs seconds; discovering it via a 20-agent batch that produces nothing costs the whole batch.

### Resolver

Export a single `resolveHeadlessLaunchSpec(role)` used by the spawn engine, returning either a fully-resolved spec or a structured reason for rejection. One resolver, one place where defaults and placeholder substitution happen — the engine must not parse config itself.

Placeholder substitution belongs here too, including writing the temp prompt file for `file` mode and cleaning it up.

### Configuration UI

Extend the Setup panel's agent configuration section with a headless spec editor per role, the seed-from-startup-command action, inline validation, and the Test launch button. Show the resolved `label` next to the role so the billing target is visible where the role is chosen.

Per the project's standing rule, none of these actions may gate on `confirm()` — `window.confirm()` is a silent no-op in VS Code webviews and would make the control do nothing.

### Secrets

`env` will hold credentials for other providers. Do not write secret values into `.switchboard/` state files, batch state, logs, or digests. Prefer referencing environment variables or a config-dir path over inlining a key; redact `env` values in any surfaced payload, including the Test launch output. The batch status payload must expose the role and its `label`, never its `env`.

## Verification Plan

1. **Unit — resolver defaults.** A spec omitting `promptDelivery`, `requiresTty`, and `timeoutSeconds` resolves to `stdin`, `false`, and the global default.
2. **Unit — placeholder validation.** `arg` without `{prompt}` is rejected; `file` without `{promptFile}` is rejected; `stdin` with a stray placeholder is rejected. Each returns a structured reason, not a throw.
3. **Unit — command resolution.** A `command` not on `PATH` fails validation with a clear message.
4. **Unit — file mode lifecycle.** `file` delivery writes a temp file, substitutes its path, and deletes it after the run — including when the run fails.
5. **Unit — interactive path untouched.** With `headlessLaunch` populated for a role, assert `injectStartupCommand` still reads `startupCommands` and its behavior and 750ms readiness delay are unchanged. Existing terminal-launch tests must pass unmodified.
6. **Unit — additive config write.** Writing `headlessLaunch` preserves `startupCommands` and all unknown keys byte-for-byte.
7. **Unit — seeding is opt-in.** Assert no code path uses a `startupCommands` value as a launch spec without an explicit stored `headlessLaunch` entry.
8. **Unit — secret redaction.** Assert `env` values never appear in batch state files, per-agent logs, the status payload, or Test launch output.
9. **Unit — no confirm gate.** Static assertion that the new Setup controls introduce no `confirm(` / `window.confirm(` call.
10. **Manual.** Configure a non-Claude role end to end, run Test launch, confirm it reports a real exit code and output, then deliberately remove the non-interactive flag and confirm the validator warns.

## Dependencies

None. This plan ships standalone — the config surface and Test launch are useful and verifiable before any batch engine consumes them, and landing it first de-risks the spawn primitive.
