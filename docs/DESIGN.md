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
| `--tile-violet`        | `oklch(0.52 0.25 300)`      | Product tile: VaultZ                              |
| `--tile-blue`          | `oklch(0.5 0.19 258)`       | Product tile: Chambers                            |
| `--tile-red`           | `oklch(0.55 0.22 27)`       | Product tile: SenatePortal                        |
| `--tile-green`         | `oklch(0.5 0.13 155)`       | Product tile: Aplio                               |
| `--tile-neutral`       | `oklch(0.4 0 0)`            | Product tile with no assigned tone                |
| `--tile-foreground`    | `oklch(1 0 0)`              | Letter on a tile, and "Go to" button text         |

Every tile colour must stay at 4.5:1 or better against `--tile-foreground`, because the "Go to" button text sits on it.

Tailwind names: `bg-glow`, `ring-glow-faint`, `bg-warning`, `bg-tile-violet`, and so on (`--color-*` in `@theme inline`).

The body font is Geist through `--font-sans: var(--font-geist-sans)`.

## Backdrop

`<Backdrop />` is the first child of `<body>` in the root layout. It is a fixed, `aria-hidden`, `pointer-events-none`, `-z-10` layer, hidden under `forced-colors` and `print`.

- **Rays.** Each side has waving 1px white lines running the full height, each with a breathing halo. The wave travels down the page by exactly one wavelength per loop, so it repeats seamlessly (the right side is offset by half a loop). The specs are the `RAYS` table in `src/lib/backdrop/rays.ts`. At `>= 70rem` there are three per side; below that, one. `LightRays` is pure markup, so `global-error` uses it too.

  | id        | Offset (rem) | Amplitude (px) | Wavelength (px) | Loop (s) | Opacity | Wide only |
  | --------- | ------------ | -------------- | --------------- | -------- | ------- | --------- |
  | `primary` | 0            | 4              | 420             | 16       | 1       | no        |
  | `inner`   | 0.875        | 7              | 300             | 12       | 0.45    | yes       |
  | `outer`   | -1.25        | 10             | 520             | 20       | 0.3     | yes       |

- **Dust.** A canvas of 24 to 110 faint specks drifting upward and twinkling (`src/lib/backdrop/dust.ts` is the pure math). The device pixel ratio is capped at 2, the loop stops while the tab is hidden, and `dt` is clamped so nothing jumps when a tab returns.

### Ray geometry

Defined in `globals.css`. Rays are not coupled to any content column.

| Variable     | Value                                                  | Meaning                            |
| ------------ | ------------------------------------------------------ | ---------------------------------- |
| `--ray-half` | `34rem`                                                | Half the distance between the rays |
| `--ray-x`    | `0.5rem`; at `>= 70rem`, `calc(50% - var(--ray-half))` | Distance of each ray from its edge |

The rays sit outside the widest content (`(app)` `main` is `max-w-5xl`, a 32rem half). `--ray-x` uses `50%` of the fixed containing block, not `vw`, so a classic scrollbar does not misalign the rays.

## Home: product explorer

`/` is the landing page after sign-in. `ProductExplorer` shows the products the user may open, exactly as `loadAccountOverview(...).tools` returns them (the visibility gate from #290). It adds no query and no check. SGAuth's own registry row gets no tile.

- **Tiles and lines.** Thick, glowing, waving lines run down the left, one ending at each tile's left edge, plus three free lines that fade out top and bottom. The geometry is `src/lib/home/tree.ts`. The tile list's Tailwind spacing (`pt-10 gap-5 pl-[5.5rem]`) must equal `PAD_Y`, `ROW_GAP` and `TREE_WIDTH` there, or the lines miss the tiles.
- **Waving.** SMIL `d` morphing between a `rest` and a `peak` curve that share every node and both end points, so the tile ends stay fixed while the rest sways. `tree.test.ts` pins that the two curves have the same command sequence.
- **Tile tone.** Each product's tone token and letter are in `PRODUCT_TILES` (`src/lib/home/products.ts`). An unknown slug gets `neutral` and the first letter of its name.
- **Selection.** A group of toggle buttons (`aria-pressed`), not ARIA tabs. Nothing is selected at first. Selecting a tile greys out the others (hover or focus restores them); selecting it again clears the selection. Below `md` the panel sits under the tiles and scrolls into view without moving focus.
- **Panel.** After the vertical divider, in order: the product name, a **Go to** button in the tile's tone linking to the registry base URL, the description, then, for leaders only, **Leadership information** and a link to the full guide.
- **Leadership is attached on the server only.** `toHomeProducts` adds the leadership groups and guide path only when the viewer is a leader, so a non-leader's page never contains them.
- **Empty.** With no visible tools the page shows the empty copy; the "Around SGA" links still render.

## Leadership pages

`/resources` (the general resources) and `/guides/[slug]` (Aplio, Chambers, VaultZ, SGA website) are for people who hold a leadership position. `loadLeadershipViewer` is the one place that decides access. A non-leader sees the `LeadershipOnly` empty state and nothing else.

- **Link states.** A linked item shows an arrow and opens in the same tab. An item marked `comingSoon` shows a "Coming soon" badge. An item with no URL shows "Link coming soon" and is not focusable.
- **Content lives only in `src/lib/home/resources.ts`.** No link without a source: an item with no URL ships as `href: null`.
- Leadership gating is listing-level, not authorization. It mirrors `canViewProduct`: the content is internal links, and the decision is made server-side.

## Motion and accessibility

- `prefers-reduced-motion` stills everything: the dust is drawn once, rays do not wave or breathe, and the explorer's lines keep their curves but do not move. The same holds when motion is paused. The explorer's waves start only after hydration.
- WCAG 2.2.2: the footer has a **Pause motion** / **Play motion** button. The choice is stored under `sgauth.motion` in `localStorage` (`"paused"`), so it persists across reloads and tabs. The button is hidden when the OS setting already stills motion.
- `DustField` is the only writer of `html[data-motion]`. The `motion-still` Tailwind variant reads it.
- Forced colours and print hide the whole backdrop. Content, focus rings, touch targets and states from #67 are unchanged.
- The backdrop never carries text or information.
