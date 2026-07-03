// Reusable markdown renderer for the story generator dark theme.
//
// Wraps react-markdown with remark-gfm and provides dark-theme-aware
// component overrides so rendered markdown (headings, paragraphs, code
// blocks, lists, links, tables, etc.) looks correct on the #121212
// dashboard background.
//
// This mirrors the approach in packages/react/material/components/output/OutputMarkdown.tsx
// (react-markdown + remark-gfm with component overrides) but without MUI
// dependencies — uses plain styled divs since this distribution package
// only declares react/react-dom in its deps.
//
// Usage:
//   <MarkdownContent>{data.plotlines}</MarkdownContent>
//   <MarkdownContent>{ch.content}</MarkdownContent>

import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { styled } from '../styles';

// Wrapper div that prevents markdown content from escaping its container.
// Uses overflow-wrap:anywhere so long unbroken strings (URLs, code tokens)
// wrap instead of overflowing horizontally.
// NOTE: The vendored styled() helper (src/styles/styled.tsx) does NOT support
// nested CSS selectors like & > *:first-child. Margin resets on child elements
// are handled by the individual component overrides (P, H1-H6, etc.) below.
const MarkdownWrapper = styled('div', {
    overflowWrap: 'anywhere',
    lineHeight: 1.6,
    color: '#d8dade'
});

// Heading styles — progressively smaller for h1-h6, inheriting the light
// text color from the wrapper.
const headingBase: React.CSSProperties = {
    color: '#e0e0e0',
    fontWeight: 600,
    marginTop: '1.2em',
    marginBottom: '0.4em',
    lineHeight: 1.3
};

const H1: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h1 style={{ ...headingBase, fontSize: '1.5em' }}>{children}</h1>
);

const H2: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h2 style={{ ...headingBase, fontSize: '1.3em' }}>{children}</h2>
);

const H3: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h3 style={{ ...headingBase, fontSize: '1.15em' }}>{children}</h3>
);

const H4: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h4 style={{ ...headingBase, fontSize: '1.05em' }}>{children}</h4>
);

const H5: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h5 style={{ ...headingBase, fontSize: '1em' }}>{children}</h5>
);

const H6: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h6 style={{ ...headingBase, fontSize: '0.95em', color: '#a0a0a0' }}>{children}</h6>
);

// Paragraph — base text block.
const P: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <p style={{ margin: '0.6em 0' }}>{children}</p>
);

// Inline code — subtle highlight on dark surface.
const InlineCode: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <code
        style={{
            fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace',
            fontSize: '0.9em',
            background: 'rgba(255, 255, 255, 0.08)',
            padding: '1px 4px',
            borderRadius: 3,
            color: '#e8b4b8'
        }}
    >
        {children}
    </code>
);

// Code block — fenced code rendered with a distinct background and monospace font.
const CodeBlock: React.FC<{ children?: React.ReactNode; className?: string }> = ({
    children,
    className
}) => {
    // react-markdown passes className like "language-js" on fenced code blocks.
    // We render a <pre> wrapper around the <code> to preserve whitespace.
    return (
        <pre
            style={{
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 6,
                padding: 12,
                overflowX: 'auto',
                margin: '0.8em 0'
            }}
        >
            <code
                className={className}
                style={{
                    fontFamily: 'ui-monospace, "Cascadia Code", "Source Code Pro", monospace',
                    fontSize: '0.85em',
                    lineHeight: 1.5,
                    color: '#d8dade'
                }}
            >
                {children}
            </code>
        </pre>
    );
};

// Lists — unordered and ordered.
const Ul: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <ul style={{ margin: '0.4em 0', paddingLeft: '1.5em' }}>{children}</ul>
);

const Ol: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <ol style={{ margin: '0.4em 0', paddingLeft: '1.5em' }}>{children}</ol>
);

const Li: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <li style={{ margin: '0.2em 0' }}>{children}</li>
);

// Blockquote — indented left border for visual distinction.
const Blockquote: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <blockquote
        style={{
            margin: '0.8em 0',
            paddingLeft: 12,
            borderLeft: '3px solid rgba(255, 255, 255, 0.2)',
            color: '#a0a0a0'
        }}
    >
        {children}
    </blockquote>
);

// Horizontal rule.
const Hr: React.FC = () => (
    <hr
        style={{
            border: 'none',
            borderTop: '1px solid rgba(255, 255, 255, 0.12)',
            margin: '1.2em 0'
        }}
    />
);

// Links — subtle underline with a distinct color for clickability.
const A: React.FC<{ href?: string; children?: React.ReactNode }> = ({ href, children }) => (
    <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#7db4e0', textDecoration: 'underline' }}
    >
        {children}
    </a>
);

// Table — GFM table support via remark-gfm. Simple bordered table style.
const Table: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '0.8em 0' }}>
        <table
            style={{
                borderCollapse: 'collapse',
                width: '100%',
                fontSize: '0.9em'
            }}
        >
            {children}
        </table>
    </div>
);

const Th: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <th
        style={{
            border: '1px solid rgba(255, 255, 255, 0.15)',
            padding: '6px 10px',
            textAlign: 'left',
            background: 'rgba(255, 255, 255, 0.05)',
            color: '#e0e0e0',
            fontWeight: 600
        }}
    >
        {children}
    </th>
);

const Td: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <td
        style={{
            border: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '6px 10px',
            color: '#d8dade'
        }}
    >
        {children}
    </td>
);

// Strong/emphasis.
const Strong: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <strong style={{ color: '#e0e0e0', fontWeight: 700 }}>{children}</strong>
);

const Em: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <em style={{ fontStyle: 'italic' }}>{children}</em>
);

// Component override map passed to react-markdown. Every key is an HTML tag
// name that react-markdown will use instead of the default element for that
// markdown construct. This lets us inject dark-theme styling without a global
// stylesheet.
const MARKDOWN_COMPONENTS = {
    h1: H1,
    h2: H2,
    h3: H3,
    h4: H4,
    h5: H5,
    h6: H6,
    p: P,
    code: InlineCode,
    pre: CodeBlock,
    ul: Ul,
    ol: Ol,
    li: Li,
    blockquote: Blockquote,
    hr: Hr,
    a: A,
    table: Table,
    th: Th,
    td: Td,
    strong: Strong,
    em: Em
};

export type MarkdownContentProps = {
    // The raw markdown string to render.
    children: string;
    // Optional test id for the wrapper div.
    'data-testid'?: string;
};

// Renders a markdown string as React elements with dark-theme styling.
// Used by SectionStoryContent to replace plain-text PlotBlock and ChapterCard
// with properly formatted markdown output.
//
// react-markdown with remark-gfm handles:
//   - Headings (#, ##, ###, etc.)
//   - Bold/italic (*, **, _, __)
//   - Unordered and ordered lists
//   - Fenced code blocks (```)
//   - Inline code (`)
//   - Links [text](url)
//   - Blockquotes (>)
//   - Horizontal rules (---)
//   - GFM tables
//   - GFM strikethrough (~~)
//   - GFM task lists (- [ ])
export const MarkdownContent: React.FC<MarkdownContentProps> = React.memo(
    ({ children, 'data-testid': testId }) => (
        <MarkdownWrapper data-testid={testId}>
            <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {children}
            </Markdown>
        </MarkdownWrapper>
    )
);
