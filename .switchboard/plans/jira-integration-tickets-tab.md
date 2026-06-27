# Jira Cloud Integration — Tickets Tab

## Goal

Add Jira Cloud as a third provider option in the tickets tab, alongside the existing ClickUp and Linear integrations. Users who have configured a Jira Cloud API token should be able to browse issues, view issue details, and post comments — the same capabilities offered by ClickUp and Linear today.

### Core problems / root cause

The tickets tab provider system is fully symmetrical: `lastIntegrationProvider` drives `renderTicketsTab()` → per-provider panel, and `integrationProviderStates` from `PlanningPanelProvider` drives the selector visibility. Every provider touch point currently has a binary ClickUp/Linear branch. Jira is a third case that must be added at each of these branch points. There is no single plugin registration point — it's deliberately spread across LocalApiServer (proxy), PlanningPanelProvider (config/state), and planning.js (UI).

### Constraints

- Jira Cloud only (no Server/Data Center)
- Read + comment only for v1 (no write-back to Jira issue status)
- Auth: email + API token (Basic auth) — no OAuth 2.0
- No new UI paradigms; Jira slots into the existing provider tab/selector pattern
- Must not break existing ClickUp or Linear users

---

## Scope

**In scope:** Issue list, issue detail (description, subtasks, comments), post comment, token/email/instance setup, provider selector, metadata caching.

**Out of scope (future):** Status transitions, creating issues from plans, file attachments, webhooks/real-time sync, Jira Server, OAuth 2.0.

---

## Files to Create

### 1. `src/services/JiraSyncService.ts` (~400 lines)

New service mirroring `LinearSyncService.ts` structure. Key points:

**Config interface:**
```typescript
interface JiraConfig {
  instanceUrl: string;          // e.g. https://myorg.atlassian.net
  projectKey: string;           // e.g. "ENG"
  email: string;                // user's Atlassian account email
  setupComplete: boolean;
  lastSync: string | null;
  autoPullEnabled: boolean;
  pullIntervalMinutes: 5 | 15 | 30 | 60;
}
```

**Issue interface:**
```typescript
interface JiraIssue {
  id: string;           // internal numeric ID ("10042")
  key: string;          // human key ("ENG-42")
  title: string;        // fields.summary
  description: string;  // ADF → markdown (via adfToMarkdown helper)
  status: { id: string; name: string; statusCategory: string } | null;
  issuetype: { id: string; name: string } | null;
  priority: { id: string; name: string } | null;
  assignee: { accountId: string; displayName: string; emailAddress: string } | null;
  labels: string[];
  created: string;
  updated: string;
  url: string;
  parentKey: string | null;
}
```

**Auth:** `Authorization: Basic <base64(email:apiToken)>`. Token stored in `vscode.SecretStorage` under `'switchboard.jira.apiToken'`. Email stored in config JSON (not secret).

**Base URL:** `${config.instanceUrl}/rest/api/3` — no Cloud ID needed.

**Key methods:**
- `constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage)`
- `async loadConfig(): Promise<JiraConfig | null>` — reads `.switchboard/jira-config.json`
- `async getApiToken(): Promise<string | null>` — reads SecretStorage
- `private async httpRequest(method, path, query?, body?)` — makes authenticated REST call
- `async makeApiRequest(method, endpoint, query?, body?): Promise<any>` — public proxy entry point
- `async getIssue(keyOrId: string): Promise<JiraIssue | null>` — `GET /issue/{key}?fields=...`
- `async queryIssues(opts: { jql?: string; search?: string; startAt?: number; maxResults?: number }): Promise<{ issues: JiraIssue[]; total: number }>` — `GET /search?jql=project=KEY+ORDER+BY+updated+DESC&startAt=0&maxResults=50`
- `async getSubtasks(issueKey: string): Promise<JiraIssue[]>` — reads `fields.subtasks` from issue detail
- `async getComments(issueKey: string): Promise<JiraComment[]>` — `GET /issue/{key}/comment`
- `async postManagedComment(issueKey: string, body: string): Promise<{ success: boolean; error?: string }>` — `POST /issue/{key}/comment` with ADF body
- `async resolveNameToId(name: string): Promise<string | null>` — check if key pattern (ENG-42), else JQL title search
- `private adfToMarkdown(adfDoc: any): string` — recursive ADF node → markdown text converter

