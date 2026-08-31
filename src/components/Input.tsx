// Modular form input components — the shared field frames the dialogs and
// forms previously styled ad hoc (DialogInput in the old StoryGeneratorApp,
// RewriteTextarea / AppendNotesTextarea / AppendCountInput in the old
// SectionStoryContent, ChapterCountInput in the old footer).
//
// Three components:
//   - <Input>        single-line text/number field (rename dialog, counts)
//   - <Textarea>     multi-line field (rewrite context, append notes)
//   - <Select>       native select (revision dropdown — mostly a passthrough
//                    with the shared flat frame)
//
// The flat frame: radiusSm corners, hairline borderStrong, surface1 fill on
// the dark dialog surface, focus handled by the shared `.sg-input` class hook
// (accent border swap, no glow — styles/global.ts).
//
// MODULAR: pure presentation + native HTML semantics; no store, no domain.
//
// NOTE: like the Dialog buttons, these merge style objects manually instead of
// using the vendored styled() — a consumer `style` prop would fully replace
// styled()'s static style object (src/styles/styled.tsx:47).

import React from 'react';
import { theme } from '../styles';

// Shared flat field frame — both inputs and textareas.
const FIELD_BASE: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    fontFamily: theme.fontSans,
    fontSize: theme.fontSize.body,
    lineHeight: 1.5,
    borderRadius: theme.radiusSm,
    border: `1px solid ${theme.borderStrong}`,
    backgroundColor: theme.surface1,
    color: theme.text,
    outline: 'none',
    transition: `border-color ${theme.transition}, box-shadow ${theme.transition}, background-color ${theme.transition}`
};

// Single-line input. Pass `className="sg-input"` (default ON) for the flat
// focus treatment; the rename dialog uses className="sg-dialog-input" for
// its stronger focus ring (App.test.tsx:399 asserts the exact class).
export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
    style,
    className,
    ...rest
}) => <input {...rest} className={className ?? 'sg-input'} style={{ ...FIELD_BASE, ...style }} />;

// Multi-line textarea. resize vertical, theme font. `rows`/value/onChange flow
// through untouched (controlled fields stay feature-owned).
export const Textarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({
    style,
    className,
    ...rest
}) => (
    <textarea
        {...rest}
        className={className ?? 'sg-input'}
        style={{ ...FIELD_BASE, resize: 'vertical', ...style }}
    />
);

// Compact numeric variant — the 80px chapter-count field used by the footer
// form and the append dialog. Same frame, narrower, centered text.
export const NumberInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
    style,
    className,
    ...rest
}) => (
    <input
        {...rest}
        type="number"
        className={className ?? 'sg-input'}
        style={{ ...FIELD_BASE, width: 80, padding: '7px 10px', textAlign: 'center', ...style }}
    />
);
