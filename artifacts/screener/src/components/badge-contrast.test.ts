/**
 * WCAG AA contrast tests for status badges and delta badges.
 *
 * Both badge types now use opaque backgrounds, so contrast is independent
 * of the parent container (results table bg-black/20, market-status widget
 * bg-black/40, etc.).  Each test checks text colour directly against the
 * badge's own background colour and asserts ≥ 4.5:1 (WCAG AA).
 *
 * Colour sources
 * ──────────────
 * Delta badge (results-table.tsx):
 *   up   light  bg-emerald-100  text-emerald-800
 *   up   dark   dark:bg-emerald-900  dark:text-emerald-300
 *   down light  bg-red-100      text-red-800
 *   down dark   dark:bg-red-900      dark:text-red-300
 *
 * Status badge (badge.tsx):
 *   success  light  bg-emerald-100  text-emerald-800
 *   success  dark   dark:bg-emerald-900  dark:text-emerald-300
 *   danger   light  bg-red-100      text-red-800
 *   danger   dark   dark:bg-red-900      dark:text-red-300
 */

import { describe, it, expect } from "vitest";

// ── Colour helpers ─────────────────────────────────────────────────────────────

/** Convert an 8-bit channel value (0–255) to a linear light component. */
function toLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an rgb(r,g,b) triple (0–255 each). */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two colours. */
function contrastRatio(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const l1 = luminance(...fg);
  const l2 = luminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Colour constants ───────────────────────────────────────────────────────────
// All Tailwind v3 defaults.  Opaque backgrounds mean no compositing is needed.

// Badge backgrounds
const EMERALD_100: [number, number, number] = [209, 250, 229]; // #d1fae5
const EMERALD_900: [number, number, number] = [6, 78, 59];    // #064e3b
const RED_100: [number, number, number]     = [254, 226, 226]; // #fee2e2
const RED_900: [number, number, number]     = [127, 29, 29];   // #7f1d1d

// Badge text colours
const EMERALD_300: [number, number, number] = [110, 231, 183]; // #6ee7b7
const EMERALD_800: [number, number, number] = [6, 95, 70];    // #065f46
const RED_300: [number, number, number]     = [252, 165, 165]; // #fca5a5
const RED_800: [number, number, number]     = [153, 27, 27];   // #991b1b

// ── Test suite ─────────────────────────────────────────────────────────────────

const WCAG_AA = 4.5;

describe("Badge WCAG AA contrast (≥ 4.5:1)", () => {
  // ── Delta badge (results-table.tsx) ─────────────────────────────────────────
  // up:   bg-emerald-100 text-emerald-800 / dark:bg-emerald-900 dark:text-emerald-300
  // down: bg-red-100     text-red-800     / dark:bg-red-900     dark:text-red-300

  describe("delta badge — price-up", () => {
    it("light mode: text-emerald-800 on bg-emerald-100", () => {
      expect(contrastRatio(EMERALD_800, EMERALD_100)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: text-emerald-300 on dark:bg-emerald-900", () => {
      expect(contrastRatio(EMERALD_300, EMERALD_900)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });

  describe("delta badge — price-down", () => {
    it("light mode: text-red-800 on bg-red-100", () => {
      expect(contrastRatio(RED_800, RED_100)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: text-red-300 on dark:bg-red-900", () => {
      expect(contrastRatio(RED_300, RED_900)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });

  // ── Status badge (badge.tsx) ─────────────────────────────────────────────────
  // success: bg-emerald-100 text-emerald-800 / dark:bg-emerald-900 dark:text-emerald-300
  // danger:  bg-red-100     text-red-800     / dark:bg-red-900     dark:text-red-300

  describe("status badge — success (qualified)", () => {
    it("light mode: text-emerald-800 on bg-emerald-100", () => {
      expect(contrastRatio(EMERALD_800, EMERALD_100)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: text-emerald-300 on dark:bg-emerald-900", () => {
      expect(contrastRatio(EMERALD_300, EMERALD_900)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });

  describe("status badge — danger (not qualified)", () => {
    it("light mode: text-red-800 on bg-red-100", () => {
      expect(contrastRatio(RED_800, RED_100)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: text-red-300 on dark:bg-red-900", () => {
      expect(contrastRatio(RED_300, RED_900)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });
});
