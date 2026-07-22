import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { HostPathConfigProvider } from './hostSeams';

/**
 * The body class a webview should render with on first paint, derived from the
 * current Switchboard theme setting. Mirrors the per-panel JS theme handlers:
 *   - claudify    -> theme-claudify (+ cyber-animation-disabled / cyber-scanlines-disabled if set)
 *   - anything else (default/legacy) -> cyber-theme-enabled (Afterburner)
 *
 * Injecting this at HTML-generation time prevents the "flash of afterburner"
 * before the switchboardThemeChanged message arrives, and stops panels whose
 * <body> had a hardcoded (or missing) class from starting on the wrong theme.
 *
 * NOTE: Keep the client-side theme-class handlers (e.g. inside implementation.html's
 * switchboardThemeChanged event handler) in sync with the classes returned here.
 */
/**
 * Resolve the effective value of `switchboard.theme.colourKanbanIcons`,
 * applying a per-theme default when the setting has never been explicitly
 * set at either the workspace or global level.
 *
 * - Explicit workspace value wins.
 * - Else explicit global (user) value wins.
 * - Else (unset): `true` for `claudify`, `false` for all other themes.
 *
 * Shared by `getThemeBodyClass()` (first-paint body class) and
 * `TaskViewerProvider.handleGetColourKanbanIconsSetting()` (Theme tab toggle)
 * so both read sites use identical logic.
 */
export function getEffectiveColourKanbanIcons(configOrWorkspaceRoot?: string | HostPathConfigProvider): boolean {
    if (configOrWorkspaceRoot && typeof configOrWorkspaceRoot === 'object' && 'getConfigBoolean' in configOrWorkspaceRoot) {
        return configOrWorkspaceRoot.getConfigBoolean('theme.colourKanbanIcons', configOrWorkspaceRoot.getConfigStringWithDefault('theme.name', 'afterburner') === 'claudify');
    }
    let fileConfig: Record<string, any> = {};
    if (typeof configOrWorkspaceRoot === 'string' && configOrWorkspaceRoot) {
        try {
            const p = path.join(configOrWorkspaceRoot, '.switchboard', 'config.json');
            if (fs.existsSync(p)) {
                fileConfig = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
            }
        } catch {}
    }
    const val = fileConfig['switchboard.theme.colourKanbanIcons'] ?? fileConfig['theme.colourKanbanIcons'];
    if (val !== undefined) return !!val;

    if (vscode.workspace?.getConfiguration) {
        const cfg = vscode.workspace.getConfiguration('switchboard');
        const inspection = cfg.inspect<boolean>('theme.colourKanbanIcons');
        if (inspection?.workspaceValue !== undefined) {
            return !!inspection.workspaceValue;
        }
        if (inspection?.globalValue !== undefined) {
            return !!inspection.globalValue;
        }
        const theme = cfg.get<string>('theme.name', 'afterburner');
        return theme === 'claudify';
    }
    return false;
}

export function getThemeBodyClass(configOrWorkspaceRoot?: string | HostPathConfigProvider): string {
    let theme = 'afterburner';
    let animDisabled = false;
    let scanlinesDisabled = false;
    let ultracodeEnabled = false;

    if (configOrWorkspaceRoot && typeof configOrWorkspaceRoot === 'object' && 'getConfigStringWithDefault' in configOrWorkspaceRoot) {
        theme = configOrWorkspaceRoot.getConfigStringWithDefault('theme.name', 'afterburner');
        animDisabled = configOrWorkspaceRoot.getConfigBoolean('theme.disableCyberAnimation', false);
        scanlinesDisabled = configOrWorkspaceRoot.getConfigBoolean('theme.disableCyberScanlines', false);
        ultracodeEnabled = configOrWorkspaceRoot.getConfigBoolean('theme.ultracodeAnimation', false);
    } else {
        let fileConfig: Record<string, any> = {};
        if (typeof configOrWorkspaceRoot === 'string' && configOrWorkspaceRoot) {
            try {
                const p = path.join(configOrWorkspaceRoot, '.switchboard', 'config.json');
                if (fs.existsSync(p)) {
                    fileConfig = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
                }
            } catch {}
        }
        const cfg = vscode.workspace?.getConfiguration ? vscode.workspace.getConfiguration('switchboard') : null;
        theme = fileConfig['switchboard.theme.name'] ?? fileConfig['theme.name'] ?? cfg?.get<string>('theme.name', 'afterburner') ?? 'afterburner';
        animDisabled = fileConfig['switchboard.theme.disableCyberAnimation'] ?? fileConfig['theme.disableCyberAnimation'] ?? cfg?.get<boolean>('theme.disableCyberAnimation', false) ?? false;
        scanlinesDisabled = fileConfig['switchboard.theme.disableCyberScanlines'] ?? fileConfig['theme.disableCyberScanlines'] ?? cfg?.get<boolean>('theme.disableCyberScanlines', false) ?? false;
        ultracodeEnabled = fileConfig['switchboard.theme.ultracodeAnimation'] ?? fileConfig['theme.ultracodeAnimation'] ?? cfg?.get<boolean>('theme.ultracodeAnimation', false) ?? false;
    }

    const effectClasses =
        (animDisabled ? ' cyber-animation-disabled' : '') +
        (scanlinesDisabled ? ' cyber-scanlines-disabled' : '') +
        (ultracodeEnabled ? ' ultracode-animation-enabled' : '');
    if (theme === 'claudify') {
        const colourIcons = getEffectiveColourKanbanIcons(configOrWorkspaceRoot);
        const colourClass = colourIcons ? ' kanban-icons-colour' : '';
        return 'theme-claudify' + colourClass + effectClasses;
    }
    // Afterburner is the default, and the fallback for any legacy/removed theme value.
    return 'cyber-theme-enabled' + effectClasses;
}

/**
 * Rewrite the <body> tag's class to match the current theme, preserving any
 * other attributes (e.g. data-initial-workspace-root). Works whether the
 * source <body> had a class or not. No-op if there is no <body> tag.
 */
export function applyThemeBodyClass(html: string, configOrWorkspaceRoot?: string | HostPathConfigProvider): string {
    const cls = getThemeBodyClass(configOrWorkspaceRoot);
    return html.replace(/<body\b([^>]*)>/i, (_match, attrs: string) => {
        const withoutClass = attrs.replace(/\s*class="[^"]*"/i, '');
        return `<body${withoutClass}${cls ? ` class="${cls}"` : ''}>`;
    });
}

