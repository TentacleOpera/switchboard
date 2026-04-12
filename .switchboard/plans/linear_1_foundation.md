# Linear Integration — Part 1: GraphQL Foundation & Token Management

## Goal

Create `LinearSyncService` with a GraphQL client, secure token storage via VS Code SecretStorage, and config schema. Mirrors `ClickUpSyncService` structure. Produces no user-visible features — lays the plumbing for Parts 2–4.

## Metadata

**Tags:** backend, infrastructure
**Complexity:** 5

## User Review Required

> [!NOTE]
> - **MCP tools vs extension**: The `mcp4_*` Linear tools are available to AI agents (like Cascade) but NOT to the VS Code extension runtime. The extension must make direct GraphQL calls to `https://api.linear.app/graphql`. The MCP tools are useful for Cascade to manage Linear directly, but this service is needed for automated sync within the extension.
> - **Linear API token**: Personal API keys start with `lin_api_`. After this plan lands, users run "Switchboard: Set Linear API Token" to store theirs securely.
> - **No UI yet**: Setup button and sync behaviour come in Parts 2–3.

## Complexity Audit

### Routine
- Config file schema — `.switchboard/linear-config.json`, same I/O pattern as `clickup-config.json`
- SecretStorage token — same pattern as `switchboard.clickup.apiToken`
- Utility methods (`delay`, `retry`, `chunkArray`) — identical to `ClickUpSyncService`

### Complex / Risky
- **`graphqlRequest()` method**: Unlike ClickUp's REST, Linear uses a single `POST /graphql` endpoint. Every request — queries and mutations — is a POST with a JSON body `{ query, variables }`. Errors return HTTP 200 with an `errors` array. The method must check BOTH HTTP status AND `response.errors`.

## Edge-Case & Dependency Audit

- **GraphQL errors vs HTTP errors**: Linear returns 200 even on auth failure — response body contains `{ errors: [{ message: "..."}] }`. `graphqlRequest()` must throw if `errors` is non-empty.
- **Missing token**: `getApiToken()` returns `null` → `graphqlRequest()` throws → callers handle gracefully.
- **Config dir missing**: `saveConfig()` creates `.switchboard/` with `mkdir -p`.
- **Corrupted config JSON**: `loadConfig()` returns `null`.

### Cross-Plan Conflict Analysis
- **Parts 2, 3, and Import** all depend on this plan — they consume `LinearSyncService`, `CANONICAL_COLUMNS`, and the token command registered here.
- **No conflict with ClickUp plans** (`clickup_1/2/3`) — parallel integration touching entirely different files (`ClickUpSyncService.ts`, `clickup-config.json`).
- **No conflict with Notion plans** (`notion_1/2/3`) — different service pattern, no shared files.
- **`extension.ts` is modified by both this plan AND ClickUp plans** — imports and command registrations are additive (different command IDs, different import paths). No conflict as long as additions are placed separately from each other.

## Proposed Changes

<!-- Complexity: Complex -->
### Target File 1: LinearSyncService — Foundation
#### CREATE `src/services/LinearSyncService.ts`

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

export interface LinearConfig {
  teamId: string;
  teamName: string;
  projectId?: string;               // optional — scope import/sync to one project
  columnToStateId: Record<string, string>; // Switchboard column → Linear state UUID
  switchboardLabelId: string;       // UUID of the "switchboard" label in the team
  setupComplete: boolean;
  lastSync: string | null;
}

// Canonical Switchboard kanban columns (mirrors KanbanDatabase.ts VALID_KANBAN_COLUMNS)
export const CANONICAL_COLUMNS = [
  'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'LEAD CODED',
  'CODER CODED', 'CODED', 'CODE REVIEWED', 'COMPLETED'
];

const LINEAR_API_HOST = 'api.linear.app';
const LINEAR_API_PATH = '/graphql';

