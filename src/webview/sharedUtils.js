// Shared utilities for Switchboard webviews (Planning and Design panels)
// Loaded globally within the webview environment

// Passthrough: returns the path as-is (no prefix).
// Kept as a function for call-site compatibility; the @ prefix was removed
// because users want clean absolute paths on clipboard copy.
function toAgentRef(absPath) {
    if (!absPath) return absPath;
    return absPath;
}

function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeUrl(rawUrl) {
    const trimmed = String(rawUrl).trim();
    if (/^(#|\/|\.{1,2}\/)/.test(trimmed)) { return trimmed; }
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (schemeMatch) {
        const scheme = schemeMatch[1].toLowerCase();
        if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
            || scheme === 'vscode-webview-resource' || scheme === 'vscode-resource' || scheme === 'vscode-webview') {
            return trimmed;
        }
        return '#';
    }
    return trimmed;
}

function renderInlineMarkdown(text) {
    if (!text) return '';
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, t, url) => {
            const safeUrl = escapeAttr(sanitizeUrl(url));
            return `<a href="${safeUrl}">${t}</a>`;
        })
        .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');
}

const TABLE_SEPARATOR_REGEX = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function parseTableBlock(lines) {
    if (lines.length < 2) return '';
    let sepIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (TABLE_SEPARATOR_REGEX.test(lines[i])) {
            sepIdx = i;
            break;
        }
    }
    if (sepIdx === -1) return '';

    const splitRow = (row) => {
        const trimmed = row.trim();
        let rawCells = trimmed.split('|');
        if (trimmed.startsWith('|')) rawCells.shift();
        if (trimmed.endsWith('|') && rawCells.length > 0) rawCells.pop();
        return rawCells.map(c => c.trim());
    };

    const headerCells = splitRow(lines[0]);
    const sepCells = splitRow(lines[sepIdx]);
    const alignments = sepCells.map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
    });

    let html = '<div class="table-wrapper"><table><thead><tr>';
    for (let i = 0; i < headerCells.length; i++) {
        const align = alignments[i] || '';
        const style = align ? ` style="text-align: ${align}"` : '';
        html += `<th${style}>${renderInlineMarkdown(headerCells[i])}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = sepIdx + 1; i < lines.length; i++) {
        const cells = splitRow(lines[i]);
        html += '<tr>';
        for (let j = 0; j < headerCells.length; j++) {
            const align = alignments[j] || '';
            const style = align ? ` style="text-align: ${align}"` : '';
            const cellContent = j < cells.length ? cells[j] : '';
            html += `<td${style}>${renderInlineMarkdown(cellContent)}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
}

