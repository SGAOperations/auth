# Design

Interface rules for SGAuth. The app is dark only. Accessibility rules live in [`ENGINEERING.md`](ENGINEERING.md) and [`a11y-checklist.md`](a11y-checklist.md); where they disagree with this file, they win.

**Tokens only.** Colours come from the tokens below, never inline values. Add a token before adding a colour.

## Surfaces and tokens

All values are the `.dark` tokens in `src/app/globals.css`. `:root` holds unused light values.

| Token                  | Value                       | Use                                               |
| ---------------------- | --------------------------- | ------------------------------------------------- |
| `--background`         | `oklch(0.1 0 0)`            | Deep-black page (about `#030303`)                 |
| `--card`               | `oklch(0.15 0 0)`           | Cards. Opaque, so dense admin tables stay legible |
| `--popover`            | `oklch(0.17 0 0)`           | Menus and dialogs                                 |
| `--glow`               | `oklch(1 0 0)`              | Ray cores, junction dots, active branches         |
| `--glow-muted`         | `oklch(1 0 0 / 35%)`        | Branch lines, hover rings, glow shadows           |
| `--glow-faint`         | `oklch(1 0 0 / 8%)`         | Card and node edges, header border, ray halo      |
| `--particle`           | `oklch(1 0 0)`              | Dust. The canvas reads it with `getComputedStyle` |
| `--warning`            | `oklch(0.879 0.169 91.605)` | Environment banner background                     |
| `--warning-foreground` | `oklch(0.279 0.077 45.635)` | Environment banner text                           |

Tailwind names: `bg-glow`, `ring-glow-faint`, `bg-warning`, and so on (`--color-*` in `@theme inline`).

The body font is Geist through `--font-sans: var(--font-geist-sans)`.

## Backdrop

`<Backdrop />` is the first child of `<body>` in the root layout. It is a fixed, `aria-hidden`, `pointer-events-none`, `-z-10` layer, hidden under `forced-colors` and `print`.

- **Rays.** Two 1px white lines run the full height, each with a breathing halo and a light pulse that travels down every 9 s (the right ray is offset by 4.5 s). `LightRays` is pure markup, so `global-error` uses it too.
- **Dust.** A canvas of 24 to 110 faint specks drifting upward and twinkling (`src/lib/backdrop/dust.ts` is the pure math). The device pixel ratio is capped at 2, the loop stops while the tab is hidden, and `dt` is clamped so nothing jumps when a tab returns.

### Ray geometry

Defined in `globals.css` and coupled to the account page.

| Variable          | Value                                                  | Meaning                                  |
| ----------------- | ------------------------------------------------------ | ---------------------------------------- |
| `--ray-half`      | `34rem`                                                | Half the distance between the rays       |
| `--tools-half`    | `24rem`                                                | Half of the account column (`max-w-3xl`) |
| `--branch-length` | `calc(var(--ray-half) - var(--tools-half))`            | 10rem, the gap between column and ray    |
| `--ray-x`         | `0.5rem`; at `>= 70rem`, `calc(50% - var(--ray-half))` | Distance of each ray from its edge       |

The rays sit outside the widest content (`(app)` `main` is `max-w-5xl`, a 32rem half). `--ray-x` uses `50%` of the fixed containing block, not `vw`, so a classic scrollbar does not misalign branches.

**If the account column's `max-w-3xl` changes, change `--tools-half` with it**, or the branches miss the rays.

## Account tools as branches

`ProductBranches` renders the products the user may open, exactly as `visibleTools` returns them. It adds no query and no check.

- **Wide (`>= 70rem`).** Two columns. Odd items branch left and even items branch right, each by a `--branch-length` line that ends in a junction dot on the ray. An odd count leaves the last node on the left.
- **Narrow.** One column hanging off a local 1px trunk, with a 1.5rem branch and a dot per item. No horizontal scroll down to 360px.
- **Node.** The link keeps its content: letter tile, name, two-line description. Hover or focus brightens the node and its branch. Focus uses the solid `focus-visible:ring-ring` from #67.
- **Entrance.** The branch grows from the ray side and the node fades in, staggered `min(index, 8) x 90ms` through the `--i` property. It runs once and finishes well under 5 s.
- **Empty.** The heading, description and the empty copy stay; no branches render.

## Motion and accessibility

- `prefers-reduced-motion` stills everything: the dust is drawn once, rays do not breathe or pulse, branches do not grow.
- WCAG 2.2.2: the footer has a **Pause motion** / **Play motion** button. The choice is stored under `sgauth.motion` in `localStorage` (`"paused"`), so it persists across reloads and tabs. The button is hidden when the OS setting already stills motion.
- `DustField` is the only writer of `html[data-motion]`. The `motion-still` Tailwind variant reads it.
- Forced colours and print hide the whole backdrop. Content, focus rings, touch targets and states from #67 are unchanged.
- The backdrop never carries text or information.
