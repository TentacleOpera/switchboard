---
name: Refined Terracotta IDE
colors:
  surface: '#131313'
  surface-dim: '#131313'
  surface-bright: '#393939'
  surface-container-lowest: '#0e0e0e'
  surface-container-low: '#1c1b1b'
  surface-container: '#201f1f'
  surface-container-high: '#2a2a2a'
  surface-container-highest: '#353534'
  on-surface: '#e5e2e1'
  on-surface-variant: '#dbc1b9'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#a38c85'
  outline-variant: '#55433d'
  surface-tint: '#ffb59e'
  primary: '#ffb59e'
  on-primary: '#5c1902'
  primary-container: '#d97757'
  on-primary-container: '#541400'
  inverse-primary: '#99462a'
  secondary: '#c8c6c5'
  on-secondary: '#303030'
  secondary-container: '#474746'
  on-secondary-container: '#b6b5b4'
  tertiary: '#5edac7'
  on-tertiary: '#003731'
  tertiary-container: '#09a493'
  on-tertiary-container: '#00312b'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdbd0'
  primary-fixed-dim: '#ffb59e'
  on-primary-fixed: '#390b00'
  on-primary-fixed-variant: '#7a2f15'
  secondary-fixed: '#e4e2e1'
  secondary-fixed-dim: '#c8c6c5'
  on-secondary-fixed: '#1b1c1c'
  on-secondary-fixed-variant: '#474746'
  tertiary-fixed: '#7df7e3'
  tertiary-fixed-dim: '#5edac7'
  on-tertiary-fixed: '#00201c'
  on-tertiary-fixed-variant: '#005047'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  headline-lg:
    fontFamily: Poppins
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Poppins
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
  ui-label-lg:
    fontFamily: Poppins
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  ui-label-sm:
    fontFamily: Poppins
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  content-body:
    fontFamily: Lora
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
  content-metadata:
    fontFamily: Lora
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  button:
    fontFamily: Poppins
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  panel-padding: 12px
  item-gap: 4px
---

## Brand & Style
The design system focuses on a **Technical Professional** aesthetic, blending the precision of a high-performance IDE with a sophisticated, editorial warmth. The brand personality is focused, mature, and distinctively warm—departing from the cold blues typically found in developer tools.

The design style is **Modern Corporate with Tactile accents**, utilizing a high-contrast dark theme. It prioritizes content density and legibility, using subtle gradients to create a sense of physical depth without sacrificing the "flat" efficiency required for coding environments.

## Colors
This design system utilizes a deep, monochromatic base centered around a #131313 "Total Dark" surface. The primary identifier is **Terracotta (#d97757)**, used sparingly for critical actions, active states, and focus indicators to maintain visual calm.

Secondary surfaces utilize a custom vertical gradient to provide structural separation between panels. Neutral tones are strictly cool-grey to ensure the Terracotta accent remains the warmest element in the interface.

## Typography
The typography strategy employs a functional split: **Poppins** handles the structural "shell" of the application (menus, buttons, tabs, and toolbars), providing a clean, geometric sans-serif feel that aids quick scanning. **Lora** is used for all "long-form" or "document" content, including README files, documentation panels, and metadata, offering a literary contrast that reduces eye strain during extended reading sessions.

For code blocks (not defined in variables), a high-legibility monospaced font should be used, paired with a syntax highlighting theme that utilizes the Terracotta palette for keywords.

## Layout & Spacing
The layout follows a **Fixed-Panel Fluid** model. Sidebars, activity bars, and inspector panels have fixed widths, while the primary editor/content area stretches to fill the remaining viewport. 

A compact 4px base unit is used to maximize information density. Gutters between major panels are kept at a minimum (1px borders or 4px gaps) to maintain a seamless, "integrated" feel. Horizontal padding in navigation lists and trees should be tighter than standard web applications to accommodate deep nesting.

## Elevation & Depth
In this dark-mode environment, depth is communicated through **Tonal Elevation** rather than heavy shadows. 
- **Level 0 (Background):** #131313 - The lowest layer (Activity bar, status bar).
- **Level 1 (Panels):** #1e1e1e - Sidebar and secondary panels.
- **Level 2 (Cards/Active Editor):** The custom neutral gradient (linear-gradient(180deg, #2a2a2a 0%, #1e1e1e 100%)). This level represents the focus area.
- **Overlays:** Modals and tooltips use a solid #2a2a2a with a 1px border of #d97757 at 30% opacity to "lift" them off the surface.

## Shapes
The shape language is disciplined and professional. A consistent **4px border radius** (Small/Soft) is applied to all interactive elements including buttons, input fields, tabs, and cards. This slight rounding softens the brutalism of the dark theme while maintaining a precise, technical silhouette. Icons should follow a 1.5px or 2px stroke weight to match the refined lines of the typography.

## Components
### Buttons
- **Primary:** Background #d97757, Text #131313 (Poppins Bold). 4px radius.
- **Secondary:** Border 1px #333333, Background transparent, Text #f5f5f5.
- **Ghost:** No border/background, Terracotta text on hover.

### Cards & Panels
- All container cards must use the defined `--card-bg-gradient`.
- Use a 1px solid border of #333333 to define boundaries between different functional IDE zones.

### Tabs
- **Active:** 2px bottom border of #d97757, background matches the card gradient.
- **Inactive:** #1e1e1e background, muted text.

### Form Inputs
- Background: #131313.
- Border: 1px #333333.
- Focus State: 1px solid #d97757 with a subtle terracotta outer glow (blur: 4px).

### Chips/Tags
- Small, uppercase Poppins. Background #2a2a2a with #a1a1aa text. Terracotta tags reserved for "Error" or "Critical" status items.