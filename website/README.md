# Kibu marketing site

A lightweight, standalone static site. `dist/` contains the complete deployable website. No install or build step is required.

## Preview

From this directory:

```sh
python3 -m http.server 4173 --directory dist
```

Open http://localhost:4173.

## Content and behavior

- `dist/index.html`: marketing copy, GitHub calls to action, social title/description metadata.
- `dist/styles.css`: app-inspired obsidian/lime visual design and responsive layouts.
- `dist/app.js`: simulated Find, Organize, and Rename demos. No visitor files are accessed; no model connection is required.
- `dist/assets/`: actual Kibu sprite exports from the app's `Sprite.tsx`, not new character artwork.
- `.openai/hosting.json`: Sites deployment identity and static directory.

The GitHub destination is https://github.com/madhurjyadc/kibu. The page accurately labels Kibu as in development; it does not advertise an installer, pricing, customer numbers, or unverified app integrations.

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

## Opening-screen layout

`dist/viewport.css` adapts the entire hero composition to the available screen
height using `svh`, with compact phone and landscape layouts. The header,
headline, GitHub link, and demo controls fit in the first viewport. Further
sections remain in normal document flow; no scroll locking or whole-page scaling
is used. Content can grow naturally with enlarged text.

Checked at 320×568, 375×667, 390×844, 768×1024, 1024×768, 1366×650,
1470×836, and phone landscape sizes. The Organize demo also passed at 320×568.

## Retro typography

`dist/retro.css` uses self-hosted Pixelify Sans for headings, the wordmark, small
section labels, and Kibu's speech bubbles. Body copy and control labels keep the
system sans-serif for readability. Font source: https://github.com/google/fonts/tree/main/ofl/pixelifysans.
The SIL Open Font License is included at `dist/assets/fonts/OFL.txt`.
The first viewport still fits at desktop, 320px-wide phone, and landscape sizes.
