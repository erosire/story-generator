// Styled-component factory for the story-generator dashboard.
//
// BACKED BY @presource/react: this is no longer a vendored implementation.
// It is a thin compatibility shim over the approved `styledComponent` factory
// (packages/presource/react/src/components/builder/styled/styled-component.tsx),
// re-exported under the module's historical `styled` name so every call site
// keeps its shape: `styled('div', { ...staticStyle }) -> <Box ... />`.
//
// What changed by moving to `styledComponent` (Emotion-backed):
//   - Styles are emitted as an Emotion CLASS, not an inline `style` attribute.
//     Inline styles outranked every class rule, which made the .sg-* pseudo
//     hooks in styles/global.ts (:hover/:focus) dead code on any element whose
//     base styles were inline. With Emotion classes, class rules and the
//     pseudo-hooks now compose correctly (.sg-input:focus etc. actually fire).
//   - The consumer `style` prop now MERGES on top of the Emotion class
//     (previously the vendored helper REPLACED its static style object with the
//     consumer prop wholesale). Components that must never lose their frame
//     under overrides (components/Dialog.tsx, components/Button.tsx,
//     components/Input.tsx, components/Badge.tsx) still merge manually and are
//     unaffected either way.
//   - Numbers stay raw in static values (Emotion appends px for non-unitless
//     properties exactly like React's inline-style handling: padding 8 -> 8px,
//     zIndex 10 stays unitless).
//
// Still true from the previous contract:
//   - Static style objects only at the call sites shown here; the few genuinely
//     dynamic values (the collapsible sidebar's animated width during its open/
//     close transition, the focus-driven composer height) are passed as inline
//     `style` props that merge on top.
//   - Pseudo-selector styling (`:hover`, `:focus`, keyframes) is NOT expressed
//     through this factory — the class hooks in styles/global.ts own those.

import React from 'react';
import { styledComponent } from '@presource/react';

type StyleObject = React.CSSProperties & Record<`--${string}`, string | number>;

// Permissive props for styled elements: standard HTML attributes for the tag,
// plus the index signature so arbitrary `data-*` and `aria-*` attributes pass
// typecheck even if the upstream JSX type omits them. We need this because TS
// with exactOptionalPropertyTypes may exclude `data-testid` from some element
// attribute interfaces, breaking the dashboard's test ids.
type StyledProps<Tag extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[Tag] & {
    as?: keyof JSX.IntrinsicElements;
    [key: string]: unknown;
};

// Create a styled element given a tag and a static style object.
// Delegates to the @presource/react `styledComponent` factory (Emotion) and
// only re-asserts the permissive prop surface the dashboard relies on.
export function styled<Tag extends keyof JSX.IntrinsicElements>(
    tag: Tag,
    style: StyleObject
): React.FC<StyledProps<Tag>> {
    return styledComponent(tag, style as any) as unknown as React.FC<StyledProps<Tag>>;
}
