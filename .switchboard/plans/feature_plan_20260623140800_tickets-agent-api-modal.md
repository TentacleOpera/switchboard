# Tickets Tab "Agent API" Modal — Source-Aware Non-MCP Capability Reference

> **Implementation Status (verified 2026-06-23):** This feature is **already implemented** in the codebase. The `tickets-agent-api` button exists at `planning.html:3556`, `renderAgentApiModal()` exists at `planning.js:6357`, and the `AGENT_API_CAPABILITIES` constant is present. The line numbers in the original plan below reflect the pre-implementation codebase and are stale — see the **Line Number Audit** section at the end for corrections.

## Goal

Today the Switchboard tickets tab gives users no in-UI explanation of what coding agents can do with tickets **without the MCP server** — i.e. via the `LocalApiServer` HTTP bridge that the extension already runs on a random localhost port. The bridge is real and shipped (`src/services/LocalApiServer.ts`), agents discover it through `.switchboard/api-server-port.txt`, and a set of skill docs (`.agents/skills/clickup_api.md`, `linear_api.md`, `get_tickets.md`, `clickup_create_task.md`, `clickup_modify_task.md`, `clickup_attach.md`, `clickup_create_subpage.md`, `generate_diagram.md`, `clickup_fetch.md`) document the individual endpoints. But a user sitting in the tickets tab has no way to learn "I can just tell my agent to update this ticket's status without any MCP" or to grab a ready-to-paste instruction.

This feature adds an **"Agent API"** button to the tickets-tab toolbar that opens a modal. The modal lists the **actual** bridge capabilities as list items, each with a one-line description and a **Copy prompt** button that copies a ready-to-paste natural-language instruction for an agent. The capability list is **source-aware**: it shows the ClickUp capability set when the tickets tab's selected provider is ClickUp, and the Linear capability set when it is Linear.

### Root cause / context (cited)

- The tickets tab's selected provider is tracked by the single module-level variable `lastIntegrationProvider` (`'clickup'` | `'linear'` | `null`), declared at `src/webview/planning.js:120`, set by the provider `<select>` change handler at `src/webview/planning.js:6378`, persisted/restored at `src/webview/planning.js:8473` and `:8489`. The provider `<select>` lives inside the existing **source modal** (`#tickets-provider-selector`, `src/webview/planning.html:3795`). So the "currently selected source" the issue refers to is exactly `lastIntegrationProvider`.
- The toolbar (controls strip) for the tickets tab is `#controls-strip-tickets` → `.controls-strip-row` at `src/webview/planning.html:3527-3539`, holding `Source`, search, `+ New Ticket`, `Refetch`, `Sync changes` buttons (all `class="strip-btn"`). This is where the new `Agent API` button belongs.
- The real, shipped bridge endpoints are all in `LocalApiServer._handleRequest` (`src/services/LocalApiServer.ts:737-775`). These are the ONLY capabilities the modal may claim. See the audit below for the exact list.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, feature, docs, api

## User Review Required

**None** — all decisions are baked into the Proposed Changes. The modal is purely additive UI (new button, new modal, new in-memory constant), no persisted state changes, no settings, no migrations. The capability list is hardcoded from the known bridge endpoint table and rebuilt on each open.

## Dependencies

- **`feature_plan_20260623120000_localapiserver-bridge-robustness`** — Fixes the `LocalApiServer` bridge auth/skill-discovery issues that today cause 401s when a token is configured. This modal advertises bridge capabilities; if it ships before the bridge fix, copy-prompts will instruct agents to do things that 401. **Recommended sequencing:** land the bridge robustness plan first (or together with this one). The modal code itself needs no change either way — it already avoids `/config/token` and names skills, matching the hardened skills.
- **No other cross-plan dependencies.** The modal reuses existing UI patterns (folder-modal, strip-btn, clipboard copy) and existing module-level state (`lastIntegrationProvider`).

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) The hardcoded `AGENT_API_CAPABILITIES` list has no sync mechanism with `LocalApiServer._handleRequest` — endpoints added/removed in the bridge will cause the modal to go stale silently. Mitigation: acceptable for a small modal; a build-time assertion is a future improvement. (2) Stale line numbers throughout the plan (8/12 references off by 15-200+ lines) — corrected in the Line Number Audit below. (3) The `_checkAuth` sequencing claim is unverified — the plan's approach of naming skills rather than raw endpoints is sound regardless. (4) Three required sections were missing from the original plan (now added).

