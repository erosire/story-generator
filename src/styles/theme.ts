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
    surface1: 'rgba(255, 255, 255, 0.025)',
    surface2: 'rgba(255, 255, 255, 0.045)',
    surface3: 'rgba(255, 255, 255, 0.07)',

    // Border hairlines. Stronger on hover/focus.
    border: 'rgba(255, 255, 255, 0.08)',
    borderStrong: 'rgba(255, 255, 255, 0.16)',

    // Text tones — from dim → bright for hierarchical emphasis.
    text: '#e6e8ee',
    textMuted: '#a4abbd',
    textDim: '#6b7180',
    textFaint: '#4a4f5c',

    // Brand accent — indigo/blue. Used on primary action, selected story
    // highlight, focus rings, and the header title.
    accent: '#6366f1',
    accentHover: '#7c7ff5',
    accentSoft: 'rgba(99, 102, 241, 0.18)',
    accentRing: 'rgba(99, 102, 241, 0.45)',

    // Secondary accent for status badges (e.g. word-count timing chip).
    accent2: '#7ca6c9',

    // Semantic colors.
    danger: '#ff6b6b',
    dangerSoft: 'rgba(255, 107, 107, 0.12)',
    dangerBorder: 'rgba(255, 107, 107, 0.32)',
    warning: '#ffb86b',
    warningSoft: 'rgba(255, 184, 107, 0.10)',
    success: '#5fd9a5',

    // Radii.
    radiusSm: 6,
    radiusMd: 8,
    radiusLg: 12,

    // Soft elevation shadows. Used on cards and the input focus state to lift
    // them off the flat dark background without adding heavy borders.
    shadowSm: '0 1px 2px rgba(0, 0, 0, 0.4)',
    shadowMd: '0 4px 16px rgba(0, 0, 0, 0.45)',
    shadowLg: '0 12px 40px rgba(0, 0, 0, 0.55)',
    shadowAccent: '0 4px 18px rgba(99, 102, 241, 0.35)',

    // Transition curves reused across hover/focus effects.
    transitionFast: '120ms ease',
    transition: '180ms ease',
    transitionSlow: '280ms cubic-bezier(0.16, 1, 0.3, 1)',

    // Font stacks.
    fontSans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontMono: 'ui-monospace, "Cascadia Code", "Source Code Pro", "JetBrains Mono", monospace'
} as const;

// Helper to build a translucent white overlay of a given alpha — used by
// styled() callers when they want a hover/active surface tint.
export const surface = (alpha: number) => `rgba(255, 255, 255, ${alpha})`;

// Convenience: a soft accent-tinted glow used as a box-shadow on focus.
export const focusRing = theme.accentRing;
