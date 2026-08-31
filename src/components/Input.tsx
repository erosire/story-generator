// Modular form input components — built on the Material UI TextField.
//
// Three components:
//   - <Input>        single-line text/number field (rename dialog, counts)
//   - <Textarea>     multi-line field (rewrite context, append notes)
//   - <NumberInput>  compact numeric variant (the 80px chapter-count field)
//
// The flat field frame (surface1 fill, hairline borderStrong outline, the
// dashboard's rem typography) is applied via sx overrides on the MUI
// OutlinedInput structure — the notched outline (fieldset) carries the border,
// the .MuiInputBase-input element carries padding/typography. Focus states are
// MUI-native (accent border via the theme palette) plus the .sg-input class
// hook on the input element itself (styles/global.ts surface swap).
//
// IMPORTANT test contract: `data-testid` and the sg-* className land on the
// NATIVE <input>/<textarea> element via slotProps.htmlInput (not the MUI
// wrapper div), because the tests read .value off the element they find by
// test id. Controlled-field props (value/onChange/onKeyDown/onFocus) MUST stay
// on the TextField level: MUI's InputBase attaches its own change/focus/blur
// handlers AFTER spreading htmlInput props, so handler props given via
// slotProps.htmlInput would be silently overridden and never fire.
//
// MODULAR: pure presentation + native HTML semantics; no store, no domain.

import React from 'react';
import { TextField } from '@mui/material';
import { theme } from '../styles';

// Shared flat field frame — sx overrides for the OutlinedInput structure.
// NOTE: sx numbers are SPACING-MAPPED in MUI (10 → 80px!) — paddings/gaps are
// explicit px strings. The ROOT padding is zeroed because MUI's multiline /
// outlined root carries its own 16.5px 14px padding that would STACK on top
// of the input-element padding below (double inset).
const FIELD_SX = {
    // Field fill + radius + typography on the outlined root.
    '& .MuiOutlinedInput-root': {
        padding: '0',
        backgroundColor: theme.surface1,
        color: theme.text,
        borderRadius: theme.radiusSm,
        fontFamily: theme.fontSans,
        fontSize: theme.fontSize.body
    },
    // Hairline outline (the notched fieldset) — the flat border token.
    '& .MuiOutlinedInput-notchedOutline': {
        borderColor: theme.borderStrong
    }
};

// The input-element padding/line-height override (single-line fields).
const INPUT_ELEMENT_SX = {
    '& .MuiInputBase-input': {
        padding: '10px 12px',
        lineHeight: 1.5
    }
};

// Props shared by every field: controlled-field props go to the TextField;
// DOM-attribute props (test id, class hooks, style) go to the native element
// via slotProps.htmlInput (see the header note for why the split matters).
type BaseFieldProps = {
    value?: string | number;
    onChange?: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
    onFocus?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
    onBlur?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
    placeholder?: string;
    disabled?: boolean;
    autoFocus?: boolean;
    id?: string;
    name?: string;
    'aria-label'?: string;
    // Class hook(s) for the native input element (defaults to the shared
    // 'sg-input' focus treatment; the rename dialog passes its stronger
    // 'sg-dialog-input' ring).
    className?: string;
    style?: React.CSSProperties;
    'data-testid'?: string;
};

// Single-line input.
export type InputProps = BaseFieldProps;

export const Input: React.FC<InputProps> = ({ className, style, 'data-testid': testId, ...rest }) => (
    <TextField
        variant="outlined"
        fullWidth
        sx={{ ...FIELD_SX, ...INPUT_ELEMENT_SX }}
        slotProps={{
            htmlInput: { 'data-testid': testId, className: className ?? 'sg-input', style }
        }}
        // MUI's TextField types its forwarded handlers against the wrapper
        // element; at runtime they attach to the native input. The union
        // handler types are intentional — cast past the structural mismatch.
        {...(rest as any)}
    />
);

// Multi-line textarea. Theme font. `rows`/value/onChange flow
// through untouched (controlled fields stay feature-owned).
export type TextareaProps = BaseFieldProps & {
    rows?: number;
};

export const Textarea: React.FC<TextareaProps> = ({ className, style, 'data-testid': testId, ...rest }) => (
    <TextField
        variant="outlined"
        fullWidth
        multiline
        sx={{
            ...FIELD_SX,
            // MUI multiline sizes the field via `rows`; no `resize` (the
            // browser's resize grip renders as a light square that breaks
            // the dark theme).
            '& .MuiInputBase-input': {
                padding: '10px 12px',
                lineHeight: 1.5
            }
        }}
        slotProps={{
            htmlInput: { 'data-testid': testId, className: className ?? 'sg-input', style }
        }}
        // See the Input note: runtime handlers attach to the native element.
        {...(rest as any)}
    />
);

// Compact numeric variant — the 80px chapter-count field used by the footer
// form and the append dialog. Same frame, narrower, centered text.
export type NumberInputProps = BaseFieldProps & {
    min?: number;
    max?: number;
};

export const NumberInput: React.FC<NumberInputProps> = ({ className, style, 'data-testid': testId, min, max, ...rest }) => (
    <TextField
        variant="outlined"
        type="number"
        sx={{
            ...FIELD_SX,
            width: 80,
            flex: '0 0 auto',
            '& .MuiInputBase-input': {
                padding: '7px 10px',
                textAlign: 'center'
            }
        }}
        slotProps={{
            htmlInput: { 'data-testid': testId, className: className ?? 'sg-input', style, min, max }
        }}
        // See the Input note: runtime handlers attach to the native element.
        {...(rest as any)}
    />
);
