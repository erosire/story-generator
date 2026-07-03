// Main App component — example React app for the distribution template.
// Renders a simple page with a counter to demonstrate interactivity.

import { useState } from 'react';

// Inline styles defined as constants to avoid inline style objects in JSX.
// In a real app, use styledComponent from @presource/react instead.
const styles = {
    container: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        fontFamily: 'system-ui, sans-serif',
        gap: 16,
    },
    title: {
        fontSize: 32,
        fontWeight: 700,
        margin: 0,
    },
    subtitle: {
        fontSize: 16,
        color: '#666',
        margin: 0,
    },
    counter: {
        fontSize: 48,
        fontWeight: 700,
        margin: '16px 0',
    },
    buttonRow: {
        display: 'flex',
        gap: 8,
    },
    button: {
        padding: '8px 24px',
        fontSize: 16,
        borderRadius: 6,
        border: '1px solid #ccc',
        background: '#f5f5f5',
        cursor: 'pointer',
    },
};

export function App() {
    // Simple counter state to demonstrate React interactivity
    const [count, setCount] = useState(0);

    return (
        <div style={styles.container}>
            <h1 style={styles.title}>Distribution Template</h1>
            <p style={styles.subtitle}>Vite + React — deployable to GitHub Pages</p>
            <div style={styles.counter} data-testid="counter">
                {count}
            </div>
            <div style={styles.buttonRow}>
                <button
                    style={styles.button}
                    onClick={() => setCount((c) => c - 1)}
                    aria-label="Decrement"
                >
                    -1
                </button>
                <button
                    style={styles.button}
                    onClick={() => setCount(0)}
                    aria-label="Reset"
                >
                    Reset
                </button>
                <button
                    style={styles.button}
                    onClick={() => setCount((c) => c + 1)}
                    aria-label="Increment"
                >
                    +1
                </button>
            </div>
        </div>
    );
}