export class LinearSyncService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _syncMapPath: string;      // sessionId → Linear issueId mapping
  private _config: LinearConfig | null = null;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress = false;
  private _isSyncInProgress = false;
  private _consecutiveFailures = 0;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly _maxRetries = 3;

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'linear-config.json');
    this._syncMapPath = path.join(workspaceRoot, '.switchboard', 'linear-sync.json');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ───────────────────────────────────────────────

  async loadConfig(): Promise<LinearConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      this._config = JSON.parse(content);
      return this._config;
    } catch { return null; }
  }

  async saveConfig(config: LinearConfig): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
    this._config = config;
  }

  // ── Local Sync Map (sessionId → Linear issueId) ──────────────
  // Stored locally to avoid tag/label search on every card move.

  async loadSyncMap(): Promise<Record<string, string>> {
    try {
      const content = await fs.promises.readFile(this._syncMapPath, 'utf8');
      return JSON.parse(content);
    } catch { return {}; }
  }

  async saveSyncMap(map: Record<string, string>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._syncMapPath), { recursive: true });
    await fs.promises.writeFile(this._syncMapPath, JSON.stringify(map, null, 2));
  }

  async getIssueIdForPlan(sessionId: string): Promise<string | null> {
    const map = await this.loadSyncMap();
    return map[sessionId] || null;
  }

  async setIssueIdForPlan(sessionId: string, issueId: string): Promise<void> {
    const map = await this.loadSyncMap();
    map[sessionId] = issueId;
    await this.saveSyncMap(map);
  }

  // ── Token Management ─────────────────────────────────────────

  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.linear.apiToken') || null;
    } catch { return null; }
  }

  // ── GraphQL Client ───────────────────────────────────────────

  /**
   * Authenticated GraphQL request to Linear API.
   * Linear always returns HTTP 200; errors are in response.errors.
   * Throws if HTTP status != 200 OR if response.errors is non-empty.
   */
  async graphqlRequest(
    query: string,
    variables?: Record<string, unknown>,
    timeoutMs = 10000
  ): Promise<{ data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('Linear API token not configured'); }

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ query, variables });
      const req = https.request({
        hostname: LINEAR_API_HOST,
        path: LINEAR_API_PATH,
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Linear API HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.errors?.length) {
              return reject(new Error(`Linear GraphQL error: ${parsed.errors[0].message}`));
            }
            resolve({ data: parsed.data });
          } catch {
            reject(new Error('Failed to parse Linear API response'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Linear request timed out')); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // ── Availability Check ───────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      await this.graphqlRequest('{ viewer { id } }', undefined, 2000);
      return true;
    } catch { return false; }
  }

  // ── Utilities ────────────────────────────────────────────────

  get setupInProgress() { return this._setupInProgress; }
  set setupInProgress(v) { this._setupInProgress = v; }
  get isSyncInProgress() { return this._isSyncInProgress; }
  set isSyncInProgress(v) { this._isSyncInProgress = v; }
  get consecutiveFailures(): number { return this._consecutiveFailures; }
  set consecutiveFailures(v: number) { this._consecutiveFailures = v; }
  get debounceTimers() { return this._debounceTimers; }
  get configPath() { return this._configPath; }
  get workspaceRoot() { return this._workspaceRoot; }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) { chunks.push(array.slice(i, i + size)); }
    return chunks;
  }

  async retry<T>(fn: () => Promise<T>, retries = this._maxRetries): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (error) {
        if (i === retries - 1) { throw error; }
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── Debounced Sync (timer management for Part 3) ────────────

  /**
   * Debounce wrapper for plan sync on card move.
   * Timer management is a foundation concern; syncPlan() is added in Part 3.
   */
  debouncedSync(sessionId: string, plan: any, column: string): void {
    const existing = this._debounceTimers.get(sessionId);
    if (existing) { clearTimeout(existing); }
    this._debounceTimers.set(sessionId, setTimeout(async () => {
      this._debounceTimers.delete(sessionId);
      try {
        await this.syncPlan(plan, column); // syncPlan() added in Part 3
      } catch {
        this._consecutiveFailures++;
      }
    }, 500));
  }
}
```

<!-- Complexity: Routine -->
### Target File 2: Token Storage Command
#### MODIFY `src/extension.ts`

Add the following import at the top of `extension.ts` (near the existing ClickUp import at line 15):

```typescript
import { LinearSyncService } from './services/LinearSyncService';
```

Add alongside existing ClickUp command registration:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand('switchboard.setLinearToken', async () => {
    const token = await vscode.window.showInputBox({
      prompt: 'Enter your Linear API token (starts with lin_api_)',
      password: true,
      placeHolder: 'lin_api_...',
      ignoreFocusOut: true,
      validateInput: (v) => (!v || v.trim().length < 10) ? 'Token appears too short' : null
    });
    if (token) {
      await context.secrets.store('switchboard.linear.apiToken', token.trim());
      vscode.window.showInformationMessage('Linear API token saved securely.');
    }
  })
);
```

<!-- Complexity: Routine -->
### Target File 3: Command Registration
#### MODIFY `package.json`

```json
{
  "command": "switchboard.setLinearToken",
  "title": "Set Linear API Token",
  "category": "Switchboard"
}
```

<!-- Complexity: Routine -->
### Target File 4: Gitignore
#### MODIFY `.gitignore`

```
# Linear integration config (workspace-specific IDs and sync map)
.switchboard/linear-config.json
.switchboard/linear-sync.json
```

## Verification Plan

- `graphqlRequest` with mock HTTPS: verify 200 + `errors` array throws; verify 200 + valid data resolves
- `isAvailable()`: mock `{ viewer: { id: '...' } }` → true; mock network error → false; missing token → false
- Config round-trip: write → read → verify fidelity; corrupted JSON → null
- Sync map: `setIssueIdForPlan` + `getIssueIdForPlan` round-trip

