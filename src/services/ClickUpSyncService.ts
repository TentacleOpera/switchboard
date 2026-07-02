import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { hostInlineImages } from './ImageHostingHelper';
import type { AutoPullIntervalMinutes } from './IntegrationAutoPullService';
import { KanbanDatabase } from './KanbanDatabase';
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';
import {
  matchesClickUpAutomationRule,
  normalizeClickUpAutomationRules,
  type ClickUpAutomationRule
} from '../models/PipelineDefinition';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { stampMarker, truncateForComment } from './commentMarker';
import { localizeHttpError } from './errorMessages';


export interface ClickUpConfig {
  workspaceId: string;
  folderId: string;
  spaceId: string;
  columnMappings: Record<string, string>;
  customFields: {
    sessionId: string;
    planId: string;
    syncTimestamp: string;
  };
  setupComplete: boolean;
  lastSync: string | null;
  realTimeSyncEnabled: boolean;
  autoPullEnabled: boolean;
  pullIntervalMinutes: AutoPullIntervalMinutes;
  automationRules: ClickUpAutomationRule[];
  selectedListId: string;
  selectedListName: string;
  selectedSpaceId: string;
  selectedSpaceName: string;
  selectedFolderId: string;
  selectedFolderName: string;
  deleteSyncEnabled?: boolean;   // default: false — delete ClickUp task when plan is deleted
  completeSyncEnabled?: boolean; // default: false — sync completed status to ClickUp
  excludeBacklog?: boolean;      // default: false — exclude tasks with 'backlog' status from sync
  ticketSaveLocation?: string;   // base dir for local ticket .md files (set via Setup / migration)
}

export interface KanbanPlanRecord {
  planId: string;
  sessionId: string;
  topic: string;
  planFile: string;
  kanbanColumn: string;
  status: string;
  complexity: string;
  tags: string;
  createdAt: string;
  updatedAt: string;
  lastAction: string;
  clickupTaskId?: string;
}

export interface ClickUpListSummary {
  id: string;
  name: string;
}

export interface ClickUpList {
  id: string;
  name: string;
  archived: boolean;
  folder: { id: string; name: string } | null;
  space: { id: string; name: string } | null;
  taskCount: number | null;
}

export interface ClickUpTask {
  id: string;
  name: string;
  description: string;
  markdownDescription: string;
  textContent: string;
  url: string;
  parentId: string | null;
  archived: boolean;
  status: { status: string; color: string; type: string; orderindex: string } | null;
  priority: { id: string; priority: string; color: string; orderindex: string } | null;
  list: { id: string; name: string } | null;
  creator: { id: string; username: string; email: string } | null;
  assignees: Array<{ id: string; username: string; email: string }>;
  tags: Array<{ name: string; tagFg: string; tagBg: string }>;
  dateCreated: string;
  dateUpdated: string;
}

export interface ClickUpColumnMappingState {
  columnId: string;
  listId: string;
  listName: string;
  status: 'mapped' | 'excluded' | 'unmapped';
}

export interface ClickUpMappingState {
  availableLists: ClickUpListSummary[];
  mappings: ClickUpColumnMappingState[];
  mappedCount: number;
  excludedCount: number;
  unmappedCount: number;
}

export interface ClickUpMappingSelection {
  columnId: string;
  strategy: 'create' | 'existing' | 'exclude';
  listId?: string;
}

export interface ClickUpMoveResult {
  warning?: string;
  remainsInLists: number;
}

export interface ClickUpApplyOptions {
  createFolder: boolean;
  createLists: boolean;
  createCustomFields: boolean;
  enableRealtimeSync: boolean;
  enableAutoPull: boolean;
  columns?: string[];
}

export type ClickUpWriteBackTarget = 'description' | 'comment';
export type ClickUpWriteBackFormat = 'append' | 'prepend' | 'replace';

export type ClickUpSyncSkipReason = 'unmapped-column' | 'excluded-column' | 'complete-sync-disabled';

export interface ClickUpSyncResult {
  success: boolean;
  taskId?: string;
  error?: string;
  warning?: string;
  skippedReason?: ClickUpSyncSkipReason;
}

// Canonical Switchboard kanban columns (derived from DEFAULT_KANBAN_COLUMNS + legacy columns)
export const CANONICAL_COLUMNS = [
  ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
  'BACKLOG',
  'CODED'
];

export class ClickUpSyncService {
  private _workspaceRoot: string;
  private _configPath: string;
  private _config: ClickUpConfig | null = null;
  private _debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private _rateLimitDelay: number = 1000;
  private _batchSize: number = 10;
  private _maxRetries: number = 3;
  private _secretStorage: vscode.SecretStorage;
  private _setupInProgress: boolean = false;
  private _isSyncInProgress: boolean = false;
  private _consecutiveFailures: number = 0;

  /**
   * Sessions whose _createTask HTTP request is currently in flight.
   * Used by importTasksFromClickUp to skip tasks that were just created by us
   * but whose taskId has not yet been persisted to the plan record.
   * Not persisted — extension restart is self-healing because the HTTP call dies too.
   */
  private _pendingCreateSessions: Set<string> = new Set();

  // Cache service for task caching
  private _cacheService: import('./PlanningPanelCacheService').PlanningPanelCacheService | null = null;
  private _tokenPresentCache: boolean | null = null;

  // Reverse map: taskId -> listId for efficient cache invalidation on updates
  private _taskListIndex: Map<string, string> = new Map();

  public isCreating(planFile: string): boolean {
    return this._pendingCreateSessions.has(planFile);
  }

  /**
   * Inject the cache service for task caching.
   */
  public setCacheService(cacheService: import('./PlanningPanelCacheService').PlanningPanelCacheService): void {
    this._cacheService = cacheService;
  }

  /**
   * Clear the taskId → listId reverse index. Used by manual cache refresh
   * to avoid stale invalidation hints after the cache is wiped.
   */
  public clearTaskListIndex(): void {
    this._taskListIndex.clear();
  }

  public getTaskListId(taskId: string): string | undefined {
    return this._taskListIndex.get(taskId);
  }

  constructor(workspaceRoot: string, secretStorage: vscode.SecretStorage) {
    this._workspaceRoot = workspaceRoot;
    this._configPath = path.join(workspaceRoot, '.switchboard', 'clickup-config.json');
    this._secretStorage = secretStorage;
  }

  // ── Config I/O ──────────────────────────────────────────────

