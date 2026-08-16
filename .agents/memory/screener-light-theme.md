---
name: Screener light-theme conventions
description: How light mode styling works in artifacts/screener and its radius-token pitfall
---

- Light mode: boxes/cards are logo blue (`--card: 210 85% 40%`) with white bold text; dark mode keeps the black terminal look. Per-mode styling is done with `X dark:Y` utility pairs, not separate components.
- **Text inside blue surfaces**: unlayered CSS at the bottom of `src/index.css` forces white/bold on `.text-foreground` / `.text-muted-foreground` (and lighter `.text-primary`/`.text-up`/`.text-down`) inside any element whose class contains `bg-card`. New card-like surfaces get this for free by using `bg-card`.
- **Radius pitfall**: the screener's `@theme` radius scale is tiny and caps at `--radius-xl: 8px`; `--radius-2xl` is UNDEFINED, so `rounded-2xl` compiles to `var(--radius-2xl)` and silently renders square. Use arbitrary values (`rounded-[16px]`) for visible rounding.
- **Why:** user iterated to this design (blue boxes, white bold text, rounded light mode, navy Run Scanner in light only) and "no visible change" bugs came from the radius token gap.
- Verify compiled utilities via `curl http://localhost:<port>/src/index.css` when a Tailwind class seems to have no effect.