**ADF to markdown (minimal):**
```typescript
function adfToMarkdown(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'paragraph') return (node.content || []).map(adfToMarkdown).join('') + '\n\n';
  if (node.type === 'heading') return '#'.repeat(node.attrs?.level || 1) + ' ' + (node.content || []).map(adfToMarkdown).join('') + '\n';
  if (node.type === 'bulletList') return (node.content || []).map((li: any) => '- ' + (li.content || []).map(adfToMarkdown).join('')).join('\n') + '\n';
  if (node.type === 'orderedList') return (node.content || []).map((li: any, i: number) => `${i+1}. ` + (li.content || []).map(adfToMarkdown).join('')).join('\n') + '\n';
  if (node.type === 'codeBlock') return '```\n' + (node.content || []).map(adfToMarkdown).join('') + '\n```\n';
  if (node.type === 'blockquote') return '> ' + (node.content || []).map(adfToMarkdown).join('');
  if (node.type === 'strong') return '**' + (node.content || []).map(adfToMarkdown).join('') + '**';
  if (node.type === 'em') return '*' + (node.content || []).map(adfToMarkdown).join('') + '*';
  if (node.type === 'code') return '`' + (node.content || []).map(adfToMarkdown).join('') + '`';
  if (node.type === 'inlineCard') return node.attrs?.url || '';
  if (node.content) return node.content.map(adfToMarkdown).join('');
  return '';
}
```

**Comment POST body** (Jira requires ADF for v3):
```typescript
const commentBody = {
  body: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: stampMarker(truncateForComment(text, 32000)) }] }]
  }
};
```

**Config path:** `.switchboard/jira-config.json`

---

## Files to Modify

### 2. `src/services/LocalApiServer.ts`

**a. `LocalApiServerOptions` interface** — add two fields:
```typescript
jiraMetadataPath: string;
getJiraService: () => JiraSyncService | null;
```

**b. `_handleRequest()` routing** (lines ~763-798) — add new routes:
```typescript
else if (pathname === '/metadata/jira' && req.method === 'GET') {
    await this._handleGetMetadata('jira', res);
}
else if (jiraTaskMatch && req.method === 'GET') {   // /task/jira/{issueKey}
    await this._handleGetTask('jira', jiraTaskMatch[1], res);
}
else if (pathname === '/api/jira' && req.method === 'POST') {
    await this._handleJiraApiProxy(req, res);
}
```

**c. `_handleGetTask()` dispatch** — add `else if (sourceId === 'jira')` branch following Linear pattern (getIssue + getSubtasks + getComments with soft error handling).

**d. `_handlePostComment()` validation** — change the provider check from:
```typescript
if ((provider !== 'linear' && provider !== 'clickup') || !id || !text.trim())
```
to:
```typescript
if (!['linear', 'clickup', 'jira'].includes(provider) || !id || !text.trim())
```
Add Jira branch in service selection:
```typescript
const service = provider === 'linear'
    ? this._options.getLinearService()
    : provider === 'jira'
        ? this._options.getJiraService()
        : this._options.getClickUpService();
```

**e. New `_handleJiraApiProxy()` method** — copy ClickUp pattern exactly:
```typescript
private async _handleJiraApiProxy(req, res): Promise<void> {
    if (!await this._checkAuth(req, false)) { /* 401 */ return; }
    const service = this._options.getJiraService();
    if (!service) { /* 503 */ return; }
    const body = await this._parseJsonBody(req);
    const { method, endpoint, query, body: apiBody } = body || {};
    if (!method || !endpoint) { /* 400 */ return; }
    const result = await service.makeApiRequest(method, endpoint, query, apiBody);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
}
```

