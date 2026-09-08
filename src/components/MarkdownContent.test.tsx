// Tests for the MarkdownContent component (src/components/MarkdownContent.tsx).
//
// Covers:
//   - Basic paragraph text rendering
//   - Headings (h1, h2, h3) from markdown syntax
//   - Bold and italic text
//   - Inline code with monospace styling
//   - Fenced code blocks
//   - Unordered and ordered lists
//   - Links with target="_blank"
//   - GFM tables
//   - Blockquotes
//   - Horizontal rules
//   - Empty string renders empty wrapper
//   - data-testid propagation

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

describe('MarkdownContent', () => {
    it('renders plain paragraph text', () => {
        render(<MarkdownContent>Hello world</MarkdownContent>);
        expect(screen.getByText('Hello world')).toBeDefined();
    });

    it('renders h1 heading from markdown', () => {
        render(<MarkdownContent># Main Title</MarkdownContent>);
        const heading = screen.getByRole('heading', { level: 1 });
        expect(heading.textContent).toBe('Main Title');
    });

    it('renders h2 heading from markdown', () => {
        render(<MarkdownContent>## Chapter One</MarkdownContent>);
        const heading = screen.getByRole('heading', { level: 2 });
        expect(heading.textContent).toBe('Chapter One');
    });

    it('renders h3 heading from markdown', () => {
        render(<MarkdownContent>### Section</MarkdownContent>);
        const heading = screen.getByRole('heading', { level: 3 });
        expect(heading.textContent).toBe('Section');
    });

    it('renders bold text', () => {
        render(<MarkdownContent>**bold text**</MarkdownContent>);
        const strong = screen.getByText('bold text');
        expect(strong.tagName).toBe('STRONG');
    });

    it('renders italic text', () => {
        render(<MarkdownContent>*italic text*</MarkdownContent>);
        const em = screen.getByText('italic text');
        expect(em.tagName).toBe('EM');
    });

    it('renders inline code', () => {
        render(<MarkdownContent>Use `console.log` for debugging</MarkdownContent>);
        const code = screen.getByText('console.log');
        expect(code.tagName).toBe('CODE');
    });

    it('renders a fenced code block', () => {
        const md = '```js\nconst x = 1;\n```';
        render(<MarkdownContent>{md}</MarkdownContent>);
        // The code element should contain the source text.
        const code = screen.getByText('const x = 1;');
        expect(code.tagName).toBe('CODE');
    });

    it('renders an unordered list', () => {
        const md = '- item one\n- item two\n- item three';
        render(<MarkdownContent>{md}</MarkdownContent>);
        expect(screen.getByText('item one')).toBeDefined();
        expect(screen.getByText('item two')).toBeDefined();
        expect(screen.getByText('item three')).toBeDefined();
        // Should be inside a <ul>.
        const list = screen.getByRole('list');
        expect(list.tagName).toBe('UL');
    });

    it('renders an ordered list', () => {
        const md = '1. first\n2. second\n3. third';
        render(<MarkdownContent>{md}</MarkdownContent>);
        expect(screen.getByText('first')).toBeDefined();
        expect(screen.getByText('second')).toBeDefined();
        expect(screen.getByText('third')).toBeDefined();
        const list = screen.getByRole('list');
        expect(list.tagName).toBe('OL');
    });

    it('renders a link with target="_blank"', () => {
        render(<MarkdownContent>[Click here](https://example.com)</MarkdownContent>);
        const link = screen.getByText('Click here');
        expect(link.tagName).toBe('A');
        expect((link as HTMLAnchorElement).href).toBe('https://example.com/');
        expect((link as HTMLAnchorElement).target).toBe('_blank');
    });

    it('renders a blockquote', () => {
        render(<MarkdownContent>{'> quoted text'}</MarkdownContent>);
        // react-markdown wraps blockquote text in a <p> inside the <blockquote>.
        // screen.getByRole('blockquote') finds the parent element.
        const quote = screen.getByRole('blockquote');
        expect(quote).toBeDefined();
        expect(quote.textContent).toContain('quoted text');
    });

    it('renders a horizontal rule', () => {
        const { container } = render(<MarkdownContent>{'---'}</MarkdownContent>);
        const hr = container.querySelector('hr');
        expect(hr).not.toBeNull();
    });

    it('renders a GFM table', () => {
        const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
        render(<MarkdownContent>{md}</MarkdownContent>);
        expect(screen.getByText('Name')).toBeDefined();
        expect(screen.getByText('Alice')).toBeDefined();
        expect(screen.getByText('Bob')).toBeDefined();
        // Table should exist.
        const table = screen.getByRole('table');
        expect(table).toBeDefined();
    });

    it('renders empty string without errors', () => {
        const { container } = render(<MarkdownContent>{''}</MarkdownContent>);
        // Should render the wrapper div but no visible content.
        expect(container.firstChild).toBeDefined();
    });

    it('propagates data-testid to wrapper div', () => {
        render(
            <MarkdownContent data-testid="md-test">content</MarkdownContent>
        );
        expect(screen.getByTestId('md-test')).toBeDefined();
    });

    it('renders multiple headings in sequence (typical plotlines format)', () => {
        const md = [
            '## Act I: Setup',
            'The hero discovers the artifact.',
            '',
            '## Act II: Conflict',
            'The villain appears and steals the artifact.',
            '',
            '## Act III: Resolution',
            'The hero reclaims the artifact.'
        ].join('\n');

        render(<MarkdownContent>{md}</MarkdownContent>);

        const h2s = screen.getAllByRole('heading', { level: 2 });
        expect(h2s.length).toBe(3);
        expect(h2s[0].textContent).toBe('Act I: Setup');
        expect(h2s[1].textContent).toBe('Act II: Conflict');
        expect(h2s[2].textContent).toBe('Act III: Resolution');
    });

    it('renders a chapter with heading + body (typical chapter format)', () => {
        const md = [
            '## The Discovery',
            '',
            'Captain Elena stared at the **alien artifact**. It hummed with *ancient energy*.',
            '',
            'She called out to her crew: "We need to `document` everything."'
        ].join('\n');

        render(<MarkdownContent>{md}</MarkdownContent>);

        // Heading rendered.
        const heading = screen.getByRole('heading', { level: 2 });
        expect(heading.textContent).toBe('The Discovery');

        // Bold text rendered.
        const bold = screen.getByText('alien artifact');
        expect(bold.tagName).toBe('STRONG');

        // Italic text rendered.
        const italic = screen.getByText('ancient energy');
        expect(italic.tagName).toBe('EM');

        // Inline code rendered.
        const code = screen.getByText('document');
        expect(code.tagName).toBe('CODE');
    });
});
