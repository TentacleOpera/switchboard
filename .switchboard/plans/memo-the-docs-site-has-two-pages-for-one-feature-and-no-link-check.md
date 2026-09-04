# The Docs Site Has Two Pages for One Feature, No Link Check, and No Release Surface

## Goal

The documentation site must have one canonical page per feature, a gate that catches a dead internal link, and either a release-notes surface or no plan step that assumes one.

### Problem analysis

Four reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against the `switchboard-site` repository. They sit naturally with the active *One docs URL, pointed at switchboard.dev* feature, which moves the site and consolidates its URL but does not touch its content or its gates.

## Metadata

- **Complexity:** 3
- **Tags:** docs, switchboard-site

## User Review Required

Change 1 is a small author decision: which page is canonical.

## Proposed Changes

### 1. Two pages document Create Plans, and both are in the navigation **[decision]**

`src/pages/docs/artifacts/create-plans.md` and `src/pages/docs/integrations/web-agents.md` both document the same feature, and both are listed in `src/data/nav.ts` at `:82` and `:114`.

Nothing decides which is canonical, so a reader finds whichever they reach first and the two drift.

### 2. The docs describe a tab that moved a month ago

Create Plans lives in `connections.html`, labelled "Web Agents", added in `3753e3ef` on 2026-08-05 and carrying that label at `:249` and `:312`. `planning.html` no longer owns it. A later docs plan still describes it as an Artifacts tab.

The general fix belongs with the **Plan-Authoring Contract** feature: none of its six subtasks requires reading the current webview HTML before writing a docs plan. Add that rule there, and correct this instance here.

### 3. Nothing catches a dead internal link

`astro.config.mjs` lists `[sitemap()]` as its only integration, and `deploy.yml`'s single step is `uses: withastro/action@v6` — no link-check step, no script beyond `astro build`.

So a docs page can point at a route that does not exist and the build stays green. This is what would have caught changes 1 and 2 as they happened.

### 4. There is no release-notes surface, and a plan step assumes one

No `CHANGELOG` exists in the extension repository, and there is no release or changelog entry in the site's navigation or docs tree.

A docs plan carries a release-note step that therefore cannot be executed. Either create the surface or delete the step from the template, and say which in the plan-authoring contract.

## Verification Plan

1. One page documents Create Plans; the other redirects or is removed, and the navigation lists one.
2. That page describes the Web Agents tab in `connections.html`, not an Artifacts tab.
3. The Plan-Authoring Contract feature carries the rule that a docs plan reads current webview HTML first.
4. A deliberately broken internal link fails the site build or a CI step.
5. Either a release-notes surface exists and is linked, or no plan template references one.