## Complexity Audit

### Routine
- Adding one `strip-btn` to the toolbar row (`planning.html`) — identical to existing siblings.
- Adding a `folder-modal` block — the markup/CSS classes (`.folder-modal`, `.modal-content`, `.modal-header`, `.modal-body`, `.modal-section`, `.section-title`, `.modal-close-btn`) already exist (`planning.html:2561-2645`); the tickets **source** modal at `planning.html:3785-3816` is a copy-paste template.
- Open/close wiring — mirror the source-modal handlers at `planning.js:6349-6371` (open on button click, close on ✕, close on Close button, close on backdrop click).
- Copy-to-clipboard with transient "COPIED" feedback — mirror the proven research-prompt button at `planning.js:1229-1258` (`navigator.clipboard.writeText` + revert text after 2s). `navigator.clipboard.writeText` is already used successfully in this webview, so it is the established working path.

### Complex / Risky
- **Source-awareness:** the modal content must reflect `lastIntegrationProvider` **at the moment it is opened** (the user can change provider in the source modal between opens). Rebuild the list on every open rather than once at init — see Edge-Case audit.
- **Accuracy of capabilities/prompts:** the prompts must describe operations the bridge actually supports, and must NOT reference an endpoint that doesn't exist. Notably the skill docs reference `GET /config/token` to fetch the auth token, but **that endpoint does not exist** in `LocalApiServer._handleRequest` (`src/services/LocalApiServer.ts:737-775`) — the token is the `switchboard.apiToken` VS Code secret read at `src/services/TaskViewerProvider.ts:796`. The copy-prompts must therefore NOT instruct agents to curl `/config/token`; they should reference the skills by name and let the agent's skill files handle the mechanics. This keeps the modal correct regardless of the `/config/token` discrepancy.
  - **Cross-plan note:** `feature_plan_20260623120000_localapiserver-bridge-robustness` is the dedicated fix for this exact discrepancy — it deletes the dead `/config/token` lines from the 5 skills that carry them, relaxes `_checkAuth` to trust the localhost boundary (so skills stop 401-ing when a token is configured), and hardens skill discovery (health-gated, retrying, `roots` identity check). This modal's "reference the skill by name, no raw `/config/token`" approach is **already aligned with the post-fix skills**, so it requires no rework when that plan lands. See the Dependencies note below for the sequencing/reliability implication.

## Edge-Case & Dependency Audit

