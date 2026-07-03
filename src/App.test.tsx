// Tests for the App component.
// Uses React Testing Library to verify rendering and user interactions.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { App } from './App';

describe('App', () => {
    // Verifies the component renders with the expected heading and initial counter state
    it('renders title and initial counter value of 0', () => {
        render(<App />);

        expect(screen.getByRole('heading', { name: /distribution template/i })).toBeDefined();
        expect(screen.getByTestId('counter').textContent).toBe('0');
    });

    // Verifies the increment button increases the counter by 1
    it('increments counter when +1 button is clicked', () => {
        render(<App />);

        const incrementButton = screen.getByRole('button', { name: /increment/i });
        fireEvent.click(incrementButton);

        expect(screen.getByTestId('counter').textContent).toBe('1');
    });

    // Verifies the decrement button decreases the counter by 1
    it('decrements counter when -1 button is clicked', () => {
        render(<App />);

        const decrementButton = screen.getByRole('button', { name: /decrement/i });
        fireEvent.click(decrementButton);

        expect(screen.getByTestId('counter').textContent).toBe('-1');
    });

    // Verifies the reset button sets the counter back to 0
    it('resets counter to 0 when reset button is clicked', () => {
        render(<App />);

        // Increment twice to get to 2
        const incrementButton = screen.getByRole('button', { name: /increment/i });
        fireEvent.click(incrementButton);
        fireEvent.click(incrementButton);
        expect(screen.getByTestId('counter').textContent).toBe('2');

        // Reset
        const resetButton = screen.getByRole('button', { name: /reset/i });
        fireEvent.click(resetButton);
        expect(screen.getByTestId('counter').textContent).toBe('0');
    });
});
