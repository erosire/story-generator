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
/* ---- Color scheme ------------------------------------------------------ */

/* Native UI surfaces the browser paints for us — scrollbars, native
   dialogs, and native form controls (incl. the header client dropdown's
   <select> control + options popup, StoryGeneratorApp ClientSelect) are
   drawn per the document's color scheme. Without this dark hint they
   default to the LIGHT scheme (white tracks / grey-on-white popups) which
   shatters the dark dashboard. */
:root { color-scheme: dark; }

/* ---- Shared interactive class hooks ----------------------------------- */

/* Generic hover for flat outline buttons (header toggle, story pills).
   Flat Design: solid surface swap to surface2 + crisper border, no lift. */
.sg-hover:hover { background-color: ${theme.surface2}; border-color: ${theme.borderStrong}; }
.sg-hover:disabled { opacity: 0.55; cursor: not-allowed; }

/* Destructive hover — flat solid danger surface swap. */
.sg-danger:hover { background-color: ${theme.danger}; border-color: ${theme.danger}; color: ${theme.highlight}; }
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

/* Header client dropdown — themed entirely via class hooks so the hover/focus
   states actually apply. (Inline "style" from styled() outranks every class
   rule, so colors that lived inline made the sg-hover/sg-input states dead
   code — they could never override the inline background/border.) The control
   uses an OPAQUE dark surface + light text: some browsers/webviews ignore
   the color-scheme hint, and a translucent background then composites over
   the UA's white control base -> white control with unreadable text. Opaque
   colors are immune to that. colorScheme:"dark" remains inline on the element
   (StoryGeneratorApp ClientSelect) for the UA-drawn options popup.
   NOTE: these rules sit AFTER .sg-input:focus above so, at equal specificity,
   the opaque focus treatment here wins for the select. */
.sg-select {
    color: ${theme.text};
    background-color: ${theme.surfaceDialog};
    border: 1px solid ${theme.border};
}
.sg-select:hover {
    background-color: ${theme.surfaceDialogHover};
    border-color: ${theme.borderStrong};
}
.sg-select:focus {
    background-color: ${theme.surfaceDialogHover};
    border-color: ${theme.accent};
    box-shadow: 0 0 0 2px ${theme.accentRing};
}
/* Options popup entries — explicit dark surface + light text. Chromium draws
   the popup per the select's color-scheme (inline "dark"), but Firefox and
   embedded webviews style the popup from the <option> elements themselves;
   without this rule those popups render white with grey text. */
.sg-select option {
    color: ${theme.text};
    background-color: ${theme.surfaceDialog};
}

/* Rename dialog — a stronger input focus treatment makes the active editor
   unambiguous while leaving the dialog's opaque surface visually stable. */
.sg-dialog-input:focus {
    border-color: ${theme.accent};
    background-color: ${theme.surface1};
    box-shadow: 0 0 0 3px ${theme.accentRing};
}

/* Rename dialog primary action — only enabled buttons receive hover feedback;
   disabled confirmation remains visibly unavailable and cannot look clickable. */
.sg-dialog-confirm:hover:not(:disabled) {
    background-color: ${theme.accentHover};
    border-color: ${theme.accentHover};
}
.sg-dialog-confirm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Destructive confirmation (delete-revision / remove-chapter dialogs) — the
   danger-tone ConfirmButton. Flat: hover swaps to the brighter danger solid;
   disabled dims. Shares the base .sg-dialog-confirm disabled rule above. */
.sg-dialog-confirm.sg-dialog-confirm-danger:hover:not(:disabled) {
    background-color: ${theme.danger};
    border-color: ${theme.danger};
}

/* The header title is interactive only when a story is selected. */
.sg-title-action { cursor: pointer; }

/* Story tile — unselected tiles get a flat solid hover surface swap plus a
   crisper border so the card edge "lights up" on pointer. No translate/lift. */
.sg-story-item:hover { background-color: ${theme.surface3}; border-color: ${theme.borderStrong}; }

/* Selected story tile — modern "active card" treatment: an accent-tinted
   translucent surface with a crisp accent border (no solid fill, no gradient,
   no glow), and a brighter accent rail via ::before. Hover deepens the tint
   and brightens the border without ever becoming a solid block. */
.sg-story-selected {
    position: relative;
    overflow: hidden;
    background-color: ${theme.accentSoft};
    border-color: ${theme.accent};
    color: ${theme.highlight};
}
.sg-story-selected:hover {
    background-color: ${theme.accentSoftHover};
    border-color: ${theme.accentHover};
}
/* Left rail — a solid lighter-accent bar that visually locks the pick in
   place. Drawn inside the tile's left border (overflow: hidden clips it to
   the card's rounded corners). */
.sg-story-selected::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: ${theme.accentHover};
}

/* Background-processing animation for story tiles. While the server's job
   registry reports a live background thread for the story (or this session's
   poll loop is waiting), SectionStoryTabs attaches .sg-story-processing and
   the tile's SURFACE breathes between its normal and its hovered brightness.
   Background-color only — no translate, no glow — so the pulse stays within
   the flat design language. Scoped per tile variant because the two variants
   breathe between different surfaces (unselected: surface2→surface3;
   selected: accentSoft→accentSoftHover). The animation overrides the static
   hover background while running (CSS animations win the cascade); the hover
   border swap still applies, so the tile keeps its tactile hover feedback. */
@keyframes sg-processing-pulse {
    0%, 100% { background-color: ${theme.surface2}; }
    50%      { background-color: ${theme.surface3}; }
}
.sg-story-item.sg-story-processing {
    animation: sg-processing-pulse 1.8s ease-in-out infinite;
}
@keyframes sg-processing-pulse-selected {
    0%, 100% { background-color: ${theme.accentSoft}; }
    50%      { background-color: ${theme.accentSoftHover}; }
}
.sg-story-selected.sg-story-processing {
    animation: sg-processing-pulse-selected 1.8s ease-in-out infinite;
}
/* Reduced-motion users get the spinner badge only — the surface pulse is
   decorative and stops without changing what the tile communicates. */
@media (prefers-reduced-motion: reduce) {
    .sg-story-item.sg-story-processing,
    .sg-story-selected.sg-story-processing {
        animation: none;
    }
}

/* Collapsible header — flat hover surface swap. */
.sg-collapse-header:hover { background-color: ${theme.surface2}; }

/* Sidebar search input — placeholder colored via the pseudo-selector that
   inline styles cannot express (see src/styles/styled.tsx note). The focus
   treatment is the shared .sg-input flat swap (accent border, no glow); this
   rule only pins the placeholder to the dimmest text token. */
.sg-search::placeholder { color: ${theme.textFaint}; }

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

/* Dialog entrance is opacity-only so the focused task appears immediately
   without adding a distracting movement effect. */
@keyframes sg-dialog-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
}

/* Scrollbar styling — flat thin dark-native scrollbars. Square corners to
   match the flat radius system (a rounded thumb on an otherwise square UI
   reads as an accident). */
.sg-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.sg-scroll::-webkit-scrollbar-track { background: transparent; }
.sg-scroll::-webkit-scrollbar-thumb {
    background: ${theme.surface2};
    border: 2px solid transparent;
    border-radius: ${theme.radiusSm}px;
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
