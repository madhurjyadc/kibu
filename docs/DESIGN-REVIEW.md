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
