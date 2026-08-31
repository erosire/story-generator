// Standard-pattern dialog component — the modular replacement for the four
// hand-rolled dialog implementations that previously lived inline in the
// features (rename in the old StoryGeneratorApp header; rewrite / append /
// delete-revision / remove-chapter in the old SectionStoryContent).
//
// STANDARD PATTERN (the rework): every dialog is composed of exactly three
// regions, top to bottom, the way every mainstream design system (MUI, Radix,
// Apple HIG, Windows Fluent) structures a dialog:
//
//   ┌──────────────────────────────┐
//   │ Dialog.Header  (title)       │  ← hairline divider under it
//   ├──────────────────────────────┤
//   │ Dialog.Body    (children)    │  ← the ONLY region that scrolls
//   ├──────────────────────────────┤
//   │ Dialog.Footer  (actions)     │  ← right-aligned; hairline above
//   └──────────────────────────────┘
//
// The previous implementations each re-invented this differently (no footer
// divider, actions inline with the body, no header band), which is why they
// read as ad hoc.
//
// Composition API — <Dialog> renders overlay + frame + header, and exposes
// the standard regions/buttons as static sub-components:
//
//   <Dialog open title="Remove chapter" testId="remove-chapter-dialog"
//           onClose={cancel}>
//     <Dialog.Body>…</Dialog.Body>
//     <Dialog.Footer>
//       <Dialog.CancelButton testId="remove-chapter-cancel" … />
//       <Dialog.ConfirmButton tone="danger" testId="remove-chapter-confirm" … />
//     </Dialog.Footer>
//   </Dialog>
//
// MODULAR: no story-domain imports, no store access — pure presentation.
// Features own what the buttons DO; the dialog owns how it looks.
//
// Test contract (App.test.tsx) preserved by construction:
//   - frame: data-testid={testId}, role="dialog", aria-modal="true",
//     aria-labelledby = `${testId}-title` (rename-dialog:395-397,
//     delete-dialog / remove-chapter-dialog).
//   - title element: id + data-testid = `${testId}-title`, textContent exactly
//     the title (delete-dialog-title:2042, remove-chapter-dialog-title:2236 —
//     so the title band must contain ONLY the title text, no duplicated
//     screen-reader copy).
//   - ConfirmButton default class is EXACTLY 'sg-dialog-confirm'
//     (rename-confirm:400 asserts toBe, not toContain).
//
// Accessibility: Escape closes (standard), overlay click closes — both
// guarded by dismissable=false while a submit is in flight (the old dialogs
// each implemented this guard ad hoc; now it is one prop).
//
// NOTE on styling: the buttons/frames that need per-variant values are plain
// components with MERGED style objects, NOT styled() pieces — the vendored
// styled() (src/styles/styled.tsx:47) applies a consumer `style` prop by
// fully replacing the static style object, so a variant override passed via
// style would wipe the base styles. Purely static frames are safe with
// styled(); anything dynamic merges manually here.

import React from 'react';
import { styled, theme } from '../styles';

// ── Static frame pieces (styled() is safe: no consumer overrides) ──────

// Overlay scrim — dark translucent, flex-centers the dialog, padding keeps
// the dialog off narrow viewport edges. Standardized on overlayDeeper for
// ALL dialogs (the old content-area scrim was lighter — unifying scrims is
// part of the standard-pattern rework).
const DialogOverlayFrame = styled('div', {
    position: 'fixed',
    inset: 0,
    backgroundColor: theme.overlayDeeper,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    boxSizing: 'border-box' as const,
    zIndex: 1000,
    animation: 'sg-dialog-fade-in 140ms ease both'
});

// Dialog frame — opaque elevated surface. FLAT: square corners (radiusMd=3px),
// crisp strong border, the one sanctioned elevation shadow. maxHeight keeps
// long bodies inside the viewport; the BODY is the scrolling region.
const DialogFrame = styled('div', {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85vh',
    boxSizing: 'border-box' as const,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: theme.surfaceDialog,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: theme.radiusMd,
    boxShadow: theme.shadowDialogLg,
    overflow: 'hidden'
});

// Header band — title row with a hairline divider underneath. Standard
// dialogs ALWAYS give the title its own band; it anchors the task.
const DialogHeaderFrame = styled('div', {
    display: 'flex',
    alignItems: 'center',
    padding: '14px 18px',
    borderBottom: `1px solid ${theme.border}`,
    flex: '0 0 auto'
});

// Title text — the element carrying id + data-testid `${testId}-title`.
// Contains ONLY the title children (exact-textContent test contract).
const DialogTitleText = styled('h3', {
    margin: 0,
    fontSize: theme.fontSize.lg,
    fontWeight: 700,
    lineHeight: 1.3,
    color: theme.text,
    letterSpacing: 0.1
});

// Body band — the ONLY scrolling region (overflowY:auto) so long content
// (textareas, chapter lists) never breaks the frame.
const DialogBodyFrame = styled('div', {
    padding: '16px 18px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    flex: '1 1 auto'
});

// Footer band — actions right-aligned with a hairline divider above (the
// standard footer affordance the old dialogs were missing).
const DialogFooterFrame = styled('div', {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
    padding: '12px 18px',
    borderTop: `1px solid ${theme.border}`,
    flex: '0 0 auto'
});

// ── Button bases (merged manually — see file header note) ──────────────

// Shared dimensions for both dialog buttons so the footer height stays
// stable between enabled/disabled and cancel/confirm swaps.
const DIALOG_BUTTON_BASE: React.CSSProperties = {
    minHeight: 36,
    padding: '8px 16px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.md,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    transition: `background-color ${theme.transition}, color ${theme.transition}, border-color ${theme.transition}, opacity ${theme.transition}`
};

