---
name: Terminal Protocol
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
  on-surface-variant: '#b9ccb2'
  inverse-surface: '#e5e2e1'
  inverse-on-surface: '#313030'
  outline: '#84967e'
  outline-variant: '#3b4b37'
  surface-tint: '#00e639'
  primary: '#ebffe2'
  on-primary: '#003907'
  primary-container: '#00ff41'
  on-primary-container: '#007117'
  inverse-primary: '#006e16'
  secondary: '#bdf4ff'
  on-secondary: '#00363d'
  secondary-container: '#00e3fd'
  on-secondary-container: '#00616d'
  tertiary: '#fff8f4'
  on-tertiary: '#442b10'
  tertiary-container: '#ffd5ae'
  on-tertiary-container: '#7a5b3c'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#72ff70'
  primary-fixed-dim: '#00e639'
  on-primary-fixed: '#002203'
  on-primary-fixed-variant: '#00530e'
  secondary-fixed: '#9cf0ff'
  secondary-fixed-dim: '#00daf3'
  on-secondary-fixed: '#001f24'
  on-secondary-fixed-variant: '#004f58'
  tertiary-fixed: '#ffdcbd'
  tertiary-fixed-dim: '#e7bf99'
  on-tertiary-fixed: '#2c1701'
  on-tertiary-fixed-variant: '#5d4124'
  background: '#131313'
  on-background: '#e5e2e1'
  surface-variant: '#353534'
typography:
  ui-label-xs:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 12px
    letterSpacing: 0.02em
  ui-control:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  data-mono:
    fontFamily: Fira Code
    fontSize: 12px
    fontWeight: '450'
    lineHeight: 16px
  data-mono-bold:
    fontFamily: Fira Code
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
  header-section:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 16px
spacing:
  unit: 4px
  container-padding: 12px
  gutter: 1px
  row-height-dense: 24px
  row-height-standard: 32px
---

## Brand & Style

The design system is a high-density, utility-first framework optimized for technical environments, data monitoring, and low-latency workflows. It prioritizes information throughput over aesthetic ornamentation, drawing inspiration from high-end IDEs and hardware terminal interfaces. 

The aesthetic is a blend of **Minimalism** and **Brutalism**, utilizing a strictly dark, low-light palette to reduce eye strain during prolonged sessions. The personality is authoritative, precise, and utilitarian. It evokes a sense of "under-the-hood" access, where every pixel serves a functional purpose. There is no decorative whitespace; layout density is maximized to provide an eagle-eye view of complex datasets.

## Colors

This design system utilizes a "Void" palette. The background is near-pure black to ensure maximum contrast for the neon status indicators. 

- **Backgrounds:** Use `#0A0A0A` for the primary canvas and `#121212` for containers and panels.
- **Accents:** Neon hues are used exclusively for semantic signaling.
    - **Live (#00FF41):** Success, active streams, and online status.
    - **Stale (#FFB000):** Warnings, delayed data, or pending states.
    - **Error/Gap (#FF3131):** Critical failures or missing data segments.
    - **Replayed (#00E5FF):** Historical data playback or secondary active states.
- **Borders:** Use low-contrast greys (`#2A2A2A`) to define structure without distracting from the data.

## Typography

The typographic system is split between functional UI navigation and data density.

- **Interface Controls:** Use **Inter** for all buttons, menus, and sidebars. It provides high legibility at the small scales required for a dense UI.
- **Data & Code:** Use **Fira Code** for all table cells, logs, and technical readouts. Ligatures should be enabled to improve the readability of operators in code blocks.
- **Scale:** Standard body text is set to 12px. In extreme high-density views, labels may drop to 10px.
- **Weight:** Use medium (500) or semi-bold (600) for headers to maintain hierarchy against the high-contrast neon accents.

## Layout & Spacing

This design system uses a strict 4px grid. Layouts are **Fluid**, designed to span the full width of ultra-wide monitors used in developer environments.

- **Grid:** Use a 12-column grid for dashboard layouts, but default to nested flexbox or CSS grid for tool panels.
- **Density:** Padding is minimal. Standard component spacing is 8px (2 units), while internal element spacing is often 4px (1 unit).
- **Table Layout:** Tables should use `table-layout: fixed` where possible to prevent layout shift during data streaming. Cell padding should be restricted to 4px horizontally.

## Elevation & Depth

Elevation is communicated through **Tonal Layering** and **Crisp Borders** rather than shadows. Shadows are inefficient for high-density layouts and are strictly avoided.

- **Surface 0:** `#0A0A0A` (The main application background).
- **Surface 1:** `#121212` (Primary panels, sidebars, and table headers).
- **Surface 2:** `#1E1E1E` (Popovers, tooltips, and active state highlights).
- **Borders:** Every panel must be separated by a 1px border of `#2A2A2A`. This creates a "blueprint" feel and ensures clear delineation between dense data streams.

## Shapes

The design system adopts a **Sharp (0px)** corner radius for all primary structural elements (panels, tables, inputs, buttons). This reinforces the "Terminal" aesthetic and maximizes every pixel for data display.

Small UI elements like "Live" status dots or toggle switches may use a 2px radius to provide a subtle hint of interactability, but the overall container language is strictly orthogonal.

## Components

### Data Tables
- **Row Striping:** Even rows use a subtle `#161616` background; odd rows remain `#0A0A0A`.
- **Hover State:** Highlight active rows with a `#1E1E1E` background and a 1px left-border using the Primary color.
- **Scrollbars:** Custom "Terminal" style scrollbars. Width: 6px. Track: transparent. Thumb: `#333333` with no border-radius.

### Buttons
- **Action Buttons:** Small (24px height). No gradients. Background: `#1E1E1E`. Border: 1px `#2A2A2A`.
- **Icon-only Buttons:** Used extensively in headers for panel management (close, collapse, settings).

### Collapsible Panels
- Used to manage screen real estate. Panels should have a "Header Bar" with a 11px uppercase label and a chevron icon for state indication.

### Input Fields
- Inset look using a 1px solid border of `#2A2A2A`. Focus state uses a 1px solid border of the Primary color (`#00FF41`) with no outer glow.

### Status Badges
- Small, uppercase labels with a 1px border matching the status color. No background fill, or a very low-opacity (10%) fill of the status color.