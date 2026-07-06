import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class WorkspaceExcludeService {
    private static readonly BLOCK_START = '# >>> Switchboard managed exclusions >>>';
    private static readonly BLOCK_END = '# <<< Switchboard managed exclusions <<<';
    private static readonly DEFAULT_RULES: string[] = [];
    private static readonly TARGETED_RULES: string[] = [
        '# Switchboard runtime state (per-session, not shareable)',
        '.switchboard/*',
        '!.switchboard/reviews/',
        '!.switchboard/plans/',
        '!.switchboard/features/',
        '!.switchboard/sessions/',
        '!.switchboard/CLIENT_CONFIG.md',
        '!.switchboard/README.md',
        '!.switchboard/SWITCHBOARD_PROTOCOL.md',
        '',
        '# Notion page content cache',
        '.switchboard/notion-cache.md',
        '',
        '# kanban.db is machine-local state that differs per developer — never commit it.',
        '# The recursive globs also block a stray SQLite DB accidentally created in a',
        '# subdir (e.g. plans/ or features/) when sqlite3 is run from the wrong cwd.',
        '.switchboard/kanban.db',
        '.switchboard/**/*.db',
        '.switchboard/**/*.db-shm',
        '.switchboard/**/*.db-wal',
    ];

    constructor(private readonly workspaceRoot: string) {}

    public static normalizeStrategy(rawStrategy: unknown): 'targetedGitignore' | 'localExclude' | 'custom' | 'none' {
        if (
            rawStrategy === 'targetedGitignore'
            || rawStrategy === 'localExclude'
            || rawStrategy === 'custom'
            || rawStrategy === 'none'
        ) {
            return rawStrategy;
        }

        return 'targetedGitignore';
    }

    private _renderManagedBlock(rules: string[]): string {
        return [
            WorkspaceExcludeService.BLOCK_START,
            ...rules,
            WorkspaceExcludeService.BLOCK_END
        ].join('\n');
    }

    private async _readTargetFile(targetFile: string): Promise<string> {
        try {
            return await fs.promises.readFile(targetFile, 'utf-8');
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return '';
            }
            throw error;
        }
    }

    private _replaceManagedBlock(existingContent: string, nextBlock: string | null): string {
        const normalized = existingContent.replace(/\r\n/g, '\n');
        const escapedStart = WorkspaceExcludeService.BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedEnd = WorkspaceExcludeService.BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const blockPattern = new RegExp('\\n?' + escapedStart + '[\\s\\S]*?' + escapedEnd + '\\n?', 'm');
        const trimmedBlock = nextBlock ? nextBlock.trimEnd() : '';

        if (blockPattern.test(normalized)) {
            const replaced = trimmedBlock
                ? normalized.replace(blockPattern, '\n' + trimmedBlock + '\n')
                : normalized.replace(blockPattern, '\n');
            const collapsed = replaced.replace(/\n{3,}/g, '\n\n').trimEnd();
            return collapsed ? collapsed + '\n' : '';
        }

        if (!trimmedBlock) {
            return existingContent;
        }

        const base = normalized.trimEnd();
        return base ? base + '\n\n' + trimmedBlock + '\n' : trimmedBlock + '\n';
    }

    private async _upsertManagedBlock(targetFile: string, rules: string[]): Promise<void> {
        const existingContent = await this._readTargetFile(targetFile);
        const nextContent = this._replaceManagedBlock(existingContent, this._renderManagedBlock(rules));
        if (nextContent === existingContent) {
            return;
        }
        await fs.promises.writeFile(targetFile, nextContent, 'utf-8');
    }

    private async _removeManagedBlock(targetFile: string): Promise<void> {
        const existingContent = await this._readTargetFile(targetFile);
        const nextContent = this._replaceManagedBlock(existingContent, null);
        if (nextContent === existingContent) {
            return;
        }
        await fs.promises.writeFile(targetFile, nextContent, 'utf-8');
    }

    async apply(): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard.workspace');
        const strategy = WorkspaceExcludeService.normalizeStrategy(
            config.get('ignoreStrategy', 'targetedGitignore')
        );
        const storedRules: string[] = config.get('ignoreRules', WorkspaceExcludeService.DEFAULT_RULES);
        const gitRoot = path.join(this.workspaceRoot, '.git');
        const hasGitDir = fs.existsSync(gitRoot) && fs.statSync(gitRoot).isDirectory();
        const gitignoreFile = path.join(this.workspaceRoot, '.gitignore');
        const excludeFile = hasGitDir ? path.join(gitRoot, 'info', 'exclude') : null;

        if (excludeFile) {
            fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
        }

        if (strategy === 'targetedGitignore') {
            await this._upsertManagedBlock(gitignoreFile, WorkspaceExcludeService.getTargetedRules());
            if (excludeFile) {
                await this._removeManagedBlock(excludeFile);
            }
            return;
        }

        if (strategy === 'localExclude') {
            await this._removeManagedBlock(gitignoreFile);
            if (!excludeFile) {
                console.log('[WorkspaceExcludeService] No .git directory found — skipping local exclude management.');
                return;
            }
            await this._upsertManagedBlock(excludeFile, storedRules);
            return;
        }

        if (strategy === 'custom') {
            await this._upsertManagedBlock(gitignoreFile, storedRules);
            if (excludeFile) {
                await this._removeManagedBlock(excludeFile);
            }
            return;
        }

        if (strategy === 'none') {
            await this._removeManagedBlock(gitignoreFile);
            if (excludeFile) {
                await this._removeManagedBlock(excludeFile);
            }
            return;
        }

        console.warn('[WorkspaceExcludeService] Unknown strategy "' + String(strategy) + '" — skipping.');
    }

    /**
     * The managed targeted-gitignore rules. The board-state mirror files
     * (kanban-board.md / kanban-state-*.md) are no longer un-ignored — the
     * bidirectional mirror is retired and the read-only snapshot writes to
     * its own orphan ref, not the code tree. Mirror files stay ignored under
     * `.switchboard/*`. The `includeMirrorExport` parameter is retained for
     * backward compatibility but no longer adds mirror carve-outs.
     */
    static getTargetedRules(_includeMirrorExport: boolean = false): string[] {
        return [...WorkspaceExcludeService.TARGETED_RULES];
    }
}
