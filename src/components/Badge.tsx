// Flat-design badge/chip component — the modular replacement for the previous
// per-feature pill implementations (JobCountBadge / Badge / BadgeActive /
// StatChip / ChapterMeta were each styled locally with 999px pill radii).
//
// DELIBERATE CUSTOM COMPONENT (not MUI Chip): the interactive controls are all
// Material UI (components/Button.tsx, Dialog.tsx, Input.tsx, Collapsible.tsx),
// but this chip's signature is its 2px left STATUS RAIL — a display element
// MUI's Chip cannot express without the exact same custom styling. Swapping to
// <Chip> would trade the design language for a generic pill, so the chip stays
// hand-rolled on a plain <span>.
//
// FLAT REWORK: badges are no longer pills. The flat chip is a SQUARE tag:
//   - 2px corner radius (theme.radiusSm) — reads as a crisp block, not a bubble
//   - a 2px solid accent EDGE on the left as the status marker — the flat
//     design's signature device (the same left-rail trick the selected
//     sidebar tile uses), which lets the chip work without heavy fills
//   - solid surface + hairline border for the rest of the frame
// Variants swap the edge color: neutral (borderStrong), accent (accent),
// danger (danger), warning (warning).
//
// Reusable anywhere: no story-domain imports, everything driven by props +
// theme tokens.
//
// NOTE: the chip is a PLAIN <span> with a merged style object, NOT a styled()
// piece — the frame is deliberately constructed from plain React.CSSProperties
// objects so a consumer `style` prop MERGES on top without ever risking the
// frame (this predates the @presource/react-backed styled() in ../styles/
// styled.tsx, which also merges, but the explicit merge keeps the variant →
// edge/color math obvious).
//
// Cross-refs: src/styles/theme.ts (tokens), .sg-spinner ring (global.ts) can
// still be rendered INSIDE via children (the processing chip does this).

import React from 'react';
import { theme } from '../styles';

// Variant → edge color. The 2px left rail is the status marker; everything
// else about the chip is variant-neutral.
const EDGE_BY_VARIANT = {
    neutral: theme.borderStrong,
    accent: theme.accent,
    danger: theme.danger,
    warning: theme.warning
} as const;

// Variant → text color. Neutral counts read as metadata (dimmed); the
// activity variants read as status (full text).
const TEXT_BY_VARIANT = {
    neutral: theme.textMuted,
    accent: theme.text,
    danger: theme.text,
    warning: theme.text
} as const;

export type BadgeVariant = keyof typeof EDGE_BY_VARIANT;

// Chip frame — merged static base (see file header note for why this is not
// a styled() piece). Height pinned to 20px so text glyph sizes (⏳ renders
// larger in system emoji fonts) can never stretch a chip row.
const BADGE_FRAME: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    flex: '0 0 auto',
    height: 20,
    boxSizing: 'border-box',
    overflow: 'hidden',
    padding: '0 7px',
    // FLAT: square corners (2px), not a pill. The variant's left rail below
    // is the status device.
    borderRadius: theme.radiusSm,
    fontSize: theme.fontSize.xs,
    lineHeight: 1,
    fontWeight: 600
};

export type BadgeProps = {
    children?: React.ReactNode;
    variant?: BadgeVariant;
    // Flat chips do not need filled emphasis (the rail marks them), but a
    // slightly raised surface keeps them readable over panel surfaces.
    // surface2 is the default; surface3 for chips on top of other chips
    // (the selected tile's badges).
    elevated?: boolean;
} & React.HTMLAttributes<HTMLSpanElement>;

// Flat badge chip. Usage:
//   <Badge variant="accent">5ch</Badge>
//   <Badge variant="neutral"><span className="sg-spinner" /> ⏳</Badge>
// Consumer `style` overrides merge ON TOP of the frame (never replaces it).
export const Badge: React.FC<BadgeProps> = ({ variant = 'neutral', elevated, children, style, ...rest }) => (
    <span
        {...rest}
        style={{
            ...BADGE_FRAME,
            // Left status rail — 2px solid edge in the variant color. This is
            // the flat marker replacing the old pill's tinted fill.
            borderLeft: `2px solid ${EDGE_BY_VARIANT[variant]}`,
            borderRight: `1px solid ${theme.border}`,
            borderTop: `1px solid ${theme.border}`,
            borderBottom: `1px solid ${theme.border}`,
            background: elevated ? theme.surface3 : theme.surface2,
            color: TEXT_BY_VARIANT[variant],
            ...style
        }}
    >
        {children}
    </span>
);
