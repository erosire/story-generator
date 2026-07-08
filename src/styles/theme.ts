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
    accentRing: 'rgba(129, 140, 248, 0.45)',

    // Secondary accent for status badges (e.g. word-count timing chip).
    accent2: '#93b4d4',

    // Semantic colors.
    danger: '#f87171',
    dangerSoft: 'rgba(248, 113, 113, 0.15)',
    dangerBorder: 'rgba(248, 113, 113, 0.35)',
    warning: '#fbbf24',
    warningSoft: 'rgba(251, 191, 36, 0.12)',
    success: '#6ee7b7',

    // Radii.
    radiusSm: 6,
    radiusMd: 8,
    radiusLg: 12,

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