- **Source switching updates modal content.** The provider can change via `#tickets-provider-selector` (`planning.js:6373`). The modal must read `lastIntegrationProvider` *when opened* and rebuild its list each time, so opening it after a ClickUp→Linear switch shows Linear capabilities. Do NOT cache the rendered list.
- **Provider is `null` (no integration configured).** `lastIntegrationProvider` can be `null` (`planning.js:120`; the `+ New Ticket` button ships `disabled` for this reason). When null, render a short empty-state message ("Configure a ClickUp or Linear integration in Setup to enable the agent API.") instead of a capability list, and still allow the modal to open/close.
- **Clipboard in the webview sandbox.** The webview is a sandboxed iframe. `navigator.clipboard.writeText` is confirmed working here (research-prompt copy, `planning.js:1244`) — reuse that exact try/catch pattern with a `FAILED` fallback label. Do **not** route prompt text through the `copyToClipboard` postMessage: that host handler (`PlanningPanelProvider.ts:4461`) only resolves ticket *file paths* by id and ignores arbitrary text — wrong tool for this job.
- **No confirmation dialogs.** Per project rule, the Agent API button just toggles the modal; copy buttons copy immediately. No `confirm()` anywhere (and it would be a silent no-op in the webview anyway).
- **Dependency on the bridge being usable (sequencing).** This modal *advertises* what agents can do over the `LocalApiServer` bridge, but it does not make the bridge work. Today the bridge is effectively down whenever a token is configured: the skills fetch a token from the non-existent `GET /config/token` (404 → empty `Authorization: Bearer `), which `_checkAuth` (`LocalApiServer.ts:106-119`) rejects with 401 on every read/write. `feature_plan_20260623120000_localapiserver-bridge-robustness` is the fix. **Implication:** if this modal ships *before* that plan, the copy-prompts will tell users to instruct their agent to do things that then 401 — advertising a broken capability. Therefore **sequence this modal to land after (or together with) the bridge robustness plan**, OR ship it now with the understanding that the capabilities only become reliable once that plan lands. This is purely a release-ordering concern — the modal code here needs no change either way (it already avoids `/config/token` and names skills, matching the hardened skills). Recommended: land the bridge plan first.
- **Capabilities must match the real bridge.** Source of truth = `LocalApiServer._handleRequest` route table (`src/services/LocalApiServer.ts:737-775`). Exact endpoints:

  | Endpoint (method) | Handler | LocalApiServer.ts |
  |---|---|---|
  | `GET /metadata/clickup`, `GET /metadata/linear` | cached ticket metadata list | :741-744, :786 |
  | `GET /task/clickup/{id}`, `GET /task/linear/{id}` | full task/issue + subtasks/comments/attachments | :745-750, :806 |
  | `POST /task/clickup` | create ClickUp task (+subtasks) | :751, :197 |
  | `PUT /task/clickup/{id}` | update ClickUp task (name/description/status/assignees/dueDate/priority/tags) | :753, :279 |
  | `POST /api/clickup` | raw ClickUp REST proxy (method/endpoint/query/body) | :756, :158 |
  | `POST /api/linear` | raw Linear GraphQL proxy (query/variables) | :758, :613 |
  | `POST /task/clickup/{id}/attach` | attach file (base64) to ClickUp task | :760, :341 |
  | `POST /doc/clickup` | create ClickUp doc page | :763, :425 |
  | `POST /diagram/generate` | generate (and optionally upload) architecture diagram | :765, :502 |
  | `GET /resolve/{source}/name/{name}` | resolve a name → id (clickup or linear) | :767, :650 |

  **Asymmetry to respect:** ClickUp has first-class create/update/attach/doc endpoints; Linear only has `GET /task/linear/{id}`, `GET /metadata/linear`, `GET /resolve/linear/...`, and the generic `POST /api/linear` GraphQL proxy (so Linear *writes* — create issue, change state, comment — go through the GraphQL proxy, not a dedicated endpoint). The Linear capability list must reflect this: read/resolve are direct; create/update/comment are "via the Linear GraphQL API proxy". The `generate_diagram` endpoint supports `platform: "linear"` upload (`LocalApiServer.ts:569`), so it appears in both lists.

## Proposed Changes

### 1. `src/webview/planning.html` — toolbar button

Insert an `Agent API` button into the tickets controls strip row, after `Sync changes` (`planning.html:3538`):

```html
                    <button id="tickets-sync-all" class="strip-btn" title="Push all local ticket changes back to the integration">Sync changes</button>
                    <button id="tickets-agent-api" class="strip-btn" title="What agents can do with this ticket source without the MCP">Agent API</button>
```

### 2. `src/webview/planning.html` — modal markup

Add a new `folder-modal` after the tickets source modal (`planning.html:3816`, before `#tickets-delete-modal`). The body holds a static intro + a container that JS fills source-awarely:

```html
    <div class="folder-modal" id="tickets-agent-api-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="tickets-agent-api-modal-title">
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="tickets-agent-api-modal-title">Agent API</h3>
                <button class="modal-close-btn" id="btn-close-tickets-agent-api-modal" aria-label="Close">&times;</button>
            </div>
            <div class="modal-body">
                <p style="margin: 0 0 14px 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
                    Switchboard runs a local HTTP bridge so your coding agent can read and change tickets
                    <strong>without the MCP server</strong>. Agents discover it via
                    <code>.switchboard/api-server-port.txt</code> and call it with the matching skill.
                    Pick a capability below and copy a ready-to-paste instruction for your agent.
                </p>
                <div id="tickets-agent-api-provider-label" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 10px;"></div>
                <ul id="tickets-agent-api-list" class="agent-api-list" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px;"></ul>
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;">
                    <button id="btn-close-tickets-agent-api-modal-action" class="strip-btn">Close</button>
                </div>
            </div>
        </div>
    </div>
```

### 3. `src/webview/planning.html` — minimal list-item CSS

Add near the other `.folder-modal` rules (after `planning.html:2645`):

