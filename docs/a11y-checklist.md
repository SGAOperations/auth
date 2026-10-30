# Accessibility checklist

Audit record for #67. **Theme: dark only.** The products are built dark-mode only (operator decision at plan review), so every contrast measurement and axe run is against the `.dark` tokens. No light-theme review was done.

- axe DevTools version: **\_\_** (fill in when the sweep is run)
- Browser: **\_\_**
- Date of sweep: **\_\_**
- Theme: dark

## Status of this record

The code fixes below were made by the implementing agent. The axe sweep, the keyboard walk and the 360 / 1440 px passes need a real browser with the axe DevTools extension and are the operator's to run (the plan's Testing section). Until a cell reads "pass", it is **not yet verified**. A route from a ticket that has not merged is marked "not built", not "pass".

## Route inventory

Columns: axe (dark), keyboard, dialogs, 360 px, 1440 px, states (loading, empty, error).

| Route               | Source                                 | axe (dark) | Keyboard  | Dialogs            | 360 px    | 1440 px   | States                                                                           |
| ------------------- | -------------------------------------- | ---------- | --------- | ------------------ | --------- | --------- | -------------------------------------------------------------------------------- |
| `/`                 | `src/app/(app)/page.tsx`               | to be run  | to be run | n/a                | to be run | to be run | Home: product explorer, SGA links                                                |
| `/login`            | `src/app/login/page.tsx`               | to be run  | to be run | n/a                | to be run | to be run | Inline form errors with `role="alert"`; pending "…ing" text                      |
| `/sign-up`          | `src/app/sign-up/page.tsx`             | to be run  | to be run | n/a                | to be run | to be run | Same as `/login`                                                                 |
| `/forgot-password`  | `src/app/forgot-password/page.tsx`     | to be run  | to be run | n/a                | to be run | to be run | Same as `/login`                                                                 |
| `/reset-password`   | `src/app/reset-password/page.tsx`      | to be run  | to be run | n/a                | to be run | to be run | Token page, confirm step                                                         |
| `/set-password`     | `src/app/set-password/page.tsx`        | to be run  | to be run | n/a                | to be run | to be run | Token page, confirm step; expired-link state                                     |
| `/verify-email`     | `src/app/verify-email/page.tsx`        | to be run  | to be run | n/a                | to be run | to be run | Token page, confirm step; expired-link state                                     |
| `/unlock`           | `src/app/unlock/page.tsx`              | to be run  | to be run | n/a                | to be run | to be run | Token page, confirm step                                                         |
| `/transfer/cancel`  | `src/app/transfer/cancel/page.tsx`     | to be run  | to be run | n/a                | to be run | to be run | Token page, confirm step                                                         |
| `/locked`           | `src/app/locked/page.tsx`              | to be run  | to be run | n/a                | to be run | to be run | Static                                                                           |
| `/privacy`          | `src/app/privacy/page.tsx`             | to be run  | to be run | n/a                | to be run | to be run | Static                                                                           |
| `/preview-gate`     | `src/app/preview-gate/page.tsx`        | to be run  | to be run | n/a                | to be run | to be run | Preview environments only                                                        |
| `/account`          | `src/app/(app)/account/page.tsx`       | to be run  | to be run | n/a                | to be run | to be run | Loading and error via `(app)` boundaries; profile, positions, sessions, security |
| `/resources`        | `src/app/(app)/resources/page.tsx`     | to be run  | to be run | n/a                | to be run | to be run | Leadership-gated; `LeadershipOnly` empty state                                   |
| `/guides/[slug]`    | `src/app/(app)/guides/[slug]/page.tsx` | to be run  | to be run | n/a                | to be run | to be run | Leadership-gated; `LeadershipOnly` empty state; 404 for unknown                  |
| `/admin`            | `src/app/(app)/admin/page.tsx`         | to be run  | to be run | n/a                | to be run | to be run | Loading and error via `(app)` boundaries; empty-sections copy                    |
| `/admin/audit`      | `src/app/(app)/admin/audit/page.tsx`   | to be run  | to be run | Event detail sheet | to be run | to be run | Own `loading.tsx` and `error.tsx`; empty and filtered-empty                      |
| `not-found`         | `src/app/not-found.tsx`                | to be run  | to be run | n/a                | to be run | to be run | Static                                                                           |
| `global-error`      | `src/app/global-error.tsx`             | to be run  | to be run | n/a                | to be run | to be run | Replaces the root layout                                                         |
| `/admin/users`      | not built                              | not built  | not built | not built          | not built | not built | Audited in its own ticket (#60)                                                  |
| `/admin/users/[id]` | not built                              | not built  | not built | not built          | not built | not built | Audited in its own ticket (#60)                                                  |
| `/admin/positions`  | not built                              | not built  | not built | not built          | not built | not built | Audited in its own ticket (#61)                                                  |
| `/account/security` | not built                              | not built  | not built | not built          | not built | not built | Audited in its own ticket (#66)                                                  |

The account page's positions, tools, and sessions sections (#65) are not built, so their empty states are not part of this pass.

## Contrast (dark tokens)

Ratios use WCAG relative luminance. For the neutral tokens, luminance is the OKLCH lightness cubed (`Y = L^3`). `--destructive` is `oklch(0.704 0.191 22.216)`, which is `#f87171` in sRGB.

Surfaces were re-recorded in #232 for the near-black palette: `--background` 0.1, `--card` 0.15, `--popover` 0.17. `--ring`, `--muted`, `--muted-foreground` and `--destructive` are unchanged.

| Pair                                            | Ratio     | Requirement  | Result |
| ----------------------------------------------- | --------- | ------------ | ------ |
| `--ring` (0.556) on `--background` (0.1)        | 4.35      | 3:1 (1.4.11) | pass   |
| `--ring` on `--card` (0.15)                     | 4.16      | 3:1          | pass   |
| `--ring` on `--popover` (0.17)                  | 4.04      | 3:1          | pass   |
| `--ring` on `--muted` (0.269)                   | 3.2       | 3:1          | pass   |
| `--muted-foreground` (0.708) on `--background`  | 7.94      | 4.5:1        | pass   |
| `--muted-foreground` on `--card`                | 7.59      | 4.5:1        | pass   |
| `--muted-foreground` on `--muted`               | 5.8       | 4.5:1        | pass   |
| `--muted-foreground` on `bg-muted/50` over card | about 6.8 | 4.5:1        | pass   |
| `--destructive` on `--background`               | 7.44      | 4.5:1        | pass   |
| `--destructive` on `--card`                     | 7.11      | 4.5:1        | pass   |

The glass auth card (`bg-card/80` over the backdrop) sits between `--background` and `--card`, so its ratios fall between the two rows above. The backdrop is decorative, hidden under forced colours and print, and never carries text.

No `.dark` token adjustment was needed for #67. The base outline was `outline-ring/50`, which blends the 4.2:1 ring toward the background and falls under 3:1. It is now solid `outline-ring`. These figures are computed, not measured in a browser; confirm them with the axe contrast check during the sweep.

## Fixes made in this ticket

- Base focus outline is solid (`globals.css`).
- Focus rings on the admin section cards and the audit filter links use the solid `ring-ring`, not the 50% halo.
- Shared `RouteError` for segment errors: heading is focused on mount, no raw error text, optional reference digest, **Try again** and **Go to home**. Used by `(app)/error.tsx` and `admin/audit/error.tsx`.
- Loading boundaries use the `Skeleton` primitive in the page's real layout with a `role="status"` "Loading…" line and `aria-busy`.
- Audit log: `Empty` for no-events and no-matches (different copy), a keyboard-focusable named region around the table (`Table` takes a `label`), a focusable named region around the metadata block, and the disabled **Export CSV** control now has a visible reason linked by `aria-describedby` and stays focusable (`aria-disabled`).

## Already in place on `dev`

Skip link and `<main id="main">` in the `(app)` layout, dark-only root layout, `lang="en"`, title template `%s · SGAuth`, one `h1` per page (the auth pages through `AuthShell`), labelled form fields, and pending buttons that swap to "…ing" text.

## Findings still open

Moderate and minor axe findings go here with a disposition (fixed, or accepted with a reason). None recorded yet; the sweep has not been run.
