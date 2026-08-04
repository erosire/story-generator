// Tests for the distribution Vite configuration.
//
// The dev port is part of the local integration contract: keeping this exact
// assertion prevents a future config cleanup from silently restoring Vite's
// default port and breaking the documented localhost URL.

import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

describe('Vite development configuration', () => {
    it('uses localhost port 8000 for the dev server', () => {
        // `server.port` is the value consumed by Vite's dev server; asserting
        // the complete scalar value keeps this test deterministic.
        expect(viteConfig.server?.port).toBe(8000);
    });
});
