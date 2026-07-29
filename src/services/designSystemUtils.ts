import * as fs from 'fs';
import * as path from 'path';
import { sanitizeProjectSlug } from './prdUtils';
import { KanbanDatabase } from './KanbanDatabase';

export function getProjectDesignSystemPointerPath(workspaceRoot: string, projectName: string): string {
    const slug = sanitizeProjectSlug(projectName);
    return path.join(workspaceRoot, '.switchboard', 'projects', slug, 'design-system.json');
}

export async function getProjectDesignSystemPath(workspaceRoot: string, projectName: string): Promise<string | null> {
    const pointerPath = getProjectDesignSystemPointerPath(workspaceRoot, projectName);
    try {
        if (!fs.existsSync(pointerPath)) return null;
        const raw = await fs.promises.readFile(pointerPath, 'utf8');
        const json = JSON.parse(raw);
        if (!json || typeof json.path !== 'string') return null;
        const targetPath = path.isAbsolute(json.path)
            ? json.path
            : path.resolve(workspaceRoot, json.path);
        if (fs.existsSync(targetPath)) {
            return targetPath;
        }
        return null;
    } catch {
        return null;
    }
}

export async function setProjectDesignSystemPath(workspaceRoot: string, projectName: string, designSystemPath: string): Promise<void> {
    const pointerPath = getProjectDesignSystemPointerPath(workspaceRoot, projectName);
    const dir = path.dirname(pointerPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const relative = path.relative(workspaceRoot, designSystemPath);
    const storedPath = (!relative.startsWith('..') && !path.isAbsolute(relative))
        ? relative
        : designSystemPath;

    await fs.promises.writeFile(pointerPath, JSON.stringify({ path: storedPath }, null, 2), 'utf8');
}

export async function removeProjectDesignSystemPath(workspaceRoot: string, projectName: string): Promise<void> {
    const pointerPath = getProjectDesignSystemPointerPath(workspaceRoot, projectName);
    try {
        if (fs.existsSync(pointerPath)) {
            await fs.promises.unlink(pointerPath);
        }
    } catch {}
}

export async function migrateLegacyDesignSystemIfNeeded(workspaceRoot: string, db: KanbanDatabase, pathConfig: any): Promise<void> {
    try {
        await db.ensureReady();
        const stamp = await db.getConfigValue('ds_legacy_migration_done');
        if (stamp === 'true') return;

        const dsEnabled = pathConfig?.getConfigBoolean ? pathConfig.getConfigBoolean('planner.designSystemDocEnabled', false) : false;
        const dsLink = pathConfig?.getConfigString ? pathConfig.getConfigString('planner.designSystemDocLink') : null;

        if (dsEnabled && dsLink && fs.existsSync(dsLink)) {
            const projects = await db.getProjects();
            for (const proj of projects) {
                if (proj.name) {
                    await setProjectDesignSystemPath(workspaceRoot, proj.name, dsLink);
                }
            }
        }

        await db.setConfigValue('ds_legacy_migration_done', 'true');
    } catch (err) {
        console.error('[DesignSystem] Legacy migration failed:', err);
    }
}
