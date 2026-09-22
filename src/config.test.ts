// Tests for src/config.ts — the runtime storyboard-API host resolution.
//
// REGRESSION CONTEXT: DEFAULT_CONFIG.baseUrl (src/context/store.tsx) used to
// pin the host to LOCAL_AREA_NETWORK_HOST_NAME (192.168.8.128) unconditionally,
// so a dashboard loaded from the local dev server (http://localhost:8000 —
// vite.config.ts server.port) dialled the API across the machine's LAN
// interface and could fail even with the server healthy at localhost:5252.
// The fix resolves the host from window.location.hostname at module load:
// UI loaded via a loopback host → 'localhost'; anything else (LAN IP, another
// machine's origin, or no window at all) → the LAN constant.
//
// jsdom note: jsdom makes window.location an UNFORGEABLE property (non-
// configurable, non-deletable), so the window-based branch cannot be mocked
// per-case here. The pure predicate isLocalHostOrigin covers every branch
// deterministically; the resolver test pins the jsdom environment itself
// (default URL http://localhost:3000/ → hostname 'localhost') as an
// end-to-end check of the wiring.

import { describe, expect, it } from 'vitest';
import {
    LOCAL_AREA_NETWORK_HOST_NAME,
    LOCAL_AREA_NETWORK_STORYBOARD_PORT,
    isLocalHostOrigin,
    isMixedContentApiPair,
    isMixedContentBlocked,
    resolveStoryboardApiHostName
} from './config';

describe('isLocalHostOrigin (pure loopback-host predicate)', () => {
    it('is true for the standard loopback host names', () => {
        expect(isLocalHostOrigin('localhost')).toBe(true);
        expect(isLocalHostOrigin('127.0.0.1')).toBe(true);
        // IPv6 loopback: browsers report the literal WITH brackets in
        // location.hostname; the bare form is accepted defensively.
        expect(isLocalHostOrigin('[::1]')).toBe(true);
        expect(isLocalHostOrigin('::1')).toBe(true);
    });

    it('is true for RFC 6761 subdomains of localhost', () => {
        expect(isLocalHostOrigin('app.localhost')).toBe(true);
        expect(isLocalHostOrigin('dev.story.localhost')).toBe(true);
    });

    it('is false for the LAN host and every other remote host', () => {
        expect(isLocalHostOrigin(LOCAL_AREA_NETWORK_HOST_NAME)).toBe(false);
        expect(isLocalHostOrigin('192.168.0.1')).toBe(false);
        expect(isLocalHostOrigin('example.com')).toBe(false);
        // A suffix match must not confuse similar-looking names.
        expect(isLocalHostOrigin('notlocalhost')).toBe(false);
        expect(isLocalHostOrigin('localhost.evil.com')).toBe(false);
        expect(isLocalHostOrigin('')).toBe(false);
    });
});

describe('resolveStoryboardApiHostName (window.location-driven resolution)', () => {
    it('runs in a browser-like registry whose origin is loopback (environment precondition)', () => {
        // Pin the assumed jsdom default URL so the following assertion is
        // meaningful and a vitest environment change surfaces loudly.
        expect(window.location.hostname).toBe('localhost');
    });

    it('resolves to localhost when the UI itself is loaded from localhost', () => {
        expect(resolveStoryboardApiHostName()).toBe('localhost');
    });
});

describe('port constants (unchanged contract)', () => {
    it('the storyboard API still lives on port 5252', () => {
        expect(LOCAL_AREA_NETWORK_STORYBOARD_PORT).toBe(5252);
    });
});

// ── Mixed-content detection (the deployed mobile blocker) ─────────────────
// The GitHub Pages deployment serves the dashboard over HTTPS while the
// storyboard API base URL stays plain HTTP (the LAN host). Every iOS/Android
// browser blocks those requests outright, so on mobile nothing is ever
// fetched — and therefore nothing is ever cached. The pure predicate lets the
// branches be pinned deterministically (jsdom cannot flip location.protocol —
// same unforgeable-location constraint as the resolver tests above); the
// end-to-end HTTPS-page shape is exercised in App.test.tsx, whose jsdoc
// environment options set the jsdom URL to an https origin for that file.
describe('isMixedContentApiPair (pure mixed-content predicate)', () => {
    it('is true for an https page dialing a plain-http API (the deployed shape)', () => {
        expect(
            isMixedContentApiPair('https:', `http://${LOCAL_AREA_NETWORK_HOST_NAME}:5252/v1/storyboard/generations`)
        ).toBe(true);
        // Scheme match is case-insensitive (URLs normalize the scheme).
        expect(isMixedContentApiPair('https:', 'HTTP://example.com/api')).toBe(true);
    });

    it('is false for every non-poisoned pairing', () => {
        // Matching schemes (both the dev shape and an all-HTTPS deployment).
        expect(isMixedContentApiPair('http:', 'http://192.168.8.128:5252/v1/storyboard/generations')).toBe(false);
        expect(isMixedContentApiPair('https:', 'https://api.example.com/v1/storyboard/generations')).toBe(false);
        // http page dialing https API is fine (an upgrade, not a block).
        expect(isMixedContentApiPair('http:', 'https://api.example.com/v1/storyboard/generations')).toBe(false);
        // Non-web protocols and non-URL inputs never claim mixed content.
        expect(isMixedContentApiPair('file:', 'http://192.168.8.128:5252/v1/storyboard/generations')).toBe(false);
        expect(isMixedContentApiPair('https:', '')).toBe(false);
        expect(isMixedContentApiPair('https:', 'not-a-url')).toBe(false);
    });
});

describe('isMixedContentBlocked (window-reading wrapper)', () => {
    it('is false in the default http jsdom origin (environment precondition)', () => {
        // This file runs at http://localhost:3000/ — an http page dialing an
        // http API is NOT mixed content; the wrapper must not fire.
        expect(window.location.protocol).toBe('http:');
        expect(isMixedContentBlocked('http://localhost:5252/v1/storyboard/generations')).toBe(false);
    });
});
