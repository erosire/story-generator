// Barrel export for the MODULAR component set.
//
// Per the folder contract: src/components = reusable building blocks usable
// anywhere in the codebase and by other code — pure presentation, no business
// logic, no store access, no story-domain imports. The dashboard composition
// and the UI features live in src/features (see src/features/index.ts); the
// app entry is src/App.tsx.
//
// NOTE: no local markdown renderer here — markdown output uses the shared
// OutputMarkdown from @reloaded/material (packages/react/material/components/output).

export * from './Badge';
export * from './Button';
export * from './Collapsible';
export * from './Dialog';
export * from './Input';