```css
        .agent-api-list li {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 12px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            background: var(--panel-bg2, var(--card-bg, #1a1a2e));
        }
        .agent-api-list .agent-api-text { flex: 1; min-width: 0; }
        .agent-api-list .agent-api-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
        .agent-api-list .agent-api-desc { font-size: 11px; color: var(--text-secondary); line-height: 1.4; margin-top: 2px; }
        .agent-api-list .agent-api-copy { white-space: nowrap; flex: 0 0 auto; }
```

### 4. `src/webview/planning.js` — source-aware capability data

Add a module-level constant (near the other tickets constants, e.g. after `lastIntegrationProvider` at `:120`). Each prompt is a concrete, copy-paste agent instruction that names the relevant **skill** (so the agent uses its own skill files for port discovery + auth, avoiding the non-existent `/config/token` pitfall). Use `{ticketId}` substitution where a ticket is selected so prompts are pre-filled when possible.

```js
    // Source-aware list of what agents can do via the LocalApiServer bridge (no MCP).
    // Mirrors the real endpoints in src/services/LocalApiServer.ts:737-775 and the
    // .agents/skills/*.md docs. ClickUp has dedicated write endpoints; Linear writes
    // go through the GraphQL proxy.
    const AGENT_API_CAPABILITIES = {
        clickup: [
            { name: 'List / filter cached tickets',
              desc: 'Read the local cached ticket metadata — no MCP round-trip (GET /metadata/clickup, get_tickets skill).',
              prompt: 'Use the get_tickets skill to read my cached ClickUp tickets from the Switchboard local API (GET /metadata/clickup) and list them grouped by status. Do not use the MCP.' },
            { name: 'Read a ticket in full',
              desc: 'Fetch a task with description, subtasks, comments and attachments (GET /task/clickup/{id}).',
              prompt: 'Use the get_tickets skill to fetch ClickUp task {ticketId} in full from the Switchboard local API (GET /task/clickup/{ticketId}) — description, subtasks, comments and attachments — and summarise it. Do not use the MCP.' },
            { name: 'Create a task (with subtasks)',
              desc: 'Create a new ClickUp task and optional subtasks (POST /task/clickup, clickup_create_task skill).',
              prompt: 'Use the clickup_create_task skill to create a ClickUp task via the Switchboard local API (POST /task/clickup). Ask me for the list, then the task name, description and any subtasks. Do not use the MCP.' },
            { name: 'Update a task',
              desc: 'Change name, description, status, assignees, due date, priority or tags (PUT /task/clickup/{id}, clickup_modify_task skill).',
              prompt: 'Use the clickup_modify_task skill to update ClickUp task {ticketId} via the Switchboard local API (PUT /task/clickup/{ticketId}). Ask me which fields to change (status, assignees, priority, tags, due date) and apply them. Do not use the MCP.' },
            { name: 'Attach a file',
              desc: 'Upload a screenshot/doc (≤10MB) to a task (POST /task/clickup/{id}/attach, clickup_attach skill).',
              prompt: 'Use the clickup_attach skill to attach a file to ClickUp task {ticketId} via the Switchboard local API (POST /task/clickup/{ticketId}/attach). Ask me which local file to upload. Do not use the MCP.' },
            { name: 'Create a doc page',
              desc: 'Add a Markdown page to a ClickUp doc (POST /doc/clickup, clickup_create_subpage skill).',
              prompt: 'Use the clickup_create_subpage skill to create a ClickUp doc page via the Switchboard local API (POST /doc/clickup). Ask me for the docId, page title and content. Do not use the MCP.' },
            { name: 'Resolve a name to an ID',
              desc: 'Turn a task/list name into its ID (GET /resolve/clickup/name/{name}, clickup_fetch skill).',
              prompt: 'Use the clickup_fetch skill to resolve a ClickUp name to an ID via the Switchboard local API (GET /resolve/clickup/name/...). Ask me the name to resolve. Do not use the MCP.' },
            { name: 'Generate an architecture diagram',
              desc: 'Build a Mermaid diagram and optionally attach it to a task (POST /diagram/generate, generate_diagram skill).',
              prompt: 'Use the generate_diagram skill to generate an architecture diagram via the Switchboard local API (POST /diagram/generate) and attach it to ClickUp task {ticketId}. Do not use the MCP.' },
            { name: 'Raw ClickUp API call',
              desc: 'Any ClickUp v2 REST endpoint not covered above (POST /api/clickup, clickup_api skill).',
              prompt: 'Use the clickup_api skill to make a raw ClickUp REST call via the Switchboard local API proxy (POST /api/clickup). Tell me which endpoint/method you need and I will confirm. Do not use the MCP.' }
        ],
        linear: [
            { name: 'List / filter cached issues',
              desc: 'Read the local cached issue metadata — no MCP round-trip (GET /metadata/linear, get_tickets skill).',
              prompt: 'Use the get_tickets skill to read my cached Linear issues from the Switchboard local API (GET /metadata/linear) and list them grouped by state. Do not use the MCP.' },
            { name: 'Read an issue in full',
              desc: 'Fetch an issue with description, sub-issues, comments and attachments (GET /task/linear/{id}).',
              prompt: 'Use the get_tickets skill to fetch Linear issue {ticketId} in full from the Switchboard local API (GET /task/linear/{ticketId}) — description, sub-issues, comments and attachments — and summarise it. Do not use the MCP.' },
            { name: 'Resolve a name to an ID',
              desc: 'Turn an issue/project name into its ID (GET /resolve/linear/name/{name}).',
              prompt: 'Resolve a Linear name to an ID via the Switchboard local API (GET /resolve/linear/name/...). Ask me the name to resolve. Do not use the MCP.' },
            { name: 'Create / update / comment via GraphQL',
              desc: 'Linear writes (create issue, change state, add comment) go through the GraphQL proxy (POST /api/linear, linear_api skill).',
              prompt: 'Use the linear_api skill to run a Linear GraphQL mutation via the Switchboard local API proxy (POST /api/linear) — e.g. create an issue, change its state, or add a comment to {ticketId}. Tell me the operation and I will confirm the fields. Do not use the MCP.' },
            { name: 'Run any GraphQL query',
              desc: 'Arbitrary Linear GraphQL read query (POST /api/linear, linear_api skill).',
              prompt: 'Use the linear_api skill to run a Linear GraphQL query via the Switchboard local API proxy (POST /api/linear). Tell me what to fetch and I will confirm the query. Do not use the MCP.' },
            { name: 'Generate an architecture diagram',
              desc: 'Build a Mermaid diagram and optionally attach it to an issue (POST /diagram/generate, generate_diagram skill).',
              prompt: 'Use the generate_diagram skill to generate an architecture diagram via the Switchboard local API (POST /diagram/generate) and attach it to Linear issue {ticketId} (platform "linear"). Do not use the MCP.' }
        ]
    };
```

