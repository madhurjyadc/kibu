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
- `dist/styles.css`: app-inspired obsidian/lime visual design and responsive layouts.
- `dist/launch.css`: the sections added for launch. Hairline rows rather than cards, and 5 × 5 dot glyphs in the language of Kibu's face as icons.
- `dist/app.js`: simulated Find, Organize, and Rename demos. No visitor files are accessed; no model connection is required.
- `dist/assets/`: actual Kibu sprite exports from the app's `Sprite.tsx`, not new character artwork, plus `og.png` (the 1200 × 630 link preview) and `apple-touch-icon.png`.
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

## Responsive layout and typography

`dist/viewport.css` lets the hero grow with its content. Below 1050px the
copy and demo stack; phones use a flat file window and full-width task controls.
The design does not shrink text to fit a single screen. Section layouts,
commands and touch controls also adapt to narrow screens.

`dist/retro.css` keeps self-hosted Pixelify Sans for the wordmark and Kibu’s
speech bubbles. Headings, body text and labels use system fonts for readability.
`dist/launch.css` supplies section spacing, contrast and the open-source badge.
The Pixelify font license is at `dist/assets/fonts/OFL.txt`.

## GitHub stars

`dist/github.js` reads the public repository’s star count from GitHub’s API.
It displays the exact count, including zero, and falls back to a working
“Star on GitHub” link if the request fails, times out or is rate-limited.
No token, tracking service or hard-coded count is used.

Verified at 320×568, 390×844, 600×800, 768×1024, 844×390, 1024×768,
1440×1000 and 1920×1080. Browser checks cover horizontal overflow, all three
demos, copying the install command, FAQ disclosure, the pet’s nap control,
and GitHub success and failure states. Motion preferences remain respected.
