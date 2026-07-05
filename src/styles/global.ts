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

import { theme } from './theme';

// Build the CSS string. We use CSS variables for the accent tokens so future
// runtime theming (eg. dark/light swap) only needs to redefine --sg-accent.
const sheet = `
/* ---- Shared interactive class hooks ----------------------------------- */

/* Generic hover lift — used by header toggle, story pills. */
.sg-hover:hover { background-color: ${theme.surface2}; border-color: ${theme.borderStrong}; }
.sg-hover:active { transform: translateY(0.5px); }

/* Destructive hover — delete button. */
.sg-danger:hover { background-color: rgba(255, 107, 107, 0.18); border-color: ${theme.danger}; color: #ff8a8a; }
.sg-danger:disabled { opacity: 0.55; cursor: not-allowed; }

/* Primary action button — gradient + glow on hover. */
.sg-primary:hover { background: linear-gradient(180deg, ${theme.accentHover}, ${theme.accent}); box-shadow: ${theme.shadowAccent}; transform: translateY(-1px); }
.sg-primary:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(99, 102, 241, 0.25); }
.sg-primary:disabled { opacity: 0.55; cursor: not-allowed; transform: none; box-shadow: none; }

/* Outline input — focus ring. Used by StorylineTextarea + ChapterCountInput. */
.sg-input:focus { outline: none; border-color: ${theme.accent}; box-shadow: 0 0 0 3px ${theme.accentRing}; background-color: ${theme.surface3}; }
.sg-input:disabled { opacity: 0.55; cursor: not-allowed; }

/* Story pill — selected/unselected states handled inline, but unselected
   rows get a hover bg here. */
.sg-story-item:hover { background-color: ${theme.surface2}; }

/* Collapsible header — hover subtle bg. */
.sg-collapse-header:hover { background-color: ${theme.surface2}; }

/* Plotpoints toggle — hover lift. */
.sg-plot-toggle:hover { background-color: ${theme.surface3}; color: ${theme.text}; }

/* ---- Keyframes ------------------------------------------------------- */

@keyframes sg-spin {
    to { transform: rotate(360deg); }
}
/* Spinner badge used while a story is generating. */
.sg-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid ${theme.accentSoft};
    border-top-color: ${theme.accent};
    border-radius: 50%;
    animation: sg-spin 700ms linear infinite;
}

@keyframes sg-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
}
/* Subtle entrance used by chapter cards + plotpoints list. */
.sg-fade-in { animation: sg-fade-in 220ms ease both; }

/* Scrollbar styling — modern thin dark-native scrollbars. */
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