### 5. `src/webview/planning.js` — render + open/close + copy wiring

Add a renderer and wire the button/modal. Place the wiring alongside the existing source-modal handlers in `initTicketsTab` (`planning.js:6349`), and define `renderAgentApiModal` near `updateTicketsSourceSummary` (`planning.js:6298`). The renderer reads `lastIntegrationProvider` **every time** (source-aware) and pre-fills `{ticketId}` from the currently selected ticket when one is open.

```js
    function currentSelectedTicketId() {
        // Mirrors how the tickets tab resolves the active ticket id elsewhere
        // (e.g. planning.js:416-417 / :657).
        return lastIntegrationProvider === 'linear'
            ? (selectedLinearIssue?.issue?.id || null)
            : (selectedClickUpIssue?.task?.id || null);
    }

    function renderAgentApiModal() {
        const list = document.getElementById('tickets-agent-api-list');
        const label = document.getElementById('tickets-agent-api-provider-label');
        if (!list) return;
        const provider = lastIntegrationProvider;
        list.innerHTML = '';

        if (!provider || !AGENT_API_CAPABILITIES[provider]) {
            if (label) label.textContent = '';
            const li = document.createElement('li');
            li.style.justifyContent = 'flex-start';
            li.innerHTML = '<span class="agent-api-desc">Configure a ClickUp or Linear integration in Setup to enable the agent API.</span>';
            list.appendChild(li);
            return;
        }

        if (label) label.textContent = (provider === 'clickup' ? 'ClickUp' : 'Linear') + ' — no MCP required';
        const ticketId = currentSelectedTicketId();

        AGENT_API_CAPABILITIES[provider].forEach(cap => {
            // Pre-fill {ticketId}; if no ticket is selected, fall back to a placeholder the agent can ask about.
            const filledPrompt = cap.prompt.replace(/\{ticketId\}/g, ticketId || 'the ticket id');
            const li = document.createElement('li');
            const text = document.createElement('div');
            text.className = 'agent-api-text';
            const name = document.createElement('div');
            name.className = 'agent-api-name';
            name.textContent = cap.name;
            const desc = document.createElement('div');
            desc.className = 'agent-api-desc';
            desc.textContent = cap.desc;
            text.appendChild(name);
            text.appendChild(desc);
            const btn = document.createElement('button');
            btn.className = 'strip-btn agent-api-copy';
            btn.textContent = 'Copy prompt';
            btn.addEventListener('click', async () => {
                if (btn.textContent === 'COPIED') return;
                try {
                    await navigator.clipboard.writeText(filledPrompt);
                    btn.textContent = 'COPIED';
                } catch (err) {
                    console.error('[AgentAPI] clipboard failed:', err);
                    btn.textContent = 'FAILED';
                }
                setTimeout(() => { btn.textContent = 'Copy prompt'; }, 2000);
            });
            li.appendChild(text);
            li.appendChild(btn);
            list.appendChild(li);
        });
    }
```