**f. `_getMetadataFilePath()` or equivalent** — wherever the metadata path is resolved per provider, add `'jira'` → `this._options.jiraMetadataPath`.

---

### 3. `src/services/PlanningPanelProvider.ts`

**a. `PlanningPanelAdapterFactories` interface** (line 35) — add:
```typescript
getJiraSyncService: (root: string) => any;
```

**b. Three `integrationProviderStates` postMessage calls** (lines ~1678, ~1771, ~1797) — extend each to load Jira config and include `jiraSetupComplete`:

```typescript
const [clickUpConfig, linearConfig, jiraConfig] = await Promise.all([
    this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
    this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig(),
    this._adapterFactories.getJiraSyncService(workspaceRoot).loadConfig(),
]);
const clickupSetupComplete = clickUpConfig?.setupComplete === true;
const linearSetupComplete = linearConfig?.setupComplete === true;
const jiraSetupComplete = jiraConfig?.setupComplete === true;
// ...
this._panel?.webview.postMessage({
    type: 'integrationProviderStates',
    clickupSetupComplete,
    linearSetupComplete,
    jiraSetupComplete,   // ← new
    provider,
    ticketsAutoSync
});
```

**c. `activeProvider` resolution** — wherever the active provider is determined from configs, extend to include Jira as a candidate.

---

### 4. `src/webview/planning.html`

Add Jira option to the provider selector (line ~3784):
```html
<select id="tickets-provider-selector" class="workspace-filter-select" style="display:none; margin-left: 0;">
    <option value="clickup">ClickUp</option>
    <option value="linear">Linear</option>
    <option value="jira">Jira</option>   <!-- add this -->
</select>
```

---

### 5. `src/webview/planning.js`

**a. State variables** (alongside existing provider vars, ~line 287):
```javascript
let jiraIssues = [];
let selectedJiraIssue = null;
let jiraProjectStatus = 'idle';
let jiraProjectMessage = '';
let jiraProjectSearchValue = '';
let jiraStatusFilterValue = '';
let jiraCurrentPage = 0;
let jiraHasMore = false;
let jiraLoadedOnce = false;
let jiraLoading = false;
```

**b. `integrationProviderStates` handler** (line ~4957) — extend provider-selector show logic:
```javascript
const clickupSetup = msg.clickupSetupComplete === true;
const linearSetup = msg.linearSetupComplete === true;
const jiraSetup = msg.jiraSetupComplete === true;
const setupCount = [clickupSetup, linearSetup, jiraSetup].filter(Boolean).length;

if (setupCount >= 2) {
    if (providerSelector) providerSelector.style.display = '';
} else {
    if (providerSelector) providerSelector.style.display = 'none';
}
// Set active provider if not already set
if (!lastIntegrationProvider) {
    lastIntegrationProvider = msg.provider || (jiraSetup ? 'jira' : null);
}
```

**c. `renderTicketsTab()`** (line ~7530) — add Jira branch:
```javascript
function renderTicketsTab() {
    if (!isTicketsTabActive()) return;
    if (lastIntegrationProvider === 'linear') {
        renderTicketsLinearPanel();
    } else if (lastIntegrationProvider === 'clickup') {
        renderTicketsClickUpPanel();
    } else if (lastIntegrationProvider === 'jira') {
        renderTicketsJiraPanel();    // ← new
    } else {
        // disable create button
    }
}
```

**d. New functions** — add after the Linear panel functions (~line 7850):

- `renderTicketsJiraPanel()` — mirrors `renderTicketsLinearPanel()`:
  - Project key display (read from jira-config.json via backend, or show raw key)
  - Search input bound to `jiraProjectSearchValue`
  - Status filter dropdown
  - Calls `renderTicketsJiraList()`
  - Load trigger if `!jiraLoadedOnce`

