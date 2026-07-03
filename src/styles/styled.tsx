// Lightweight inline styled-component clone for the story-generator dashboard.
//
// Validated:
//   export const Box = styled('div')({ background: 'red', padding: 8 }) -> <Box ... />
//
// The approved `styledComponent` factory lives in @presource/react
// (packages/react/src/components/builder/styled/styled-component.tsx) — but the
// distribution package declares only react/react-dom in its deps, so we cannot
// import @presource/react without breaking the build. We vendor the minimal
// subset we need (<10 lines) instead of pulling the whole monorepo dep tree.
//
// Style values:
//   - numbers stay as-is (React converts unitless numeric CSS values to px)
//   - strings are passed through verbatim (e.g. '100%', '1rem', '8px')
//   - functions are NOT supported (use inline override for dynamic values)
//
// This is intentionally tiny and only used by dashboard layout pieces. Component
// sections (SectionStoryTabs / SectionStoryContent / SectionStoryInput) use it too
// for their wrapper panels, but their interactive styling is plain CSS classes /
// inline overrides where the value is truly dynamic (e.g. width during a drag).

import React from 'react';

type StyleObject = React.CSSProperties & Record<`--${string}`, string | number>;

// Permissive props for styled elements: standard HTML attributes for the tag,
// plus the `as` override prop, plus an index signature so arbitrary `data-*` and
// `aria-*` attributes pass typecheck even if the upstream JSX type omits them.
// We need this because TS with exactOptionalPropertyTypes may exclude `data-testid`
// from some element attribute interfaces, breaking the dashboard's test ids.
type StyledProps<Tag extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[Tag] & {
    as?: keyof JSX.IntrinsicElements;
    [key: string]: unknown;
};

// Create a styled element given a tag and a static style object.
// Returns a component that accepts all standard HTMLAttributes for the tag.
export function styled<Tag extends keyof JSX.IntrinsicElements>(
    tag: Tag,
    style: StyleObject
): React.FC<StyledProps<Tag>> {
    const Component: React.FC<any> = ({ as, ...rest }) => {
        const Tag = (as || tag) as keyof JSX.IntrinsicElements;
        return React.createElement(Tag, { style, ...rest });
    };
    Component.displayName = `styled.${tag}`;
    return Component;
}
