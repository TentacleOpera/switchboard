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
 */
export function getThemeBodyClass(): string {
    const cfg = vscode.workspace.getConfiguration('switchboard');
    const theme = cfg.get<string>('theme.name', 'afterburner');
    if (theme === 'afterburner') {
        const animDisabled = cfg.get<boolean>('theme.disableCyberAnimation', false);
        return 'cyber-theme-enabled' + (animDisabled ? ' cyber-animation-disabled' : '');
    }
    const colourIcons = cfg.get<boolean>('theme.colourKanbanIcons', false);
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