Wiring (add inside `initTicketsTab`, next to the source-modal handlers at `planning.js:6349-6371`):

```js
        const agentApiBtn = document.getElementById('tickets-agent-api');
        const agentApiModal = document.getElementById('tickets-agent-api-modal');
        agentApiBtn?.addEventListener('click', () => {
            renderAgentApiModal();              // rebuild every open → source-aware
            if (agentApiModal) agentApiModal.style.display = 'block';
        });
        document.getElementById('btn-close-tickets-agent-api-modal')?.addEventListener('click', () => {
            if (agentApiModal) agentApiModal.style.display = 'none';
        });
        document.getElementById('btn-close-tickets-agent-api-modal-action')?.addEventListener('click', () => {
            if (agentApiModal) agentApiModal.style.display = 'none';
        });
        agentApiModal?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
        });
```

> Note on `.folder-modal` display: the source modal toggles `style.display = 'block'` (`planning.js:6351`) even though `.folder-modal` is `display:flex` in CSS (`planning.html:2565`). That inline `block` overrides flex centering but still shows the modal — matching existing behaviour exactly. Use `'block'` here too for consistency with the sibling modal (do not "fix" it to `flex`, to stay consistent with the shipped source modal).

### 6. Migrations

None. This is purely additive UI (new button, new modal, new in-memory constant). No persisted state changes, no settings, no files. The `AGENT_API_CAPABILITIES` data is rebuilt from scratch on each open. (Migration rule: nothing shipped is being altered or removed.)

## Verification Plan

1. **Build:** `npm run compile` — must succeed (webpack bundles `src/webview/*` into `dist/webview/`; the extension serves from `dist/`). This is the mandatory gate.
2. **Manual smoke (Extension Development Host):**
   - Open the planning panel → Tickets tab. Confirm the new **Agent API** button appears in the toolbar after `Sync changes`.
   - With provider = ClickUp (via the Source modal), open Agent API → confirm the **ClickUp** capability list (9 items incl. create/update/attach/doc/diagram/raw API) and the "ClickUp — no MCP required" label.
   - In the Source modal switch provider to **Linear**, reopen Agent API → confirm the list now shows the **Linear** set (read/resolve direct, writes via GraphQL proxy, diagram) and the label updates — proving source-awareness on each open.
   - Select a ticket first, reopen Agent API, click **Copy prompt** on "Read a ticket in full" → button flips to COPIED then reverts; paste shows the real ticket id substituted for `{ticketId}`.
   - With no ticket selected, copy a prompt → it contains the literal `the ticket id` fallback (no broken `{ticketId}`).
   - Close via ✕, via Close button, and via backdrop click — all dismiss.
   - With no integration configured (`lastIntegrationProvider === null`) the modal opens and shows the "Configure a ClickUp or Linear integration in Setup" empty state, and still closes cleanly.
3. **Accuracy check:** cross-read each capability's endpoint against `src/services/LocalApiServer.ts:737-775` — every claimed endpoint exists; no prompt instructs an agent to call the non-existent `GET /config/token`.
4. **No-confirm check:** grep the diff for `confirm(` — must be zero.

> **SKIP COMPILATION:** Do NOT run `npm run compile` or any project compilation step.
>
> **SKIP TESTS:** Do NOT run automated tests. The test suite will be run separately by the user.

