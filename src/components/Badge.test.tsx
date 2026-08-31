// Tests for the modular Badge component (src/components/Badge.tsx).
//
// Covers:
//   - renders children in a flat square chip (radiusSm, NOT the 999px pill)
//   - each variant swaps the left status-rail color
//   - neutral vs non-neutral text colors
//   - elevated surface swap
//   - data-testid / title pass-through
//
// jsdom normalizes CSS colors (#hex → rgb(...) strings) and collapses
// alpha decimals (0.10 → 0.1) when reading el.style — assertions compare
// against the browser-serialized forms, not the raw theme tokens.

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';
import { theme } from '../styles';

// jsdom's CSSStyleDeclaration serializes colors as rgb(...) — the exact form
// the browser produces for the theme's hex/rgba tokens.
const rgb = (r: number, g: number, b: number, a?: number) =>
    a === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;

describe('Badge', () => {
    it('renders children inside a flat square chip (radiusSm, never the pill radius)', () => {
        render(<Badge data-testid="chip">5ch</Badge>);
        const chip = screen.getByTestId('chip') as HTMLSpanElement;
        // FLAT contract: 2px square corners — the old 999px pill is gone.
        expect(chip.style.borderRadius).toBe(`${theme.radiusSm}px`);
        expect(chip.textContent).toBe('5ch');
    });

    it('neutral variant draws the border-strong left rail on the default surface', () => {
        render(<Badge data-testid="chip">3</Badge>);
        const chip = screen.getByTestId('chip') as HTMLSpanElement;
        // theme.borderStrong rgba(148, 163, 255, 0.34) — blue-tinted hairline.
        expect(chip.style.borderLeft).toBe(`2px solid ${rgb(148, 163, 255, 0.34)}`);
        // theme.surface2 rgba(130, 150, 255, 0.095) — blue-tinted lift.
        expect(chip.style.background).toBe(rgb(130, 150, 255, 0.095));
        // Neutral chips are metadata — dimmed textMuted, not full text.
        expect(chip.style.color).toBe(rgb(201, 209, 242));
    });

    it('accent variant uses the accent rail + bright text', () => {
        render(
            <Badge data-testid="chip" variant="accent">
                2 running
            </Badge>
        );
        const chip = screen.getByTestId('chip') as HTMLSpanElement;
        // theme.accent #7c8cff — the electric periwinkle.
        expect(chip.style.borderLeft).toBe(`2px solid ${rgb(124, 140, 255)}`);
        expect(chip.style.color).toBe(rgb(240, 243, 255));
    });

    it('danger and warning variants use their semantic rail colors', () => {
        const { container } = render(
            <>
                <Badge data-testid="danger-chip" variant="danger">del</Badge>
                <Badge data-testid="warning-chip" variant="warning">stale</Badge>
            </>
        );
        expect(container).toBeDefined();
        expect((screen.getByTestId('danger-chip') as HTMLSpanElement).style.borderLeft).toBe(`2px solid ${rgb(255, 117, 131)}`);
        expect((screen.getByTestId('warning-chip') as HTMLSpanElement).style.borderLeft).toBe(`2px solid ${rgb(255, 197, 85)}`);
    });

    it('elevated swaps to the surface3 fill', () => {
        render(
            <Badge data-testid="chip" elevated>
                12ch
            </Badge>
        );
        // surface3 = rgba(130,150,255,0.15) — the blue-tinted top elevation.
        expect((screen.getByTestId('chip') as HTMLSpanElement).style.background).toBe(rgb(130, 150, 255, 0.15));
    });

    it('passes through title and standard span attributes', () => {
        render(
            <Badge data-testid="chip" title="2 background jobs in progress">
                2 running
            </Badge>
        );
        expect(screen.getByTestId('chip').getAttribute('title')).toBe('2 background jobs in progress');
    });
});
