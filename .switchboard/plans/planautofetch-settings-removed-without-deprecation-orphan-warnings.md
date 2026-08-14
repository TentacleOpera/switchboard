# Five Shipped `planAutoFetch` Settings Were Removed Outright, Leaving ~4,000 Installs With "Unknown Configuration Setting" Warnings and No Migration Path

## Metadata

**Complexity:** 2
**Tags:** settings, migration, deprecation, shipped-state, scheduler
**Project:** Browser Switchboard
**Feature:** 30e0c0a7-a621-4393-bd94-b222900e158c

## Goal

Restore the five retired `switchboard.planAutoFetch.*` settings to `contributes.configuration` as **deprecated** declarations carrying a migration message that points at the `fetch-plans` Scheduler source, so installs holding those keys stop showing bare "Unknown Configuration Setting" warnings and are told where the capability went. Removing them outright skipped the repo's own established deprecation pattern.

### Problem analysis and root cause

Commit `4d335c3c` retired plan auto-fetch — correctly; `PlanAutoFetchService` only fast-forwarded the default branch and hard-skipped on feature branches, so it could not serve the cloud-VM workflow it existed for. As part of that commit it deleted **all five** `switchboard.planAutoFetch.*` declarations from `package.json`'s `contributes.configuration` block. Verified at HEAD: `planAutoFetch` appears nowhere in `package.json` or `src/`.

The settings themselves shipped in released versions. The extension has ~4,000 installs, many on much older versions. Every install where a user set any of `planAutoFetch.enabled`, `.intervalSeconds`, `.remote`, `.defaultBranch` or `.trustedAuthors` still carries that key in its user or workspace `settings.json`.

**What that produces, confirmed by research into VS Code's behaviour rather than assumed:**

- VS Code validates `settings.json` against the currently registered configuration schemas. An entry under a namespace with no registered declaration is flagged with a squiggle and the hover text **"Unknown Configuration Setting"**, and the warning is surfaced in the **Problems view** against `settings.json`.
- The GUI settings editor ignores the orphan key entirely — it does not appear in search and shows no banner. So the user gets a warning in one surface and silence in the other, with no indication of what replaced the setting.
- VS Code **never** prunes user or workspace settings on extension update or uninstall. The key persists indefinitely until removed by hand.

So the retirement left every affected install with a warning that says only "unknown", on a setting that was valid in the version they upgraded from, with no pointer to the `fetch-plans` Scheduler source that replaced it.

**The repo already has the right pattern and this change bypassed it.** `package.json` carries three existing `deprecationMessage` declarations — two at `:363` and `:369` redirecting to `switchboard.team.strictPrompts`, and one at `:758` for `switchboard.theme.cyberPanel` explaining that the Cyber Panel theme is always on and naming the replacement setting. That is exactly the treatment `planAutoFetch` should have received. This is not a proposal to adopt a new convention; it is a departure from an existing one.

A deprecated declaration behaves differently from an absent one in both directions that matter: the JSON editor renders the key struck through with the migration message in the hover and the Problems view, and the GUI settings editor **does** render a configured deprecated setting with a warning box carrying the guidance — the surface an orphan key is invisible in.

**Root-cause framing.** This is the same defect shape as the rest of the parent feature, one layer out: a retirement that removed the implementation and the declaration, verified as complete because nothing in the tree referenced `planAutoFetch` any more. The tree was clean. The ~4,000 `settings.json` files that shipped with those keys are the state the check could not see, and `CLAUDE.md`'s migration rule names this case exactly — state that shipped in a released version must be migrated on change, and a prior migration must never be assumed to have run for the install base.

## User Review Required

None. Decisions taken:

- **Re-declare rather than leave removed.** The five keys come back as deprecated declarations with `markdownDeprecationMessage`, not as live settings — nothing reads them, and nothing should start.
- **Message points at the Scheduler source, not at a replacement setting.** There is no key-for-key successor; the capability moved to a Scheduler source configured in the AUTOMATION tab. The message says that in one line.
- **Hard removal is deferred to a future major version bump**, per the pattern the three existing deprecations follow. Not this change.
- **No code fallback.** The usual deprecation pattern reads the new key and falls back to the old one. That does not apply here: there is no new key, and `PlanAutoFetchService` is deleted. The declarations exist solely to carry the message.

