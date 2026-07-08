// Global stylesheet for the story generator dashboard.
//
// The vendored styled() helper (src/styles/styled.tsx:38) only applies a
// static inline style object — it cannot express `:hover`, `:focus`, keyframe
// animations, or any pseudo-selector. Modern UI requires those for tactile
// hover/focus feedback. This stylesheet is injected once at boot via
// main.tsx and uses a small set of class hooks that the styled components
// attach (via the `className` prop, which styled() forwards through `...rest`).
//
// All colors reference the same tokens as src/styles/theme.ts so the visual
// style stays consistent. Keep this file in sync with theme.ts if you retune
// the palette.
//
// Modern Flat Design principles applied here:
//   - Depth comes from solid color blocks + crisp hairline borders, NOT shadows,
//     gradients, or glow effects.
//   - Hover feedback swaps to a solid surface color or solid border — never
//     translates / lifts / glows.
//   - The selected-state indicator is a flat accent block (left rail) rather
//     than a gradient-tinted card.

import { theme } from './theme';

// Solid accent fill used by the primary button base background. Flat buttons
// have no gradients — the hover just swaps to a brighter solid.
const ACCENT_SOLID = theme.accent;
const ACCENT_SOLID_HOVER = theme.accentHover;

const sheet = `
/* ---- Shared interactive class hooks ----------------------------------- */

/* Generic hover for flat outline buttons (header toggle, story pills).
   Flat Design: solid surface swap to surface2 + crisper border, no lift. */
.sg-hover:hover { background-color: ${theme.surface2}; border-color: ${theme.borderStrong}; }
.sg-hover:disabled { opacity: 0.55; cursor: not-allowed; }

/* Destructive hover — flat solid danger surface swap. */
.sg-danger:hover { background-color: ${theme.danger}; border-color: ${theme.danger}; color: #ffffff; }
.sg-danger:disabled { opacity: 0.55; cursor: not-allowed; }

/* Primary action button — flat solid accent fill. Hover swaps to a brighter
   accent solid, stays put (no translate, no shadow). */
.sg-primary { background-color: ${ACCENT_SOLID}; }
.sg-primary:hover { background-color: ${ACCENT_SOLID_HOVER}; }
.sg-primary:active { background-color: ${ACCENT_SOLID}; }
.sg-primary:disabled { opacity: 0.55; cursor: not-allowed; }

/* Outline input — flat focus treatment. Flat Design uses a crisp accent
   border swap (not a gl Resource box-shadow ring). A subtle 1px inner accent
   keeps the focus visible without a glow. */
.sg-input:focus { outline: none; border-color: ${theme.accent}; background-color: ${theme.surface3}; }
.sg-input:disabled { opacity: 0.55; cursor: not-allowed; }

/* Story pill — unselected rows get a flat solid hover surface. */
.sg-story-item:hover { background-color: ${theme.surface2}; }

/* Selected story item — modern Flat "active" treatment: a flat solid accent
   surface (no gradient, no glow) with a brighter accent rail via ::before.
   Hover swaps the surface to a slightly brighter accent solid. */
.sg-story-selected {
    position: relative;
    overflow: hidden;
    background-color: ${theme.accent};
    color: #ffffff;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.10);
}
.sg-story-selected:hover {
    background-color: ${theme.accentHover};
}
/* Left rail — a solid lighter-accent bar that visually locks the pick in place. */
.sg-story-selected::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: #c7cdfc;
}

/* Collapsible header — flat hover surface swap. */
.sg-collapse-header:hover { background-color: ${theme.surface2}; }

/* Plotpoints toggle — flat hover, surface + text color swap. */
.sg-plot-toggle:hover { background-color: ${theme.surface3}; color: ${theme.text}; border-color: ${theme.borderStrong}; }

/* ---- Keyframes ------------------------------------------------------- */

@keyframes sg-spin {
    to { transform: rotate(360deg); }
}
/* Spinner badge used while a story is generating. Flat: solid accent ring
   on a faint accent surface, no glow. */
.sg-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid rgba(129, 140, 248, 0.30);
    border-top-color: ${theme.accent};
    border-radius: 50%;
    animation: sg-spin 700ms linear infinite;
}

/* Flat: fade-in kept minimal — opacity only, no translate lift. */
@keyframes sg-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
}
.sg-fade-in { animation: sg-fade-in 160ms ease both; }

/* Scrollbar styling — flat thin dark-native scrollbars. */
.sg-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.sg-scroll::-webkit-scrollbar-track { background: transparent; }
.sg-scroll::-webkit-scrollbar-thumb {
    background: ${theme.surface2};
    border: 2px solid transparent;
    border-radius: 8px;
    background-clip: padding-box;
}
.sg-scroll::-webkit-scrollbar-thumb:hover { background: ${theme.surface3}; background-clip: padding-box; }
`;

// Inject the stylesheet into the document head exactly once. Idempotent —
// re-invocation is a no-op, which keeps fast-refresh/HMR safe.
let injected = false;
export function injectGlobalStyles(): void {
    if (injected || typeof document === 'undefined') return;
    const styleEl = document.createElement('style');
    styleEl.setAttribute('data-sg-styles', '');
    styleEl.textContent = sheet;
    document.head.appendChild(styleEl);
    injected = true;
}
