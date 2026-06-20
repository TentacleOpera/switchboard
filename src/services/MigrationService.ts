import * as vscode from 'vscode';
import * as path from 'path';
import { KanbanDatabase } from './KanbanDatabase';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';

export class MigrationService {
    public static async runMigration(): Promise<void> {
        try {
            const globalConfig = await GlobalIntegrationConfigService.loadGlobal();
            if (globalConfig.migrationComplete === true) {
                return;
            }

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return;
            }

            console.log('[MigrationService] Running migration for workspace folders...');

            let migratedClickup: any = null;
            let migratedLinear: any = null;
            let migratedNotion: any = null;
            let migratedTicketsFolderPath: string | null = null;
            let migratedAutoSync: boolean | undefined = undefined;

            const roots: string[] = [];
            for (const folder of workspaceFolders) {
                const workspaceRoot = path.resolve(folder.uri.fsPath);
                let effective = workspaceRoot;
                try {
                    const { resolveEffectiveWorkspaceRootFromMappings } = require('./WorkspaceIdentityService');
                    effective = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
                } catch {}
                roots.push(effective);
            }

            for (const root of roots) {
                const db = KanbanDatabase.forWorkspace(root);
                
                // Clickup Config
                if (!migratedClickup) {
                    const clickup = await db.getConfigJson<any>('clickup.config', null);
                    if (clickup && Object.keys(clickup).length > 0 && !clickup._migrated) {
                        migratedClickup = clickup;
                    }
                }

                // Linear Config
                if (!migratedLinear) {
                    const linear = await db.getConfigJson<any>('linear.config', null);
                    if (linear && Object.keys(linear).length > 0 && !linear._migrated) {
                        migratedLinear = linear;
                    }
                }

                // Notion Config
                if (!migratedNotion) {
                    const notion = await db.getConfigJson<any>('notion.config', null);
                    if (notion && Object.keys(notion).length > 0 && !notion._migrated) {
                        migratedNotion = notion;
                    }
                }

                // Tickets paths
                const folderPaths = await db.getConfigJson<any>('folders.paths', null);
                if (folderPaths) {
                    if (!migratedTicketsFolderPath && folderPaths.ticketsFolderPaths && folderPaths.ticketsFolderPaths.length > 0) {
                        migratedTicketsFolderPath = folderPaths.ticketsFolderPaths[0];
                    }
                    if (migratedAutoSync === undefined && folderPaths.ticketsAutoSync !== undefined) {
                        migratedAutoSync = folderPaths.ticketsAutoSync === true;
                    }
                }
            }

            // If we migrated configs, construct global shapes
            const clickupData = migratedClickup || {};
            const linearData = migratedLinear || {};
            const notionData = migratedNotion || {};

            if (migratedTicketsFolderPath) {
                if (!clickupData.ticketSaveLocation) {
                    clickupData.ticketSaveLocation = migratedTicketsFolderPath;
                }
                if (!linearData.ticketSaveLocation) {
                    linearData.ticketSaveLocation = migratedTicketsFolderPath;
                }
            }

            globalConfig.clickup = clickupData;
            globalConfig.linear = linearData;
            globalConfig.notion = notionData;
            globalConfig.ticketsAutoSync = migratedAutoSync !== undefined ? migratedAutoSync : false;
            globalConfig.migrationComplete = true;

            await GlobalIntegrationConfigService.saveGlobal(globalConfig);

            // Archive the DB keys
            const migratedAt = new Date().toISOString();
            const archivePayload = { _migrated: true, _migratedAt: migratedAt };

            for (const root of roots) {
                const db = KanbanDatabase.forWorkspace(root);
                const clickup = await db.getConfigJson<any>('clickup.config', null);
                if (clickup && !clickup._migrated) {
                    await db.setConfigJson('clickup.config', archivePayload);
                }
                const linear = await db.getConfigJson<any>('linear.config', null);
                if (linear && !linear._migrated) {
                    await db.setConfigJson('linear.config', archivePayload);
                }
                const notion = await db.getConfigJson<any>('notion.config', null);
                if (notion && !notion._migrated) {
                    await db.setConfigJson('notion.config', archivePayload);
                }
            }

            console.log('[MigrationService] Migration completed successfully.');
        } catch (err) {
            console.error('[MigrationService] Migration failed:', err);
        }
    }
}
