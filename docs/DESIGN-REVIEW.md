# Minimal Kibu redesign

The earlier design used too much explanatory copy and treated the home like a
landing page. The current interface is a compact, dark command surface: a
metallic floating pet, one input, and three short actions. History, connections,
permissions, preferences, and diagnostics remain available on demand.

## Implemented

- Removed slogans, onboarding cards, recent-activity summaries, duplicate task
  headings, decorative text, and persistent keyboard instructions.
- Redesigned the shared desktop/inline pet as a silver capsule with a dark face,
  cyan eyes, subtle orbit, and state-driven expressions. No image or model call
  is needed to draw it. Reduced motion is respected.
- Home uses a 620 × 440 panel; tasks and secondary views get more vertical room.
- Kept editable starter requests, visible task controls, previews, undo, typed
  answers, and persistent drafts. Added a native file/folder attachment picker.
- Added single-task deletion and clear-finished-history. Both remove task rows,
  logs, and undo records. File contents are unaffected. Active tasks cannot be
  deleted; delayed runtime events cannot recreate a deleted task in that session.
- Removed the host's model-key gate for deterministic workflows.

## Document search fix

The old route rules did not recognize “find my aadhar card in my pc” as a strong
file request. Search also treated “card” and “pc” as distinctive words, used
broad OR matching, and did not expand document spelling variants.

Routing now recognizes personal document searches. Query processing supports
Aadhaar/aadhar/adhar/adhaar/UIDAI/आधार, CV/resume, driving licence/license, PAN
card, passport, and insurance. Common machine and conversational words are
removed. Recognized document concepts constrain the index query; matching names
outweigh recency, and additional descriptions contribute to ranking.

The bounded fallback prunes noisy and protected directories before traversal,
prioritizes common user folders, and handles a directly attached file. Indexed
results are constrained to the requested root and protected real paths are
excluded. No card contents are uploaded as part of the deterministic search.

This is improved local retrieval, not universal semantic understanding. Images
with generic names, encrypted PDFs, and unindexed scans may still be missed;
on-device OCR is a useful next step. The tests use synthetic files and do not
establish that the user's actual Aadhaar document has been located.

## Checks

- Production build and TypeScript.
- 129 automated tests, including exact Aadhaar wording through the real workflow,
  spelling variants, unrelated-card rejection, alternate document names, direct
  file scope, data deletion, active-task protection, and persistence after restart.
- Browser checks for minimal home copy, preserved drafts/attachments, answers,
  previews, navigation during tasks, key saving, pause/undo, attachments, deletion,
  clear history, and a compact 420 × 360 viewport.
- Screenshots inspected for home, settings, history, previews, results, and compact
  layout. UI tests use a fake IPC bridge; native app control and live model quality
  remain separate validation work.

## Workspace, status and timer pass

The workspace, status and timer had drifted from the system: gradient cards,
a mono-uppercase page title, three copies of the same status, and a stretched
pebble with plain text for the timer.

- **Shared language with the website.** Pixelify Sans (bundled, OFL) is used
  only where Kibu speaks or names a state: page titles, “Kibu” above answers,
  status labels, the pet's speech bubble, empty states. Reading text stays
  SF. Lime buttons get a hard 2 px drop, as on the site.
- **One status.** A single chip: a 5 × 5 dot glyph from the face's glyph
  language (scanner, check, ?, ‖, ×), a pixel word, and elapsed time. While a
  task runs it lives in the status bar on every page and doubles as the way
  back to the task; the separate return banner is gone. The task header shows
  only the outcome.
- **Workspace.** Hairline rows like History instead of boxed cards; segmented
  tabs with counts; Edit/Archive appear on hover or focus; the home entry is a
  normal row with a badge (the live timer, “2 due”, or “5 kept”).
- **Timer mode is a TV.** The pebble ducks out and a small CRT pops up:
  antennae spring, a scanline flash switches the screen on, and the countdown
  is drawn in the face's dots, with a dot progress bar. Paused turns amber and
  pulses; time's up shakes the set and flips the screen between 00:00 and
  Kibu's face. Leaving collapses the picture to a line, then a dot. Hovering
  shows the timer's label. The workspace shows the same dot clock on a tiny
  screen, and the minimized island shows the countdown.
