// Reusable markdown renderer for the story generator dark theme.
//
// Wraps react-markdown with remark-gfm and provides dark-theme-aware
// component overrides so rendered markdown (headings, paragraphs, code
// blocks, lists, links, tables, etc.) looks correct on the dashboard
// background.
//
// This mirrors the approach in packages/react/material/components/output/OutputMarkdown.tsx
// (react-markdown + remark-gfm with component overrides) but without MUI
// dependencies — uses plain styled divs since this distribution package
// only declares react/react-dom in its deps.
//
// Usage:
//   <MarkdownContent>{data.plotlines}</MarkdownContent>
//   <MarkdownContent>{ch.content}</MarkdownContent>
//
// Visual: pulls colors from src/styles/theme.ts so headings, links, code, and
// blockquotes coordinate with the rest of the dashboard rather than reading as
// ad-hoc color choices. Inline + fenced code now use accent-tinted backgrounds.

import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { styled, theme } from '../styles';

// Wrapper div that prevents markdown content from escaping its container.
// Uses overflow-wrap:anywhere so long unbroken strings (URLs, code tokens)
// wrap instead of overflowing horizontally.
const MarkdownWrapper = styled('div', {
    overflowWrap: 'anywhere',
    lineHeight: 1.7,
    color: theme.textMuted,
    fontSize: 15
});

// Heading styles — progressively smaller for h1-h6, inheriting the bright
// text color from the wrapper. Accent-colored border under h1/h2 gives long
// markdown a more readable hierarchy.
const headingBase: React.CSSProperties = {
    color: theme.text,
    fontWeight: 600,
    marginTop: '1.4em',
    marginBottom: '0.5em',
    lineHeight: 1.3,
    letterSpacing: 0.1
};

const H1: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h1
        style={{
            ...headingBase,
            fontSize: '1.6em',
            paddingBottom: '0.3em',
            borderBottom: `1px solid ${theme.border}`
        }}
    >
        {children}
    </h1>
);

const H2: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h2
        style={{
            ...headingBase,
            fontSize: '1.35em',
            paddingBottom: '0.3em',
            borderBottom: `1px solid ${theme.border}`
        }}
    >
        {children}
    </h2>
);

const H3: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h3 style={{ ...headingBase, fontSize: '1.18em' }}>{children}</h3>
);

const H4: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h4 style={{ ...headingBase, fontSize: '1.05em' }}>{children}</h4>
);

const H5: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h5 style={{ ...headingBase, fontSize: '1em' }}>{children}</h5>
);

const H6: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <h6 style={{ ...headingBase, fontSize: '0.95em', color: theme.textDim }}>{children}</h6>
);

// Paragraph — base text block.
const P: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <p style={{ margin: '0.7em 0' }}>{children}</p>
);

// Inline code — accent-tinted highlight on dark surface.
const InlineCode: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <code
        style={{
            fontFamily: theme.fontMono,
            fontSize: '0.88em',
            background: theme.accentSoft,
            padding: '2px 6px',
            borderRadius: 4,
            color: '#c7c9ff',
            border: `1px solid rgba(99, 102, 241, 0.25)`
        }}
    >
        {children}
    </code>
);

// Code block — fenced code rendered with a distinct elevated background plus a
// subtle accent left-bar to read as "code surface" rather than plain text.
const CodeBlock: React.FC<{ children?: React.ReactNode; className?: string }> = ({
    children,
    className
}) => {
    // react-markdown passes className like "language-js" on fenced code blocks.
    // We render a <pre> wrapper around the <code> to preserve whitespace.
    return (
        <pre
            style={{
                background: theme.surface2,
                border: `1px solid ${theme.border}`,
                borderLeft: `3px solid ${theme.accent}`,
                borderRadius: theme.radiusMd,
                padding: 14,
                overflowX: 'auto',
                margin: '1em 0',
                boxShadow: theme.shadowSm
            }}
        >
            <code
                className={className}
                style={{
                    fontFamily: theme.fontMono,
                    fontSize: '0.86em',
                    lineHeight: 1.6,
                    color: theme.text
                }}
            >
                {children}
            </code>
        </pre>
    );
};

// Lists — unordered and ordered.
const Ul: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <ul style={{ margin: '0.5em 0', paddingLeft: '1.5em' }}>{children}</ul>
);

const Ol: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <ol style={{ margin: '0.5em 0', paddingLeft: '1.5em' }}>{children}</ol>
);

const Li: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <li style={{ margin: '0.25em 0' }}>{children}</li>
);

// Blockquote — accent-tinted left border for visual distinction.
const Blockquote: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <blockquote
        style={{
            margin: '1em 0',
            paddingLeft: 14,
            borderLeft: `3px solid ${theme.accent}`,
            color: theme.textMuted,
            background: theme.accentSoft,
            borderRadius: '0 6px 6px 0',
            padding: '6px 12px'
        }}
    >
        {children}
    </blockquote>
);

// Horizontal rule — soft accent gradient divider.
const Hr: React.FC = () => (
    <hr
        style={{
            border: 'none',
            height: 1,
            background: `linear-gradient(90deg, transparent, ${theme.border}, transparent)`,
            margin: '1.4em 0'
        }}
    />
);

// Links — accent color with subtle underline.
const A: React.FC<{ href?: string; children?: React.ReactNode }> = ({ href, children }) => (
    <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: theme.accent, textDecoration: 'underline', textDecorationThickness: 1 }}
    >
        {children}
    </a>
);

// Table — GFM table support via remark-gfm. Simple bordered table style with
// elevated header row.
const Table: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '1em 0' }}>
        <table
            style={{
                borderCollapse: 'collapse',
                width: '100%',
                fontSize: '0.92em',
                boxShadow: theme.shadowSm,
                borderRadius: theme.radiusMd,
                overflow: 'hidden'
            }}
        >
            {children}
        </table>
    </div>
);

const Th: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <th
        style={{
            border: `1px solid ${theme.border}`,
            padding: '8px 12px',
            textAlign: 'left',
            background: theme.surface3,
            color: theme.text,
            fontWeight: 600
        }}
    >
        {children}
    </th>
);

const Td: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <td
        style={{
            border: `1px solid ${theme.border}`,
            padding: '8px 12px',
            color: theme.textMuted
        }}
    >
        {children}
    </td>
);

// Strong/emphasis.
const Strong: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <strong style={{ color: theme.text, fontWeight: 700 }}>{children}</strong>
);

const Em: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <em style={{ fontStyle: 'italic', color: theme.text }}>{children}</em>
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
export const MarkdownContent: React.FC<MarkdownContentProps> = React.memo(
    ({ children, 'data-testid': testId }) => (
        <MarkdownWrapper data-testid={testId}>
            <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {children}
            </Markdown>
        </MarkdownWrapper>
    )
);
