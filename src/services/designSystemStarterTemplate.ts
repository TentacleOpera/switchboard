export const STARTER_DESIGN_SYSTEM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Design System</title>
    <style>
        :root {
            /* Palette (Light) */
            --ground: #FDFDFD;
            --card: #FFFFFF;
            --ink: #222222;
            --body: #444444;
            --muted: #666666;
            --rule: #E5E5E5;
            --accent: #2563EB;
            --accent-text: #FFFFFF;
            --shadow: rgba(0, 0, 0, 0.08);

            /* Typography */
            --font-sans: system-ui, -apple-system, sans-serif;
            --font-mono: ui-monospace, SFMono-Regular, monospace;
            --font-sm: 12px;
            --font-md: 14px;
            --font-lg: 18px;
            --font-xl: 24px;

            /* Spacing */
            --space-xs: 4px;
            --space-sm: 8px;
            --space-md: 16px;
            --space-lg: 24px;
            --space-xl: 32px;

            /* Radius */
            --radius-sm: 4px;
            --radius-md: 8px;
            --radius-lg: 12px;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                /* Palette (Dark) */
                --ground: #121212;
                --card: #1E1E1E;
                --ink: #F3F4F6;
                --body: #D1D5DB;
                --muted: #9CA3AF;
                --rule: #374151;
                --accent: #3B82F6;
                --accent-text: #FFFFFF;
                --shadow: rgba(0, 0, 0, 0.4);
            }
        }

        :root[data-theme="dark"] {
            /* Palette (Dark) — explicit data-theme override, same values as the media query */
            --ground: #121212;
            --card: #1E1E1E;
            --ink: #F3F4F6;
            --body: #D1D5DB;
            --muted: #9CA3AF;
            --rule: #374151;
            --accent: #3B82F6;
            --accent-text: #FFFFFF;
            --shadow: rgba(0, 0, 0, 0.4);
        }

        body {
            font-family: var(--font-sans);
            background: var(--ground);
            color: var(--body);
            margin: 0;
            padding: var(--space-lg);
            line-height: 1.5;
        }

        h1, h2, h3 { color: var(--ink); margin-top: 0; }
        section { margin-bottom: var(--space-xl); padding-bottom: var(--space-lg); border-bottom: 1px solid var(--rule); }

        .swatch-grid { display: flex; gap: var(--space-md); flex-wrap: wrap; }
        .swatch {
            width: 120px;
            padding: var(--space-sm);
            border-radius: var(--radius-md);
            background: var(--card);
            border: 1px solid var(--rule);
            box-shadow: 0 2px 4px var(--shadow);
            font-size: var(--font-sm);
        }
        .color-box { height: 48px; border-radius: var(--radius-sm); margin-bottom: var(--space-xs); border: 1px solid var(--rule); }

        .btn {
            display: inline-block;
            padding: var(--space-sm) var(--space-md);
            background: var(--accent);
            color: var(--accent-text);
            border-radius: var(--radius-sm);
            font-size: var(--font-md);
            text-decoration: none;
            border: none;
            cursor: pointer;
        }

        .card {
            background: var(--card);
            border: 1px solid var(--rule);
            border-radius: var(--radius-md);
            padding: var(--space-md);
            box-shadow: 0 4px 6px var(--shadow);
            max-width: 320px;
        }
    </style>
</head>
<body>

    <h1>Design System Starter</h1>
    <p>Visual and UI conventions for this project. Edit or refine via the agent interview.</p>

    <section>
        <h2>Color Palette</h2>
        <div class="swatch-grid">
            <div class="swatch">
                <div class="color-box" style="background: var(--ground);"></div>
                <strong>Ground</strong>
                <div><code>--ground</code></div>
            </div>
            <div class="swatch">
                <div class="color-box" style="background: var(--card);"></div>
                <strong>Card</strong>
                <div><code>--card</code></div>
            </div>
            <div class="swatch">
                <div class="color-box" style="background: var(--ink);"></div>
                <strong>Ink</strong>
                <div><code>--ink</code></div>
            </div>
            <div class="swatch">
                <div class="color-box" style="background: var(--accent);"></div>
                <strong>Accent</strong>
                <div><code>--accent</code></div>
            </div>
        </div>
    </section>

    <section>
        <h2>Typography</h2>
        <div style="font-size: var(--font-xl);">Headline XL (24px)</div>
        <div style="font-size: var(--font-lg);">Subheading LG (18px)</div>
        <div style="font-size: var(--font-md);">Body MD (14px) - System sans font</div>
        <div style="font-size: var(--font-sm); color: var(--muted);">Caption SM (12px) - Muted text</div>
    </section>

    <section>
        <h2>Spacing & Layout</h2>
        <div style="display: flex; gap: var(--space-sm); align-items: center;">
            <span style="width: var(--space-xs); height: 16px; background: var(--accent);"></span> XS (4px)
            <span style="width: var(--space-sm); height: 16px; background: var(--accent);"></span> SM (8px)
            <span style="width: var(--space-md); height: 16px; background: var(--accent);"></span> MD (16px)
            <span style="width: var(--space-lg); height: 16px; background: var(--accent);"></span> LG (24px)
        </div>
    </section>

    <section>
        <h2>Radius & Elevation</h2>
        <div style="display: flex; gap: var(--space-md);">
            <div style="padding: var(--space-md); background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius-sm);">Radius SM</div>
            <div style="padding: var(--space-md); background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius-md);">Radius MD</div>
            <div style="padding: var(--space-md); background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius-lg);">Radius LG</div>
        </div>
    </section>

    <section>
        <h2>Components</h2>
        <div class="card">
            <h3>Sample Card Component</h3>
            <p>Cards and containers use <code>--card</code> background with <code>--shadow</code> elevation.</p>
            <button class="btn">Primary Action</button>
        </div>
    </section>

</body>
</html>
`;
