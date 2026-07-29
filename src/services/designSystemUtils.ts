import * as fs from 'fs';
import * as path from 'path';
import { sanitizeProjectSlug } from './prdUtils';
import type { KanbanDatabase } from './KanbanDatabase';

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

export async function migrateLegacyDesignSystemIfNeeded(
    workspaceRoot: string,
    db: KanbanDatabase,
    pathConfig: { getConfigBoolean(key: string, defaultValue: boolean): boolean; getConfigString(key: string): string }
): Promise<void> {
    try {
        await db.ensureReady();
        const stamp = await db.getConfig('ds_legacy_migration_done');
        if (stamp === 'true') return;

        // Legacy released keys — consumed once here, never consulted for injection
        // again. Their stored values are deliberately left in place (downgrade-safe,
        // and re-running this migration is a no-op rewrite of the same pointers).
        const dsEnabled = pathConfig.getConfigBoolean('planner.designSystemDocEnabled', false);
        const dsLink = (pathConfig.getConfigString('planner.designSystemDocLink') || '').trim();

        if (dsEnabled && dsLink) {
            if (!fs.existsSync(dsLink)) {
                // Configured but currently unreadable (unmounted volume, moved file).
                // Do NOT stamp — stamping now would silently drop the user's
                // configuration forever; retrying next dispatch costs one stat.
                return;
            }
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) {
                // No workspace row yet — retry on a later dispatch rather than
                // stamping an empty migration over a configured design system.
                return;
            }
            const projectNames = await db.getProjects(workspaceId);
            for (const projectName of projectNames) {
                if (projectName) {
                    await setProjectDesignSystemPath(workspaceRoot, projectName, dsLink);
                }
            }
        }

        await db.setConfig('ds_legacy_migration_done', 'true');
    } catch (err) {
        console.error('[DesignSystem] Legacy migration failed:', err);
    }
}
