// Modular button family — built on the Material UI Button.
//
// Variants map to the flat design's button taxonomy:
//   - 'outline'  hairline-bordered surface button (default actions, cancels)
//   - 'primary'  solid accent fill (Generate, Append, Rewrite submit)
//   - 'danger'   danger-tinted outline (destructive: Delete Chapter, Terminate)
//   - 'ghost'    borderless quiet control (icon buttons, the tile "x")
//
// STYLING CONTRACT: the variant frames stay INLINE styles merged onto the MUI
// Button's root. Two reasons this must remain inline (not Emotion/sx classes):
//   1. pointerEvents: 'auto' — REQUIRED and asserted via style.pointerEvents in
//      App.test. The ActionBar frame (features/content.tsx) sets
//      pointerEvents: 'none' so its full-width strip lets scrolling chapter
//      content receive clicks through the empty left region; without this,
//      collapse-all / resume / extend are dead in real browsers — jsdom does
//      NOT enforce pointer-events, so the test suite cannot catch a regression.
//   2. The inline fill beats MUI's own variant classes, keeping the exact flat
//      colors regardless of theme resolution.
// Pseudo-selector feedback is attached via the .sg-* class hooks in
// styles/global.ts (rendered classes — the hover rules out-specify MUI's):
//   - outline → 'sg-hover'   (flat surface swap)
//   - primary → 'sg-primary' (brighter accent solid)
//   - danger  → 'sg-danger'  (flat danger fill swap)
//   - ghost   → none (caller adds sg-hover/sg-danger where the slot needs it)
//
// The sx prop neutralizes MUI's defaults that would fight the flat frames
// (uppercase text, 64px minWidth) so the MUI Button renders as the same
// compact flat control the hand-rolled version was.

import React from 'react';
import { Button as MaterialButton } from '@mui/material';
import { theme } from '../styles';

export type ButtonVariant = 'outline' | 'primary' | 'danger' | 'ghost';

const FRAME_BY_VARIANT: Record<ButtonVariant, React.CSSProperties> = {
    // Hairline outline — the default secondary action.
    outline: {
        padding: '8px 16px',
        fontWeight: 600,
        fontSize: theme.fontSize.body,
        border: `1px solid ${theme.border}`,
        backgroundColor: theme.surface2,
        color: theme.text
    },
    // Solid accent — the one high-emphasis action per surface.
    primary: {
        padding: '9px 20px',
        fontWeight: 600,
        fontSize: theme.fontSize.body,
        border: 'none',
        backgroundColor: theme.accent,
        color: theme.highlight
    },
    // Danger outline — destructive actions that still need a confirm step.
    danger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        fontWeight: 500,
        fontSize: theme.fontSize.base,
        border: `1px solid ${theme.dangerBorder}`,
        backgroundColor: theme.dangerSoft,
        color: theme.danger
    },
    // Ghost — icon-only / quiet controls. No frame; the caller adds padding.
    ghost: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        fontSize: theme.fontSize.body,
        border: 'none',
        backgroundColor: 'transparent',
        color: theme.textMuted
    }
};

// Shared frame properties every variant carries (cursor + the pointerEvents
// contract + the flat transition).
const BASE: React.CSSProperties = {
    fontFamily: theme.fontSans,
    cursor: 'pointer',
    borderRadius: theme.radiusSm,
    pointerEvents: 'auto',
    transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`
};

// Variant → class hook for the pseudo-selector feedback (global.ts).
const CLASS_BY_VARIANT: Record<ButtonVariant, string> = {
    outline: 'sg-hover',
    primary: 'sg-primary',
    danger: 'sg-danger',
    ghost: ''
};

export type ButtonProps = {
    variant?: ButtonVariant;
    // Extra classes appended AFTER the variant hook class (callers compose
    // e.g. 'sg-plot-toggle' on top). The append-button's class contract
    // ('sg-primary' contained) holds when no extra className is passed.
    className?: string;
} & Omit<React.ComponentProps<typeof MaterialButton>, 'variant' | 'className' | 'style'> & {
    style?: React.CSSProperties;
};

export const Button: React.FC<ButtonProps> = ({ variant = 'outline', className, style, children, ...rest }) => {
    const hook = CLASS_BY_VARIANT[variant];
    return (
        <MaterialButton
            type="button"
            {...rest}
            className={hook && className ? `${hook} ${className}` : hook || className}
            style={{ ...BASE, ...FRAME_BY_VARIANT[variant], ...style }}
            // Neutralize MUI defaults that fight the flat frames: no uppercase,
            // no forced 64px minWidth, normal line-height.
            sx={{ textTransform: 'none', minWidth: 0, lineHeight: 1.5 }}
        >
            {children}
        </MaterialButton>
    );
};

// Icon button — the compact square control used by the chapter action bar
// (re-expand / fork / rewrite / delete-revision). 30×30, glyph centered.
// Built on the Material UI IconButton; the hover feedback that previously
// required JS mouseenter/leave handlers is now a CSS :hover rule in sx.
export type IconButtonProps = {
    disabled?: boolean;
    onClick?: () => void;
    title?: string;
    'data-testid'?: string;
    children: React.ReactNode;
} & Omit<React.ComponentProps<typeof MaterialButton>, 'variant' | 'children' | 'style'> & {
    style?: React.CSSProperties;
};

export const IconButton: React.FC<IconButtonProps> = ({ disabled, onClick, children, style, ...rest }) => (
    <MaterialButton
        type="button"
        {...(rest as Record<string, unknown>)}
        onClick={onClick}
        disabled={disabled}
        style={style}
        // CSS hover replaces the old inline JS enter/leave handlers: surface +
        // accent border swap, the flat treatment from the design tokens.
        sx={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            minWidth: 0,
            padding: 0,
            color: disabled ? theme.textFaint : theme.textMuted,
            background: 'transparent',
            border: `1px solid ${disabled ? 'transparent' : theme.border}`,
            borderRadius: theme.radiusMd,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`,
            '&:hover': disabled
                ? undefined
                : {
                      background: theme.surface3,
                      color: theme.accent,
                      borderColor: theme.accent
                  }
        }}
    >
        {children}
    </MaterialButton>
);
