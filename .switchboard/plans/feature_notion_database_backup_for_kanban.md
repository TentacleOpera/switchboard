# Feature: Notion Database Backup for kanban.db

## Goal
Add a Notion database backup option in the Database tab of setup.html to allow users to back up their kanban.db SQLite database to a Notion database, providing cloud-based backup and restore functionality for plan metadata.

## Metadata
- **Tags:** backend, database, devops, infrastructure, UI, reliability
- **Complexity:** 8

## User Review Required
- Confirm placement of Notion Database Backup UI in the Database tab vs. Integrations tab
- Approve conflict-resolution strategy: restore resurrects deleted local plans by default, with timestamp-gated skip option
- Confirm acceptable backup duration for ~100 plans (~35s due to Notion rate limits) — progress notification UX

## Complexity Audit

### Routine
- UI markup addition in setup.html (follows existing `db-subsection` pattern)
- Event listener wiring in setup.html JavaScript
- package.json settings schema addition
- Config I/O (load/save JSON) following NotionFetchService pattern

### Complex / Risky
- Notion database API operations (query database, create/update pages) — new API surface beyond existing page/block fetching
- Schema mapping between SQLite columns and Notion property types with bidirectional conversion
- Auto-create database: requires parent page selection, Notion property type constraints, and handling of duplicate database creation
- Rate-limiting arithmetic: ~3 req/sec means 100 plans ≈ 35s minimum; UI must show progress without blocking indefinitely
- Conflict resolution: timestamp comparison between local `updated_at` and Notion page `last_edited_time`; deleted-plan resurrection policy
- Partial failure handling: backup stopping at plan 50 of 100 must not update `lastBackupAt`; config state must remain consistent
- KanbanDatabase interface mismatch: `upsertPlan()` does not exist, only `upsertPlans(records[])` — requires adding singular wrapper or batching restore

## Edge-Case & Dependency Audit

- **Race Conditions:** Two IDE instances backing up to the same Notion database simultaneously will create duplicate pages (Notion does not enforce unique constraints on custom properties). Mitigation: Notion page lookup by Plan ID via query filter before create/update.
- **Security:** Database URL and ID stored in plaintext `.switchboard/notion-backup-config.json`. Acceptable — the database ID is discoverable from the URL. API token already in secretStorage (`switchboard.notion.apiToken`).
- **Side Effects:** Restore operation mutates kanban.db directly via `upsertPlans()`. If restore fails partway, some plans are already written. Mitigation: wrap restore in a single `upsertPlans()` batch after collecting all valid records in memory.
- **Dependencies & Conflicts:**
  - Reuses `NotionFetchService.httpRequest()` for all Notion API calls — no new HTTP client
  - Reuses `switchboard.notion.apiToken` from secretStorage — no new token flow
  - Depends on KanbanDatabase `getAllPlans(workspaceId)` — takes workspace ID hash, NOT workspace root path. Must call `getWorkspaceId()` first.
- `upsertPlans()` on conflict does NOT update `kanban_column` (intentional SQL design). Restore must use `updateColumn()` separately for column changes.
- `upsertPlans()` on conflict DOES update `plan_file`, `brain_source_path`, `mirror_path`. Restore must NOT pass empty strings for these fields on existing plans — must preserve local values.
  - Notion API `2022-06-28` version header required (already set in NotionFetchService)

## Dependencies
- `sess_XXXXXXXXXXXXX — NotionFetchService token storage and HTTP client patterns` (existing)
- `sess_XXXXXXXXXXXXX — KanbanDatabase schema and query interfaces` (existing)
- `sess_XXXXXXXXXXXXX — SetupPanelProvider message routing conventions` (existing)

## Adversarial Synthesis

Key risks: (1) `getAllPlans()` takes `workspaceId` (a hash), not `workspaceRoot` (a path) — calling it with a path returns zero plans silently; (2) `upsertPlans()` on conflict does NOT update `kanban_column`, so restore cannot sync column changes from Notion; (3) restore sets `planFile`, `brainSourcePath`, `mirrorPath` to empty strings, and the upsert SQL DOES update these on conflict — this overwrites local file paths with empty strings, severing the plan-to-file link; (4) `validateDatabaseAccess()` is mentioned in steps but missing from the code block, and the handler still uses broken private-field access; (5) per-plan progress reporting is claimed but never implemented — `backupToNotion()` returns only a final result. Mitigations: resolve workspace ID via `getWorkspaceId()` before calling `getAllPlans()`, merge strategy for restore that preserves local path fields, use `updateColumn()` for kanban column changes after upsert, add `validateDatabaseAccess()` public method, implement incremental progress via `Progress.report()`.

## Proposed Changes

### src/services/NotionBackupService.ts (new file)

**Context:** New service that wraps Notion database API operations for kanban.db backup/restore. Reuses NotionFetchService for HTTP and token management.

**Implementation:**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';                    // MISSING in original plan — added
import { NotionFetchService } from './NotionFetchService';
import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';

export interface NotionBackupConfig {
  databaseUrl: string;
  databaseId: string;
  databaseTitle: string;
  lastBackupAt: string | null;
  lastRestoreAt: string | null;
}

