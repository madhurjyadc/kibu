# Kibu marketing site

A lightweight, standalone static site. `dist/` contains the complete deployable website. No install or build step is required.

Live at https://getkibu.vercel.app.

## Preview

From this directory:

```sh
python3 -m http.server 4173 --directory dist
```

Open http://localhost:4173.

## Deploying

The site is the Vercel project `kibu`. `vercel.json` serves `dist/` as it is,
with no build step, and `.vercelignore` keeps the teaser video out of the upload.
From this directory:

```sh
vercel --prod
```

The social preview tags in `dist/index.html` (`canonical`, `og:url`, `og:image`)
hold the site's address. Change them if the domain changes.

## Content and behavior

- `dist/index.html`: the whole page and its social metadata. In order: the opening screen with the demo, what Kibu does, how you stay in control, the agent Kibu needs, install steps, permissions and privacy, the playground, and questions.
- `dist/site.css`: the one stylesheet, written in page order: tokens, header, the opening screen and demo, each section, the playground, then the rules for short windows and small screens.
- `dist/app.js`: simulated Find, Organize, and Rename demos. No visitor files are accessed; no model connection is required.
- `dist/assets/`: actual Kibu sprite exports from the app's `Sprite.tsx`, not new character artwork, plus `og.png` (the 1200 × 630 link preview), `apple-touch-icon.png` and the two self-hosted fonts.
- `.openai/hosting.json`: the earlier Sites deployment identity.

The GitHub destination is https://github.com/madhurjyadc/kibu. Every claim on the page comes from the app's own tour, the README or `docs/TESTED.md`: macOS 14 or later on Apple silicon, an agent to plan with (Claude Code, Codex, OpenCode or an Anthropic API key), installed from source with one command. It calls Kibu an early release and does not advertise a download, pricing, customer numbers, or unverified app integrations. When the app changes what it needs or does, change the page with it.

## Character playground

The page now includes live dot-matrix expressions, cursor-following eyes, blinks,
pet reactions, a bounded draggable character, keyboard movement, simulated file
snacks, a dance break, sleep/wake, and cycling surprise expressions. The three
product demos animate file sorting, search, and renaming. The playground uses
sample files only.

- Drag Kibu with a pointer, or focus it and use arrow keys.
- Enter/Space pets Kibu; every action also has a regular button.
- Pause motion stops CSS and active Web Animations; interactions remain usable.
- OS reduced-motion preferences are respected, with an explicit motion toggle.
- Live faces update only while visible and the page is foregrounded.
- `dist/character.js` owns shared motion and character rendering.
- `dist/playground.js` owns playground interactions.
- `dist/faces.js` reuses the actual app's face generator. Regenerate after changing
  the character with `node website/sync-character.mjs` from the repository root.

## Layout and typography

The desktop hero puts the four requirements in a compact two-column grid
beneath the main actions, beside the demo. It fills larger windows and grows
naturally on short screens. Below 900px the copy, facts and demo stack without
forcing content into the first viewport. The demo window and response panel
stay in normal flow so they cannot overlap as content grows.

Headings and body text use self-hosted Manrope at
`dist/assets/fonts/Manrope.ttf` (SIL Open Font License, in `Manrope-OFL.txt`).
Pixelify Sans is kept for the wordmark and Kibu's speech bubbles only;
its licence is `OFL.txt`.

The agent section includes a short note about optional Jev decisions, the
separate TypeSafe API key and billing, and the local fallback. Existing page
copy was preserved when adding this note.

Icons are line drawings in one inline SVG sprite at the top of `index.html`
(`<symbol id="i-…">`), shown in soft lime tiles. Add a symbol there and
reference it with `<use href="#i-name">`.

Copy rules: plain, specific sentences; say what Kibu does and what it needs;
no em dashes.

## GitHub stars

`dist/github.js` reads the public repository's star count from GitHub's API
and shows it in the header once there is at least one star. Until then, or if
the request fails, times out or is rate-limited, the button stays a plain
"Star on GitHub" link. No token, tracking service or hard-coded count is used.

Checked at 15 viewport sizes from 320 × 568 through 2560 × 1440, including
phone landscape and the 900px layout breakpoint: no horizontal overflow,
no overlap between the demo window and response panel, and the font loads.
All three demos run, the install command copies, questions open, and the
playground controls work. Motion preferences are respected.
