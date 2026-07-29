/**
 * Token extraction from CSS custom properties and HTML design systems.
 */

export interface TokenDeclaration {
    scope: string;
    name: string;
    value: string;
}

export interface TokenGroup {
    scheme: string; // 'light' | 'dark' | scope name
    tokens: Array<{ name: string; value: string }>;
}

export interface ExtractedDesignSystem {
    groups: TokenGroup[];
    sections: string[];
    truncated: boolean;
}

/**
 * Core scanner for CSS text: parses selector blocks and at-rules,
 * collecting custom property (--*) declarations with their scope.
 */
export function extractTokensFromCss(cssText: string): TokenDeclaration[] {
    const results: TokenDeclaration[] = [];
    if (!cssText) return results;

    let pos = 0;
    const len = cssText.length;
    const atStack: string[] = [];
    let currentSelector = '';
    let inBlock = false;
    let blockBuffer = '';
    // Depth of braces nested INSIDE the current selector block (native CSS
    // nesting, @keyframes percent blocks). Only a `}` at depth 0 closes the
    // block — without this, the first nested `}` desyncs scope tracking.
    let nestedDepth = 0;

    while (pos < len) {
        const char = cssText[pos];

        // Skip comments /* ... */
        if (char === '/' && cssText[pos + 1] === '*') {
            const endComment = cssText.indexOf('*/', pos + 2);
            if (endComment === -1) break;
            pos = endComment + 2;
            continue;
        }

        if (char === '{') {
            if (!inBlock) {
                const header = currentSelector.trim();
                if (header.startsWith('@media') || header.startsWith('@supports')) {
                    atStack.push(header);
                    currentSelector = '';
                } else {
                    inBlock = true;
                    blockBuffer = '';
                    nestedDepth = 0;
                }
            } else {
                nestedDepth++;
                blockBuffer += char;
            }
            pos++;
            continue;
        }

        if (char === '}') {
            if (inBlock) {
                if (nestedDepth > 0) {
                    nestedDepth--;
                    blockBuffer += char;
                } else {
                    // End of selector block
                    const fullScope = [atStack.join(' '), currentSelector.trim()].filter(Boolean).join(' ');
                    parseDeclarations(blockBuffer, fullScope, results);
                    inBlock = false;
                    currentSelector = '';
                    blockBuffer = '';
                }
            } else if (atStack.length > 0) {
                atStack.pop();
                currentSelector = '';
            }
            pos++;
            continue;
        }

        if (!inBlock) {
            currentSelector += char;
        } else {
            blockBuffer += char;
        }
        pos++;
    }

    return results;
}

function parseDeclarations(blockText: string, scope: string, out: TokenDeclaration[]): void {
    const decls = blockText.split(';');
    for (const decl of decls) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const prop = decl.substring(0, colonIdx).trim();
        const val = decl.substring(colonIdx + 1).trim();
        if (prop.startsWith('--') && val) {
            out.push({
                scope: scope || ':root',
                name: prop,
                value: val
            });
        }
    }
}

/**
 * Normalizes CSS scope strings into 'light', 'dark', or clean scope names.
 */
function normalizeScheme(scope: string): string {
    const lower = scope.toLowerCase();
    if (lower.includes('prefers-color-scheme: dark') || lower.includes('dark') || lower.includes('color-scheme: dark')) {
        return 'dark';
    }
    if (lower.includes(':root') || lower.includes('light') || lower.includes('html') || lower.includes('body')) {
        return 'light';
    }
    return scope.trim() || 'default';
}

/**
 * Extract tokens and section headings from an HTML design system (or CSS string).
 */
export function extractDesignSystemTokens(html: string): ExtractedDesignSystem {
    if (!html) {
        return { groups: [], sections: [], truncated: false };
    }

    // Extract section titles (h2)
    const sections: string[] = [];
    const h2Regex = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
    let match: RegExpExecArray | null;
    while ((match = h2Regex.exec(html)) !== null) {
        const title = match[1].replace(/<[^>]+>/g, '').trim();
        if (title && !sections.includes(title)) {
            sections.push(title);
        }
    }

    // Extract style block contents or treat entire input as CSS if no style tags
    let cssText = '';
    const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch: RegExpExecArray | null;
    let hasStyleTags = false;
    while ((styleMatch = styleRegex.exec(html)) !== null) {
        hasStyleTags = true;
        cssText += styleMatch[1] + '\n';
    }
    if (!hasStyleTags && (html.includes('--') || html.includes('{'))) {
        cssText = html;
    }

    const rawDecls = extractTokensFromCss(cssText);

    // Group and deduplicate by scheme
    const schemeMap = new Map<string, Map<string, string>>();

    for (const decl of rawDecls) {
        const scheme = normalizeScheme(decl.scope);
        if (!schemeMap.has(scheme)) {
            schemeMap.set(scheme, new Map());
        }
        // Cascade order: later declaration overrides earlier
        schemeMap.get(scheme)!.set(decl.name, decl.value);
    }

    const MAX_TOKENS_PER_GROUP = 50;
    const MAX_TOTAL_CHARS = 2000;
    let truncated = false;
    let totalChars = 0;

    const groups: TokenGroup[] = [];

    // Ensure 'light' comes first, then 'dark', then others
    const schemeKeys = Array.from(schemeMap.keys()).sort((a, b) => {
        if (a === 'light') return -1;
        if (b === 'light') return 1;
        if (a === 'dark') return -1;
        if (b === 'dark') return 1;
        return a.localeCompare(b);
    });

    for (const scheme of schemeKeys) {
        const propMap = schemeMap.get(scheme)!;
        const tokens: Array<{ name: string; value: string }> = [];

        for (const [name, value] of propMap.entries()) {
            if (tokens.length >= MAX_TOKENS_PER_GROUP) {
                truncated = true;
                break;
            }
            const entryLen = name.length + value.length + 5;
            if (totalChars + entryLen > MAX_TOTAL_CHARS) {
                truncated = true;
                break;
            }
            tokens.push({ name, value });
            totalChars += entryLen;
        }

        if (tokens.length > 0) {
            groups.push({ scheme, tokens });
        }
    }

    return { groups, sections, truncated };
}