## Complexity Audit

### Routine

- Adding five properties to `contributes.configuration` with a deprecation message each.

### Complex / Risky

- **Do not make them functional.** A re-added declaration with a `default` is still an inert schema entry as long as nothing reads it — and nothing does, since the service is deleted. Any change that wires a reader resurrects a feature that was retired for a good reason.
- **`trustedAuthors` needs an honest message.** It was a security control — only plans committed by listed author emails were pulled. The `fetch-plans` Scheduler source has **no author filtering**. Its deprecation message must not imply the filter moved; a user relying on it needs to know it is gone, not relocated.
- **Message accuracy across five keys.** `intervalSeconds`, `remote` and `defaultBranch` have rough analogues in the Scheduler source's schedule and its `remote` / `branchGlob` config; `enabled` and `trustedAuthors` do not. Writing one generic message for all five understates the difference on the two that matter.
- **Verify the diagnostic actually clears.** The point of the change is the warning turning into guidance. Confirm against an install carrying the keys, not by reasoning about the schema.

## Edge-Case & Dependency Audit

**Race Conditions** — none.

**Security** — the `trustedAuthors` message must state the author filter no longer exists rather than implying continuity. Understating a removed security control is worse than the orphan warning this plan fixes.

**Side Effects** — the five keys reappear in settings search and IntelliSense as deprecated entries. That is the intended behaviour and is how the three existing deprecations present.

**Dependencies & Conflicts**

- Pairs with `docs-still-document-retired-plan-autofetch.md`, which corrects the four site pages describing the retired feature. The two are the halves of one incomplete retirement: that plan tells a *reader* where the capability went, this one tells a *user whose settings.json still holds the keys*. They touch different repositories and can land independently, but shipping only the docs half leaves the in-editor warning bare.
- No overlap with any other subtask. `package.json`'s `contributes.configuration` block is touched by no other plan in this feature.

## Dependencies

None. Can land at any point.

## Implementation

1. Re-add the five `switchboard.planAutoFetch.*` properties to `contributes.configuration` in `package.json`, matching the shape of the three existing deprecated settings at `:363`, `:369` and `:758`.
2. Give each a `markdownDeprecationMessage` naming the `fetch-plans` Scheduler source and where it is configured (the AUTOMATION tab). Keep the type and default from the original declarations so the schema still describes the value a user's `settings.json` holds.
3. Write `trustedAuthors`' message to state plainly that the replacement applies no author filter — do not phrase it as a relocation.
4. Confirm no code path reads any of the five keys. They are schema-only.
5. Confirm the deprecation is consistent with the site copy landed by `docs-still-document-retired-plan-autofetch.md`, so the in-editor message and the docs describe the same replacement.

## Proposed Changes

### `package.json`
- **Context:** `contributes.configuration` declared five `switchboard.planAutoFetch.*` settings until `4d335c3c` removed them outright. Three unrelated settings in the same block already use `deprecationMessage` for this exact situation.
- **Logic:** Re-add the five as deprecated schema-only declarations with migration messages.
- **Edge Cases:** Must stay inert — no reader; `trustedAuthors` must not imply the author filter survived.

## Verification Plan

*Per session directive, no compilation or automated-test execution is part of this plan's verification.*

1. On an install whose `settings.json` contains `switchboard.planAutoFetch.enabled`, the JSON editor no longer shows "Unknown Configuration Setting" — it shows the key struck through with the migration message.
2. The Problems view entry for that key carries the migration guidance rather than a bare unknown-setting warning.
3. The GUI settings editor renders the configured deprecated setting with its warning box — the surface where the orphan key was previously invisible.
4. `trustedAuthors`' message states that the replacement applies no author filter.
5. No code path reads any of the five keys.
6. The five messages and the four corrected site pages describe the same replacement.

## Recommendation

Complexity 2 → **Send to Coder.** Five schema entries and five sentences. It matters because the retirement was verified against a clean tree, and the state it broke lives in ~4,000 `settings.json` files the tree cannot see — the parent feature's defect shape, applied to the retirement rather than to the code.
