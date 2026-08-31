// Standard-pattern dialog component — built on the Material UI Dialog.
//
// STANDARD PATTERN: every dialog is composed of exactly three regions, top to
// bottom, the way every mainstream design system (MUI included) structures a
// dialog:
//
//   ┌──────────────────────────────┐
//   │ Dialog.Header  (title)       │  ← MUI DialogTitle, hairline divider under it
//   ├──────────────────────────────┤
//   │ Dialog.Body    (children)    │  ← MUI DialogContent; the ONLY scrolling region
//   ├──────────────────────────────┤
//   │ Dialog.Footer  (actions)     │  ← MUI DialogActions; right-aligned; hairline above
//   └──────────────────────────────┘
//
// Composition API — <Dialog> renders the MUI Dialog (scrim + focus trap +
// paper) and exposes the standard regions/buttons as static sub-components:
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
//     aria-labelledby = `${testId}-title` — all rendered by MUI's Paper slot
//     (slotProps.paper), which is the element carrying MUI's dialog role.
//   - title element: id + data-testid = `${testId}-title` (MUI DialogTitle),
//     textContent exactly the title.
//   - overlay: the MUI container slot (the full-viewport flex scrim) carries
//     data-testid `${testId}-overlay`. MUI closes on backdrop click only when
//     the mousedown AND click both start on the scrim (its nested-click guard),
//     so tests drive it with mouseDown + click.
//   - Escape: MUI's Modal keydown handler (bubbling from the frame) fires
//     onClose with reason 'escapeKeyDown'.
//
// dismissable=false (a submit in flight) suppresses BOTH close reasons in the
// onClose guard — MUI has no per-reason disable props, so the guard is the
// single choke point.
//
// MOUNT GATE: `if (!open) return null` BEFORE rendering MUI's Dialog (which
// then always sees open=true). This keeps the hand-rolled version's
// SYNCHRONOUS unmount semantics — MUI runs an exit transition when its own
// open prop flips, which would keep the frame mounted for the transition
// duration and break the tests' immediate queryByTestId(null) assertions.

import React from 'react';
import {
    Dialog as MaterialDialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    Button as MaterialButton
} from '@mui/material';
import { theme } from '../styles';

// ── Frame styling (sx on the MUI slots) ────────────────────────────────

// Scrim — dark translucent, flex-centers the dialog. Standardized on
// overlayDeeper for ALL dialogs (the old content-area scrim was lighter —
// unifying scrims is part of the standard-pattern rework). NOTE: sx numbers
// are spacing-mapped (2 → 16px) — explicit px strings keep the values exact.
const SCRIM_SX = {
    backgroundColor: theme.overlayDeeper,
    padding: '16px'
};

// Dialog frame — opaque elevated surface. FLAT: square corners (radiusMd=3px),
// crisp strong border, the one sanctioned elevation shadow. maxHeight keeps
// long bodies inside the viewport; the BODY (DialogContent) is the scrolling
// region, so the paper itself clips.
const PAPER_SX = {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: theme.surfaceDialog,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: `${theme.radiusMd}px`,
    // The flat design keeps exactly one drop shadow — the dialog's.
    boxShadow: theme.shadowDialogLg,
    backgroundImage: 'none',
    overflow: 'hidden'
};

// Title band — the standard dialogs ALWAYS give the title its own band with a
// hairline divider underneath; it anchors the task.
const TITLE_SX = {
    padding: '14px 18px',
    flex: '0 0 auto',
    borderBottom: `1px solid ${theme.border}`,
    fontSize: theme.fontSize.lg,
    fontWeight: 700,
    lineHeight: 1.3,
    color: theme.text,
    letterSpacing: 0.1
};

// Body band — the ONLY scrolling region so long content (textareas, chapter
// lists) never breaks the frame.
const BODY_SX = {
    padding: '16px 18px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flex: '1 1 auto'
};

// Footer band — actions right-aligned with a hairline divider above (the
// standard footer affordance).
const FOOTER_SX = {
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 18px',
    borderTop: `1px solid ${theme.border}`,
    flex: '0 0 auto'
};

// ── Sub-components ─────────────────────────────────────────────────────

// Body band — scrolling content region. All feature-specific form fields /
// copy / inline errors live here as children.
const DialogBody: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <DialogContent sx={BODY_SX}>{children}</DialogContent>
);

// Footer band — action buttons right-aligned. Children are usually
// Dialog.CancelButton / Dialog.ConfirmButton (plus small labeled controls
// like the append dialog's chapter-count field).
const DialogFooter: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <DialogActions sx={FOOTER_SX}>{children}</DialogActions>
);

// Shared button frame — keeps the footer height stable between enabled/
// disabled and cancel/confirm swaps. These stay INLINE (not sx) so the exact
// flat fills survive MUI's variant classes and remain assertable via
// el.style (Dialog.test / the visual flat contract).
const DIALOG_BUTTON_BASE: React.CSSProperties = {
    minHeight: 36,
    padding: '8px 16px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.md,
    borderRadius: theme.radiusSm,
    textTransform: 'none',
    boxShadow: 'none',
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
    color: theme.textMuted,
    minWidth: 0
};

