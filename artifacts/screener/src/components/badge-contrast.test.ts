/**
 * WCAG AA contrast tests for status badges and delta badges.
 *
 * Colour values are derived from the CSS custom-property palette defined in
 * index.css — specifically the --status-* HSL variables that back
 * --color-up-subtle, --color-up-fg, --color-down-subtle, --color-down-fg.
 *
 * If you change a token value in index.css, update the matching constant here.
 *
 * Token → Tailwind approximate equivalents
 * ─────────────────────────────────────────
 *   up-subtle  light  hsl(152 81% 90%)  ≈ emerald-100
 *   up-fg      light  hsl(161 88% 20%)  ≈ emerald-800
 *   up-subtle  dark   hsl(161 94% 17%)  ≈ emerald-900
 *   up-fg      dark   hsl(152 76% 66%)  ≈ emerald-300
 *   down-subtle light  hsl(0 93% 94%)   ≈ red-100
 *   down-fg    light  hsl(0 66% 35%)    ≈ red-800
 *   down-subtle dark   hsl(0 63% 31%)   ≈ red-900
 *   down-fg    dark   hsl(0 94% 82%)    ≈ red-300
 */

import { describe, it, expect } from "vitest";

// ── Colour helpers ─────────────────────────────────────────────────────────────

/** Convert an 8-bit channel value (0–255) to a linear-light component. */
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

/** Convert HSL (h 0–360, s 0–100, l 0–100) to an 8-bit RGB triple. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sv = s / 100;
  const lv = l / 100;
  const C = (1 - Math.abs(2 * lv - 1)) * sv;
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lv - C / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = C; g = X; b = 0; }
  else if (h < 120) { r = X; g = C; b = 0; }
  else if (h < 180) { r = 0; g = C; b = X; }
  else if (h < 240) { r = 0; g = X; b = C; }
  else if (h < 300) { r = X; g = 0; b = C; }
  else              { r = C; g = 0; b = X; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// ── Token-derived colour constants ────────────────────────────────────────────
// Keep in sync with --status-* values in artifacts/screener/src/index.css.

// Light mode  (:root)
const UP_SUBTLE_LIGHT   = hslToRgb(152, 81, 90); // --status-up-subtle
const UP_FG_LIGHT       = hslToRgb(161, 88, 20); // --status-up-fg
const DOWN_SUBTLE_LIGHT = hslToRgb(0,   93, 94); // --status-down-subtle
const DOWN_FG_LIGHT     = hslToRgb(0,   66, 35); // --status-down-fg

// Dark mode  (.dark)
const UP_SUBTLE_DARK    = hslToRgb(161, 94, 17); // --status-up-subtle
const UP_FG_DARK        = hslToRgb(152, 76, 66); // --status-up-fg
const DOWN_SUBTLE_DARK  = hslToRgb(0,   63, 31); // --status-down-subtle
const DOWN_FG_DARK      = hslToRgb(0,   94, 82); // --status-down-fg

// ── Test suite ─────────────────────────────────────────────────────────────────

const WCAG_AA = 4.5;

describe("Badge WCAG AA contrast (≥ 4.5:1)", () => {
  // ── Delta badge (results-table.tsx) ─────────────────────────────────────────
  // Uses bg-up-subtle / text-up-fg  and  bg-down-subtle / text-down-fg

  describe("delta badge — price-up", () => {
    it("light mode: up-fg on up-subtle", () => {
      expect(contrastRatio(UP_FG_LIGHT, UP_SUBTLE_LIGHT)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: up-fg on up-subtle", () => {
      expect(contrastRatio(UP_FG_DARK, UP_SUBTLE_DARK)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });

  describe("delta badge — price-down", () => {
    it("light mode: down-fg on down-subtle", () => {
      expect(contrastRatio(DOWN_FG_LIGHT, DOWN_SUBTLE_LIGHT)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: down-fg on down-subtle", () => {
      expect(contrastRatio(DOWN_FG_DARK, DOWN_SUBTLE_DARK)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });

  // ── Status badge (badge.tsx) ─────────────────────────────────────────────────
  // success variant → bg-up-subtle / text-up-fg
  // danger  variant → bg-down-subtle / text-down-fg

  describe("status badge — success (qualified)", () => {
    it("light mode: up-fg on up-subtle", () => {
      expect(contrastRatio(UP_FG_LIGHT, UP_SUBTLE_LIGHT)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: up-fg on up-subtle", () => {
      expect(contrastRatio(UP_FG_DARK, UP_SUBTLE_DARK)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });

  describe("status badge — danger (not qualified)", () => {
    it("light mode: down-fg on down-subtle", () => {
      expect(contrastRatio(DOWN_FG_LIGHT, DOWN_SUBTLE_LIGHT)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it("dark mode: down-fg on down-subtle", () => {
      expect(contrastRatio(DOWN_FG_DARK, DOWN_SUBTLE_DARK)).toBeGreaterThanOrEqual(WCAG_AA);
    });
  });
});
