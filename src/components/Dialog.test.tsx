// Tests for the modular standard-pattern Dialog (src/components/Dialog.tsx).
//
// Covers:
//   - renders nothing when open=false; frame + regions when open=true
//   - frame a11y contract: role=dialog, aria-modal, aria-labelledby → title id
//   - title element carries id + data-testid `${testId}-title` with EXACT text
//   - ConfirmButton default className is EXACTLY 'sg-dialog-confirm'
//   - CancelButton hook class 'sg-hover'
//   - danger tone appends the danger class + swaps the fill
//   - overlay click closes when dismissable; ignored when dismissable=false
//   - Escape closes via keydown on the frame
//
// These mirror the App.test.tsx contracts (rename/delete/remove dialogs)
// at the component level so regressions surface without the full app.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './Dialog';

describe('Dialog', () => {
    it('renders nothing while closed and the standard bands while open', () => {
        const { rerender } = render(
            <Dialog open={false} title="Unused" testId="d">
                <Dialog.Body>body</Dialog.Body>
            </Dialog>
        );
        expect(screen.queryByTestId('d')).toBeNull();

        rerender(
            <Dialog open title="Task" testId="d">
                <Dialog.Body>body content</Dialog.Body>
                <Dialog.Footer>
                    <Dialog.CancelButton>Cancel</Dialog.CancelButton>
                </Dialog.Footer>
            </Dialog>
        );
        // Frame + a11y contract.
        const frame = screen.getByTestId('d');
        expect(frame.getAttribute('role')).toBe('dialog');
        expect(frame.getAttribute('aria-modal')).toBe('true');
        expect(frame.getAttribute('aria-labelledby')).toBe('d-title');
        // Title element: id + data-testid + exact text.
        const title = screen.getByTestId('d-title');
        expect(title.id).toBe('d-title');
        expect(title.textContent).toBe('Task');
        // Bands render in order: header (title), body, footer.
        expect(screen.getByText('body content')).toBeDefined();
        expect(screen.getByText('Cancel')).toBeDefined();
    });

    it('ConfirmButton carries exactly the sg-dialog-confirm class by default', () => {
        render(
            <Dialog open title="T" testId="d">
                <Dialog.Footer>
                    <Dialog.ConfirmButton data-testid="ok">OK</Dialog.ConfirmButton>
                </Dialog.Footer>
            </Dialog>
        );
        // EXACT class (App.test asserts toBe, not toContain).
        expect((screen.getByTestId('ok') as HTMLButtonElement).className).toBe('sg-dialog-confirm');
    });

    it('danger tone swaps the fill and appends the danger hook class', () => {
        render(
            <Dialog open title="T" testId="d">
                <Dialog.Footer>
                    <Dialog.ConfirmButton tone="danger" data-testid="del">
                        Delete
                    </Dialog.ConfirmButton>
                </Dialog.Footer>
            </Dialog>
        );
        const btn = screen.getByTestId('del') as HTMLButtonElement;
        expect(btn.className).toBe('sg-dialog-confirm sg-dialog-confirm-danger');
        // jsdom serializes the #f87171 danger fill as rgb(...).
        expect(btn.style.backgroundColor).toBe('rgb(248, 113, 113)');
    });

    it('CancelButton carries the sg-hover hook class', () => {
        render(
            <Dialog open title="T" testId="d">
                <Dialog.Footer>
                    <Dialog.CancelButton data-testid="cancel">Cancel</Dialog.CancelButton>
                </Dialog.Footer>
            </Dialog>
        );
        expect((screen.getByTestId('cancel') as HTMLButtonElement).className).toBe('sg-hover');
    });

    it('overlay click closes when dismissable and is ignored mid-flight', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <Dialog open title="T" testId="d" onClose={onClose}>
                <Dialog.Body>x</Dialog.Body>
            </Dialog>
        );
        // Overlay click → close fired.
        fireEvent.click(screen.getByTestId('d-overlay'));
        expect(onClose).toHaveBeenCalledTimes(1);

        // Mid-submit (dismissable=false): overlay click ignored.
        onClose.mockClear();
        rerender(
            <Dialog open title="T" testId="d" onClose={onClose} dismissable={false}>
                <Dialog.Body>x</Dialog.Body>
            </Dialog>
        );
        fireEvent.click(screen.getByTestId('d-overlay'));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape keydown closes the dialog (and is suppressed mid-flight)', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <Dialog open title="T" testId="d" onClose={onClose}>
                <Dialog.Body>x</Dialog.Body>
            </Dialog>
        );
        fireEvent.keyDown(screen.getByTestId('d'), { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);

        onClose.mockClear();
        rerender(
            <Dialog open title="T" testId="d" onClose={onClose} dismissable={false}>
                <Dialog.Body>x</Dialog.Body>
            </Dialog>
        );
        fireEvent.keyDown(screen.getByTestId('d'), { key: 'Escape' });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('clicks inside the frame do not bubble to the overlay close handler', () => {
        const onClose = vi.fn();
        render(
            <Dialog open title="T" testId="d" onClose={onClose}>
                <Dialog.Body>
                    <button data-testid="inner">inner</button>
                </Dialog.Body>
            </Dialog>
        );
        fireEvent.click(screen.getByTestId('inner'));
        expect(onClose).not.toHaveBeenCalled();
    });
});