// Cancel — low-emphasis outline. The sg-hover class hook (global.ts) supplies
// the flat hover surface swap; sg-hover:disabled dims it.
const DIALOG_CANCEL_STYLE: React.CSSProperties = {
    ...DIALOG_BUTTON_BASE,
    fontWeight: 600,
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.surface1,
    color: theme.textMuted
};

// Confirm — solid accent fill (flat). tone="danger" swaps to the destructive
// fill, the standard destructive-action convention (delete/remove dialogs).
const DIALOG_CONFIRM_STYLE: React.CSSProperties = {
    ...DIALOG_BUTTON_BASE,
    fontWeight: 700,
    border: `1px solid ${theme.accent}`,
    backgroundColor: theme.accent,
    color: theme.highlight
};

const DIALOG_CONFIRM_DANGER_STYLE: React.CSSProperties = {
    ...DIALOG_CONFIRM_STYLE,
    border: `1px solid ${theme.danger}`,
    backgroundColor: theme.danger
};

export type DialogConfirmTone = 'accent' | 'danger';

// ── Sub-components ─────────────────────────────────────────────────────

// Header band (rendered by <Dialog> itself; exposed for completeness).
const DialogHeader: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <DialogHeaderFrame>
        <DialogTitleText>{children}</DialogTitleText>
    </DialogHeaderFrame>
);

// Body band — scrolling content region. All feature-specific form fields /
// copy / inline errors live here as children.
const DialogBody: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <DialogBodyFrame>{children}</DialogBodyFrame>
);

// Footer band — action buttons right-aligned. Children are usually
// Dialog.CancelButton / Dialog.ConfirmButton (plus small labeled controls
// like the append dialog's chapter-count input).
const DialogFooter: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <DialogFooterFrame>{children}</DialogFooterFrame>
);

// Cancel button — the standard low-emphasis escape. className is EXACTLY
// 'sg-hover' unless the caller appends more (no trailing-space padding).
const DialogCancelButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
    className,
    style,
    children,
    ...rest
}) => (
    <button
        type="button"
        {...rest}
        className={className ? `sg-hover ${className}` : 'sg-hover'}
        style={{ ...DIALOG_CANCEL_STYLE, ...style }}
    >
        {children}
    </button>
);

// Confirm button — the standard high-emphasis action. Default className is
// EXACTLY 'sg-dialog-confirm' (App.test.tsx:400 asserts toBe); the danger
// tone appends 'sg-dialog-confirm-danger' whose hover rule lives in
// styles/global.ts.
const DialogConfirmButton: React.FC<
    React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: DialogConfirmTone }
> = ({ tone = 'accent', className, style, children, ...rest }) => (
    <button
        type="button"
        {...rest}
        className={
            tone === 'danger'
                ? className
                    ? `sg-dialog-confirm sg-dialog-confirm-danger ${className}`
                    : 'sg-dialog-confirm sg-dialog-confirm-danger'
                : className
                  ? `sg-dialog-confirm ${className}`
                  : 'sg-dialog-confirm'
        }
        style={{ ...(tone === 'danger' ? DIALOG_CONFIRM_DANGER_STYLE : DIALOG_CONFIRM_STYLE), ...style }}
    >
        {children}
    </button>
);

// ── Dialog ─────────────────────────────────────────────────────────────

export type DialogProps = {
    // Renders only when true — callers keep their own isOpen booleans so the
    // feature business logic (state machines, in-flight guards) is unchanged.
    open: boolean;
    // Title band content (plain text or a node). Renders in the header as the
    // ONLY child of the title element (exact-textContent contract).
    title: React.ReactNode;
    // Closes on overlay click + Escape. Set false while a submit is in
    // flight — a dialog must not vanish mid-request (each old dialog guarded
    // this ad hoc; now it is one prop).
    dismissable?: boolean;
    onClose?: () => void;
    // data-testid for the frame. Derives the title element's id AND
    // data-testid as `${testId}-title` (rename/delete/remove contracts);
    // the aria-labelledby on the frame points at it.
    testId?: string;
    children?: React.ReactNode;
};

export const Dialog: React.FC<DialogProps> & {
    Header: typeof DialogHeader;
    Body: typeof DialogBody;
    Footer: typeof DialogFooter;
    CancelButton: typeof DialogCancelButton;
    ConfirmButton: typeof DialogConfirmButton;
} = ({ open, title, dismissable = true, onClose, testId, children }) => {
    // Escape closes — the standard keyboard affordance the old dialogs were
    // missing entirely. Bound on the frame (fires only while mounted) and
    // suppressed when !dismissable (mid-submit).
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape' && dismissable) {
            e.stopPropagation();
            onClose?.();
        }
    };

    if (!open) return null;

    // Derived id: frame aria-labelledby + title id + title data-testid all
    // share this, so multiple dialogs can never collide.
    const titleId = testId ? `${testId}-title` : undefined;

    return (
        <DialogOverlayFrame
            role="presentation"
            data-testid={testId ? `${testId}-overlay` : undefined}
            onClick={() => {
                if (dismissable) onClose?.();
            }}
        >
            <DialogFrame
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-testid={testId}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={handleKeyDown}
            >
                <DialogHeaderFrame>
                    <DialogTitleText id={titleId} data-testid={titleId}>
                        {title}
                    </DialogTitleText>
                </DialogHeaderFrame>
                {children}
            </DialogFrame>
        </DialogOverlayFrame>
    );
};

// Attach the standard regions — the composition API.
Dialog.Header = DialogHeader;
Dialog.Body = DialogBody;
Dialog.Footer = DialogFooter;
Dialog.CancelButton = DialogCancelButton;
Dialog.ConfirmButton = DialogConfirmButton;