// Confirm — solid accent fill (flat). tone="danger" swaps to the destructive
// fill, the standard destructive-action convention (delete/remove dialogs).
const DIALOG_CONFIRM_STYLE: React.CSSProperties = {
    ...DIALOG_BUTTON_BASE,
    fontWeight: 700,
    border: `1px solid ${theme.accent}`,
    backgroundColor: theme.accent,
    color: theme.highlight,
    minWidth: 0
};

const DIALOG_CONFIRM_DANGER_STYLE: React.CSSProperties = {
    ...DIALOG_CONFIRM_STYLE,
    border: `1px solid ${theme.danger}`,
    backgroundColor: theme.danger
};

export type DialogConfirmTone = 'accent' | 'danger';

// Cancel button — the standard low-emphasis escape. className contains the
// 'sg-hover' hook (plus any caller extras).
const DialogCancelButton: React.FC<React.ComponentProps<typeof MaterialButton>> = ({
    className,
    style,
    children,
    ...rest
}) => (
    <MaterialButton
        type="button"
        disableElevation
        {...rest}
        className={className ? `sg-hover ${className}` : 'sg-hover'}
        style={{ ...DIALOG_CANCEL_STYLE, ...style }}
        sx={{ textTransform: 'none' }}
    >
        {children}
    </MaterialButton>
);

// Confirm button — the standard high-emphasis action. Default className
// contains 'sg-dialog-confirm' (App.test asserts it); the danger tone appends
// 'sg-dialog-confirm-danger' whose hover rule lives in styles/global.ts.
const DialogConfirmButton: React.FC<
    React.ComponentProps<typeof MaterialButton> & { tone?: DialogConfirmTone }
> = ({ tone = 'accent', className, style, children, ...rest }) => {
    const classes =
        tone === 'danger'
            ? className
                ? `sg-dialog-confirm sg-dialog-confirm-danger ${className}`
                : 'sg-dialog-confirm sg-dialog-confirm-danger'
            : className
              ? `sg-dialog-confirm ${className}`
              : 'sg-dialog-confirm';
    return (
        <MaterialButton
            type="button"
            disableElevation
            {...rest}
            className={classes}
            style={{ ...(tone === 'danger' ? DIALOG_CONFIRM_DANGER_STYLE : DIALOG_CONFIRM_STYLE), ...style }}
            sx={{ textTransform: 'none' }}
        >
            {children}
        </MaterialButton>
    );
};

// ── Dialog ─────────────────────────────────────────────────────────────

export type DialogProps = {
    // Renders only when true — callers keep their own isOpen booleans so the
    // feature business logic (state machines, in-flight guards) is unchanged.
    open: boolean;
    // Title band content (plain text or a node). Renders in the header as the
    // ONLY child of the title element (exact-textContent contract).
    title: React.ReactNode;
    // Closes on scrim click + Escape. Set false while a submit is in
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
    Body: typeof DialogBody;
    Footer: typeof DialogFooter;
    CancelButton: typeof DialogCancelButton;
    ConfirmButton: typeof DialogConfirmButton;
} = ({ open, title, dismissable = true, onClose, testId, children }) => {
    // MUI fires onClose(event, reason) for 'backdropClick' (scrim) and
    // 'escapeKeyDown'. When dismissable=false (a submit is in flight) both
    // reasons are suppressed — the dialog must not vanish mid-request.
    const handleClose = React.useCallback(
        (_event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => {
            if (!dismissable) return;
            onClose?.();
        },
        [dismissable, onClose]
    );

    // Mount gate — see the header note. Unmount is synchronous, exactly like
    // the previous hand-rolled implementation.
    if (!open) return null;

    // Derived id: frame aria-labelledby + title id + title data-testid all
    // share this, so multiple dialogs can never collide.
    const titleId = testId ? `${testId}-title` : undefined;

    return (
        <MaterialDialog
            open
            onClose={handleClose}
            // The aria-labelled relationship lives on the element carrying
            // MUI's role="dialog" (the paper slot) — passed as the Dialog prop
            // so MUI merges it into its own paper additionalProps.
            aria-labelledby={titleId}
            // The container slot is the full-viewport flex scrim — the element
            // users perceive as "the overlay". data-testid is the overlay test
            // contract; MUI's nested-click guard (mousedown + click must both
            // start here) decides whether a click closes the dialog.
            // (SlotProps typings don't model data-* attributes — cast.)
            slotProps={
                {
                    container: { 'data-testid': testId ? `${testId}-overlay` : undefined, sx: SCRIM_SX },
                    paper: { 'data-testid': testId, sx: PAPER_SX }
                } as any
            }
        >
            {/* Title band — id + data-testid `${testId}-title` (the
                aria-labelledby target). Contains ONLY the title children
                (exact-textContent contract). */}
            <DialogTitle id={titleId} data-testid={titleId} sx={TITLE_SX}>
                {title}
            </DialogTitle>
            {children}
        </MaterialDialog>
    );
};

// Attach the standard regions — the composition API.
Dialog.Body = DialogBody;
Dialog.Footer = DialogFooter;
Dialog.CancelButton = DialogCancelButton;
Dialog.ConfirmButton = DialogConfirmButton;
