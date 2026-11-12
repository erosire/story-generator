/**
 * ci-strip-dep.ts — CI pre-step for `.github/workflows/deploy.yml`.
 *
 * WHAT IT DOES
 * Removes the unpublished `@underload/service` dependency from this package's
 * `package.json` before `npm install` runs, so the Pages install never hits a
 * registry 404. The dependency is only used by server/test code and is never
 * imported by the static GitHub Pages bundle built by `vite build`.
 *
 * WHY A COMMITTED SCRIPT AND NOT AN INLINE `node <<'EOF'` HEREDOC
 * This monorepo runs only on `vite` / `vite-node` / `vitest` — raw `node` is
 * never a runner for repo code (AGENTS.md "Runtime / runner policy" (a)). The
 * workflow now invokes `npx vite-node scripts/ci-strip-dep.ts`; `npx` rather
 * than `yarn` because this file is executed in the standalone-mirror context,
 * where the install is plain `npm install` and `vite-node` is a declared
 * devDependency resolved from the local `node_modules/.bin`.
 *
 * WHY A PER-PACKAGE COPY RATHER THAN ONE SHARED SCRIPT
 * `distribution/story-generator` and `distribution/comfy-dashboard` are each
 * published as their own standalone repositories (each has its own `.git`),
 * and the mirror root IS the package directory. A shared
 * `distribution/scripts/ci-strip-dep.ts` would live outside every mirror and
 * could not be checked out by either Pages workflow, so the byte-identical
 * heredocs became byte-identical per-package copies on purpose — keep them in
 * sync manually.
 *
 * BEHAVIOUR CONTRACT (port of the previous heredoc, plus idempotency)
 * 1. The manifest is read from `package.json` resolved against
 *    `process.cwd()`, exactly as the heredoc did — the workflow runs this step
 *    from the mirror root with no `working-directory` override.
 * 2. Only the `dependencies` field is touched (the heredoc deleted
 *    `manifest.dependencies['@underload/service']`); `devDependencies` and
 *    every other field are preserved, and key order is preserved because the
 *    object is mutated in place and re-serialised, not rebuilt.
 * 3. Serialisation matches the heredoc byte for byte: `JSON.stringify(manifest,
 *    null, 4)` plus a trailing newline — the same 4-space indent the committed
 *    manifest already uses, so the edit removes exactly one line.
 * 4. IDEMPOTENCY: when the dependency is already absent the file is not
 *    rewritten at all, so a second run is a true no-op (the old heredoc always
 *    re-serialised). A missing `dependencies` field is treated as "nothing to
 *    strip" instead of throwing, which is what makes re-running safe.
 * 5. Any other failure (no `package.json`, invalid JSON) is left to throw, so
 *    the CI step goes red rather than silently deploying an unstripped tree.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// The one unpublished package the Pages bundle never imports; stripping it is
// what keeps `npm install` free of registry 404s.
const STRIPPED_DEPENDENCY = '@underload/service';

// Minimal structural view of the manifest: only `dependencies` is ever read or
// mutated, and it is mutated in place so every other field and the key order
// survive the re-serialisation untouched.
type Manifest = { dependencies?: Record<string, string> };

// Relative to cwd on purpose — mirrors the heredoc's `package.json` path and
// keeps the script portable between the monorepo and the standalone mirror.
const manifestPath = 'package.json';

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const dependencies = manifest.dependencies;

// Idempotent exit: nothing to remove means nothing to rewrite, so the manifest
// stays byte-identical on a second run.
if (!dependencies || !(STRIPPED_DEPENDENCY in dependencies)) {
    console.log(`ci-strip-dep: ${STRIPPED_DEPENDENCY} already absent — no change`);
    process.exit(0);
}

// Same deletion the heredoc performed, on the same field.
delete dependencies[STRIPPED_DEPENDENCY];

// Same serialisation the heredoc used: 4-space indent plus a trailing newline.
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);

console.log(`ci-strip-dep: removed ${STRIPPED_DEPENDENCY} from ${manifestPath}`);