## Line Number Audit (Post-Verification, 2026-06-23)

The following corrections reflect the **current** codebase (post-implementation). The original plan citations above are preserved for reference; use these corrected numbers when navigating the code.

| Original Citation | Correct Location | Notes |
|---|---|---|
| `planning.js:120` (`lastIntegrationProvider`) | `planning.js:120` | ✅ Correct |
| `planning.js:6378` (provider `<select>` change handler) | `planning.js:6518` | Off by ~140 lines |
| `planning.js:8473` and `:8489` (persist/restore) | `planning.js:8618` (`saveTicketsState`) and `:8634` (`restoreTicketsStateForRoot`) | Off by ~145-160 lines |
| `planning.html:3795` (`#tickets-provider-selector`) | `planning.html:3811` | Off by 16 lines |
| `planning.html:3527-3539` (`#controls-strip-tickets`) | `planning.html:3542-3556` | Off by 15 lines |
| `LocalApiServer.ts:737-775` (route table) | `LocalApiServer.ts:737-776` | ✅ Correct (±1 line) |
| `planning.js:6349-6371` (source modal handlers) | `planning.js:6469-6489` | Off by ~120 lines |
| `planning.js:1229-1258` (research prompt copy) | `planning.js:1290-1319` | Off by ~61 lines |
| `planning.html:2561-2645` (folder-modal CSS) | `planning.html:2561-2645` | ✅ Correct |
| `planning.js:6298` (`updateTicketsSourceSummary`) | `planning.js:6417` | Off by ~119 lines |
| `planning.js:416-417` and `:657` (selected ticket vars) | `planning.js:213` (`selectedLinearIssue`), `:227` (`selectedClickUpIssue`), `:472-474` (resolution logic) | Off by 200+ lines |
| `PlanningPanelProvider.ts:4461` (`copyToClipboard` handler) | `PlanningPanelProvider.ts:4461` | ✅ Correct |

---

**Recommendation:** Complexity 4 → **Send to Coder.** The feature is already implemented and shipped. The plan's core approach (source-aware modal, skill-name references, no `/config/token`) is architecturally sound. Remaining work: verify the implementation matches the plan via the manual smoke test, and consider adding a build-time assertion to keep `AGENT_API_CAPABILITIES` in sync with the bridge route table.

---

## Reviewer Pass (2026-06-23, in-place)

### Stage 1 — Grumpy Principal Engineer

*Theatrical, incisive, severity-tagged. The implementation was reviewed against the plan file as the single source of truth.*

**NIT (out-of-scope note) — `dist/` is stale; rebuild before shipping.**
`src/` carries the full implementation, but `dist/webview/planning.{html,js}` do not yet reflect it (`grep` returns 0 matches). Per `CLAUDE.md`, the extension serves from `dist/`, so `npm run compile` is needed before the feature appears at runtime. This is a build-hygiene reminder, **not a code defect** — the review session was scoped to source-vs-plan (SKIP COMPILATION), so this is noted only as a pre-ship action item, not a review finding.

**NIT — `/comment` endpoint is a first-class bridge capability the modal never mentions.**
`LocalApiServer.ts:781-782` routes `POST /comment` to `_handlePostComment` (`:143`), a provider-gated (clickup|linear) comment poster backed by `service.postManagedComment`. The plan's "Capabilities must match the real bridge" audit table (lines 57-69) **omits this route entirely**, so the implementer faithfully reproduced the omission. The capability IS reachable indirectly — `clickup_api.md:37` and `linear_api.md:32` both document `/comment` and are referenced by the modal's "Raw ClickUp API call" and "Create / update / comment via GraphQL" entries — so the modal is not *wrong*, just under-advertised. A future improvement: add a "Post a comment" capability row naming the `clickup_api` / `linear_api` skill and the `/comment` route.

**NIT — Copy-button setTimeout race on rapid re-click during FAILED state.**
`planning.js:6401` guards re-entry only when `btn.textContent === 'COPIED'`. If the first click fails (→ 'FAILED'), a second click during the 2s window starts a new copy; the first click's `setTimeout` (`:6409`) then fires and resets to 'Copy prompt', potentially clobbering a fresh 'COPIED' label. This is inherited verbatim from the research-prompt pattern (`planning.js:1290-1319`) and is cosmetic — not worth diverging from the established pattern to fix.

