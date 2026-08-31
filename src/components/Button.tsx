// Modular button family — the shared action surfaces the features previously
// styled per-implementation (ActionButton in the old SectionStoryContent,
// GenerateButton/AppendButton, DialogButton, PlotpointsButton,
// RemoveChapterButton, TerminateButton, StoryDeleteButton, icon buttons).
//
// Variants map to the flat design's button taxonomy:
//   - 'outline'  hairline-bordered surface button (default actions, cancels)
//   - 'primary'  solid accent fill (Generate, Append, Rewrite submit)
//   - 'danger'   danger-tinted outline (destructive: Delete Chapter, Terminate)
//   - 'ghost'    borderless quiet control (icon buttons, the tile "x")
//
// Pseudo-selector feedback is attached via the existing class hooks in
// styles/global.ts so hover/disabled states stay in ONE place:
//   - outline → 'sg-hover'   (flat surface swap)
//   - primary → 'sg-primary' (brighter accent solid)
//   - danger  → 'sg-danger'  (flat danger fill swap)
//   - ghost   → none (caller adds sg-hover/sg-danger where the slot needs it)
//
// MODULAR: no domain imports; appearance only. Test contracts that assert
// EXACT classNames (e.g. append-button via sg-primary) are satisfied by the
// variant→class mapping below.
//
// NOTE: merged style objects instead of styled() — consumer `style` props must
// not wipe the base frame (see src/styles/styled.tsx:47 note in Dialog.tsx).

import React from 'react';
import { theme } from '../styles';

export type ButtonVariant = 'outline' | 'primary' | 'danger' | 'ghost';

// Variant → flat base frame.
//
// pointerEvents: 'auto' — REQUIRED. The ActionBar frame (features/content.tsx)
// sets pointerEvents: 'none' so its full-width strip lets scrolling chapter
// content receive clicks through the empty left region; the old ActionButton
// frame re-enabled pointer events per-button (see git dc50a4a SectionStoryContent
// ActionButton). Without this, collapse-all / resume / extend are dead in
// real browsers — jsdom does NOT enforce pointer-events, so the test suite
// cannot catch this regression.
const BASE: React.CSSProperties = {
    fontFamily: theme.fontSans,
    cursor: 'pointer',
    borderRadius: theme.radiusSm,
    pointerEvents: 'auto',
    transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`
};

const FRAME_BY_VARIANT: Record<ButtonVariant, React.CSSProperties> = {
    // Hairline outline — the default secondary action.
    outline: {
        ...BASE,
        padding: '8px 16px',
        fontWeight: 600,
        fontSize: theme.fontSize.body,
        border: `1px solid ${theme.border}`,
        backgroundColor: theme.surface2,
        color: theme.text
    },
    // Solid accent — the one high-emphasis action per surface.
    primary: {
        ...BASE,
        padding: '9px 20px',
        fontWeight: 600,
        fontSize: theme.fontSize.body,
        border: 'none',
        backgroundColor: theme.accent,
        color: theme.highlight
    },
    // Danger outline — destructive actions that still need a confirm step.
    danger: {
        ...BASE,
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
        ...BASE,
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
    // e.g. 'sg-plot-toggle' on top). The append-button's exact class contract
    // ('sg-primary') holds when no extra className is passed.
    className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export const Button: React.FC<ButtonProps> = ({ variant = 'outline', className, style, children, ...rest }) => {
    const hook = CLASS_BY_VARIANT[variant];
    return (
        <button
            type="button"
            {...rest}
            className={hook && className ? `${hook} ${className}` : hook || className}
            style={{ ...FRAME_BY_VARIANT[variant], ...style }}
        >
            {children}
        </button>
    );
};

// Icon button — the compact square control used by the chapter action bar
// (re-expand / fork / rewrite / delete-revision). 30×30, glyph centered,
// hover feedback via inline enter/leave handlers (the original
// ChapterActionButton pattern — preserved because the glyph+border swap is
// too dynamic for a class hook).
export type IconButtonProps = {
    disabled?: boolean;
    onClick?: () => void;
    title?: string;
    'data-testid'?: string;
    children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export const IconButton: React.FC<IconButtonProps> = ({
    disabled,
    onClick,
    children,
    style,
    ...rest
}) => (
    <button
        type="button"
        {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        onClick={onClick}
      disabled={disabled}
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            padding: 0,
            color: disabled ? theme.textFaint : theme.textMuted,
            background: 'transparent',
            border: `1px solid ${disabled ? 'transparent' : theme.border}`,
            borderRadius: theme.radiusMd,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1,
            transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`,
            ...style
        }}
        onMouseEnter={(e) => {
            if (!disabled) {
                e.currentTarget.style.background = theme.surface3;
                e.currentTarget.style.color = theme.accent;
                e.currentTarget.style.borderColor = theme.accent;
            }
        }}
        onMouseLeave={(e) => {
            if (!disabled) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = theme.textMuted;
                e.currentTarget.style.borderColor = theme.border;
            }
        }}
    >
        {children}
    </button>
);