## Adversarial Synthesis

### Grumpy Critique

1. **Missing `debouncedSync()` method**: ClickUpSyncService has `debouncedSync()` (line 510) which is called by the KanbanProvider card move hook. Plan 3 (`linear_3_sync_on_move.md`) refers to debouncing but this foundation plan originally didn't include `debouncedSync()`. Without it, Part 3 would either need to add it (wrong — foundation concern) or skip debouncing (rapid moves fire multiple API calls).

2. **Missing `consecutiveFailures` counter**: ClickUp has `_consecutiveFailures` (line 52) with getter (line 164), incremented on sync failure, reset on success, checked in the KanbanProvider hook to show degraded state. The Linear plan had `_isSyncInProgress` but no failure counter. Part 3 needs this to show the degraded indicator.

3. **No `import` statement shown for `extension.ts`**: The plan modifies `extension.ts` to add a command, but originally didn't show `import { LinearSyncService } from './services/LinearSyncService';` at the top. Without it, TypeScript won't compile. ClickUp's import is at line 15 of `extension.ts`.

4. **`CANONICAL_COLUMNS` exported but unused in Part 1**: The constant is defined for Part 2's use, which is fine for a foundation plan. But if Part 2 changes the column list, this creates a coupling. (Low risk — just noting.)

### Balanced Response

1. **`debouncedSync()`** — ✅ Fixed. A stub `debouncedSync()` method has been added to the foundation class with the same signature as ClickUp's. Timer management and the 500ms debounce window are foundation concerns. `syncPlan()` (the actual sync logic) is Part 3's responsibility and will be added there.

2. **`consecutiveFailures`** — ✅ Fixed. Added `private _consecutiveFailures = 0;` with a getter and setter, matching the ClickUp pattern exactly. Part 3 will increment on failure and reset on success.

3. **Import statement** — ✅ Fixed. An explicit import line is now shown in the Target File 2 section: `import { LinearSyncService } from './services/LinearSyncService';`.

4. **`CANONICAL_COLUMNS`** — Acceptable coupling. The column list is a shared constant mirroring `KanbanDatabase.ts VALID_KANBAN_COLUMNS` and is unlikely to change. If it does, the single-source-of-truth update in `KanbanDatabase.ts` would trigger updates in all integration plans equally.

## Files to Modify

1. `src/services/LinearSyncService.ts` — CREATE
2. `src/extension.ts` — MODIFY (register token command)
3. `package.json` — MODIFY (add command)
4. `.gitignore` — MODIFY (add config and sync map exclusions)

## Agent Recommendation

**Send to Coder** — Complexity 5. Mirrors `ClickUpSyncService` pattern exactly with one structural change (GraphQL vs REST). The only novel piece is the `graphqlRequest()` error-handling logic.

## Implementation Review (2026-04-09)

### Stage 1: Grumpy Principal Engineer

**Verdict: CLEAN.** I went hunting for blood and came back mostly empty-handed. Annoying.

1. **NIT — Token prompt text differs from plan**: Plan says `'Enter your Linear API token (starts with lin_api_)'`; implementation says `'Enter your Linear API token'`. The `(starts with lin_api_)` hint is helpful for users. Marginal, but why remove helpful UX copy?

2. **NIT — `CANONICAL_COLUMNS` re-export**: Implementation imports `CANONICAL_COLUMNS` from `ClickUpSyncService` and re-exports it (`export { CANONICAL_COLUMNS }`). Plan 1 defined its own local `CANONICAL_COLUMNS` constant. The re-export approach is arguably better (single source of truth), but creates a coupling between Linear and ClickUp services. If ClickUp is ever removed, Linear breaks. Acceptable tradeoff for now.

3. **NIT — `debouncedSync` resets `_consecutiveFailures` on success**: The plan's code stub didn't include `this._consecutiveFailures = 0;` in the success path — implementation (line 337) correctly adds it. This is an improvement over the plan.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|:--------|:---------|:-------|
| Token prompt text | NIT | Defer — cosmetic only |
| CANONICAL_COLUMNS re-export coupling | NIT | Defer — shared constant is correct |
| consecutiveFailures reset on success | NIT (improvement) | ✅ Already correct in code |

**No code changes required.** All plan requirements are satisfied.

### Validation Results

- `npx tsc --noEmit`: ✅ Pass (only pre-existing ArchiveManager error)
- `npm run compile`: ✅ webpack compiled successfully
- All 4 target files verified present and correct:
  - `src/services/LinearSyncService.ts` — ✅ Created with all required methods
  - `src/extension.ts` — ✅ `setLinearToken` command registered (line 1415)
  - `package.json` — ✅ Command entry present (line 127)
  - `.gitignore` — ✅ Exclusions present (lines 48-49)

### Remaining Risks

- None. Implementation faithfully follows plan.
