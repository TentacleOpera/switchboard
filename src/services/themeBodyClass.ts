import * as vscode from 'vscode';

/**
 * The body class a webview should render with on first paint, derived from the
 * current Switchboard theme setting. Mirrors the per-panel JS theme handlers:
 *   - afterburner -> cyber-theme-enabled (+ cyber-animation-disabled if set)
 *   - claudify    -> theme-claudify
 *   - anything else (default) -> no class
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
 * - Else (unset): `true` for `claudify` and `afterburner-professional`,
 *   `false` for all other themes.
 *
 * Shared by `getThemeBodyClass()` (first-paint body class) and
 * `TaskViewerProvider.handleGetColourKanbanIconsSetting()` (Theme tab toggle)
 * so both read sites use identical logic.
 */
export function getEffectiveColourKanbanIcons(): boolean {
    const cfg = vscode.workspace.getConfiguration('switchboard');
    const inspection = cfg.inspect<boolean>('theme.colourKanbanIcons');
    if (inspection?.workspaceValue !== undefined) {
        return !!inspection.workspaceValue;
    }
    if (inspection?.globalValue !== undefined) {
        return !!inspection.globalValue;
    }
    const theme = cfg.get<string>('theme.name', 'afterburner');
    return theme === 'claudify' || theme === 'afterburner-professional';
}

export function getThemeBodyClass(): string {
    const cfg = vscode.workspace.getConfiguration('switchboard');
    const theme = cfg.get<string>('theme.name', 'afterburner');
    if (theme === 'afterburner') {
        const animDisabled = cfg.get<boolean>('theme.disableCyberAnimation', false);
        return 'cyber-theme-enabled' + (animDisabled ? ' cyber-animation-disabled' : '');
    }
    const colourIcons = getEffectiveColourKanbanIcons();
    const colourClass = colourIcons ? ' kanban-icons-colour' : '';
    if (theme === 'claudify') {
        return 'theme-claudify' + colourClass;
    }
    if (theme === 'afterburner-professional') {
        return 'theme-claudify theme-afterburner-pro' + colourClass;
    }
    return '';
}

/**
 * Rewrite the <body> tag's class to match the current theme, preserving any
 * other attributes (e.g. data-initial-workspace-root). Works whether the
 * source <body> had a class or not. No-op if there is no <body> tag.
 */
export function applyThemeBodyClass(html: string): string {
    const cls = getThemeBodyClass();
    return html.replace(/<body\b([^>]*)>/i, (_match, attrs: string) => {
        const withoutClass = attrs.replace(/\s*class="[^"]*"/i, '');
        return `<body${withoutClass}${cls ? ` class="${cls}"` : ''}>`;
    });
}