function renderMarkdown(markdown) {
    if (!markdown) return '';

    let processed = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    processed = processed.replace(/\\`/g, '__ESCAPED_BACKTICK__');

    const lines = processed.split('\n');
    const resultLines = [];
    let lastHeaderText = null;

    for (const line of lines) {
        const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headerMatch) {
            const headerText = headerMatch[2].trim();
            if (headerText === lastHeaderText) {
                continue;
            }
            lastHeaderText = headerText;
        }
        resultLines.push(line);
    }

    const groupedLines = [];
    let inBlockquote = false;
    let blockquoteLines = [];
    for (const line of resultLines) {
        const bqMatch = line.match(/^&gt;\s?(.*)$/);
        if (bqMatch) {
            if (!inBlockquote) { inBlockquote = true; blockquoteLines = []; }
            blockquoteLines.push(bqMatch[1]);
        } else {
            if (inBlockquote) {
                groupedLines.push({ type: 'blockquote', lines: blockquoteLines });
                inBlockquote = false;
                blockquoteLines = [];
            }
            groupedLines.push(line);
        }
    }
    if (inBlockquote) { groupedLines.push({ type: 'blockquote', lines: blockquoteLines }); }

    const processedLines = [];
    let inCodeFence = false;
    let tableBlockLines = [];

    const flushTableBlock = () => {
        if (tableBlockLines.length >= 2) {
            let hasSep = false;
            for (const l of tableBlockLines) {
                if (TABLE_SEPARATOR_REGEX.test(l)) {
                    hasSep = true;
                    break;
                }
            }
            if (hasSep) {
                const tableHtml = parseTableBlock(tableBlockLines);
                processedLines.push(`HTML_TABLE_START${tableHtml}HTML_TABLE_END`);
            } else {
                for (const l of tableBlockLines) {
                    processedLines.push(l);
                }
            }
        } else {
            for (const l of tableBlockLines) {
                processedLines.push(l);
            }
        }
        tableBlockLines = [];
    };

    for (const item of groupedLines) {
        if (typeof item === 'string') {
            if (item.trim().startsWith('```')) {
                flushTableBlock();
                inCodeFence = !inCodeFence;
                processedLines.push(item);
            } else if (inCodeFence) {
                processedLines.push(item);
            } else {
                const isTableLine = item.trim().startsWith('|');
                if (isTableLine) {
                    tableBlockLines.push(item);
                } else {
                    flushTableBlock();
                    processedLines.push(item);
                }
            }
        } else if (item && item.type === 'blockquote') {
            flushTableBlock();
            const content = item.lines.join('\n');
            const alertMatch = content.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*([\s\S]*)$/i);
            if (alertMatch) {
                const type = alertMatch[1].toLowerCase();
                const title = alertMatch[1].charAt(0).toUpperCase() + alertMatch[1].slice(1).toLowerCase();
                const body = alertMatch[2].trim();
                processedLines.push(`HTML_ALERT_START_${type}_${title}HTML_ALERT_CONTENT${body}HTML_ALERT_END`);
            } else {
                processedLines.push(`HTML_BLOCKQUOTE_START${content}HTML_BLOCKQUOTE_END`);
            }
        }
    }
    flushTableBlock();

    processed = processedLines.join('\n');

    let html = processed
        .replace(/```(\w*)([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/^\s*###### (.+)$/gm, '<h6>$1</h6>')
        .replace(/^\s*##### (.+)$/gm, '<h5>$1</h5>')
        .replace(/^\s*#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^\s*### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^\s*## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^\s*# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^\* (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
            const safeUrl = escapeAttr(sanitizeUrl(url));
            return `<img src="${safeUrl}" alt="${escapeAttr(alt)}" style="max-width:100%;height:auto;display:block;margin:4px 0;">`;
        })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
            const safeUrl = escapeAttr(sanitizeUrl(url));
            return `<a href="${safeUrl}">${text}</a>`;
        })
        .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1');

    const parts = html.split(/(<pre><code>[\s\S]*?<\/code><\/pre>)/);
    html = parts.map((part, i) => {
        if (i % 2 === 1) return part;
        return part.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
    }).join('');

    html = html.replace(/<\/li><br><li>/g, '</li><li>');

    html = `<p>${html}</p>`;
    html = html.replace(/<p>\s*<\/p>/g, '');

    html = html.replace(/HTML_TABLE_START([\s\S]*?)HTML_TABLE_END/g, (_, tableHtml) => {
        return `</p>${tableHtml}<p>`;
    });
    html = html.replace(/HTML_ALERT_START_([a-z]+)_([A-Za-z]+)HTML_ALERT_CONTENT([\s\S]*?)HTML_ALERT_END/g, (_, type, title, body) => {
        return `</p><div class="markdown-alert alert-${type}"><div class="markdown-alert-title">${title}</div><div>${body}</div></div><p>`;
    });
    html = html.replace(/HTML_BLOCKQUOTE_START([\s\S]*?)HTML_BLOCKQUOTE_END/g, (_, body) => {
        return `</p><blockquote>${body}</blockquote><p>`;
    });
    html = html.replace(/<p>\s*<\/p>/g, '');

    let inCode = false;
    html = html.replace(/(<code\b[^>]*>|<\/code>|<pre\b[^>]*>|<\/pre>|__ESCAPED_BACKTICK__)/g, (match) => {
        if (match.startsWith('<code') || match.startsWith('<pre')) {
            inCode = true;
            return match;
        } else if (match.startsWith('</code') || match.startsWith('</pre')) {
            inCode = false;
            return match;
        } else if (match === '__ESCAPED_BACKTICK__') {
            return inCode ? '\\`' : '`';
        }
        return match;
    });

    return html;
}

function renderJsonTree(data, depth, maxDepth, seen) {
    depth = depth || 0;
    maxDepth = maxDepth || 2;
    seen = seen || new WeakSet();

    if (data === null) {
        const span = document.createElement('span');
        span.className = 'json-null';
        span.textContent = 'null';
        return span;
    }
    if (typeof data !== 'object') {
        const span = document.createElement('span');
        span.className = 'json-' + typeof data;
        span.textContent = typeof data === 'string' ? '"' + data + '"' : String(data);
        return span;
    }

    if (seen.has(data)) {
        const span = document.createElement('span');
        span.className = 'json-null';
        span.textContent = '[Circular]';
        return span;
    }
    seen.add(data);

    const isArray = Array.isArray(data);
    const isOpen = depth < maxDepth;

    const details = document.createElement('details');
    details.className = 'json-node';
    if (isOpen) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'json-bracket';
    const countLabel = isArray
        ? `${data.length} items`
        : `${Object.keys(data).length} keys`;
    summary.textContent = isArray ? `[ ${countLabel} ]` : `{ ${countLabel} }`;
    details.appendChild(summary);

    const children = document.createElement('div');
    children.className = 'json-children';

    if (isArray) {
        data.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'json-row';
            const idx = document.createElement('span');
            idx.className = 'json-number';
            idx.textContent = String(i) + ':';
            row.appendChild(idx);
            row.appendChild(renderJsonTree(item, depth + 1, maxDepth, seen));
            children.appendChild(row);
        });
    } else {
        for (const [key, val] of Object.entries(data)) {
            const row = document.createElement('div');
            row.className = 'json-row';
            const keySpan = document.createElement('span');
            keySpan.className = 'json-key';
            keySpan.textContent = '"' + key + '"';
            row.appendChild(keySpan);
            row.appendChild(document.createTextNode(': '));
            row.appendChild(renderJsonTree(val, depth + 1, maxDepth, seen));
            children.appendChild(row);
        }
    }

    details.appendChild(children);
    return details;
}

// Shared click-flash feedback: gives every button a brief press pulse on click so actions
// don't fire silently. Self-contained (injects its own CSS); loaded in every panel via the
// shared scripts. Guarded so it only initialises once per webview.
(function initSbClickFlash() {
    if (typeof document === 'undefined' || window.__sbClickFlashInit) { return; }
    window.__sbClickFlashInit = true;

    const style = document.createElement('style');
    style.textContent =
        '@keyframes sbClickFlash{0%{transform:scale(1)}38%{transform:scale(0.94)}100%{transform:scale(1)}}' +
        '.sb-click-flash{animation:sbClickFlash 0.18s ease-out}';
    // Insert FIRST so any panel-specific click animation (e.g. kanban's richer flash)
    // wins the cascade on conflict, while this still applies everywhere else.
    const head = document.head || document.documentElement;
    head.insertBefore(style, head.firstChild);

    document.addEventListener('click', e => {
        const btn = e.target.closest && e.target.closest('button, [role="button"], [class*="btn"]');
        if (!btn || btn.disabled) { return; }
        btn.classList.remove('sb-click-flash');
        void btn.offsetWidth; // restart the animation if clicked again mid-play
        btn.classList.add('sb-click-flash');
        btn.addEventListener('animationend', () => btn.classList.remove('sb-click-flash'), { once: true });
    }, true);
})();