**Everything else is clean.** Button placement (`planning.html:3554`, after `Sync changes`) ✅. Modal markup (`planning.html:3833-3853`, after source modal, before delete modal) ✅. CSS (`planning.html:2647-2660`, after the folder-modal rules) ✅. `AGENT_API_CAPABILITIES` constant (`planning.js:126-176`) — ClickUp 9 items, Linear 6 items, every claimed endpoint verified against `LocalApiServer.ts:762-798` ✅. `renderAgentApiModal` (`planning.js:6365-6415`) reads `lastIntegrationProvider` on every open, handles `null` empty-state, pre-fills `{ticketId}` via `currentSelectedTicketId()` (`:6359-6363`) which mirrors the codebase's established resolution pattern (`:473-474`, `:4229`, `:6813`) ✅. Wiring inside `initTicketsTab` (`:6493-6516`) — open/close/backdrop/Close-button all present ✅. `getTicketsTabElements` destructures the four new element IDs (`:1016-1019`) ✅. No `confirm(` calls in the diff (grep: 0 matches) ✅. No `/config/token` reference in any prompt ✅.

### Stage 2 — Balanced Synthesis

| Finding | Severity | Verdict | Action |
|---|---|---|---|
| `dist/` stale — feature absent at runtime | NIT (out-of-scope) | **Defer** | Build-hygiene reminder, not a code defect. Run `npm run compile` before shipping. Out of this review's scope (SKIP COMPILATION). |
| `/comment` endpoint not surfaced as first-class capability | NIT | **Defer** | Reachable via advertised skills; not incorrect. Future enhancement. |
| Copy-button setTimeout race on FAILED re-click | NIT | **Defer** | Inherited from existing pattern; cosmetic only. |

**No code fixes applied in this pass.** The source implementation matches the plan exactly and is architecturally sound. Zero CRITICAL, zero MAJOR findings against the source-vs-plan review scope.

### Verification Results

| Check | Result |
|---|---|
| Button present in source (`src/webview/planning.html:3554`) | ✅ Pass |
| Modal markup present in source (`src/webview/planning.html:3833-3853`) | ✅ Pass |
| CSS rules present (`src/webview/planning.html:2647-2660`) | ✅ Pass |
| `AGENT_API_CAPABILITIES` constant present (`src/webview/planning.js:126-176`) | ✅ Pass |
| `renderAgentApiModal` + `currentSelectedTicketId` present (`src/webview/planning.js:6359-6415`) | ✅ Pass |
| Wiring inside `initTicketsTab` (`src/webview/planning.js:6493-6516`) | ✅ Pass |
| `getTicketsTabElements` includes new IDs (`src/webview/planning.js:1016-1019`) | ✅ Pass |
| Endpoint accuracy vs `LocalApiServer.ts:762-798` | ✅ Pass (all claimed routes exist) |
| No `confirm(` in diff | ✅ Pass (0 matches) |
| No `/config/token` in any prompt | ✅ Pass |
| `dist/` reflects source | ⏭️ Out of scope (SKIP COMPILATION; build-hygiene, not a code defect) |
| Compilation (`npm run compile`) | ⏭️ Skipped per session directive |
| Automated tests | ⏭️ Skipped per session directive |

### Files Reviewed (no changes applied)

- `src/webview/planning.html` — lines 2647-2660 (CSS), 3554 (button), 3833-3853 (modal)
- `src/webview/planning.js` — lines 126-176 (constant), 1016-1019 (elements), 6359-6415 (renderer), 6493-6516 (wiring)
- `src/services/LocalApiServer.ts` — lines 762-798 (route table cross-check)

### Remaining Risks

1. **`dist/` is stale (NIT, pre-ship action).** Run `npm run compile` before shipping so the feature appears at runtime. Not a code defect — out of this review's source-vs-plan scope.
2. **`/comment` endpoint under-advertised (NIT, defer).** The dedicated `POST /comment` route (`LocalApiServer.ts:781`) is not surfaced as a first-class modal capability; it is reachable indirectly via the `clickup_api` and `linear_api` skills, both of which document the route.
3. **No build-time sync assertion (NIT, defer).** `AGENT_API_CAPABILITIES` is hardcoded; bridge route additions/removals will silently stale the modal. A build-time assertion against `LocalApiServer._handleRequest` is a future improvement noted in the plan's Adversarial Synthesis.
