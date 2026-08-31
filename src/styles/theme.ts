// Centralized design tokens for the story-generator dashboard.
//
// The dashboard previously hard-coded hex/rgba values across a dozen styled
// components, which made the palette drift and theming painful. This module
// centralizes all colors, radii, shadows, transitions, and typography here so
// every component pulls from a single source of truth. Modernizing the visual
// style only requires editing these tokens — the components stay unchanged.
//
// The palette is a deep-space dark theme: a saturated navy base (NOT a neutral
// grey-black — greys read dull on large surfaces) with every elevation layer,
// hairline, and accent carrying the same indigo/sky hue family, plus a vivid
// periwinkle brand accent. Layered elevation via translucent blue-tinted
// overlays, crisp typography on the system UI stack.
//
// NOTE: This module is intentionally pure data (no React) so it can be imported
// anywhere — including from styled() static style objects which are evaluated
// once at module load time.

export const theme = {
    // Base surface tones. Surfaces are stacked translucent layers tinted with
    // the accent hue (NOT neutral white alpha — neutral overlays over a dark
    // base read as flat grey, the "dull" look). The dashboard background uses
    // `bg` and panels layer `surface*` on top.
    bg: '#0a0f1f',
    surface1: 'rgba(130, 150, 255, 0.055)',
    surface2: 'rgba(130, 150, 255, 0.095)',
    surface3: 'rgba(130, 150, 255, 0.15)',
    // The rename dialog uses an opaque surface so the form stays visually
    // grounded above the dimmed dashboard instead of blending into the overlay.
    surfaceDialog: '#141c36',
    // Opaque hover/focus variant of surfaceDialog — used by the header client
    // dropdown (.sg-select in global.ts). Must stay OPAQUE: translucent
    // backgrounds on native form controls composite over the browser's light
    // UA control base when color-scheme is ignored (white-control bug).
    surfaceDialogHover: '#1c2648',

    // Border hairlines — blue-tinted to stay in the surface hue family.
    // Stronger on hover/focus.
    border: 'rgba(148, 163, 255, 0.17)',
    borderStrong: 'rgba(148, 163, 255, 0.34)',

    // Text tones — from dim → bright for hierarchical emphasis. All slightly
    // cool-tinted (blue channel highest) so text sits IN the palette instead
    // of floating as neutral white over it. Tested against #0a0f1f:
    //   text       #f0f3ff  ~16:1  AAA
    //   textMuted  #c9d1f2  ~12:1  AAA
    //   textDim    #97a3d4   ~6:1  AA+
    //   textFaint  #808cbe   ~5:1  AA
    text: '#f0f3ff',
    textMuted: '#c9d1f2',
    textDim: '#97a3d4',
    textFaint: '#808cbe',

    // Brand accent — electric periwinkle/indigo. Used on the primary action,
    // selected story highlight, focus rings, and the header title. Brighter
    // and more saturated than a default indigo so interactive elements pop
    // against the navy surfaces.
    accent: '#7c8cff',
    accentHover: '#9eaaff',
    accentSoft: 'rgba(124, 140, 255, 0.17)',
    // Stronger accent tint — used for the selected sidebar tile's hover state
    // so the active card visibly brightens without a solid fill swap.
    accentSoftHover: 'rgba(124, 140, 255, 0.30)',
    accentRing: 'rgba(124, 140, 255, 0.5)',
    // Crisp near-white accent tints used by status chips whose text sits on a
    // translucent accent fill (sidebar badges). Deriving them from the accent
    // hue keeps the chip family in the same color story as the accent itself.
    accentChipText: '#e4e7ff',
    accentChipBorder: 'rgba(196, 204, 255, 0.5)',
    accentChipFill: 'rgba(124, 140, 255, 0.4)',

    // Overlay blacks — solid translucent scrims for modal/drawer isolation.
    // Kept as tokens (not inline literals) so the elevation story of every
    // overlay lives in this file. Slightly blue-shifted so scrims darken
    // without muddying the hue.
    overlayDim: 'rgba(3, 7, 18, 0.62)',
    overlayDeeper: 'rgba(3, 7, 18, 0.78)',
    // Content-area dialog scrim (rewrite/append/delete confirms) — slightly
    // lighter than the rename dialog's overlay so the chapter list beneath
    // stays readable as context.
    overlayDialog: 'rgba(3, 7, 18, 0.55)',
    // Opaque dialog surface kept for the rewrite modal (deliberately brighter
    // than surfaceDialog for the oldest dialog).
    surfaceDialogAlt: '#1a2342',
    // Dialog elevation shadow — the one place the flat design keeps a real
    // drop shadow (floating task surfaces above a scrim).
    shadowDialog: '0 8px 32px rgba(2, 5, 16, 0.5)',
    // Rename dialog's larger elevation (see StoryGeneratorApp DialogBox).
    shadowDialogLg: '0 20px 60px rgba(2, 5, 16, 0.6)',

    // Pure highlight token — text/icons that must sit at maximum contrast
    // above an accent/danger fill (flat-design replacement for #ffffff/#fff).
    highlight: '#ffffff',

    // Secondary accent for status badges (e.g. word-count timing chip) — a
    // vivid sky tone so the two-accent system (periwinkle + sky) reads bright.
    accent2: '#7fd4ff',

    // ── Companion hue families ──────────────────────────────────────────
    // The dashboard is deliberately NOT monochrome: three harmonious tint
    // families zone the UI so large surfaces never read as one flat color.
    //   - periwinkle (accent family above) — interactive elements + the
    //     sidebar's story tiles.
    //   - violet — app chrome (header / footer / sidebar panel fills).
    //   - sky — content-area cards (chapter cards, sticky bars, stat chips).
    // All three sit within the same cool range so they blend, while the hue
    // separation keeps each zone legible.
    violet: '#a78bfa',
    violetSoft: 'rgba(167, 139, 250, 0.08)',
    violetBorder: 'rgba(167, 139, 250, 0.22)',
    sky: '#38bdf8',
    skySoft: 'rgba(56, 189, 248, 0.10)',
    skySurface: 'rgba(56, 189, 248, 0.065)',
    skyBorder: 'rgba(56, 189, 248, 0.24)',

    // Semantic colors — vivid, slightly warm/cool-tinted for the navy base.
    danger: '#ff7583',
    dangerSoft: 'rgba(255, 117, 131, 0.14)',
    dangerBorder: 'rgba(255, 117, 131, 0.4)',
    warning: '#ffc555',
    warningSoft: 'rgba(255, 197, 85, 0.12)',
    // Stronger warning tint for the load-warning chip border (and any other
    // warning-adjacent hairline) — keeps the amber family out of inline literals.
    warningBorder: 'rgba(255, 197, 85, 0.28)',
    success: '#43dfa2',

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

// Helper to build a translucent overlay of a given alpha — used by styled()
// callers when they want a hover/active surface tint. Tinted with the surface
// hue family (NOT neutral white — neutral overlays read as flat grey on the
// navy base).
export const surface = (alpha: number) => `rgba(130, 150, 255, ${alpha})`;

// Convenience: a soft accent-tinted glow used as a box-shadow on focus.
export const focusRing = theme.accentRing;