  private _normalizeStringRecord(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>)
        .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
        .filter(([key]) => key.length > 0)
    );
  }

  private _normalizeColumns(columns: string[] | undefined, config: ClickUpConfig | null): string[] {
    const normalized = (Array.isArray(columns) ? columns : [])
      .map((column) => String(column || '').trim())
      .filter(Boolean);
    if (normalized.length > 0) {
      return Array.from(new Set(normalized));
    }

    if (config) {
      const configColumns = Object.keys(config.columnMappings || {})
        .map((column) => String(column || '').trim())
        .filter(Boolean);
      if (configColumns.length > 0) {
        return Array.from(new Set(configColumns));
      }
    }

    return [...CANONICAL_COLUMNS];
  }

  private _hasExplicitColumnMapping(config: ClickUpConfig, column: string): boolean {
    return Object.prototype.hasOwnProperty.call(config.columnMappings, column);
  }

  private _getCustomFieldState(raw: Partial<ClickUpConfig> | null): ClickUpConfig['customFields'] {
    const customFields: Partial<ClickUpConfig['customFields']> = raw?.customFields && typeof raw.customFields === 'object'
      ? raw.customFields
      : {};

    return {
      sessionId: String(customFields.sessionId || '').trim(),
      planId: String(customFields.planId || '').trim(),
      syncTimestamp: String(customFields.syncTimestamp || '').trim()
    };
  }

  private _createEmptyConfig(): ClickUpConfig {
    return {
      workspaceId: '',
      folderId: '',
      spaceId: '',
      columnMappings: {},
      customFields: { sessionId: '', planId: '', syncTimestamp: '' },
      setupComplete: false,
      lastSync: null,
      realTimeSyncEnabled: false,
      autoPullEnabled: false,
      pullIntervalMinutes: 60,
      automationRules: [],
      selectedListId: '',
      selectedListName: '',
      selectedSpaceId: '',
      selectedSpaceName: '',
      selectedFolderId: '',
      selectedFolderName: '',
      deleteSyncEnabled: false,
      completeSyncEnabled: false,
      excludeBacklog: false,
    };
  }

  private _normalizeConfig(raw: Partial<ClickUpConfig> | null): ClickUpConfig | null {
    if (!raw) {
      return null;
    }

    const interval = raw.pullIntervalMinutes;
    const normalizedInterval: AutoPullIntervalMinutes =
      interval === 5 || interval === 15 || interval === 30 || interval === 60 ? interval : 60;

    return {
      workspaceId: raw.workspaceId || '',
      folderId: raw.folderId || '',
      spaceId: raw.spaceId || '',
      columnMappings: (() => {
        const normalizedMappings = this._normalizeStringRecord(raw.columnMappings);
        return Object.keys(normalizedMappings).length > 0
          ? normalizedMappings
          : {};
      })(),
      customFields: this._getCustomFieldState(raw),
      setupComplete: raw.setupComplete === true,
      lastSync: raw.lastSync || null,
      realTimeSyncEnabled: raw.realTimeSyncEnabled === undefined
        ? raw.setupComplete === true
        : raw.realTimeSyncEnabled === true,
      autoPullEnabled: raw.autoPullEnabled === true,
      pullIntervalMinutes: normalizedInterval,
      automationRules: normalizeClickUpAutomationRules(raw.automationRules),
      selectedListId: raw.selectedListId || '',
      selectedListName: raw.selectedListName || '',
      selectedSpaceId: raw.selectedSpaceId || '',
      selectedSpaceName: raw.selectedSpaceName || '',
      selectedFolderId: raw.selectedFolderId || '',
      selectedFolderName: raw.selectedFolderName || '',
      deleteSyncEnabled: raw.deleteSyncEnabled === undefined
        ? false   // Default false — require explicit opt-in
        : raw.deleteSyncEnabled === true,
      completeSyncEnabled: raw.completeSyncEnabled === undefined
        ? true   // §4 migration — the flag was a no-op before, so sync was effectively
                 // unconditional. Defaulting undefined → true preserves that behavior for
                 // existing installs; a false default would silently suppress DONE-column syncs.
        : raw.completeSyncEnabled === true,
      excludeBacklog: raw.excludeBacklog === undefined
        ? false   // Default false — include all tasks by default
        : raw.excludeBacklog === true,
      ticketSaveLocation: raw.ticketSaveLocation || '',
    };
  }

  private _hasMappedLists(config: ClickUpConfig): boolean {
    return Object.values(config.columnMappings || {}).some(
      (listId) => typeof listId === 'string' && listId.trim().length > 0
    );
  }

  private async _loadWorkspaceId(): Promise<string> {
    const teamResult = await this.httpRequest('GET', '/team');
    if (teamResult.status !== 200) {
      throw new Error('Failed to fetch workspace. Check your API token.');
    }
    const teams = Array.isArray(teamResult.data?.teams) ? teamResult.data.teams : [];
    const workspaceId = String(teams[0]?.id || '').trim();
    if (!workspaceId) {
      throw new Error('No ClickUp workspaces found.');
    }
    return workspaceId;
  }

  /**
   * Public wrapper for _loadWorkspaceId(). Returns cached workspaceId
   * from config if available, otherwise fetches from the ClickUp API.
   * Used by ClickUpDocsAdapter to auto-load workspace ID on first browse.
   */
  public async loadWorkspaceIdIfNeeded(): Promise<string> {
    const config = await this.loadConfig();
    if (config?.workspaceId) {
      return config.workspaceId;
    }
    const workspaceId = await this._loadWorkspaceId();
    // Persist the loaded workspace ID so future calls skip the API round-trip
    const existingConfig = config || this._createEmptyConfig();
    existingConfig.workspaceId = workspaceId;
    await this.saveConfig(existingConfig);
    return workspaceId;
  }

  private async _ensureWorkspaceAndSpace(config: ClickUpConfig): Promise<void> {
    if (!config.workspaceId) {
      config.workspaceId = await this._loadWorkspaceId();
    }
    if (config.spaceId) {
      return;
    }

    const spacesResult = await this.httpRequest('GET', `/team/${config.workspaceId}/space?archived=false`);
    if (spacesResult.status !== 200) {
      throw new Error('Failed to fetch ClickUp spaces.');
    }
    const spaces = Array.isArray(spacesResult.data?.spaces) ? spacesResult.data.spaces : [];
    if (spaces.length === 0) {
      throw new Error('No spaces found in workspace.');
    }

    const spaceItems: Array<{ label: string; id: string }> = spaces.map((space: any) => ({
      label: String(space?.name || '').trim(),
      id: String(space?.id || '').trim()
    })).filter((space: { label: string; id: string }) => space.label.length > 0 && space.id.length > 0);
    const selectedSpace = await vscode.window.showQuickPick(
      spaceItems.map((space) => space.label),
      { placeHolder: 'Select a ClickUp space for the AI Agents folder' }
    );
    if (!selectedSpace) {
      throw new Error('No ClickUp space selected.');
    }

    const resolvedSpaceId = spaceItems.find((space) => space.label === selectedSpace)?.id || '';
    if (!resolvedSpaceId) {
      throw new Error('No ClickUp space selected.');
    }
    config.spaceId = resolvedSpaceId;
  }

  private async _findAiAgentsFolder(spaceId: string): Promise<{ id: string; name: string } | null> {
    const foldersResult = await this.httpRequest('GET', `/space/${spaceId}/folder?archived=false`);
    if (foldersResult.status !== 200) {
      throw new Error('Failed to load ClickUp folders.');
    }

    const existingFolder = (foldersResult.data?.folders || []).find(
      (folder: any) => String(folder?.name || '').trim() === 'AI Agents'
    );
    const folderId = String(existingFolder?.id || '').trim();
    return folderId
      ? { id: folderId, name: 'AI Agents' }
      : null;
  }

  private async _ensureFolder(
    config: ClickUpConfig,
    allowCreate: boolean
  ): Promise<{ created: boolean }> {
    if (config.folderId) {
      return { created: false };
    }

    if (!config.spaceId) {
      await this._ensureWorkspaceAndSpace(config);
    }

    const existingFolder = await this._findAiAgentsFolder(config.spaceId);
    if (existingFolder?.id) {
      config.folderId = existingFolder.id;
      return { created: false };
    }

    if (!allowCreate) {
      throw new Error('ClickUp needs an existing "AI Agents" folder. Enable folder creation or reuse an existing folder first.');
    }

    const folderResult = await this.retry(() =>
      this.httpRequest('POST', `/space/${config.spaceId}/folder`, { name: 'AI Agents' })
    );
    if (folderResult.status !== 200) {
      throw new Error(`Failed to create folder: ${JSON.stringify(folderResult.data)}`);
    }
    const folderId = String(folderResult.data?.id || '').trim();
    if (!folderId) {
      throw new Error('ClickUp returned an invalid folder id.');
    }
    config.folderId = folderId;
    return { created: true };
  }

  private async _ensureColumnMappings(config: ClickUpConfig, columns: string[]): Promise<void> {
    if (!config.folderId) {
      throw new Error('ClickUp list setup requires an existing folder.');
    }

    const existingLists = await this.listFolderLists(config.folderId);
    for (const column of columns) {
      const hasExplicitMapping = this._hasExplicitColumnMapping(config, column);
      const currentListId = String(config.columnMappings[column] || '').trim();
      if (hasExplicitMapping && !currentListId) {
        config.columnMappings[column] = '';
        continue;
      }

      let targetList = currentListId
        ? existingLists.find((list) => list.id === currentListId)
        : undefined;
      if (!targetList) {
        targetList = existingLists.find((list) => list.name.toLowerCase() === column.toLowerCase());
      }

      if (!targetList) {
        const listResult = await this.retry(() =>
          this.httpRequest('POST', `/folder/${config.folderId}/list`, { name: column })
        );
        if (listResult.status !== 200) {
          throw new Error(`Failed to create list for column: ${column}`);
        }
        targetList = {
          id: String(listResult.data?.id || '').trim(),
          name: column
        };
        if (!targetList.id) {
          throw new Error(`ClickUp returned an invalid list for column: ${column}`);
        }
        existingLists.push(targetList);
      }

      config.columnMappings[column] = targetList.id;
      await this.delay(200);
    }
  }

  private async _ensureCustomFields(config: ClickUpConfig): Promise<void> {
    const firstListId = Object.values(config.columnMappings)
      .map((value) => String(value || '').trim())
      .find(Boolean);
    if (!firstListId) {
      throw new Error('ClickUp custom fields require at least one mapped list.');
    }

    const fieldDefs = [
      { name: 'switchboard_session_id', type: 'text', configKey: 'sessionId' as const },
      { name: 'switchboard_plan_id', type: 'text', configKey: 'planId' as const },
      { name: 'sync_timestamp', type: 'date', configKey: 'syncTimestamp' as const }
    ];
    for (const field of fieldDefs) {
      if (config.customFields[field.configKey]) {
        continue;
      }
      try {
        const fieldResult = await this.retry(() =>
          this.httpRequest('POST', `/list/${firstListId}/field`, {
            name: field.name,
            type: field.type
          })
        );
        if (fieldResult.status === 200) {
          config.customFields[field.configKey] = fieldResult.data.id;
        }
      } catch {
        console.warn(`[ClickUpSync] Custom field '${field.name}' creation failed — using description fallback.`);
      }
    }
  }

  async loadConfig(): Promise<ClickUpConfig | null> {
    try {
      const raw = await GlobalIntegrationConfigService.loadConfig('clickup');
      if (!raw) return null;
      const normalized = this._normalizeConfig(raw);
      this._config = normalized;
      return normalized;
    } catch {
      return null;
    }
  }

  public getSelectedHierarchy(): { spaceName: string; folderName: string; listName: string } {
    const config = this._config || this._createEmptyConfig();
    return {
      spaceName: config.selectedSpaceName || '_unknown',
      folderName: config.selectedFolderName || '',
      listName: config.selectedListName || '_unknown'
    };
  }

  async saveConfig(config: ClickUpConfig): Promise<void> {
    const normalized = this._normalizeConfig(config);
    if (!normalized) {
      throw new Error('ClickUp config normalization failed');
    }
    await GlobalIntegrationConfigService.saveConfig('clickup', normalized);
    this._config = normalized;
  }

  async listFolderLists(folderId?: string): Promise<ClickUpListSummary[]> {
    const config = await this.loadConfig();
    const resolvedFolderId = String(folderId || config?.folderId || '').trim();
    if (!resolvedFolderId) {
      return [];
    }

    const result = await this.httpRequest('GET', `/folder/${resolvedFolderId}/list?archived=false`);
    if (result.status !== 200) {
      throw new Error(`Failed to fetch ClickUp lists for folder ${resolvedFolderId}`);
    }

    return (result.data?.lists || [])
      .map((list: any) => ({
        id: String(list?.id || '').trim(),
        name: String(list?.name || '').trim()
      }))
      .filter((list: ClickUpListSummary) => list.id.length > 0);
  }

  async getColumnMappingState(columns: string[]): Promise<ClickUpMappingState> {
    const config = await this.loadConfig();
    const normalizedColumns = this._normalizeColumns(columns, config);
    const availableLists = config?.folderId ? await this.listFolderLists(config.folderId) : [];
    const listNameById = new Map(availableLists.map((list) => [list.id, list.name]));

    const mappings = normalizedColumns.map((columnId) => {
      if (!config || !this._hasExplicitColumnMapping(config, columnId)) {
        return {
          columnId,
          listId: '',
          listName: '',
          status: 'unmapped' as const
        };
      }

      const listId = String(config.columnMappings[columnId] || '').trim();
      if (!listId) {
        return {
          columnId,
          listId: '',
          listName: '',
          status: 'excluded' as const
        };
      }

      return {
        columnId,
        listId,
        listName: listNameById.get(listId) || '',
        status: 'mapped' as const
      };
    });

    return {
      availableLists,
      mappings,
      mappedCount: mappings.filter((mapping) => mapping.status === 'mapped').length,
      excludedCount: mappings.filter((mapping) => mapping.status === 'excluded').length,
      unmappedCount: mappings.filter((mapping) => mapping.status === 'unmapped').length
    };
  }

  async saveColumnMappings(
    selections: ClickUpMappingSelection[],
    columns?: string[]
  ): Promise<ClickUpMappingState> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.folderId) {
      throw new Error('ClickUp must be set up before updating column mappings.');
    }

    const normalizedColumns = this._normalizeColumns(columns, config);
    const selectionByColumn = new Map(
      selections
        .map((selection) => ({
          columnId: String(selection.columnId || '').trim(),
          strategy: selection.strategy,
          listId: String(selection.listId || '').trim()
        }))
        .filter((selection) => selection.columnId.length > 0)
        .map((selection) => [selection.columnId, selection])
    );
    const availableLists = await this.listFolderLists(config.folderId);
    const listById = new Map(availableLists.map((list) => [list.id, list]));
    const nextMappings = {
      ...config.columnMappings
    };

    for (const columnId of normalizedColumns) {
      const selection = selectionByColumn.get(columnId);
      if (!selection) {
        if (!this._hasExplicitColumnMapping(config, columnId)) {
          nextMappings[columnId] = '';
        }
        continue;
      }

      if (selection.strategy === 'exclude') {
        nextMappings[columnId] = '';
        continue;
      }

      if (selection.strategy === 'existing') {
        if (!selection.listId || !listById.has(selection.listId)) {
          throw new Error(`Select an existing ClickUp list for column '${columnId}'.`);
        }
        nextMappings[columnId] = selection.listId;
        continue;
      }

      const currentListId = String(config.columnMappings[columnId] || '').trim();
      let targetList = currentListId ? listById.get(currentListId) : undefined;
      if (!targetList) {
        targetList = availableLists.find((list) => list.name.toLowerCase() === columnId.toLowerCase());
      }

      if (!targetList) {
        const listResult = await this.retry(() =>
          this.httpRequest('POST', `/folder/${config.folderId}/list`, { name: columnId })
        );
        if (listResult.status !== 200) {
          throw new Error(`Failed to create ClickUp list for column '${columnId}'.`);
        }
        targetList = {
          id: String(listResult.data?.id || '').trim(),
          name: columnId
        };
        if (!targetList.id) {
          throw new Error(`ClickUp created an invalid list for column '${columnId}'.`);
        }
        availableLists.push(targetList);
        listById.set(targetList.id, targetList);
      }

      nextMappings[columnId] = targetList.id;
    }

    await this.saveConfig({
      ...config,
      columnMappings: nextMappings
    });
    return this.getColumnMappingState(normalizedColumns);
  }

  async saveAutomationSettings(
    automationRules: ClickUpAutomationRule[]
  ): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp must be set up before saving automation settings.');
    }

    await this.saveConfig({
      ...config,
      automationRules: normalizeClickUpAutomationRules(automationRules)
    });
  }

  private _normalizeClickUpList(raw: any, defaults?: Partial<ClickUpList>): ClickUpList {
    return {
      id: String(raw?.id || defaults?.id || '').trim(),
      name: String(raw?.name || defaults?.name || '').trim(),
      archived: raw?.archived === true,
      folder: (() => {
        const id = String(raw?.folder?.id || defaults?.folder?.id || '').trim();
        const name = String(raw?.folder?.name || defaults?.folder?.name || '').trim();
        return id || name ? { id, name } : null;
      })(),
      space: (() => {
        const id = String(raw?.space?.id || defaults?.space?.id || '').trim();
        const name = String(raw?.space?.name || defaults?.space?.name || '').trim();
        return id || name ? { id, name } : null;
      })(),
      taskCount: raw?.task_count === undefined || raw?.task_count === null
        ? (defaults?.taskCount ?? null)
        : Number(raw.task_count)
    };
  }

  private _normalizeClickUpTask(raw: any): ClickUpTask {
    return {
      id: String(raw?.id || '').trim(),
      name: String(raw?.name || '').trim(),
      description: String(raw?.description || ''),
      markdownDescription: String(raw?.markdown_description || raw?.description || ''),
      textContent: String(raw?.text_content || ''),
      url: String(raw?.url || '').trim(),
      parentId: (() => {
        const parentId = String(raw?.parent || '').trim();
        return parentId || null;
      })(),
      archived: raw?.archived === true,
      status: raw?.status
        ? {
          status: String(raw.status.status || '').trim(),
          color: String(raw.status.color || '').trim(),
          type: String(raw.status.type || '').trim(),
          orderindex: String(raw.status.orderindex || '').trim()
        }
        : null,
      priority: raw?.priority
        ? {
          id: String(raw.priority.id || '').trim(),
          priority: String(raw.priority.priority || '').trim(),
          color: String(raw.priority.color || '').trim(),
          orderindex: String(raw.priority.orderindex || '').trim()
        }
        : null,
      list: raw?.list
        ? {
          id: String(raw.list.id || '').trim(),
          name: String(raw.list.name || '').trim()
        }
        : null,
      creator: raw?.creator
        ? {
          id: String(raw.creator.id || '').trim(),
          username: String(raw.creator.username || '').trim(),
          email: String(raw.creator.email || '').trim()
        }
        : null,
      assignees: Array.isArray(raw?.assignees)
        ? raw.assignees.map((assignee: any) => ({
          id: String(assignee?.id || '').trim(),
          username: String(assignee?.username || '').trim(),
          email: String(assignee?.email || '').trim()
        }))
        : [],
      tags: Array.isArray(raw?.tags)
        ? raw.tags.map((tag: any) => ({
          name: String(tag?.name || '').trim(),
          tagFg: String(tag?.tag_fg || '').trim(),
          tagBg: String(tag?.tag_bg || '').trim()
        }))
        : [],
      dateCreated: String(raw?.date_created || '').trim(),
      dateUpdated: String(raw?.date_updated || '').trim()
    };
  }

  private _dedupeLists(lists: ClickUpList[]): ClickUpList[] {
    const byId = new Map<string, ClickUpList>();
    for (const list of lists) {
      if (!list.id) {
        continue;
      }
      if (!byId.has(list.id)) {
        byId.set(list.id, list);
      }
    }
    return [...byId.values()];
  }

  private _dedupeTasks(tasks: ClickUpTask[]): ClickUpTask[] {
    const byId = new Map<string, ClickUpTask>();
    for (const task of tasks) {
      if (!task.id) {
        continue;
      }
      if (!byId.has(task.id)) {
        byId.set(task.id, task);
      }
    }
    return [...byId.values()];
  }

  private async _listTasksForQuery(listId: string): Promise<ClickUpTask[]> {
    const normalizedListId = String(listId || '').trim();
    if (!normalizedListId) {
      throw new Error('ClickUp list queries require a list ID.');
    }

    const tasks: ClickUpTask[] = [];
    let page = 0;
    while (true) {
      const result = await this.httpRequest(
        'GET',
        `/list/${normalizedListId}/task?page=${page}&subtasks=true&include_closed=true&include_markdown_description=true`
      );
      if (result.status !== 200) {
        throw new Error(`Failed to fetch ClickUp tasks for list ${normalizedListId}: ${result.status}`);
      }

      const pageTasks = Array.isArray(result.data?.tasks)
        ? result.data.tasks.map((task: any) => this._normalizeClickUpTask(task))
        : [];
      tasks.push(...pageTasks);
      if (pageTasks.length < 100) {
        break;
      }
      page++;
      await this.delay(200);
    }

    return tasks;
  }

  public async findList(listName: string): Promise<ClickUpList[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedListName = String(listName || '').trim().toLowerCase();
    if (!normalizedListName) {
      throw new Error('ClickUp list search requires a list name.');
    }

    const workspaceId = String(config.workspaceId || '').trim() || await this._loadWorkspaceId();
    const spacesResult = await this.httpRequest('GET', `/team/${workspaceId}/space?archived=false`);
    if (spacesResult.status !== 200) {
      throw new Error('Failed to fetch ClickUp spaces.');
    }

    const spaces = Array.isArray(spacesResult.data?.spaces) ? spacesResult.data.spaces : [];
    const foundLists: ClickUpList[] = [];

    for (const space of spaces) {
      const spaceId = String(space?.id || '').trim();
      const spaceName = String(space?.name || '').trim();
      if (!spaceId) {
        continue;
      }

      const listsResult = await this.httpRequest('GET', `/space/${spaceId}/list?archived=false`);
      if (listsResult.status !== 200) {
        throw new Error(`Failed to fetch ClickUp lists for space ${spaceId}.`);
      }
      const spaceLists = Array.isArray(listsResult.data?.lists) ? listsResult.data.lists : [];
      for (const list of spaceLists) {
        const normalizedList = this._normalizeClickUpList(list, {
          space: { id: spaceId, name: spaceName }
        });
        if (normalizedList.name.toLowerCase().includes(normalizedListName)) {
          foundLists.push(normalizedList);
        }
      }

      const foldersResult = await this.httpRequest('GET', `/space/${spaceId}/folder?archived=false`);
      if (foldersResult.status !== 200) {
        throw new Error(`Failed to fetch ClickUp folders for space ${spaceId}.`);
      }
      const folders = Array.isArray(foldersResult.data?.folders) ? foldersResult.data.folders : [];
      for (const folder of folders) {
        const folderId = String(folder?.id || '').trim();
        const folderName = String(folder?.name || '').trim();
        const folderLists = Array.isArray(folder?.lists)
          ? folder.lists
          : (() => undefined)();
        let resolvedFolderLists = folderLists;
        if (!resolvedFolderLists && folderId) {
          const folderListsResult = await this.httpRequest('GET', `/folder/${folderId}/list?archived=false`);
          if (folderListsResult.status !== 200) {
            throw new Error(`Failed to fetch ClickUp lists for folder ${folderId}.`);
          }
          resolvedFolderLists = Array.isArray(folderListsResult.data?.lists) ? folderListsResult.data.lists : [];
        }

        for (const list of resolvedFolderLists || []) {
          const normalizedList = this._normalizeClickUpList(list, {
            folder: folderId || folderName ? { id: folderId, name: folderName } : null,
            space: { id: spaceId, name: spaceName }
          });
          if (normalizedList.name.toLowerCase().includes(normalizedListName)) {
            foundLists.push(normalizedList);
          }
        }
      }
    }

    return this._dedupeLists(foundLists);
  }

  public async findTask(listId: string, taskName: string): Promise<ClickUpTask[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedTaskName = String(taskName || '').trim().toLowerCase();
    if (!normalizedTaskName) {
      throw new Error('ClickUp task search requires a task name.');
    }

    const tasks = await this._listTasksForQuery(listId);
    return tasks.filter((task) => task.name.toLowerCase().includes(normalizedTaskName));
  }

  public async searchTasks(query: string, listId?: string): Promise<ClickUpTask[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedQuery = String(query || '').trim();
    const normalizedListId = String(listId || '').trim();

    // Use getListTasks for cache benefits when query is empty (simple list fetch)
    if (!normalizedQuery && normalizedListId) {
      return this.getListTasks(normalizedListId);
    }

    const workspaceId = String(config.workspaceId || '').trim() || await this._loadWorkspaceId();
    const tasks: ClickUpTask[] = [];
    let page = 0;
    while (true) {
      let apiPath = `/team/${workspaceId}/task?subtasks=true&include_closed=true&include_markdown_description=true&page=${page}`;
      if (normalizedQuery) {
        apiPath += `&search=${encodeURIComponent(normalizedQuery)}`;
      }
      if (normalizedListId) {
        apiPath += `&list_ids[]=${encodeURIComponent(normalizedListId)}`;
      }

      const result = await this.httpRequest('GET', apiPath);
      if (result.status !== 200) {
        throw new Error(`Failed to search ClickUp tasks: ${result.status}`);
      }

      const pageTasks = Array.isArray(result.data?.tasks)
        ? result.data.tasks.map((task: any) => this._normalizeClickUpTask(task))
        : [];
      tasks.push(...pageTasks);
      if (pageTasks.length < 100) {
        break;
      }
      page++;
      await this.delay(200);
    }

    return this._dedupeTasks(tasks);
  }

  public async getSubtasks(parentId: string): Promise<ClickUpTask[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedParentId = String(parentId || '').trim();
    if (!normalizedParentId) {
      throw new Error('ClickUp subtask lookup requires a parent task ID.');
    }

    const workspaceId = String(config.workspaceId || '').trim() || await this._loadWorkspaceId();
    const result = await this.httpRequest(
      'GET',
      `/team/${workspaceId}/task?parent=${encodeURIComponent(normalizedParentId)}&subtasks=true&include_markdown_description=true`
    );
    if (result.status !== 200) {
      throw new Error(`Failed to fetch ClickUp subtasks for ${normalizedParentId}: ${result.status}`);
    }

    const tasks = Array.isArray(result.data?.tasks)
      ? result.data.tasks.map((task: any) => this._normalizeClickUpTask(task))
      : [];
    return this._dedupeTasks(tasks);
  }

  // ── Sidebar Project Methods ─────────────────────────────────────

  public async getSpaces(): Promise<Array<{ id: string; name: string }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const workspaceId = String(config.workspaceId || '').trim() || await this._loadWorkspaceId();
    const result = await this.httpRequest('GET', `/team/${workspaceId}/space?archived=false`);
    if (result.status !== 200) {
      throw new Error(`Failed to fetch ClickUp spaces: ${result.status}`);
    }

    return (result.data?.spaces || [])
      .map((space: any) => ({
        id: String(space?.id || '').trim(),
        name: String(space?.name || '').trim()
      }))
      .filter((space: { id: string; name: string }) => space.id.length > 0 && space.name.length > 0);
  }

  public async getFolders(spaceId: string): Promise<Array<{ id: string; name: string }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedSpaceId = String(spaceId || '').trim();
    if (!normalizedSpaceId) {
      throw new Error('ClickUp folder lookup requires a space ID.');
    }

    const result = await this.httpRequest('GET', `/space/${normalizedSpaceId}/folder?archived=false`);
    if (result.status !== 200) {
      throw new Error(`Failed to fetch ClickUp folders for space ${normalizedSpaceId}: ${result.status}`);
    }

    return (result.data?.folders || [])
      .map((folder: any) => ({
        id: String(folder?.id || '').trim(),
        name: String(folder?.name || '').trim()
      }))
      .filter((folder: { id: string; name: string }) => folder.id.length > 0 && folder.name.length > 0);
  }

  public async getLists(spaceId: string, folderId?: string): Promise<Array<{
    id: string;
    name: string;
    taskCount?: number;
  }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedSpaceId = String(spaceId || '').trim();
    if (!normalizedSpaceId) {
      throw new Error('ClickUp list lookup requires a space ID.');
    }

    let result;
    if (folderId) {
      const normalizedFolderId = String(folderId || '').trim();
      result = await this.httpRequest('GET', `/folder/${normalizedFolderId}/list?archived=false`);
    } else {
      result = await this.httpRequest('GET', `/space/${normalizedSpaceId}/list?archived=false`);
    }

    if (result.status !== 200) {
      throw new Error(`Failed to fetch ClickUp lists: ${result.status}`);
    }

    return (result.data?.lists || [])
      .map((list: any) => ({
        id: String(list?.id || '').trim(),
        name: String(list?.name || '').trim(),
        taskCount: list?.task_count !== undefined ? Number(list.task_count) : undefined
      }))
      .filter((list: { id: string; name: string }) => list.id.length > 0 && list.name.length > 0);
  }

  /**
   * Generate a fingerprint for list options to use in cache keys.
   */
  private _fingerprintListOptions(options: {
    status?: string[];
    assignee?: string;
    archived?: boolean;
    includeClosed?: boolean;
    dateUpdatedGt?: number;
  }): string {
    const parts: string[] = [];
    if (options.status?.length) {
      parts.push(`status:${options.status.join(',')}`);
    }
    if (options.assignee) {
      parts.push(`assignee:${options.assignee}`);
    }
    if (options.archived !== undefined) {
      parts.push(`archived:${options.archived}`);
    }
    if (options.includeClosed !== undefined) {
      parts.push(`includeClosed:${options.includeClosed}`);
    }
    if (options.dateUpdatedGt !== undefined) {
      parts.push(`dateUpdatedGt:${options.dateUpdatedGt}`);
    }
    return parts.length > 0 ? parts.join('|') : 'default';
  }

  public async getListTasks(
    listId: string,
    options: {
      status?: string[];
      assignee?: string;
      archived?: boolean;
      includeClosed?: boolean;
      dateUpdatedGt?: number;
    } = {}
  ): Promise<ClickUpTask[]> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedListId = String(listId || '').trim();
    if (!normalizedListId) {
      throw new Error('ClickUp task lookup requires a list ID.');
    }

    // Determine if this is a "simple" query that can use cache
    // Filtered queries (status, assignee, dateUpdatedGt) bypass cache;
    // archived:false is default/simple. Delta queries must hit the API —
    // the cache is keyed on isSimpleQuery and a delta query is not "simple".
    const isSimpleQuery = !options.status?.length && !options.assignee && !options.dateUpdatedGt && (options.archived === undefined || options.archived === false);
    const cacheKey = isSimpleQuery ? normalizedListId : `${normalizedListId}:${this._fingerprintListOptions(options)}`;

    // Try cache first for simple queries
    if (isSimpleQuery && this._cacheService) {
      try {
        const cached = this._cacheService.getCachedTasks<ClickUpTask>('clickup', cacheKey);
        if (cached) {
          return cached;
        }
      } catch (e) {
        // Fail-open: continue to API fetch
        console.warn('[ClickUpSync] Cache read failed, falling back to API:', e);
      }
    }

    const includeClosed = options.includeClosed !== false;
    const tasks: ClickUpTask[] = [];
    let page = 0;

    while (true) {
      // ClickUp v2 API: date_updated_gt is Unix epoch milliseconds on
      // GET /list/{id}/task, with order_by=updated for sort order.
      const deltaParam = options.dateUpdatedGt ? `&date_updated_gt=${options.dateUpdatedGt}&order_by=updated` : '';
      const result = await this.httpRequest(
        'GET',
        `/list/${normalizedListId}/task?page=${page}&subtasks=true&include_closed=${includeClosed}&include_markdown_description=true${deltaParam}`
      );
      if (result.status !== 200) {
        throw new Error(`Failed to fetch ClickUp tasks for list ${normalizedListId}: ${result.status}`);
      }

      const pageTasks = Array.isArray(result.data?.tasks)
        ? result.data.tasks.map((task: any) => this._normalizeClickUpTask(task))
        : [];
      tasks.push(...pageTasks);

      if (pageTasks.length < 100) {
        break;
      }
      page++;
      await this.delay(200);
    }

    const dedupedTasks = this._dedupeTasks(tasks);

    // Update cache and reverse map
    if (isSimpleQuery && this._cacheService) {
      try {
        this._cacheService.cacheTasks('clickup', cacheKey, dedupedTasks);
        // Update reverse map: taskId -> listId
        for (const task of dedupedTasks) {
          if (task.id) {
            this._taskListIndex.set(task.id, normalizedListId);
          }
        }
      } catch (e) {
        // Fail-open: cache errors are non-fatal
        console.warn('[ClickUpSync] Cache write failed:', e);
      }
    }

    return dedupedTasks;
  }

  public async getTaskDetails(taskId: string): Promise<{
    task: ClickUpTask;
    subtasks: ClickUpTask[];
    comments: Array<{ id: string; comment_text: string; user: { username: string; email: string }; date: string }>;
    attachments: Array<{ id: string; url: string; title: string; filename: string }>;
  }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('ClickUp task detail lookup requires a task ID.');
    }

    const taskResult = await this.httpRequest(
      'GET',
      `/task/${normalizedTaskId}?include_subtasks=true&include_markdown_description=true`
    );
    if (taskResult.status !== 200) {
      const err: any = new Error(localizeHttpError(taskResult.status, 'clickup', 'fetch this ticket from ClickUp'));
      err.statusCode = taskResult.status;
      throw err;
    }

    const task = this._normalizeClickUpTask(taskResult.data);

    // Extract subtasks from the task response (returned when include_subtasks=true param is used)
    const subtasks = Array.isArray(taskResult.data?.subtasks)
      ? taskResult.data.subtasks.map((subtask: any) => this._normalizeClickUpTask(subtask))
      : [];

    // Extract attachments from the task response
    const attachments = Array.isArray(taskResult.data?.attachments)
      ? taskResult.data.attachments.map((att: any) => ({
          id: String(att?.id || '').trim(),
          url: String(att?.url || att?.thumbnail_url || '').trim(),
          title: String(att?.title || '').trim(),
          filename: String(att?.filename || '').trim()
        }))
      : [];

    const commentsResult = await this.httpRequest('GET', `/task/${normalizedTaskId}/comment`);
    const comments = Array.isArray(commentsResult.data?.comments)
      ? commentsResult.data.comments.map((comment: any) => ({
          id: String(comment?.id || '').trim(),
          comment_text: String(comment?.comment_text || comment?.text_content || '').trim(),
          user: {
            username: String(comment?.user?.username || '').trim(),
            email: String(comment?.user?.email || '').trim()
          },
          date: String(comment?.date || '').trim()
        }))
      : [];

    return {
      task,
      subtasks,
      comments,
      attachments
    };
  }

  /** Fetches only a task's comments (lighter than getTaskDetails). */
  public async getTaskComments(
    taskId: string
  ): Promise<Array<{ id: string; comment_text: string; user: { username: string; email: string }; date: string }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { throw new Error('ClickUp not configured'); }
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) { return []; }
    const commentsResult = await this.httpRequest('GET', `/task/${normalizedTaskId}/comment`);
    return Array.isArray(commentsResult.data?.comments)
      ? commentsResult.data.comments.map((comment: any) => ({
          id: String(comment?.id || '').trim(),
          comment_text: String(comment?.comment_text || comment?.text_content || '').trim(),
          user: {
            username: String(comment?.user?.username || '').trim(),
            email: String(comment?.user?.email || '').trim()
          },
          date: String(comment?.date || '').trim()
        }))
      : [];
  }

  public async createTask(params: {
    name: string;
    listId: string;
    description?: string;
    assignees?: number[];
    dueDate?: string;
    parent?: string;
    status?: string;
    priority?: number;
  }): Promise<ClickUpTask | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const { name, listId, description, assignees, dueDate, parent, status, priority } = params;

    const normalizedListId = String(listId || '').trim();
    if (!normalizedListId) {
      throw new Error('ClickUp task creation requires a list ID.');
    }

    const normalizedName = String(name || '').trim();
    if (!normalizedName) {
      throw new Error('ClickUp task creation requires a task name.');
    }

    const body: Record<string, unknown> = { name: normalizedName };
    if (description) body.description = description;
    if (status) body.status = status;
    if (parent) body.parent = parent;
    if (assignees && Array.isArray(assignees)) body.assignees = assignees;
    if (priority) body.priority = priority;
    
    // ClickUp API expects dueDate in epoch milliseconds
    if (dueDate) {
      const date = new Date(dueDate);
      if (!isNaN(date.getTime())) {
        body.due_date = date.getTime();
      }
    }

    const createResult = await this.retry(() =>
      this.httpRequest('POST', `/list/${normalizedListId}/task`, body)
    );
    if (createResult.status !== 200 && createResult.status !== 201) {
      throw new Error(`Failed to create ClickUp task in list ${normalizedListId}.`);
    }

    // Invalidate list cache after creation
    if (this._cacheService) {
      this._cacheService.invalidateTaskCache('clickup', normalizedListId);
    }

    const taskId = String(createResult.data?.id || '').trim();
    if (!taskId) {
      return createResult.data ? this._normalizeClickUpTask(createResult.data) : null;
    }

    if (description) {
      try {
        const { rewritten } = await hostInlineImages(
          (fileName, buffer) => this.attachFile(taskId, fileName, buffer),
          description
        );
        if (rewritten !== description) {
          await this.updateTask(taskId, { markdown_content: rewritten });
          if (createResult.data) {
            createResult.data.description = rewritten;
          }
        }
      } catch (hostErr) {
        console.warn(`[ClickUpSync] Created task ${taskId}, but inline image hosting failed:`, hostErr);
      }
    }

    try {
      const taskResult = await this.retry(() =>
        this.httpRequest('GET', `/task/${taskId}`)
      );
      if (taskResult.status === 200) {
        return this._normalizeClickUpTask(taskResult.data);
      }
      console.warn(
        `[ClickUpSync] Created task ${taskId}, but follow-up read returned HTTP ${taskResult.status}; returning POST payload.`
      );
    } catch (error) {
      console.warn(`[ClickUpSync] Created task ${taskId}, but follow-up read failed; returning POST payload.`, error);
    }
    
    return this._normalizeClickUpTask({
      id: taskId,
      name: normalizedName,
      description,
      parent: parent || null,
      list: { id: normalizedListId, name: '' },
      ...createResult.data
    });
  }

  public async updateTask(
    taskId: string,
    updates: {
      name?: string;
      description?: string;
      markdown_content?: string;
      markdown_description?: string;
      status?: string;
      assignees?: number[];
      due_date?: number;
      priority?: number;
      tags?: string[];
      parent?: string;
    }
  ): Promise<ClickUpTask | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('ClickUp task updates require a task ID.');
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('ClickUp task updates require at least one changed field.');
    }

    const updateResult = await this.retry(() =>
      this.httpRequest('PUT', `/task/${normalizedTaskId}`, updates)
    );
    if (updateResult.status !== 200) {
      const detail = typeof updateResult.data === 'string'
        ? updateResult.data
        : JSON.stringify(updateResult.data);
      throw new Error(`Failed to update ClickUp task ${normalizedTaskId}. Status: ${updateResult.status} — ${detail}`);
    }

    // Invalidate cache for the list containing this task
    if (this._cacheService) {
      const listId = this._taskListIndex.get(normalizedTaskId);
      if (listId) {
        this._cacheService.invalidateTaskCache('clickup', listId);
      } else {
        // Fallback: invalidate all ClickUp cache if list unknown
        this._cacheService.invalidateTaskCache('clickup');
      }
    }

    return this._normalizeClickUpTask(updateResult.data);
  }

  /**
   * Move a ClickUp task to a different HOME list.
   * Uses the v3 move endpoint: PUT /api/v3/workspaces/{workspace_id}/tasks/{task_id}/home_list/{list_id}
   * Only the home list changes — additional list memberships (e.g. sprint lists) are untouched.
   */
  public async moveTask(
    taskId: string,
    targetListId: string,
    options?: {
      moveCustomFields?: boolean;
      statusMappings?: Array<{ source_status: string; destination_status: string }>;
    }
  ): Promise<ClickUpMoveResult> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedTaskId = String(taskId || '').trim();
    const normalizedTargetListId = String(targetListId || '').trim();
    if (!normalizedTaskId || !normalizedTargetListId) {
      throw new Error('ClickUp task move requires both a task ID and a target list ID.');
    }

    const workspaceId = await this.loadWorkspaceIdIfNeeded();

    // One task fetch serves both status auto-mapping and the multi-list residue count.
    const taskResult = await this.httpRequest('GET', `/task/${normalizedTaskId}`);
    if (taskResult.status !== 200) {
      throw new Error(`Failed to load ClickUp task ${normalizedTaskId} before move. Status: ${taskResult.status}`);
    }
    const currentStatusName = String(taskResult.data?.status?.status ?? '');
    const currentStatusId = String(taskResult.data?.status?.id ?? '');
    const locations: Array<{ id: string }> = Array.isArray(taskResult.data?.locations)
      ? taskResult.data.locations
      : [];
    const remainsInLists = locations.filter(
      l => String(l.id) !== normalizedTargetListId
    ).length;

    let statusMappings = options?.statusMappings;
    let warning: string | undefined;

    if (!statusMappings || statusMappings.length === 0) {
      const listResult = await this.httpRequest('GET', `/list/${normalizedTargetListId}`);
      if (listResult.status !== 200) {
        throw new Error(`Failed to load target list ${normalizedTargetListId} before move. Status: ${listResult.status}`);
      }
      const targetStatuses: Array<{ id: string; status: string }> =
        Array.isArray(listResult.data?.statuses) ? listResult.data.statuses : [];
      const nameMatch = targetStatuses.find(
        s => String(s.status).toLowerCase() === currentStatusName.toLowerCase()
      );
      if (!nameMatch && targetStatuses.length > 0) {
        statusMappings = [{ source_status: currentStatusId, destination_status: targetStatuses[0].id }];
        warning = `Status "${currentStatusName}" does not exist in the target list — task was set to "${targetStatuses[0].status}".`;
      }
    }

    const moveBody: Record<string, unknown> = {
      move_custom_fields: options?.moveCustomFields ?? true
    };
    if (statusMappings && statusMappings.length > 0) {
      moveBody.status_mappings = statusMappings;
    }

    const moveResult = await this.retry(() =>
      this.httpRequestV3(
        'PUT',
        `/workspaces/${workspaceId}/tasks/${normalizedTaskId}/home_list/${normalizedTargetListId}`,
        moveBody
      )
    );
    if (moveResult.status !== 200) {
      const detail = typeof moveResult.data === 'string'
        ? moveResult.data
        : JSON.stringify(moveResult.data);
      throw new Error(`Failed to move ClickUp task ${normalizedTaskId} to list ${normalizedTargetListId}. Status: ${moveResult.status} — ${detail}`);
    }

    // Invalidate cache for BOTH the old list and the new list
    if (this._cacheService) {
      const oldListId = this._taskListIndex.get(normalizedTaskId);
      if (oldListId) {
        this._cacheService.invalidateTaskCache('clickup', oldListId);
      }
      this._cacheService.invalidateTaskCache('clickup', normalizedTargetListId);
      // Update the reverse map to reflect the new location
      this._taskListIndex.set(normalizedTaskId, normalizedTargetListId);
    }

    return { warning, remainsInLists };
  }

  public async getSpaceTags(spaceId: string): Promise<Array<{ name: string; tagFg: string; tagBg: string }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete || !config.workspaceId) {
        throw new Error('ClickUp not configured');
    }
    const normalizedSpaceId = String(spaceId || '').trim();
    if (!normalizedSpaceId) {
        throw new Error('Space ID required');
    }
    const result = await this.httpRequest('GET', `/space/${normalizedSpaceId}/tag`);
    const tags = Array.isArray(result.data?.tags) ? result.data.tags : [];
    return tags.map((tag: any) => ({
        name: String(tag?.name || '').trim(),
        tagFg: String(tag?.tag_fg || tag?.tagFg || '').trim(),
        tagBg: String(tag?.tag_bg || tag?.tagBg || '').trim()
    })).filter((t: { name: string }) => t.name.length > 0);
  }

  public async getListStatuses(listId: string): Promise<Array<{ status: string; color: string; type: string }>> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
        throw new Error('ClickUp not configured');
    }
    const normalizedListId = String(listId || '').trim();
    if (!normalizedListId) {
        throw new Error('List ID required');
    }
    const result = await this.httpRequest('GET', `/list/${normalizedListId}`);
    const statuses = Array.isArray(result.data?.statuses) ? result.data.statuses : [];
    return statuses.map((s: any) => ({
        status: String(s?.status || '').trim(),
        color: String(s?.color || '').trim(),
        type: String(s?.type || '').trim()
    })).filter((s: { status: string }) => s.status.length > 0);
  }

  public async addTaskComment(taskId: string, comment: string): Promise<void> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('ClickUp comments require a task ID.');
    }

    const normalizedComment = String(comment || '').trim();
    if (!normalizedComment) {
      throw new Error('ClickUp comments require non-empty text.');
    }

    const commentResult = await this.retry(() =>
      this.httpRequest('POST', `/task/${normalizedTaskId}/comment`, {
        comment_text: normalizedComment,
        notify_all: false
      })
    );
    if (commentResult.status !== 200) {
      throw new Error(`Failed to comment on ClickUp task ${normalizedTaskId}.`);
    }
  }

  /**
   * §8 — host-side shared comment write-back primitive (ClickUp implementation).
   *
   * Mirrors LinearSyncService.postManagedComment: stamps the self-marker and
   * truncates to ClickUp's comment limit before posting. Shared interface, separate
   * implementation per provider (different API shapes). Reached by agents only via
   * the LocalApiServer `/comment` route — never directly.
   */
  public async postManagedComment(taskId: string, body: string): Promise<{ success: boolean; error?: string }> {
    try {
      // ClickUp comment bodies cap around 50k chars; 40k keeps headroom for the marker.
      const truncated = truncateForComment(body, 40000);
      const stamped = stampMarker(truncated);
      await this.addTaskComment(taskId, stamped);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Comment Manager: threading + structured mentions ──────────────

  /**
   * Cached list members for the mention picker.
   * Keyed by listId; 5-minute TTL (matches Linear _cachedProjects pattern).
   */
  private _cachedListMembers: Map<string, { data: Array<{ id: string; username: string; email: string; name: string }>; fetchedAt: number }> = new Map();
  private static readonly LIST_MEMBERS_TTL_MS = 5 * 60 * 1000;

  /**
   * Fetch list members for the mention picker.
   * GET /list/{list_id}/member — returns members with id, username, email.
   */
  public async getListMembers(listId: string): Promise<Array<{ id: string; username: string; email: string; name: string }>> {
    const normalizedListId = String(listId || '').trim();
    if (!normalizedListId) { return []; }

    const cached = this._cachedListMembers.get(normalizedListId);
    if (cached && (Date.now() - cached.fetchedAt) < ClickUpSyncService.LIST_MEMBERS_TTL_MS) {
      return cached.data;
    }

    try {
      const result = await this.retry(() =>
        this.httpRequest('GET', `/list/${normalizedListId}/member`)
      );
      const members = Array.isArray(result.data?.members)
        ? result.data.members.map((m: any) => ({
            id: String(m?.id || '').trim(),
            username: String(m?.user?.username || m?.username || '').trim(),
            email: String(m?.user?.email || m?.email || '').trim(),
            name: String(m?.user?.username || m?.username || m?.email || '').trim()
          })).filter((m: { id: string }) => m.id.length > 0)
        : [];
      this._cachedListMembers.set(normalizedListId, { data: members, fetchedAt: Date.now() });
      return members;
    } catch (e) {
      console.warn('[ClickUpSync] Failed to fetch list members:', e);
      return [];
    }
  }

  /**
   * Fetch top-level comments + their reply threads for a task.
   * GET /task/{id}/comment returns top-level comments with reply_count.
   * For each comment with reply_count > 0, GET /comment/{commentId}/reply.
   * Reply fetches are parallelized in batches of 5 to respect rate limits.
   *
   * Verification gate: if reply_count is absent on the response, falls back
   * to flat comments (no threading) — safe degradation to current behavior.
   */
  public async getCommentThreads(taskId: string): Promise<{
    threads: Array<{
      id: string;
      author: { id: string; name: string; email: string };
      body: string;
      bodyParts?: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>;
      date: string;
      mentions: Array<{ id: string; name: string }>;
      replies: Array<{
        id: string;
        author: { id: string; name: string; email: string };
        body: string;
        bodyParts?: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>;
        date: string;
        mentions: Array<{ id: string; name: string }>;
      }>;
    }>;
    threadingSupported: boolean;
  }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { throw new Error('ClickUp not configured'); }
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) { return { threads: [], threadingSupported: false }; }

    const commentsResult = await this.retry(() =>
      this.httpRequest('GET', `/task/${normalizedTaskId}/comment`)
    );
    const rawComments = Array.isArray(commentsResult.data?.comments) ? commentsResult.data.comments : [];

    // Verification gate: check if reply_count field exists on any comment.
    // If absent across all comments, threading is not supported by this API version.
    const hasReplyCount = rawComments.some((c: any) => typeof c?.reply_count === 'number');
    const threadingSupported = hasReplyCount;

    if (!threadingSupported) {
      const threads = rawComments.map((comment: any) => this._normalizeClickUpComment(comment));
      return { threads, threadingSupported: false };
    }

    // Filter out comments that are actually replies (which have a parent_id).
    // ClickUp /task/{id}/comment returns a flat list of all comments + replies.
    // Grouping is handled client-side via parent_id relationships.
    const topLevelRaw = rawComments.filter((c: any) => !c.parent_id);
    const replyRaw = rawComments.filter((c: any) => c.parent_id);
    const repliesByParent = new Map<string, any[]>();
    for (const r of replyRaw) {
      const pid = String(r.parent_id || '').trim();
      if (!repliesByParent.has(pid)) { repliesByParent.set(pid, []); }
      repliesByParent.get(pid)!.push(r);
    }

    const threads: any[] = [];
    for (const comment of topLevelRaw) {
      const normalized = this._normalizeClickUpComment(comment);
      const parentId = normalized.id;
      const directReplies = repliesByParent.get(parentId) || [];

      // If ClickUp response indicates replies exist (reply_count > 0)
      // but repliesByParent is empty (which happens when flat list lacks reply objects),
      // we perform defensive API fetches to load nested threads.
      const replyCount = Number(comment.reply_count || 0);
      if (replyCount > 0 && directReplies.length === 0) {
        // Fallback: fetch replies via separate endpoint API.
        try {
          const repliesResult = await this.retry(() =>
            this.httpRequest('GET', `/comment/${parentId}/reply`)
          );
          const rawReplies = Array.isArray(repliesResult.data?.replies) ? repliesResult.data.replies : [];
          normalized.replies = rawReplies.map((r: any) => this._normalizeClickUpComment(r));
        } catch {
          // Log fallback error, proceed with empty replies list.
          normalized.replies = [];
        }
      } else {
        // Map inline replies if they were retrieved in the initial flat list.
        normalized.replies = directReplies.map((r: any) => this._normalizeClickUpComment(r));
      }

      threads.push(normalized);
    }

    return { threads, threadingSupported: true };
  }

  /**
   * Normalize a raw ClickUp comment into the thread shape.
   * ClickUp comment_text may contain structured content; we extract plain text
   * and parse mentions from the comment array if present.
   */
  private _normalizeClickUpComment(comment: any): {
    id: string;
    author: { id: string; name: string; email: string };
    body: string;
    bodyParts?: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }>;
    date: string;
    mentions: Array<{ id: string; name: string }>;
    replies: any[];
  } {
    const mentions: Array<{ id: string; name: string }> = [];
    let body = '';
    const bodyParts: Array<{ type: 'text' | 'emoji' | 'image'; text?: string; url?: string; alt?: string }> = [];

    // ClickUp structured comment: array of blocks.
    // GET response shape: text blocks are {"text": "..."} (no type field),
    //   tag blocks are {"type": "tag", "user": {id, username, ...}}.
    // POST shape (for reference): text blocks have type:"text", tag blocks use assignee.
    if (Array.isArray(comment?.comment)) {
      for (const block of comment.comment) {
        if (typeof block?.text === 'string' && (!block.type || block.type === 'text')) {
          body += block.text;
          bodyParts.push({ type: 'text', text: block.text });
        } else if (block?.type === 'tag') {
          const userId = String(block?.user?.id || block?.assignee || '').trim();
          const name = String(block?.user?.username || block?.text || '').trim();
          mentions.push({ id: userId, name });
          const mentionText = `@${name || userId}`;
          body += mentionText;
          bodyParts.push({ type: 'text', text: mentionText });
        } else if (block?.type === 'emoticon') {
          // ClickUp emoticon block: { type: "emoticon", text: "U0001F60A", emoticon: { code: "1f60a" } }
          // Construct the emoji character from the hex codepoint.
          // Multi-codepoint emoji (ZWJ sequences, skin-tone modifiers) may use
          // "-"-separated hex segments, e.g. "1f468-200d-1f469-200d-1f467".
          const hexCode = String(block?.emoticon?.code || '').trim();
          let emoji = '';
          if (hexCode && /^[0-9a-fA-F-]+$/.test(hexCode)) {
            try {
              if (hexCode.includes('-')) {
                // Multi-codepoint: split on "-" and concatenate codepoints.
                emoji = hexCode.split('-')
                  .filter(seg => /^[0-9a-fA-F]+$/.test(seg))
                  .map(seg => String.fromCodePoint(parseInt(seg, 16)))
                  .join('');
              } else {
                emoji = String.fromCodePoint(parseInt(hexCode, 16));
              }
            } catch { emoji = ''; }
          }
          if (!emoji && typeof block?.text === 'string') {
            // Fallback: try to decode "U0001F60A" format (single codepoint only)
            const m = block.text.match(/^U0*([0-9a-fA-F]+)$/);
            if (m) {
              try { emoji = String.fromCodePoint(parseInt(m[1], 16)); } catch { emoji = ''; }
            }
          }
          if (emoji) {
            body += emoji;
            bodyParts.push({ type: 'emoji', text: emoji });
          }
        } else if (block?.type === 'attachment' || block?.type === 'image' || block?.type === 'file') {
          // Defensive: undocumented block type. Extract URL from common fields.
          const url = String(block?.url || block?.image || block?.src || block?.attachment || '').trim();
          const alt = String(block?.title || block?.filename || block?.name || 'attachment').trim();
          if (url && (url.startsWith('https://') || url.startsWith('data:'))) {
            body += `[${alt}]`;
            bodyParts.push({ type: 'image', url, alt });
          } else {
            // No valid URL — show placeholder text
            body += `[${alt}]`;
            bodyParts.push({ type: 'text', text: `[${alt}]` });
          }
        }
      }
      // Fallback: if the structured array yielded no text, use comment_text.
      if (!body) {
        const fallback = String(comment?.comment_text || '').trim();
        if (fallback) {
          body = fallback;
          bodyParts.push({ type: 'text', text: fallback });
        } else {
          // Last-resort placeholder for media-only comments with no decodable blocks.
          body = '[media comment]';
          bodyParts.push({ type: 'text', text: '[media comment]' });
        }
      }
    } else {
      body = String(comment?.comment_text || '').trim();
      if (body) { bodyParts.push({ type: 'text', text: body }); }
    }

    return {
      id: String(comment?.id || '').trim(),
      author: {
        id: String(comment?.user?.id || '').trim(),
        name: String(comment?.user?.username || '').trim(),
        email: String(comment?.user?.email || '').trim()
      },
      body,       // Plain-text representation. For image blocks, shows [alt] placeholder.
      bodyParts,  // Structured representation. For image blocks, contains the actual URL.
                   // body and bodyParts intentionally diverge for image blocks —
                   // body is for non-webview consumers (logging, search), bodyParts
                   // is for the webview renderer.
      date: String(comment?.date || '').trim(),
      mentions,
      replies: []
    };
  }

  /**
   * Build a structured comment body from text + mentions.
   * ClickUp v2 accepts `comment` as an array of:
   *   { type: 'text', text: '...' }
   *   { type: 'tag', assignee: <userIdInteger> }
   * Falls back to plain `comment_text` with @name if structured format fails.
   */
  private _buildStructuredComment(commentText: string, mentions: Array<{ id: string; name: string }>): {
    structured: { comment: Array<{ type: string; text?: string; assignee?: number }>; notify_all: boolean };
    plain: { comment_text: string; notify_all: boolean };
  } {
    const blocks: Array<{ type: string; text?: string; assignee?: number }> = [];
    // Split text by mention tokens to interleave text and tag blocks.
    // Mentions are inserted as {@id} tokens in the UI; we split on those.
    const mentionRegex = /@\{(\d+)\}/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const mentionById = new Map(mentions.map(m => [m.id, m]));

    while ((match = mentionRegex.exec(commentText)) !== null) {
      const userId = match[1];
      // Push preceding text block if any
      if (match.index > lastIndex) {
        const textSegment = commentText.slice(lastIndex, match.index);
        if (textSegment) { blocks.push({ type: 'text', text: textSegment }); }
      }
      // Push the tag block
      const mention = mentionById.get(userId);
      blocks.push({
        type: 'tag',
        assignee: parseInt(userId, 10),
        ...(mention?.name ? { text: mention.name } : {})
      });
      lastIndex = match.index + match[0].length;
    }
    // Push trailing text
    if (lastIndex < commentText.length) {
      const textSegment = commentText.slice(lastIndex);
      if (textSegment) { blocks.push({ type: 'text', text: textSegment }); }
    }
    // If no mentions were found, just use a single text block
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: commentText });
    }

    // Plain-text fallback: replace @{id} tokens with @name
    let plainText = commentText;
    for (const m of mentions) {
      plainText = plainText.replace(new RegExp(`@\\{${m.id}\\}`, 'g'), `@${m.name || m.id}`);
    }

    return {
      structured: { comment: blocks, notify_all: false },
      plain: { comment_text: plainText, notify_all: false }
    };
  }

  /**
   * Post a new top-level comment on a task with optional structured mentions.
   * Tries structured `comment` array format first; on non-200, falls back to
   * plain `comment_text` with @name text (visible but no notification).
   */
  public async postComment(taskId: string, params: { commentText: string; mentions?: Array<{ id: string; name: string }> }): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { throw new Error('ClickUp not configured'); }

    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) { throw new Error('ClickUp comments require a task ID.'); }
    const normalizedComment = String(params?.commentText || '').trim();
    if (!normalizedComment) { throw new Error('ClickUp comments require non-empty text.'); }

    const mentions = Array.isArray(params?.mentions) ? params.mentions : [];
    const { structured, plain } = this._buildStructuredComment(normalizedComment, mentions);

    // Try structured format only if there are mentions; otherwise plain text is fine
    if (mentions.length > 0) {
      try {
        const result = await this.retry(() =>
          this.httpRequest('POST', `/task/${normalizedTaskId}/comment`, structured)
        );
        if (result.status === 200) {
          return { success: true };
        }
        // Non-200: fall back to plain text
        console.warn(`[ClickUpSync] Structured comment failed (HTTP ${result.status}), falling back to plain text.`);
      } catch (e) {
        console.warn('[ClickUpSync] Structured comment threw, falling back to plain text:', e);
      }
    }

    const commentResult = await this.retry(() =>
      this.httpRequest('POST', `/task/${normalizedTaskId}/comment`, plain)
    );
    if (commentResult.status !== 200) {
      return { success: false, error: `Failed to comment on ClickUp task ${normalizedTaskId} (HTTP ${commentResult.status}).` };
    }
    return { success: true };
  }

  /**
   * Reply to an existing comment with optional structured mentions.
   * POST /comment/{commentId}/reply — same structured format as postComment.
   */
  public async replyToComment(commentId: string, params: { commentText: string; mentions?: Array<{ id: string; name: string }> }): Promise<{ success: boolean; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) { throw new Error('ClickUp not configured'); }

    const normalizedCommentId = String(commentId || '').trim();
    if (!normalizedCommentId) { throw new Error('ClickUp reply requires a comment ID.'); }
    const normalizedComment = String(params?.commentText || '').trim();
    if (!normalizedComment) { throw new Error('ClickUp reply requires non-empty text.'); }

    const mentions = Array.isArray(params?.mentions) ? params.mentions : [];
    const { structured, plain } = this._buildStructuredComment(normalizedComment, mentions);

    if (mentions.length > 0) {
      try {
        const result = await this.retry(() =>
          this.httpRequest('POST', `/comment/${normalizedCommentId}/reply`, structured)
        );
        if (result.status === 200) {
          return { success: true };
        }
        console.warn(`[ClickUpSync] Structured reply failed (HTTP ${result.status}), falling back to plain text.`);
      } catch (e) {
        console.warn('[ClickUpSync] Structured reply threw, falling back to plain text:', e);
      }
    }

    const replyResult = await this.retry(() =>
      this.httpRequest('POST', `/comment/${normalizedCommentId}/reply`, plain)
    );
    if (replyResult.status !== 200) {
      return { success: false, error: `Failed to reply to ClickUp comment ${normalizedCommentId} (HTTP ${replyResult.status}).` };
    }
    return { success: true };
  }

  /**
   * Delete a ClickUp task via the native DELETE endpoint.
   * Used when a Switchboard plan is deleted and deleteSyncEnabled is true.
   * ClickUp DELETE /api/v2/task/{task_id} returns HTTP 204 on success.
   * A 404 means the task is already gone — treated as success-with-warning.
   */
  public async archiveTask(taskId: string): Promise<{ success: boolean; error?: string }> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      return { success: false, error: 'Task ID is required' };
    }

    try {
      const result = await this.httpRequest('DELETE', `/task/${normalizedTaskId}`);
      if (result.status === 204) {
        console.log(`[ClickUpSync] Deleted ClickUp task ${normalizedTaskId}`);
        return { success: true };
      } else if (result.status === 404) {
        // Task already deleted — treat as success
        console.warn(`[ClickUpSync] ClickUp task ${normalizedTaskId} not found (already deleted?). Continuing.`);
        return { success: true };
      } else {
        return { success: false, error: `Failed to delete task: HTTP ${result.status}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listTasksFromClickUp(listId: string): Promise<any[]> {
    const tasks: any[] = [];
    let page = 0;

    while (true) {
      const result = await this.httpRequest('GET', `/list/${listId}/task?page=${page}&subtasks=true&include_closed=false`);
      if (result.status !== 200) {
        throw new Error(`Failed to fetch ClickUp tasks for list ${listId}: ${result.status}`);
      }

      const pageTasks: any[] = result.data?.tasks || [];
      tasks.push(...pageTasks);
      if (pageTasks.length < 100) {
        break;
      }
      page++;
      await this.delay(200);
    }

    return tasks;
  }

  private _mergeWriteBackContent(existing: string, content: string, format: ClickUpWriteBackFormat): string {
    const normalizedExisting = String(existing || '').trim();
    const normalizedContent = String(content || '').trim();
    if (!normalizedExisting) {
      return normalizedContent;
    }
    if (!normalizedContent) {
      return normalizedExisting;
    }

    switch (format) {
      case 'prepend':
        return `${normalizedContent}\n\n${normalizedExisting}`;
      case 'replace':
        return normalizedContent;
      case 'append':
      default:
        return `${normalizedExisting}\n\n${normalizedContent}`;
    }
  }

  async writeBackAutomationResult(
    taskId: string,
    content: string,
    target: ClickUpWriteBackTarget,
    format: ClickUpWriteBackFormat
  ): Promise<void> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('ClickUp write-back requires a task ID.');
    }

    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) {
      throw new Error('ClickUp write-back requires non-empty content.');
    }

    if (target === 'comment') {
      const commentResult = await this.retry(() =>
        this.httpRequest('POST', `/task/${normalizedTaskId}/comment`, {
          comment_text: normalizedContent,
          notify_all: false
        })
      );
      if (commentResult.status !== 200) {
        throw new Error(`Failed to comment on ClickUp task ${normalizedTaskId}.`);
      }
      return;
    }

    const taskResult = await this.retry(() =>
      this.httpRequest('GET', `/task/${normalizedTaskId}`)
    );
    if (taskResult.status !== 200) {
      throw new Error(`Failed to load ClickUp task ${normalizedTaskId} for write-back.`);
    }

    const existingDescription = String(
      taskResult.data?.description
      ?? taskResult.data?.markdown_description
      ?? ''
    );
    const updateResult = await this.retry(() =>
      this.httpRequest('PUT', `/task/${normalizedTaskId}`, {
        description: this._mergeWriteBackContent(existingDescription, normalizedContent, format)
      })
    );
    if (updateResult.status !== 200) {
      throw new Error(`Failed to update ClickUp task ${normalizedTaskId}.`);
    }
  }

  public async attachFile(taskId: string, fileName: string, buffer: Buffer, comment?: string): Promise<{ url: string; fileName: string }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('ClickUp API token not configured'); }

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
    
    return new Promise((resolve, reject) => {
      const header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="attachment"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      
      const req = https.request({
        hostname: 'api.clickup.com',
        path: `/api/v2/task/${taskId}/attachment`,
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': header.length + buffer.length + footer.length
        }
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk.toString(); });
        res.on('end', async () => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            reject(new Error(`ClickUp attachment failed with status ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            const data = JSON.parse(raw);
            const result = {
              url: String(data?.url || '').trim(),
              fileName: String(data?.filename || fileName).trim()
            };
            
            // Post comment if provided
            if (comment) {
              await this.addTaskComment(taskId, comment).catch(err => {
                console.warn('[ClickUpSync] Failed to post comment after attachment:', err);
              });
            }
            
            resolve(result);
          } catch (err) {
            reject(new Error('Failed to parse ClickUp attachment response'));
          }
        });
      });
      
      req.on('error', reject);
      req.write(header);
      req.write(buffer);
      req.write(footer);
      req.end();
    });
  }

  public async createDocPage(params: {
    workspaceId?: string;
    docId: string;
    pageName: string;
    content: string;
    parentPageId?: string;
  }): Promise<{ id: string; url: string }> {
    let { workspaceId, docId, pageName, content, parentPageId } = params;
    
    if (!workspaceId) {
      workspaceId = await this.loadWorkspaceIdIfNeeded();
    }
    
    const body: any = {
      name: pageName,
      content: content
    };
    if (parentPageId) {
      body.parent = parentPageId;
    }
    
    const result = await this.httpRequestV3('POST', `/workspace/${workspaceId}/doc/${docId}/page`, body);
    if (result.status !== 200 && result.status !== 201) {
      throw new Error(`ClickUp doc page creation failed with status ${result.status}: ${JSON.stringify(result.data)}`);
    }
    
    return {
      id: String(result.data?.id || '').trim(),
      url: String(result.data?.url || '').trim()
    };
  }

  // ── Token Management ────────────────────────────────────────

  /**
   * Read ClickUp API token from VS Code SecretStorage.
   * Returns null if not set — callers must handle this.
   */
  async getApiToken(): Promise<string | null> {
    try {
      return await this._secretStorage.get('switchboard.clickup.apiToken') || null;
    } catch {
      return null;
    }
  }

  async hasApiToken(): Promise<boolean> {
    if (this._tokenPresentCache !== null) { return this._tokenPresentCache; }
    const token = await this.getApiToken();
    this._tokenPresentCache = !!token;
    return this._tokenPresentCache;
  }

  clearApiTokenCache(): void {
    this._tokenPresentCache = null;
  }

  private async _promptForApiToken(): Promise<string | null> {
    const inputToken = await vscode.window.showInputBox({
      prompt: 'Enter your ClickUp API token (starts with pk_)',
      password: true,
      placeHolder: 'pk_...',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length < 10) {
          return 'Token appears too short. ClickUp tokens typically start with pk_';
        }
        return null;
      }
    });
    return inputToken ? inputToken.trim() : null;
  }

  // ── HTTP Client ─────────────────────────────────────────────

  /**
   * Generic API request wrapper for LocalApiServer proxy.
   */
  async makeApiRequest(method: string, endpoint: string, query?: any, body?: any): Promise<any> {
    const apiPath = endpoint + (query ? '?' + new URLSearchParams(query).toString() : '');
    const result = await this.httpRequest(method as any, apiPath, body);
    return result.data;
  }

  /**
   * Resolve a task or list name to its ID.
   */
  async resolveNameToId(name: string): Promise<string | null> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      throw new Error('ClickUp not configured');
    }

    const normalizedName = name.trim().toLowerCase();
    
    // 1. Check mapped columns first
    for (const [column, listId] of Object.entries(config.columnMappings)) {
      if (column.toLowerCase() === normalizedName && listId) {
        return listId;
      }
    }

    // 2. Search for lists by name
    const lists = await this.findList(name);
    if (lists.length > 0) {
      // Return the first exact match, or the first partial match
      const exactMatch = lists.find(l => l.name.toLowerCase() === normalizedName);
      return exactMatch ? exactMatch.id : lists[0].id;
    }

    // 3. Search for tasks by name across all mapped lists
    for (const listId of Object.values(config.columnMappings)) {
      if (!listId) continue;
      const tasks = await this.findTask(listId, name);
      if (tasks.length > 0) {
        const exactMatch = tasks.find(t => t.name.toLowerCase() === normalizedName);
        return exactMatch ? exactMatch.id : tasks[0].id;
      }
    }

    return null;
  }

  /**
   * Authenticated HTTPS request to ClickUp REST API.
   * All extension-code ClickUp interactions go through this method.
   * Never logs the Authorization header.
   */
  async httpRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs: number = 10000,
    signal?: AbortSignal
  ): Promise<{ status: number; data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('ClickUp API token not configured'); }

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: { status: number; data: any }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: 'api.clickup.com',
        path: `/api/v2${apiPath}`,
        method,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('error', (err) => safeReject(new Error(`ClickUp response stream error: ${err.message}`)));
        res.on('aborted', () => safeReject(new Error('ClickUp response aborted by server')));
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            safeResolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            safeResolve({ status: res.statusCode || 0, data: raw });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); safeReject(new Error('Request timed out')); });
      req.on('error', (err) => safeReject(err));

      // Wire up AbortController cancellation
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('AbortError'));
          return safeReject(new Error('AbortError'));
        }
        const abortHandler = () => {
          req.destroy(new Error('AbortError'));
          safeReject(new Error('AbortError'));
        };
        signal.addEventListener('abort', abortHandler);
        req.on('close', () => signal.removeEventListener('abort', abortHandler));
      }

      if (payload) { req.write(payload); }
      req.end();
    });
  }

  /**
   * Authenticated HTTPS request to ClickUp REST API v3.
   * Used for document operations (docs, pages, etc.).
   * Never logs the Authorization header.
   */
  async httpRequestV3(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    apiPath: string,
    body?: Record<string, unknown>,
    timeoutMs: number = 10000,
    signal?: AbortSignal
  ): Promise<{ status: number; data: any }> {
    const token = await this.getApiToken();
    if (!token) { throw new Error('ClickUp API token not configured'); }

    return new Promise((resolve, reject) => {
      let settled = false;
      const safeResolve = (value: { status: number; data: any }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request({
        hostname: 'api.clickup.com',
        path: `/api/v3${apiPath}`,
        method,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: timeoutMs
      }, (res) => {
        let raw = '';
        res.on('error', (err) => safeReject(new Error(`ClickUp v3 response stream error: ${err.message}`)));
        res.on('aborted', () => safeReject(new Error('ClickUp v3 response aborted by server')));
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            safeResolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            safeResolve({ status: res.statusCode || 0, data: raw });
          }
        });
      });
      req.on('timeout', () => { req.destroy(); safeReject(new Error('Request timed out')); });
      req.on('error', (err) => safeReject(err));

      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('AbortError'));
          return safeReject(new Error('AbortError'));
        }
        const abortHandler = () => {
          req.destroy(new Error('AbortError'));
          safeReject(new Error('AbortError'));
        };
        signal.addEventListener('abort', abortHandler);
        req.on('close', () => signal.removeEventListener('abort', abortHandler));
      }

      if (payload) { req.write(payload); }
      req.end();
    });
  }

  // ── Availability Check ──────────────────────────────────────

  /**
   * Check if ClickUp is configured and reachable.
   * Uses a 2-second timeout to avoid blocking UI.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const token = await this.getApiToken();
      if (!token) { return false; }
      const result = await this.httpRequest('GET', '/team', undefined, 2000);
      return result.status === 200;
    } catch {
      return false;
    }
  }

  // ── Utilities ───────────────────────────────────────────────

  get setupInProgress(): boolean { return this._setupInProgress; }
  set setupInProgress(v: boolean) { this._setupInProgress = v; }

  get isSyncInProgress(): boolean { return this._isSyncInProgress; }
  set isSyncInProgress(v: boolean) { this._isSyncInProgress = v; }

  get consecutiveFailures(): number { return this._consecutiveFailures; }

  get debounceTimers(): Map<string, NodeJS.Timeout> { return this._debounceTimers; }
  get batchSize(): number { return this._batchSize; }
  get rateLimitDelay(): number { return this._rateLimitDelay; }
  get configPath(): string { return this._configPath; }
  get workspaceRoot(): string { return this._workspaceRoot; }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  async retry<T>(fn: () => Promise<T>, retries: number = this._maxRetries): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) { throw error; }
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
    throw new Error('Max retries exceeded');
  }

  // ── Setup Flow ──────────────────────────────────────────────

  async applyConfig(options: ClickUpApplyOptions): Promise<{ success: boolean; error?: string }> {
    if (this.setupInProgress) {
      return { success: false, error: 'Setup already in progress' };
    }
    this.setupInProgress = true;

    const previousConfig = await this.loadConfig();
    const config = previousConfig
      ? JSON.parse(JSON.stringify(previousConfig)) as ClickUpConfig
      : this._createEmptyConfig();
    let folderWasCreated = false;

    try {
      let token = await this.getApiToken();
      if (!token) {
        token = await this._promptForApiToken();
        if (!token) {
          return { success: false, error: 'Setup cancelled — ClickUp API token required.' };
        }
        await this._secretStorage.store('switchboard.clickup.apiToken', token);
        this._tokenPresentCache = true;
      }

      const requestedColumns = this._normalizeColumns(options.columns, config);
      const wantsProvisioning = options.createFolder || options.createLists || options.createCustomFields || options.enableRealtimeSync;
      const hasExistingSetup = !!config.folderId || this._hasMappedLists(config) || Object.values(config.customFields).some(Boolean) || config.setupComplete;

      if (!config.workspaceId) {
        config.workspaceId = await this._loadWorkspaceId();
      }

      const needsFolder = options.createFolder || options.createLists || options.createCustomFields || options.enableRealtimeSync;
      if (needsFolder && !config.folderId && !config.spaceId) {
        await this._ensureWorkspaceAndSpace(config);
      }

      if (needsFolder) {
        const folderResult = await this._ensureFolder(config, options.createFolder);
        folderWasCreated = folderResult.created;
      }

      if (!options.createFolder && !config.folderId && (options.createLists || options.createCustomFields || options.enableRealtimeSync)) {
        return {
          success: false,
          error: 'ClickUp needs an existing "AI Agents" folder. Enable folder creation or reuse an existing folder first.'
        };
      }

      if (options.createLists) {
        await this._ensureColumnMappings(config, requestedColumns);
      }

      if (options.createCustomFields) {
        if (!this._hasMappedLists(config)) {
          throw new Error('Create custom fields requires at least one mapped ClickUp list.');
        }
        await this._ensureCustomFields(config);
      }

      if (options.enableRealtimeSync) {
        if (!config.folderId) {
          throw new Error('Realtime sync requires an existing ClickUp folder.');
        }
        if (!this._hasMappedLists(config)) {
          throw new Error('Realtime sync requires at least one mapped ClickUp list.');
        }
      }

      if (options.enableAutoPull && !this._hasMappedLists(config)) {
        throw new Error('Auto-pull requires at least one mapped ClickUp list.');
      }

      config.realTimeSyncEnabled = options.enableRealtimeSync === true;
      config.autoPullEnabled = options.enableAutoPull === true;
      config.setupComplete = true;
      await this.saveConfig(config);
      return { success: true };
    } catch (error) {
      if (folderWasCreated) {
        await this._cleanup(config, previousConfig);
      }
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    } finally {
      this.setupInProgress = false;
    }
  }

  /**
   * Clean up ClickUp resources on setup failure.
   * Deleting the folder cascades to child lists.
   */
  private async _cleanup(config: ClickUpConfig, previousConfig?: ClickUpConfig | null): Promise<void> {
    if (config.folderId) {
      try {
        await this.httpRequest('DELETE', `/folder/${config.folderId}`);
      } catch { /* best-effort */ }
    }
    if (previousConfig) {
      await this.saveConfig(previousConfig);
      return;
    }
    try {
      await GlobalIntegrationConfigService.clearConfig('clickup');
      this._config = null;
    } catch { /* ignore */ }
  }

  // ── Sync Methods ────────────────────────────────────────────

  /**
   * Sync a single plan to ClickUp (Switchboard → ClickUp only).
   * Guarded by _isSyncInProgress to prevent circular loops.
   */
  async syncPlan(plan: KanbanPlanRecord): Promise<ClickUpSyncResult> {
    if (this.isSyncInProgress) {
      return { success: false, error: 'Sync already in progress (loop guard)' };
    }
    this.isSyncInProgress = true;

    try {
      const config = await this.loadConfig();
      if (!config || !config.setupComplete) {
        return { success: false, error: 'ClickUp not set up' };
      }
      if (!(await this.hasApiToken())) {
        return { success: false, error: 'ClickUp API token not configured' };
      }

      // §4 — completeSyncEnabled gate. When off, automatic terminal-column transitions
      // are not pushed to ClickUp. Manual dispatch (changeTicketStatus) stays untouched.
      const terminalColumn = ['DONE', 'COMPLETED', 'ARCHIVED'].includes((plan.kanbanColumn || '').toUpperCase());
      if (config.completeSyncEnabled === false && terminalColumn) {
        console.log(`[ClickUpSync] completeSyncEnabled is off — skipping ${plan.kanbanColumn} sync for plan ${plan.planFile}`);
        return { success: true, skippedReason: 'complete-sync-disabled' };
      }

      const listId = config.columnMappings[plan.kanbanColumn];
      if (!listId) {
        const skippedReason: ClickUpSyncSkipReason = this._hasExplicitColumnMapping(config, plan.kanbanColumn)
          ? 'excluded-column'
          : 'unmapped-column';
        const warning = skippedReason === 'excluded-column'
          ? `ClickUp sync is excluded for column '${plan.kanbanColumn}'.`
          : `ClickUp column '${plan.kanbanColumn}' is not mapped to any ClickUp list.`;
        console.warn(`[ClickUpSync] ${warning}`);
        return {
          success: true,
          warning,
          skippedReason
        };
      }

      const planContent = await this._readPlanContent(plan.planFile);
      const existingTaskId =
        String(plan.clickupTaskId || '').trim()
        || await this._findTaskByPlanId(plan.planId, config);

      if (existingTaskId) {
        await this._updateTask(existingTaskId, plan, config, planContent);
        this._consecutiveFailures = 0;
        return { success: true, taskId: existingTaskId };
      } else {
        const taskId = await this._createTask(listId, plan, config, planContent);
        this._consecutiveFailures = 0;
        return { success: true, taskId: taskId || undefined };
      }
    } catch (error) {
      this._consecutiveFailures++;
      return { success: false, error: `Sync failed: ${error}` };
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Sync plan markdown content to ClickUp task description.
   * Used by ContinuousSyncService for live updates.
   * Does NOT change task status, list, or custom fields.
   */
  async syncPlanContent(taskId: string, markdownContent: string, signal?: AbortSignal): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await this.loadConfig();
      if (!config?.setupComplete) {
        return { success: false, error: 'ClickUp not set up' };
      }
      if (!(await this.hasApiToken())) {
        return { success: false, error: 'ClickUp API token not configured' };
      }

      // Convert markdown to ClickUp description format (if needed)
      // ClickUp API accepts markdown directly in description field
      const response = await this.httpRequest('PUT', `/task/${taskId}`, {
        description: markdownContent
      }, 10000, signal);

      if (response.status === 200) {
        return { success: true };
      } else {
        return { success: false, error: `ClickUp API error: ${response.status}` };
      }
    } catch (error) {
      return { success: false, error: `Sync failed: ${error}` };
    }
  }

  /**
   * Find an existing ClickUp task for a Switchboard plan.
   * Primary: custom field filter. Fallback: tag-based search.
   */
  private async _findTaskByPlanId(planId: string, config: ClickUpConfig): Promise<string | null> {
    if (config.customFields.planId) {
      try {
        const result = await this.httpRequest('GET',
          `/team/${config.workspaceId}/task` +
          `?custom_fields=[{"field_id":"${config.customFields.planId}","operator":"=","value":"${planId}"}]` +
          `&include_closed=true`
        );
        if (result.status === 200 && result.data?.tasks?.length > 0) {
          return result.data.tasks[0].id;
        }
      } catch { /* fall through to tag search */ }
    }

    try {
      const result = await this.httpRequest('GET',
        `/team/${config.workspaceId}/task?tags[]=switchboard:${encodeURIComponent(planId)}&include_closed=true`
      );
      if (result.status === 200 && result.data?.tasks?.length > 0) {
        return result.data.tasks[0].id;
      }
    } catch { /* not found */ }

    return null;
  }

  /**
   * Create a new ClickUp task from a Switchboard plan record.
   */
  private async _createTask(listId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<string | null> {
    // Map complexity to ClickUp priority: 1=urgent, 2=high, 3=normal, 4=low
    const complexityNum = parseInt(plan.complexity, 10) || 5;
    const priority = complexityNum >= 8 ? 2 : complexityNum >= 5 ? 3 : 4;

    // Sanitize description: use file content if available, else strip HTML from topic
    const description = planContent || (plan.topic || '').replace(/<[^>]*>/g, '');

    const tags = plan.tags
      ? plan.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    tags.push(`switchboard:${plan.planId}`);

    const body: Record<string, unknown> = {
      name: plan.topic || `Plan ${plan.planId}`,
      description: `${description}\n\n---\n[Switchboard] PlanFile: ${plan.planFile} | Plan: ${plan.planId}`,
      priority,
      tags,
      custom_fields: [
        ...(config.customFields.sessionId
          ? [{ id: config.customFields.sessionId, value: plan.planFile }] : []),
        ...(config.customFields.planId
          ? [{ id: config.customFields.planId, value: plan.planId }] : []),
        ...(config.customFields.syncTimestamp
          ? [{ id: config.customFields.syncTimestamp, value: Date.now() }] : [])
      ]
    };

    this._pendingCreateSessions.add(plan.planFile);
    try {
      const result = await this.retry(() =>
        this.httpRequest('POST', `/list/${listId}/task`, body)
      );
      if (result.status === 200) {
        const taskId = result.data.id;
        if (description) {
          try {
            const resolvedPlanPath = path.isAbsolute(plan.planFile)
              ? plan.planFile
              : path.join(this._workspaceRoot, plan.planFile);
            const { rewritten } = await hostInlineImages(
              (fileName, buffer) => this.attachFile(taskId, fileName, buffer),
              description,
              resolvedPlanPath
            );
            if (rewritten !== description) {
              await this.updateTask(taskId, { markdown_content: rewritten });
            }
          } catch (hostErr) {
            console.warn(`[ClickUpSync] Created task ${taskId} from plan, but inline image hosting failed:`, hostErr);
          }
        }
      }
      return result.status === 200 ? result.data.id : null;
    } finally {
      // Always clear, even on throw. The autopull reads this set and must see
      // a consistent view once the HTTP path has resolved one way or the other.
      this._pendingCreateSessions.delete(plan.planFile);
    }
  }

  /**
   * Update an existing ClickUp task and move it to the correct list
   * if the kanban column has changed.
   */
  private async _updateTask(taskId: string, plan: KanbanPlanRecord, config: ClickUpConfig, planContent: string): Promise<void> {
    const body: Record<string, unknown> = {
      name: plan.topic || `Plan ${plan.planId}`,
      custom_fields: [
        ...(config.customFields.sessionId
          ? [{ id: config.customFields.sessionId, value: plan.planFile }] : []),
        ...(config.customFields.planId
          ? [{ id: config.customFields.planId, value: plan.planId }] : []),
        ...(config.customFields.syncTimestamp
          ? [{ id: config.customFields.syncTimestamp, value: Date.now() }] : [])
      ]
    };

    if (planContent) {
      // WRITE field is `markdown_content`; `markdown_description` is read-only.
      body.markdown_content = `${planContent}\n\n---\n[Switchboard] PlanFile: ${plan.planFile} | Plan: ${plan.planId}`;
    }

    await this.retry(() =>
      this.httpRequest('PUT', `/task/${taskId}`, body)
    );

    // Move task to correct list if column changed
    const targetListId = config.columnMappings[plan.kanbanColumn];
    if (targetListId) {
      try {
        await this.retry(() =>
          this.httpRequest('POST', `/list/${targetListId}/task/${taskId}`)
        );
      } catch (err) {
        console.warn(`[ClickUpSync] Failed to move task ${taskId} to list ${targetListId}:`, err);
      }
    }
  }

  private async _readPlanContent(planFile: string): Promise<string> {
    if (!planFile) { return ''; }
    try {
      const filePath = path.isAbsolute(planFile)
        ? planFile
        : path.join(this._workspaceRoot, planFile);
      const content = await fs.promises.readFile(filePath, 'utf8');
      return content.slice(0, 50000);
    } catch {
      return '';
    }
  }

  /**
   * Batch sync all plans in a column with rate limiting.
   */
  async syncColumn(column: string, plans: KanbanPlanRecord[]): Promise<{ success: boolean; synced: number; errors: number }> {
    const config = await this.loadConfig();
    if (!config || !config.setupComplete) {
      return { success: false, synced: 0, errors: 0 };
    }

    let synced = 0;
    let errors = 0;
    const batches = this.chunkArray(plans, this.batchSize);

    for (const batch of batches) {
      for (const plan of batch) {
        const result = await this.syncPlan(plan);
        if (result.success) { synced++; } else { errors++; }
      }
      await this.delay(this.rateLimitDelay);
    }

    config.lastSync = new Date().toISOString();
    await this.saveConfig(config);
    return { success: true, synced, errors };
  }

  /**
   * Debounced sync for move events.
   * Rapid moves within 500ms are coalesced — only the final position syncs.
   */
  debouncedSync(
    planFile: string,
    plan: KanbanPlanRecord,
    onComplete?: (result: ClickUpSyncResult) => void
  ): void {
    const existing = this.debounceTimers.get(planFile);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(async () => {
      const result = await this.syncPlan(plan);
      onComplete?.(result);
      this.debounceTimers.delete(planFile);
    }, 500);

    this.debounceTimers.set(planFile, timer);
  }

  /**
   * Fetch tasks from a ClickUp list and write a stub plan .md file for each.
   * The PlanFileImporter picks up new files automatically — no DB calls needed.
   * Skips tasks that already have a plan file or are owned by Switchboard (switchboard: tag).
   */
  async importTasksFromClickUp(
    listId: string,
    plansDir: string
  ): Promise<{ success: boolean; imported: number; skipped: number; error?: string }> {
    const config = await this.loadConfig();
    if (!config?.setupComplete) {
      return { success: false, imported: 0, skipped: 0, error: 'ClickUp not set up' };
    }

    try {
      const tasks = await this.listTasksFromClickUp(listId);

      await fs.promises.mkdir(plansDir, { recursive: true });

      // Dedup: skip tasks that correspond to a local session with an
      // in-flight _createTask HTTP call. ClickUp has no local sync map, so we
      // use the in-memory _pendingCreateSessions set.
      //
      // IMPORTANT: the dynamic import path must NOT carry a `.js` suffix.
      // Webpack (module: Node16) cannot resolve `./KanbanDatabase.js` against
      // the TS source tree and emits "Module not found"; at runtime the
      // import rejects, which would take down the entire auto-pull path if
      // left unguarded. We also wrap the preamble in try/catch so a DB
      // bootstrap hiccup degrades to "skip dedup" rather than aborting the
      // import.
      let db: import('./KanbanDatabase').KanbanDatabase | null = null;
      let dbReady = false;
      let workspaceId = '';
      try {
        // AI NOTICE: DO NOT append .js to this import. tsc complains about Node16 module resolution, but Webpack requires it to be extensionless here to bundle correctly.
        const kdbModule = await import('./KanbanDatabase');
        const resolved = kdbModule.KanbanDatabase.forWorkspace(this._workspaceRoot);
        const ready = await resolved.ensureReady();
        db = resolved;
        dbReady = ready;
        workspaceId = ready ? (await resolved.getWorkspaceId()) || '' : '';
      } catch (dedupInitErr) {
        console.warn('[ClickUpSync] Dedup preamble failed; continuing without dedup:', dedupInitErr);
      }
      const planIdCustomFieldId = config.customFields.planId;

      // Build lookup map from the flat task list
      const taskNameById = new Map<string, string>(tasks.map((t: any) => [t.id, t.name]));

      let imported = 0;
      let skipped = 0;

      for (const task of tasks) {
        // Extract planId from custom field or switchboard:<planId> tag.
        let taskPlanId: string | null = null;
        if (planIdCustomFieldId) {
          const cf = (task.custom_fields || []).find((f: any) => f?.id === planIdCustomFieldId);
          const cfVal = cf && (cf.value ?? null);
          if (typeof cfVal === 'string' && cfVal.length > 0) { taskPlanId = cfVal; }
        }
        if (!taskPlanId) {
          const swTag = (task.tags || []).find((t: any) => typeof t?.name === 'string' && t.name.toLowerCase().startsWith('switchboard:'));
          if (swTag) { taskPlanId = String(swTag.name).slice('switchboard:'.length) || null; }
        }

        // If this task was just created by us and the taskId hasn't landed in
        // the plan record yet, the _pendingCreateSessions set will contain its
        // planFile. Skip.
        //
        // Only run the lookup when db resolved successfully. `getPlanByPlanId`
        // is a real public method on KanbanDatabase; prefer it directly over a
        // non-existent planFile path guess.
        if (taskPlanId && dbReady && db) {
          try {
            const localPlan = await db.getPlanByPlanId(taskPlanId);
            if (localPlan && this._pendingCreateSessions.has(localPlan.planFile)) {
              skipped++;
              continue;
            }
          } catch { /* fall through — dedup is best-effort */ }
        }

        // Title-fallback for the narrow window where planId custom field hasn't
        // been set yet (ClickUp eventually-consistent custom field propagation).
        if (!taskPlanId && this._pendingCreateSessions.size > 0 && dbReady && db && workspaceId) {
          const localPlan = await db.getPlanByTopic(task.name || '', workspaceId);
          if (localPlan && this._pendingCreateSessions.has(localPlan.planFile)) {
            skipped++;
            continue;
          }
        }

        // Skip tasks already owned by Switchboard (existing behavior)
        const hasSwitchboardTag = (task.tags || []).some((t: any) => t.name?.toLowerCase().startsWith('switchboard:'));
        if (hasSwitchboardTag) { skipped++; continue; }

        const handledByAutomation = config.automationRules.some((rule) =>
          matchesClickUpAutomationRule(task, listId, rule)
        );
        if (handledByAutomation) { skipped++; continue; }

        // Determine initial kanban column: backlog status → BACKLOG, everything else → CREATED
        const statusName = (task.status?.status || '').toLowerCase().trim();

        // Optional backlog filter: skip tasks named "backlog" if excludeBacklog is enabled.
        if (config.excludeBacklog === true && statusName === 'backlog') {
          skipped++;
          continue;
        }

        const planFile = path.join(plansDir, `clickup_import_${task.id}.md`);

        // Core fields
        const priority = task.priority?.priority || '';
        const dueDate = task.due_date ? new Date(Number(task.due_date)).toLocaleDateString() : '';
        const assignees = (task.assignees || []).map((a: any) => a.username || a.email || a.id).join(', ');
        const tags = (task.tags || [])
          .map((t: any) => t.name)
          .filter((n: string) => n && !n.toLowerCase().startsWith('switchboard:'))
          .join(', ');
        const description = (task.markdown_description || task.description || '').trim();
        const parentName = task.parent ? (taskNameById.get(task.parent) || task.parent) : '';

        // §5 — land backlog tasks in BACKLOG, everything else in CREATED.
        const kanbanColumn = statusName === 'backlog' ? 'BACKLOG' : 'CREATED';

        // Metadata block (top of file)
        const metaLines = [
          `> Imported from ClickUp task \`${task.id}\``,
          `> **ClickUp Task ID:** ${task.id}`,
          task.url   ? `> **URL:** ${task.url}`                       : '',
          parentName ? `> **Parent Task:** ${parentName}`             : '',
          priority   ? `> **Priority:** ${priority}`                  : '',
          dueDate    ? `> **Due:** ${dueDate}`                        : '',
          assignees  ? `> **Assignees:** ${assignees}`                : '',
          tags       ? `> **Tags:** ${tags}`                          : '',
        ].filter(Boolean).join('\n');

        const stub = [
          `# ${task.name || `ClickUp Task ${task.id}`}`,
          '',
          `kanbanColumn: ${kanbanColumn}`,
          '',
          metaLines,
          '',
          description || '',
        ].join('\n');

        await fs.promises.writeFile(planFile, stub, 'utf8');
        imported++;
      }

      return { success: true, imported, skipped };
    } catch (error) {
      return { success: false, imported: 0, skipped: 0, error: `Import failed: ${error}` };
    }
  }
}