- `renderTicketsJiraList()` — mirrors `renderTicketsLinearList()`:
  - Renders `.ticket-node` cards for each `JiraIssue`
  - Card shows: `issue.key` (identifier badge), `issue.title`, `issue.status.name`, `issue.assignee?.displayName`
  - Click → `selectedJiraIssue = issue; renderTicketsJiraIssueDetail()`

- `renderTicketsJiraIssueDetail()` — mirrors `renderTicketsLinearIssueDetail()`:
  - Title, status badge, assignee, labels, created date
  - Description (markdown from ADF conversion — already done in service)
  - Subtasks list
  - Comments thread
  - "Post comment" textarea + button → calls `/comment` endpoint with `provider: 'jira'`
  - Link out to `issue.url`

- `loadJiraIssues(opts?)` — fetches `GET /metadata/jira` (local cached) or `GET /task/jira/search?jql=...` (remote):
  - Sets `jiraLoading`, updates status, calls `renderTicketsJiraPanel()` on completion

**e. `resetTicketsInMemoryState()`** — add Jira vars to reset list.

**f. `saveTicketsState()` / restore** — add `jiraStatusFilterValue`, `jiraProjectSearchValue` to persisted state.

---

### 6. `src/extension.ts` (or adapter factory file)

Wherever `LocalApiServer` is constructed, add:
```typescript
jiraMetadataPath: path.join(workspaceRoot, '.switchboard', 'jira-metadata.json'),
getJiraService: () => jiraSyncServiceMap.get(workspaceRoot) ?? null,
```

Wherever `PlanningPanelAdapterFactories` is implemented:
```typescript
getJiraSyncService: (root: string) => {
    if (!jiraSyncServiceMap.has(root)) {
        jiraSyncServiceMap.set(root, new JiraSyncService(root, context.secrets));
    }
    return jiraSyncServiceMap.get(root)!;
}
```

---

## Implementation Order

1. **`JiraSyncService.ts`** — standalone, no dependencies on other changes. Write and unit-test HTTP calls manually.
2. **`LocalApiServer.ts`** — add interface fields and routes. Depends on JiraSyncService types.
3. **`extension.ts` / factory wiring** — wire service into LocalApiServer and adapterFactories.
4. **`PlanningPanelProvider.ts`** — add `jiraSetupComplete` to messages. Depends on factory wiring.
5. **`planning.html`** — add option to selector. Trivial, no dependencies.
6. **`planning.js`** — add state vars, handler extension, new render functions. Depends on all backend being wired.

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| ADF conversion misses node types | Medium | Fallback: return raw text content via `node.text` traversal; never show `[object Object]` |
| Basic auth deprecated by Atlassian | Low | Atlassian has committed to API token + Basic auth for Cloud; PAT is the same pattern |
| Provider selector logic breaks when 3 providers partially configured | Medium | `setupCount >= 2` logic is simple and tested; existing binary logic is replaced not extended |
| `PlanningPanelProvider.ts` has 3 call sites sending `integrationProviderStates` | Medium | All three are identical in structure — grep confirms. Must update all three or state is inconsistent |
| Jira `description` field is null for issues without description | Low | Null-guard in `adfToMarkdown`, return empty string |

---

## Testing Checklist

- [ ] Jira not configured: selector hidden, tab create button disabled as before
- [ ] Only Jira configured: selector hidden, Jira panel shows automatically
- [ ] Jira + one other configured: selector shown with all active options
- [ ] All three configured: selector shows all three options, switching works
- [ ] Issue list loads and renders correctly (key badge, title, status, assignee)
- [ ] Issue detail shows description (ADF converted), subtasks, comments
- [ ] Post comment succeeds and comment appears on refresh
- [ ] Search and status filter work
- [ ] Existing ClickUp and Linear sessions unaffected after change
- [ ] State persists across panel close/reopen (search value, selected issue)