export class NotionBackupService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _notionFetchService: NotionFetchService;

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'notion-backup-config.json');
    this._notionFetchService = new NotionFetchService(workspaceRoot, secretStorage);
  }

  async loadConfig(): Promise<NotionBackupConfig | null> {
    try {
      const content = await fs.promises.readFile(this._configPath, 'utf8');
      return JSON.parse(content);
    } catch { return null; }
  }

  async saveConfig(config: NotionBackupConfig): Promise<void> {
    await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
    await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Parse database ID from Notion URL.
   * Reuses NotionFetchService.parsePageId logic — databases share the same UUID-in-URL pattern.
   */
  parseDatabaseId(url: string): string | null {
    return this._notionFetchService.parsePageId(url);
  }

  /**
   * Backup all plans from kanban.db to Notion database.
   * Shows VS Code progress notification. Updates config only on full success.
   */
  async backupToNotion(workspaceRoot: string, progress?: vscode.Progress<{ message?: string }>): Promise<{ success: boolean; backedUp: number; total: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.databaseId) {
      return { success: false, backedUp: 0, total: 0, error: 'Notion database not configured' };
    }

    const kanbanDb = KanbanDatabase.forWorkspace(workspaceRoot);
    await kanbanDb.ensureReady();
    // CRITICAL: getAllPlans() takes workspaceId (a hash), not workspaceRoot (a path)
    const workspaceId = await kanbanDb.getWorkspaceId();
    if (!workspaceId) {
      return { success: false, backedUp: 0, total: 0, error: 'Workspace ID not found in database' };
    }
    const allPlans = await kanbanDb.getAllPlans(workspaceId);

    let backedUp = 0;
    const total = allPlans.length;

    for (let i = 0; i < allPlans.length; i++) {
      const plan = allPlans[i];
      progress?.report({ message: `Backing up plan ${i + 1} of ${total}...` });
      const result = await this._upsertPlanToNotion(config.databaseId, plan);
      if (result.success) backedUp++;
      // 350ms delay between requests to respect ~3 req/sec Notion rate limit
      if (total > 1) await this._delay(350);
    }

    const success = backedUp === total;
    if (success) {
      config.lastBackupAt = new Date().toISOString();
      await this.saveConfig(config);
    }

    return { success, backedUp, total, error: success ? undefined : `Backed up ${backedUp}/${total} plans` };
  }

  /**
   * Restore plans from Notion database to kanban.db.
   * Uses timestamp comparison: skip local plans with newer updated_at.
   * Collects all valid records first, then batch-upserts to avoid partial DB writes.
   */
  async restoreFromNotion(workspaceRoot: string, progress?: vscode.Progress<{ message?: string }>): Promise<{ success: boolean; restored: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.databaseId) {
      return { success: false, restored: 0, skipped: 0, error: 'Notion database not configured' };
    }

    const notionPages = await this._queryDatabasePages(config.databaseId);

    const kanbanDb = KanbanDatabase.forWorkspace(workspaceRoot);
    await kanbanDb.ensureReady();

    // CRITICAL: getAllPlans() takes workspaceId (a hash), not workspaceRoot (a path)
    const workspaceId = await kanbanDb.getWorkspaceId();
    if (!workspaceId) {
      return { success: false, restored: 0, skipped: 0, error: 'Workspace ID not found in database' };
    }

    // Pre-load all local plans for fast timestamp comparison
    const localPlans = await kanbanDb.getAllPlans(workspaceId);
    const localByPlanId = new Map(localPlans.map(p => [p.planId, p]));

    const toRestore: KanbanPlanRecord[] = [];
    const columnUpdates: Array<{ sessionId: string; column: string }> = [];
    let skipped = 0;

    for (let i = 0; i < notionPages.length; i++) {
      const page = notionPages[i];
      progress?.report({ message: `Restoring plan ${i + 1} of ${notionPages.length}...` });
      const plan = this._notionPageToPlanRecord(page);
      if (!plan) continue;

      const local = localByPlanId.get(plan.planId);
      if (local) {
        // Timestamp comparison: skip if local is newer
        if (local.updatedAt > plan.updatedAt) {
          skipped++;
          continue;
        }
        // CRITICAL: Preserve local path fields — Notion doesn't store filesystem paths.
        // Overwriting planFile/brainSourcePath/mirrorPath with '' would sever the plan-to-file link.
        plan.planFile = local.planFile;
        plan.brainSourcePath = local.brainSourcePath;
        plan.mirrorPath = local.mirrorPath;
        // Preserve dispatch fields — Notion doesn't track these either
        plan.routedTo = local.routedTo;
        plan.dispatchedAgent = local.dispatchedAgent;
        plan.dispatchedIde = local.dispatchedIde;
      }
      toRestore.push(plan);
      // Track column changes for separate updateColumn() calls
      // (upsertPlans() on conflict does NOT update kanban_column)
      if (local && local.kanbanColumn !== plan.kanbanColumn) {
        columnUpdates.push({ sessionId: plan.sessionId, column: plan.kanbanColumn });
      }
    }

    // Batch upsert to avoid partial DB mutations on failure
    await kanbanDb.upsertPlans(toRestore);

    // Apply column changes separately (upsertPlans skips kanban_column on conflict)
    for (const { sessionId, column } of columnUpdates) {
      await kanbanDb.updateColumn(sessionId, column);
    }

    config.lastRestoreAt = new Date().toISOString();
    await this.saveConfig(config);

    return { success: true, restored: toRestore.length, skipped };
  }

  /**
   * Auto-create a Notion database with schema matching kanban.db.
   * Defaults to the existing configured Notion design-doc page as parent.
   */
  async autoCreateDatabase(): Promise<{ success: boolean; databaseUrl?: string; error?: string }> {
    const notionConfig = await this._notionFetchService.loadConfig();
    const parentPageId = notionConfig?.pageId;
    if (!parentPageId) {
      return { success: false, error: 'No Notion page configured. Set up Notion integration in the Integrations tab first.' };
    }

    const payload = {
      parent: { page_id: parentPageId },
      title: [{ type: 'text', text: { content: 'Switchboard Kanban Backup' } }],
      properties: {
        'Topic': { title: {} },                              // Title property = display name
        'Plan ID': { rich_text: {} },
        'Session ID': { rich_text: {} },
        'Kanban Column': { select: { options: [
          { name: 'CREATED', color: 'gray' },
          { name: 'BACKLOG', color: 'brown' },
          { name: 'PLAN REVIEWED', color: 'blue' },
          { name: 'CONTEXT GATHERER', color: 'purple' },
          { name: 'LEAD CODED', color: 'green' },
          { name: 'CODER CODED', color: 'yellow' },
          { name: 'CODE REVIEWED', color: 'pink' },
          { name: 'CODED', color: 'orange' },
          { name: 'COMPLETED', color: 'default' }
        ]}},
        'Status': { select: { options: [
          { name: 'active', color: 'green' },
          { name: 'archived', color: 'gray' },
          { name: 'completed', color: 'blue' },
          { name: 'deleted', color: 'red' }
        ]}},
        'Complexity': { number: { format: 'number' } },
        'Tags': { multi_select: {} },
        'Dependencies': { rich_text: {} },
        'Repo Scope': { rich_text: {} },
        'Workspace ID': { rich_text: {} },
        'Created At': { date: {} },
        'Updated At': { date: {} },
        'Last Action': { rich_text: {} },
        'Source Type': { select: { options: [
          { name: 'local', color: 'gray' },
          { name: 'brain', color: 'purple' },
          { name: 'clickup-automation', color: 'blue' },
          { name: 'linear-automation', color: 'green' }
        ]}},
        'ClickUp Task ID': { rich_text: {} },
        'Linear Issue ID': { rich_text: {} }
      }
    };

    const result = await this._notionFetchService.httpRequest('POST', '/databases', payload, 15000);
    if (result.status !== 200) {
      return { success: false, error: `Failed to create database (HTTP ${result.status}): ${JSON.stringify(result.data)}` };
    }

    const databaseId = result.data?.id;
    const databaseUrl = result.data?.url || `https://notion.so/database/${databaseId}`;

    await this.saveConfig({
      databaseUrl,
      databaseId,
      databaseTitle: 'Switchboard Kanban Backup',
      lastBackupAt: null,
      lastRestoreAt: null
    });

    return { success: true, databaseUrl };
  }

  /**
   * Validate that the Notion database is accessible with the current token.
   * Used by handleConfigureNotionBackup() before saving config.
   */
  async validateDatabaseAccess(databaseId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await this._notionFetchService.httpRequest('GET', `/databases/${databaseId}`, undefined, 10000);
      if (result.status === 403 || result.status === 401) {
        return { success: false, error: `Database not accessible (HTTP ${result.status}). Ensure your Notion integration has access to this database.` };
      }
      if (result.status !== 200) {
        return { success: false, error: `Database not found or not accessible (HTTP ${result.status}).` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `Validation failed: ${String(err)}` };
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  private async _upsertPlanToNotion(databaseId: string, plan: KanbanPlanRecord): Promise<{ success: boolean; error?: string }> {
    try {
      // Check if page already exists by querying for Plan ID
      const queryResult = await this._notionFetchService.httpRequest('POST', `/databases/${databaseId}/query`, {
        filter: { property: 'Plan ID', rich_text: { equals: plan.planId } }
      }, 10000);

      const existingPages = queryResult.data?.results || [];
      const pageId = existingPages[0]?.id;

      const properties = this._planToNotionProperties(plan);

      if (pageId) {
        // Update existing page
        const updateResult = await this._notionFetchService.httpRequest('PATCH', `/pages/${pageId}`, { properties }, 10000);
        return { success: updateResult.status === 200, error: updateResult.status !== 200 ? `Update failed: HTTP ${updateResult.status}` : undefined };
      } else {
        // Create new page
        const createResult = await this._notionFetchService.httpRequest('POST', '/pages', {
          parent: { database_id: databaseId },
          properties
        }, 10000);
        return { success: createResult.status === 200, error: createResult.status !== 200 ? `Create failed: HTTP ${createResult.status}` : undefined };
      }
    } catch (err: any) {
      return { success: false, error: String(err) };
    }
  }

  private async _queryDatabasePages(databaseId: string): Promise<any[]> {
    const pages: any[] = [];
    let cursor: string | undefined;

    while (true) {
      const result = await this._notionFetchService.httpRequest('POST', `/databases/${databaseId}/query`,
        cursor ? { start_cursor: cursor } : {}, 15000);
      if (result.status !== 200) break;

      pages.push(...(result.data?.results || []));
      if (!result.data?.has_more) break;
      cursor = result.data.next_cursor;
      await this._delay(350);
    }

    return pages;
  }

  private _planToNotionProperties(plan: KanbanPlanRecord): Record<string, any> {
    return {
      'Topic': { title: [{ text: { content: plan.topic || 'Untitled Plan' } }] },
      'Plan ID': { rich_text: [{ text: { content: plan.planId } }] },
      'Session ID': { rich_text: [{ text: { content: plan.sessionId } }] },
      'Kanban Column': { select: { name: plan.kanbanColumn } },
      'Status': { select: { name: plan.status } },
      'Complexity': { number: plan.complexity === 'Unknown' ? null : Number(plan.complexity) },
      'Tags': { multi_select: (plan.tags || '').split(',').filter(Boolean).map((t: string) => ({ name: t.trim() })) },
      'Dependencies': { rich_text: [{ text: { content: plan.dependencies || '' } }] },
      'Repo Scope': { rich_text: [{ text: { content: plan.repoScope || '' } }] },
      'Workspace ID': { rich_text: [{ text: { content: plan.workspaceId } }] },
      'Created At': { date: { start: plan.createdAt } },
      'Updated At': { date: { start: plan.updatedAt } },
      'Last Action': { rich_text: [{ text: { content: plan.lastAction || '' } }] },
      'Source Type': { select: { name: plan.sourceType } },
      'ClickUp Task ID': { rich_text: [{ text: { content: plan.clickupTaskId || '' } }] },
      'Linear Issue ID': { rich_text: [{ text: { content: plan.linearIssueId || '' } }] }
    };
  }

  private _notionPageToPlanRecord(page: any): KanbanPlanRecord | null {
    try {
      const p = page.properties;
      const getText = (propName: string): string => {
        const prop = p?.[propName];
        if (prop?.title?.[0]?.plain_text) return prop.title[0].plain_text;
        if (prop?.rich_text?.[0]?.plain_text) return prop.rich_text[0].plain_text;
        return '';
      };
      const getSelect = (propName: string): string => p?.[propName]?.select?.name || '';
      const getNumber = (propName: string): string => {
        const n = p?.[propName]?.number;
        return n != null ? String(n) : 'Unknown';
      };
      const getDate = (propName: string): string => p?.[propName]?.date?.start || new Date().toISOString();
      const getMultiSelect = (propName: string): string => {
        const options = p?.[propName]?.multi_select || [];
        return options.map((o: any) => o.name).join(',');
      };

      return {
        planId: getText('Plan ID'),
        sessionId: getText('Session ID'),
        topic: getText('Topic'),
        planFile: '',          // Notion doesn't store file paths
        kanbanColumn: getSelect('Kanban Column') || 'CREATED',
        status: (getSelect('Status') as any) || 'active',
        complexity: getNumber('Complexity'),
        tags: getMultiSelect('Tags'),
        dependencies: getText('Dependencies'),
        repoScope: getText('Repo Scope'),
        workspaceId: getText('Workspace ID'),
        createdAt: getDate('Created At'),
        updatedAt: getDate('Updated At'),
        lastAction: getText('Last Action'),
        sourceType: (getSelect('Source Type') as any) || 'local',
        brainSourcePath: '',
        mirrorPath: '',
        routedTo: '',
        dispatchedAgent: '',
        dispatchedIde: '',
        clickupTaskId: getText('ClickUp Task ID'),
        linearIssueId: getText('Linear Issue ID')
      };
    } catch {
      return null;
    }
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

**Edge Cases:**
- `_upsertPlanToNotion` queries by Plan ID before create to prevent duplicates during concurrent backups.
- `_planToNotionProperties` maps `Topic` to Notion's `title` property ( drives page display name ); all other fields are `rich_text` or `select`.
- `Complexity` is stored as a Number property; 'Unknown' maps to `null`.
- `Tags` are split by comma and mapped to `multi_select` options.
- `_notionPageToPlanRecord` returns `planFile: ''` because Notion doesn't store filesystem paths; local path resolution is out of scope for v1.

### src/services/KanbanDatabase.ts

**Context:** The restore loop in `NotionBackupService.restoreFromNotion()` calls `kanbanDb.upsertPlan(plan)`, but `KanbanDatabase` only has `upsertPlans(records: KanbanPlanRecord[])`.

**Implementation (add method at ~line 833):**

```typescript
/**
 * Upsert a single plan record. Convenience wrapper around upsertPlans().
 * Used by NotionBackupService restore flow.
 */
public async upsertPlan(record: KanbanPlanRecord): Promise<boolean> {
    return this.upsertPlans([record]);
}
```

**Edge Cases:** None — delegates to existing `upsertPlans()` which handles transaction wrapping, conflict resolution, and path normalization.

### src/webview/setup.html

**Context:** Database tab (`data-tab-content="database"`) currently has Plan Ingestion, Database Location, and Rebuild Database subsections. Add Notion Database Backup after Rebuild Database.

**Implementation (insert after Rebuild Database `db-subsection`, around line 714):**

```html
<div class="db-subsection">
    <div class="subsection-header">
        <span>Notion Database Backup</span>
        <span id="notion-backup-status" style="margin-left:auto; font-size:9px; color:var(--text-secondary);">Not configured</span>
    </div>
    <div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.4;">
        Backup kanban.db to a Notion database for cloud-based storage and restore. Requires Notion integration token.
    </div>
    <label class="startup-row" style="display:block; margin-top:6px;">
        <span style="display:block; margin-bottom:4px;">Notion Database URL</span>
        <input id="notion-db-url-input" type="text" placeholder="https://notion.so/workspace/..." style="width:100%;">
    </label>
    <div style="font-size:9px; color:var(--text-secondary); margin-top:4px; line-height:1.3;">
        Enter the URL of your Notion database. The database should have properties matching kanban.db schema.
    </div>
    <div style="display:flex; gap:8px; margin-top:8px;">
        <button id="notion-backup-btn" class="db-action-btn" style="flex:1;">BACKUP TO NOTION</button>
        <button id="notion-restore-btn" class="db-action-btn" style="flex:1;">RESTORE FROM NOTION</button>
    </div>
    <button id="notion-auto-setup-btn" class="secondary-btn w-full" style="margin-top:8px;">AUTO-CREATE NOTION DATABASE</button>
    <div id="notion-backup-error" style="min-height:16px; color: var(--accent-red); font-size: 10px; margin-top: 6px;"></div>
    <div id="notion-backup-progress" style="font-size: 10px; color: var(--text-secondary); margin-top: 4px; font-family: var(--font-mono);"></div>
</div>
```

**Edge Cases:** `notion-backup-progress` div added for per-plan progress text (e.g., "Backing up plan 12 of 45...").

### src/webview/setup.html (JavaScript)

**Context:** Add event listeners and message handlers in the setup panel's JS block.

**Implementation (add in the main event listener setup, near other button listeners):**

```javascript
// Notion backup configuration
document.getElementById('notion-db-url-input')?.addEventListener('change', () => {
  const url = document.getElementById('notion-db-url-input')?.value.trim();
  vscode.postMessage({ type: 'configureNotionBackup', databaseUrl: url });
});

document.getElementById('notion-backup-btn')?.addEventListener('click', () => {
  // Disable buttons during operation
  document.getElementById('notion-backup-btn').disabled = true;
  document.getElementById('notion-restore-btn').disabled = true;
  document.getElementById('notion-auto-setup-btn').disabled = true;
  vscode.postMessage({ type: 'backupToNotion' });
});

document.getElementById('notion-restore-btn')?.addEventListener('click', () => {
  document.getElementById('notion-backup-btn').disabled = true;
  document.getElementById('notion-restore-btn').disabled = true;
  document.getElementById('notion-auto-setup-btn').disabled = true;
  vscode.postMessage({ type: 'restoreFromNotion' });
});

document.getElementById('notion-auto-setup-btn')?.addEventListener('click', () => {
  document.getElementById('notion-backup-btn').disabled = true;
  document.getElementById('notion-restore-btn').disabled = true;
  document.getElementById('notion-auto-setup-btn').disabled = true;
  vscode.postMessage({ type: 'autoCreateNotionDatabase' });
});
```

**Implementation (add in the main message handler switch, near other result handlers):**

```javascript
case 'notionBackupConfigResult': {
  const status = data.success ? 'Configured' : 'Not configured';
  const badge = document.getElementById('notion-backup-status');
  if (badge) badge.textContent = status;
  const error = document.getElementById('notion-backup-error');
  if (error && !data.success) error.textContent = data.error || 'Configuration failed';
  break;
}
case 'notionBackupResult': {
  const error = document.getElementById('notion-backup-error');
  const progress = document.getElementById('notion-backup-progress');
  if (data.success) {
    if (error) error.textContent = '';
    if (progress) progress.textContent = `Backed up ${data.backedUp}/${data.total} plans`;
  } else {
    if (error) error.textContent = data.error || 'Backup failed';
    if (progress) progress.textContent = `Partial: ${data.backedUp}/${data.total}`;
  }
  // Re-enable buttons
  document.getElementById('notion-backup-btn').disabled = false;
  document.getElementById('notion-restore-btn').disabled = false;
  document.getElementById('notion-auto-setup-btn').disabled = false;
  break;
}
case 'notionRestoreResult': {
  const error = document.getElementById('notion-backup-error');
  const progress = document.getElementById('notion-backup-progress');
  if (data.success) {
    if (error) error.textContent = '';
    if (progress) progress.textContent = `Restored ${data.restored} plans (${data.skipped} skipped)`;
  } else {
    if (error) error.textContent = data.error || 'Restore failed';
  }
  document.getElementById('notion-backup-btn').disabled = false;
  document.getElementById('notion-restore-btn').disabled = false;
  document.getElementById('notion-auto-setup-btn').disabled = false;
  break;
}
case 'notionAutoCreateResult': {
  const error = document.getElementById('notion-backup-error');
  if (data.success && data.databaseUrl) {
    const input = document.getElementById('notion-db-url-input');
    if (input) input.value = data.databaseUrl;
    if (error) error.textContent = '';
    document.getElementById('notion-backup-status').textContent = 'Configured';
  } else {
    if (error) error.textContent = data.error || 'Auto-create failed';
  }
  document.getElementById('notion-backup-btn').disabled = false;
  document.getElementById('notion-restore-btn').disabled = false;
  document.getElementById('notion-auto-setup-btn').disabled = false;
  break;
}
case 'notionBackupProgress': {
  const progress = document.getElementById('notion-backup-progress');
  if (progress) progress.textContent = `${data.action} plan ${data.current} of ${data.total}...`;
  break;
}
```

**Edge Cases:** Buttons are disabled during operations to prevent duplicate requests. Progress messages are shown in the dedicated progress div.

### src/services/TaskViewerProvider.ts

**Context:** Add NotionBackupService instantiation, message handlers, and integrate with existing `getIntegrationSetupStates()` to include backup config status.

**Implementation (add private field near other service maps, around line 328):**

```typescript
private _notionBackupServices: Map<string, NotionBackupService> = new Map();
```

**Implementation (add private accessor near `_getNotionService`, around line 4143):**

```typescript
private _getNotionBackupService(workspaceRoot: string): NotionBackupService {
  const resolvedRoot = path.resolve(workspaceRoot);
  let service = this._notionBackupServices.get(resolvedRoot);
  if (!service) {
    service = new NotionBackupService(resolvedRoot, this._context.secrets);
    this._notionBackupServices.set(resolvedRoot, service);
  }
  return service;
}
```

**Implementation (update `getIntegrationSetupStates()` around line 3060 to include backup state):**

```typescript
public async getIntegrationSetupStates(workspaceRoot?: string): Promise<{
  clickupSetupComplete: boolean;
  linearSetupComplete: boolean;
  notionSetupComplete: boolean;
  notionBackupSetupComplete: boolean;  // ADDED
  preferredProvider: 'linear' | 'clickup';
  clickupState?: ClickUpSetupState;
  linearState?: LinearSetupState;
  notionState?: NotionSetupState;
  clickupHasToken: boolean;
  linearHasToken: boolean;
  notionHasToken: boolean;
}> {
  // ... existing code ...
  const notionBackupConfig = await this._getNotionBackupService(resolvedRoot).loadConfig();
  // ...
  return {
    // ... existing fields ...
    notionBackupSetupComplete: !!notionBackupConfig?.databaseId,
    // ...
  };
}
```

**Implementation (add handler methods in TaskViewerProvider, near other handle* methods):**

```typescript
public async handleConfigureNotionBackup(databaseUrl: string, workspaceRoot?: string): Promise<{ success: boolean; error?: string }> {
  const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedRoot) return { success: false, error: 'No workspace found' };

  const service = this._getNotionBackupService(resolvedRoot);
  const databaseId = service.parseDatabaseId(databaseUrl);
  if (!databaseId) return { success: false, error: 'Invalid Notion database URL' };

  // Validate database exists and is accessible via public method
  const validation = await service.validateDatabaseAccess(databaseId);
  if (!validation.success) return validation;

  await service.saveConfig({
    databaseUrl,
    databaseId,
    databaseTitle: 'Switchboard Kanban Backup',
    lastBackupAt: null,
    lastRestoreAt: null
  });

  return { success: true };
}

public async handleBackupToNotion(workspaceRoot?: string): Promise<{ success: boolean; backedUp: number; total: number; error?: string }> {
  const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedRoot) return { success: false, backedUp: 0, total: 0, error: 'No workspace found' };

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Backing up to Notion...', cancellable: false },
    async (progress) => this._getNotionBackupService(resolvedRoot).backupToNotion(resolvedRoot, progress)
  );
}

public async handleRestoreFromNotion(workspaceRoot?: string): Promise<{ success: boolean; restored: number; skipped: number; error?: string }> {
  const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedRoot) return { success: false, restored: 0, skipped: 0, error: 'No workspace found' };

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Restoring from Notion...', cancellable: false },
    async (progress) => this._getNotionBackupService(resolvedRoot).restoreFromNotion(resolvedRoot, progress)
  );
}

public async handleAutoCreateNotionDatabase(workspaceRoot?: string): Promise<{ success: boolean; databaseUrl?: string; error?: string }> {
  const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
  if (!resolvedRoot) return { success: false, error: 'No workspace found' };

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating Notion database...', cancellable: false },
    async () => this._getNotionBackupService(resolvedRoot).autoCreateDatabase()
  );
}
```

**Edge Cases:**
- `handleConfigureNotionBackup` validates database accessibility via `service.validateDatabaseAccess(databaseId)` (public method on NotionBackupService) before saving config.
- Backup and restore operations use `vscode.window.withProgress()` with the `Progress` parameter passed through to the service for per-plan progress reporting.
- Auto-create uses `withProgress()` without incremental progress (single API call).

### src/services/SetupPanelProvider.ts

**Context:** Route Notion backup messages from setup.html webview to TaskViewerProvider handlers.

**Implementation (add cases in `_handleMessage()` switch, around line 388):**

```typescript
case 'configureNotionBackup': {
  const result = await this._taskViewerProvider.handleConfigureNotionBackup(
    typeof message.databaseUrl === 'string' ? message.databaseUrl : '',
    typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
  );
  this._panel?.webview.postMessage({ type: 'notionBackupConfigResult', ...result });
  break;
}
case 'backupToNotion': {
  const result = await this._taskViewerProvider.handleBackupToNotion(
    typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
  );
  this._panel?.webview.postMessage({ type: 'notionBackupResult', ...result });
  break;
}
case 'restoreFromNotion': {
  const result = await this._taskViewerProvider.handleRestoreFromNotion(
    typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
  );
  this._panel?.webview.postMessage({ type: 'notionRestoreResult', ...result });
  break;
}
case 'autoCreateNotionDatabase': {
  const result = await this._taskViewerProvider.handleAutoCreateNotionDatabase(
    typeof message.workspaceRoot === 'string' ? message.workspaceRoot : undefined
  );
  this._panel?.webview.postMessage({ type: 'notionAutoCreateResult', ...result });
  break;
}
```

**Edge Cases:** `workspaceRoot` is optional and resolved by TaskViewerProvider's `_resolveWorkspaceRoot()` if omitted.

### package.json

**Context:** Add settings schema for Notion backup configuration.

**Implementation (add to `contributes.configuration.properties`):**

```json
"switchboard.notionBackup": {
  "type": "object",
  "default": {},
  "description": "Notion database backup configuration"
}
```

**Edge Cases:** Settings object is a placeholder; actual config stored in `.switchboard/notion-backup-config.json` for per-workspace isolation. The VS Code setting is optional and not referenced by code.

## Implementation Steps

1. **Create `src/services/NotionBackupService.ts`**
   - Implement config load/save
   - Implement `parseDatabaseId()` via `NotionFetchService.parsePageId()`
   - Implement backup logic with 350ms inter-request delays, query-before-create deduplication, and incremental `Progress.report()` per plan
   - Implement restore logic with timestamp comparison, batch `upsertPlans()`, local path-field preservation, and separate `updateColumn()` calls for kanban column changes
   - **CRITICAL**: Resolve `workspaceId` via `kanbanDb.getWorkspaceId()` before calling `getAllPlans(workspaceId)` — never pass `workspaceRoot` to `getAllPlans()`
   - **CRITICAL**: For existing plans during restore, preserve `planFile`, `brainSourcePath`, `mirrorPath`, `routedTo`, `dispatchedAgent`, `dispatchedIde` from local record — never overwrite with empty strings
   - Implement auto-create database with parent page defaulting to existing Notion design-doc config
   - Add `validateDatabaseAccess(databaseId)` public method for config validation (replaces broken `service['__notionFetchService']` access pattern)

2. **Add `upsertPlan()` to `src/services/KanbanDatabase.ts`** (optional convenience)
   - Single-record wrapper around `upsertPlans()` at approximately line 833
   - Note: restore flow uses batch `upsertPlans()` directly; this wrapper is for future single-record use cases

3. **Update `src/webview/setup.html`**
   - Add Notion Database Backup subsection in Database tab after Rebuild Database (around line 714)
   - Add `notion-backup-progress` div for inline progress text

4. **Update `src/webview/setup.html` JavaScript**
   - Add event listeners for new buttons with disable/enable during operations
   - Add message handlers for `notionBackupConfigResult`, `notionBackupResult`, `notionRestoreResult`, `notionAutoCreateResult`, `notionBackupProgress`

5. **Update `src/services/TaskViewerProvider.ts`**
   - Add `_notionBackupServices` Map field
   - Add `_getNotionBackupService()` private accessor
   - Update `getIntegrationSetupStates()` to include `notionBackupSetupComplete`
   - Add `handleConfigureNotionBackup()`, `handleBackupToNotion()`, `handleRestoreFromNotion()`, `handleAutoCreateNotionDatabase()`

6. **Update `src/services/SetupPanelProvider.ts`**
   - Add message routing cases for `configureNotionBackup`, `backupToNotion`, `restoreFromNotion`, `autoCreateNotionDatabase`

7. **Update `package.json`**
   - Add `switchboard.notionBackup` settings schema

## Verification Plan

### Automated Tests

Create `src/services/__tests__/NotionBackupService.test.ts`:

1. **Mock NotionFetchService:**
   - Create a test double that implements `httpRequest()` with a mock response queue.
   - Mock `loadConfig()` and `saveConfig()` to use a temporary JSON file.

2. **Test `parseDatabaseId()`:**
   - Valid Notion database URLs (with UUID, with 32-char hex ID)
   - Invalid URLs (non-Notion domains, missing ID)

3. **Test `backupToNotion()`:**
   - Empty kanban.db returns `success: true, backedUp: 0`
   - Single plan: mock `GET /databases/{id}/query` (no existing page), mock `POST /pages` (success), verify `backedUp: 1`
   - Existing page: mock query returns a page, mock `PATCH /pages/{id}` (success), verify update path
   - Rate-limit simulation: verify 350ms delay between requests by checking timing
   - Partial failure: mock `POST /pages` fails on plan 2 of 3, verify `success: false`, `lastBackupAt` is NOT updated
   - **workspaceId resolution**: verify `getWorkspaceId()` is called and result passed to `getAllPlans()`, NOT `workspaceRoot`
   - **Progress reporting**: verify `progress.report()` called per plan with increment counter

4. **Test `restoreFromNotion()`:**
   - Empty Notion database returns `success: true, restored: 0`
   - Single page conversion: mock `POST /databases/{id}/query` with one result, verify `KanbanPlanRecord` fields match
   - Timestamp skip: local plan with `updatedAt` newer than Notion page `Updated At` date → `skipped: 1`
   - Batch upsert: verify `kanbanDb.upsertPlans()` called once with all valid records, not once per page
   - **Path preservation**: local plan with `planFile: '.switchboard/plans/foo.md'` — after restore, verify `planFile` is NOT overwritten with `''`
   - **Column update**: local plan in `CREATED`, Notion has `CODER CODED` — verify `updateColumn()` called separately after upsert
   - **workspaceId resolution**: verify `getWorkspaceId()` called before `getAllPlans()`

5. **Test `autoCreateDatabase()`:**
   - No parent page configured → error "Set up Notion integration first"
   - Successful creation: mock `POST /databases` (200 with `id` and `url`), verify config saved
   - Failed creation: mock `POST /databases` (400), verify error propagated

6. **Test `validateDatabaseAccess()`:**
   - Valid database ID → `success: true`
   - 403 response → error with permissions hint
   - Network error → error with connection hint

### Manual Verification

1. Open Switchboard Setup → Database tab → Notion Database Backup subsection visible
2. Click "Auto-Create" without Notion integration configured → error message displayed
3. Configure Notion integration in Integrations tab → return to Database tab → Auto-Create succeeds → database URL populated
4. Click "Backup to Notion" → VS Code progress notification shows → completion message with count → `notion-backup-config.json` has `lastBackupAt`
5. Verify in Notion: database has pages with readable titles (topics), Plan IDs in rich_text, all properties populated
6. Delete a plan from kanban.db → Click "Restore from Notion" → plan reappears in kanban.db
7. Modify a local plan's `updated_at` to be newer than Notion → Click "Restore" → plan not overwritten, `skipped: 1`

## Edge Cases & Considerations

1. **Rate Limiting:** Notion API has rate limits (~3 req/sec). Backup uses 350ms delays between requests and reuses `NotionFetchService.httpRequest()` which handles 429 retries with exponential backoff and `Retry-After` header support.

2. **Schema Mismatch:** If user provides an existing database with wrong schema, `backupToNotion()` will fail with HTTP 400 from Notion API. Error message propagated to UI. `autoCreateDatabase()` generates the correct schema.

3. **Partial Failures:** If backup fails partway, `lastBackupAt` is NOT updated. Success boolean is false. Error message shows `Backed up X/Y plans`. No resume logic in v1; user must retry full backup.

4. **Data Size:** kanban.db could have hundreds of plans. 100 plans × 350ms = 35 seconds minimum. VS Code progress notification (`withProgress`) shows during operation. setup.html progress div shows per-plan counts. Notion databases support thousands of pages.

5. **Conflicts:** Restore uses timestamp comparison: local `updated_at` vs Notion `Updated At`. If local is newer, plan is skipped. Deleted local plans are resurrected by restore if they exist in Notion. Clarification: this is the v1 policy; v2 could add a "skip deleted" flag.

6. **Token Reuse:** Uses existing Notion API token from `NotionFetchService` secretStorage (`switchboard.notion.apiToken`). No separate token flow.

7. **Permissions:** `handleConfigureNotionBackup()` validates database accessibility via `GET /databases/{id}` before saving config. Returns clear error if permissions missing.

8. **Duplicate Pages:** Concurrent backups from two machines could create duplicate pages. Mitigation: `_upsertPlanToNotion()` queries by Plan ID before create, so subsequent backups find and update the existing page.

9. **Notion Title Property:** Notion databases have exactly one `Title` property which drives page display names. The auto-created database uses "Topic" as Title so pages are human-readable. Plan ID is stored in a `rich_text` property.

10. **Kanban Column Update Gap:** `upsertPlans()` intentionally does NOT update `kanban_column` on conflict (the UPSERT_PLAN_SQL omits it from the `ON CONFLICT DO UPDATE SET` clause). Restore must call `updateColumn()` separately for any plan whose column changed in Notion. This is by design — the global upsert SQL protects against accidental column moves from automated sync.

11. **Local Path Preservation:** When restoring a plan that already exists locally, the Notion-sourced record has empty `planFile`, `brainSourcePath`, `mirrorPath`, `routedTo`, `dispatchedAgent`, `dispatchedIde` fields (Notion doesn't store filesystem paths or dispatch state). The restore logic must copy these values from the local record before upserting. Failure to do so would overwrite local paths with empty strings, severing the plan-to-file link.

12. **Incremental Progress:** Both `backupToNotion()` and `restoreFromNotion()` accept an optional `vscode.Progress<{ message?: string }>` parameter. The TaskViewerProvider handlers pass this through from `vscode.window.withProgress()`. Per-plan progress is reported via `progress.report({ message: '...' })`.

## Files to Modify

1. `src/services/NotionBackupService.ts` (new file)
2. `src/services/KanbanDatabase.ts` — add `upsertPlan()` wrapper (~line 833)
3. `src/webview/setup.html` — add UI subsection (~line 714) and JavaScript handlers
4. `src/services/TaskViewerProvider.ts` — add service accessors and handlers
5. `src/services/SetupPanelProvider.ts` — add message routing cases
6. `package.json` — add settings schema

## Success Criteria

- User can configure Notion database URL in setup.html
- User can click "Auto-Create" to generate a properly structured Notion database
- User can backup kanban.db to Notion database successfully
- User can restore from Notion database to kanban.db successfully
- Status indicators show configuration state and last backup/restore times
- Error messages are clear and actionable
- Rate limiting is handled gracefully
- Progress is shown for large operations

**Recommendation:** Send to Lead Coder.

## Improve-Plan Findings

### Critical Bugs Fixed
1. **`getAllPlans()` parameter mismatch** — was called with `workspaceRoot` (path), must use `workspaceId` (hash). Added `getWorkspaceId()` resolution step.
2. **Path field overwrite on restore** — Notion-sourced records have empty `planFile`/`brainSourcePath`/`mirrorPath`/dispatch fields. Added merge logic to preserve local values for existing plans.
3. **`kanban_column` not updated by upsert** — Added separate `updateColumn()` calls after batch upsert for column changes.
4. **Missing `validateDatabaseAccess()` method** — Added public method to NotionBackupService; fixed handler to use it instead of broken private-field access.
5. **No incremental progress** — Added `Progress<{ message?: string }>` parameter to `backupToNotion()` and `restoreFromNotion()`; handlers now pass progress through from `withProgress()`.

### Remaining Risks
- `updateColumn()` calls are not batched — each is a separate DB write. For large restores with many column changes, this could be slow. Acceptable for v1 since column changes are typically rare.
- The `notionBackupProgress` webview message type is still defined in the JS handler but is not emitted by the current architecture (progress goes to VS Code notification, not the webview). The webview progress div will only update on completion. A future enhancement could add webview-specific progress via postMessage from the handler.
- `getIntegrationSetupStates()` return type adds `notionBackupSetupComplete` — this is additive and non-breaking for JS consumers.
