// Centralized design tokens for the story-generator dashboard.
//
// The dashboard previously hard-coded hex/rgba values across a dozen styled
// components, which made the palette drift and theming painful. This module
// centralizes all colors, radii, shadows, transitions, and typography here so
// every component pulls from a single source of truth. Modernizing the visual
// style only requires editing these tokens — the components stay unchanged.
//
// The palette is a modern deep dark theme: a near-black surface with subtle
// blue/indigo accents, layered elevation via translucent overlays + soft
// shadows, and crisp typography using the system UI stack.
//
// NOTE: This module is intentionally pure data (no React) so it can be imported
// anywhere — including from styled() static style objects which are evaluated
// once at module load time.

export const theme = {
    // Base surface tones. surfaces are stacked translucent layers — the
    // dashboard background uses `bg` and panels layer `surface*` on top.
    bg: '#0b0f17',
    surface1: 'rgba(255, 255, 255, 0.04)',
    surface2: 'rgba(255, 255, 255, 0.07)',
    surface3: 'rgba(255, 255, 255, 0.10)',
    // The rename dialog uses an opaque surface so the form stays visually
    // grounded above the dimmed dashboard instead of blending into the overlay.
    surfaceDialog: '#151b29',
    // Opaque hover/focus variant of surfaceDialog — used by the header client
    // dropdown (.sg-select in global.ts). Must stay OPAQUE: translucent
    // backgrounds on native form controls composite over the browser's light
    // UA control base when color-scheme is ignored (white-control bug).
    surfaceDialogHover: '#1c2434',

    // Border hairlines. Stronger on hover/focus.
    border: 'rgba(255, 255, 255, 0.15)',
    borderStrong: 'rgba(255, 255, 255, 0.28)',

    // Text tones — from dim → bright for hierarchical emphasis.
    // All tested against #0b0f17 background for WCAG compliance:
    //   text       #f0f2f5  ~17:1  AAA
    //   textMuted  #c8cdd8  ~12:1  AAA
    //   textDim    #8891a5   ~6:1  AA+
    //   textFaint  #77819a   ~5:1  AA
    text: '#f0f2f5',
    textMuted: '#c8cdd8',
    textDim: '#8891a5',
    textFaint: '#77819a',

    // Brand accent — indigo/blue. Used on primary action, selected story
    // highlight, focus rings, and the header title.
    accent: '#818cf8',
    accentHover: '#a5b4fc',
    accentSoft: 'rgba(129, 140, 248, 0.18)',
    // Stronger accent tint — used for the selected sidebar tile's hover state
    // so the active card visibly brightens without a solid fill swap.
    accentSoftHover: 'rgba(129, 140, 248, 0.30)',
    accentRing: 'rgba(129, 140, 248, 0.45)',
    // Crisp near-white accent tints used by status chips whose text sits on a
    // translucent accent fill (sidebar badges). Deriving them from the accent
    // hue keeps the chip family in the same color story as the accent itself.
    accentChipText: '#e0e1ff',
    accentChipBorder: 'rgba(199, 205, 252, 0.45)',
    accentChipFill: 'rgba(129, 140, 248, 0.35)',

    // Overlay blacks — solid translucent scrims for modal/drawer isolation.
    // Kept as tokens (not inline literals) so the elevation story of every
    // overlay lives in this file.
    overlayDim: 'rgba(0, 0, 0, 0.55)',
    overlayDeeper: 'rgba(0, 0, 0, 0.74)',
    // Content-area dialog scrim (rewrite/append/delete confirms) — slightly
    // lighter than the rename dialog's overlay so the chapter list beneath
    // stays readable as context.
    overlayDialog: 'rgba(0, 0, 0, 0.5)',
    // Legacy opaque dialog surface kept for the rewrite modal (was #1e2330 —
    // deliberately brighter than surfaceDialog for the oldest dialog).
    surfaceDialogAlt: '#1e2330',
    // Dialog elevation shadow — the one place the flat design keeps a real
    // drop shadow (floating task surfaces above a scrim).
    shadowDialog: '0 8px 32px rgba(0, 0, 0, 0.3)',
    // Rename dialog's larger elevation (see StoryGeneratorApp DialogBox).
    shadowDialogLg: '0 20px 60px rgba(0, 0, 0, 0.48)',

    // Pure highlight token — text/icons that must sit at maximum contrast
    // above an accent/danger fill (flat-design replacement for #ffffff/#fff).
    highlight: '#ffffff',

    // Secondary accent for status badges (e.g. word-count timing chip).
    accent2: '#93b4d4',

    // Semantic colors.
    danger: '#f87171',
    dangerSoft: 'rgba(248, 113, 113, 0.15)',
    dangerBorder: 'rgba(248, 113, 113, 0.35)',
    warning: '#fbbf24',
    warningSoft: 'rgba(251, 191, 36, 0.12)',
    // Stronger warning tint for the load-warning chip border (and any other
    // warning-adjacent hairline) — keeps the amber family out of inline literals.
    warningBorder: 'rgba(251, 191, 36, 0.25)',
    success: '#6ee7b7',

    // Radii. FLAT DESIGN: sharp, near-square corners — depth comes from
    // solid color blocks + hairline borders, not rounded softness. radiusSm
    // is the default for chips/inputs/small controls (a 2px corner just
    // takes the harsh pixel-edge off without reading as "round"), radiusMd
    // for cards/panels/dialogs, and radiusLg only for the largest floating
    // surfaces. Keep these SMALL — a flat UI reads flat because its boxes
    // look like boxes.
    //
    // The former radiusPill token (999px full-round chips) was REMOVED in
    // the flat badge rework: every status chip is now a square Badge with a
    // 2px status rail on its left edge (src/components/Badge.tsx) instead of
    // a pill. Do not reintroduce a pill radius without a token.
    radiusSm: 2,
    radiusMd: 3,
    radiusLg: 4,

    // Soft elevation. Modern Flat Design avoids heavy shadows — depth is
    // communicated by solid background blocks + crisp borders, so we keep
    // shadows subtle and mostly off by default. shadowSm is a single soft
    // bottom whisper for elements that genuinely need separation from the
    // background (chapter cards, code blocks).
    shadowSm: '0 1px 2px rgba(0, 0, 0, 0.4)',
    shadowMd: 'none',
    shadowLg: 'none',
    shadowAccent: 'none',

    // Transition curves reused across hover/focus effects. Flat design keeps
    // motion minimal — color + border transitions only, no translate lifts.
    transitionFast: '120ms ease',
    transition: '160ms ease',
    transitionSlow: '220ms ease',

    // Font stacks.
    fontSans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontMono: 'ui-monospace, "Cascadia Code", "Source Code Pro", "JetBrains Mono", monospace',

    // Font sizes — rem-based. The root font-size is set on <body> in index.html
    // so scaling the entire UI only requires changing that one value.
    fontSize: {
        xs: '0.625rem',     // ~10px at 16px root
        sm: '0.6875rem',    // ~11px
        base: '0.75rem',    // ~12px
        md: '0.8125rem',    // ~13px
        body: '0.875rem',   // ~14px — primary body text
        lg: '0.9375rem',    // ~15px
        xl: '1rem',         // ~16px
    } as const
} as const;

// Helper to build a translucent white overlay of a given alpha — used by
// styled() callers when they want a hover/active surface tint.
export const surface = (alpha: number) => `rgba(255, 255, 255, ${alpha})`;

// Convenience: a soft accent-tinted glow used as a box-shadow on focus.
export const focusRing = theme.accentRing;
