# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Epeszűrő": a Manifest V3 Chrome extension that hides hateful YouTube comments and live chat messages. Each comment gets 6 TypeSafe Jev questions (violence, dehumanisation, group hate, vulgarity, mocking nickname as Nouls; personal attack as a 4-level Score); code decides shred / blur / mark via `action()` in `src/judge.js`. No backend: every user brings their own TypeSafe key. Everything user-facing is Hungarian, and so are code comments, the README, `LICENSE.hu.md` (Hungarian translation of the MIT `LICENSE`, which stays English so GitHub detects it) and commit messages; this file stays English. The Jev questions are deliberately English. Author: Cziczlavicz Péter.

## Development

No build step, package.json or linter. Always run node with `env -u TYPESAFE_API_KEY` unless you mean to call the live API.

- `node test/jev.mjs [fixture] [--context]`: accuracy vs hand labels in `test/fixtures/yt-*.json`, party-neutrality swap check, tokens and cost. With `TYPESAFE_API_KEY` set it calls the live API and overwrites `test/out/<fixture>.<PROMPT_VERSION>.json`; without it, it re-evaluates those saved answers (so threshold tuning needs no calls). Those JSON files are committed on purpose.
- `node test/page.mjs`: local fixture pages in headless `chromium` over CDP with a stub `chrome`; asserts extraction, reply_to, effects, badge, heatmap, sliders, cost, chat.
- `node test/youtube.mjs` / `node test/livechat.mjs`: real YouTube pages (network), stub results, never call api.typesafe.ai. They catch real-DOM issues the fixtures miss (Trusted Types forbids innerHTML; each reply sits in its own `ytd-comment-thread-renderer`).
- Load: `chrome://extensions` → Developer mode → Load unpacked. Reload the card after edits.

## Architecture

- `src/judge.js`: questions, `judge()`, `action()`, `reason()`, `DEFAULTS`, `USD_PER_MTOK`. Changing question wording means bumping `PROMPT_VERSION` and re-measuring with a key on both fixtures; don't tune thresholds on one fixture only.
- `src/background.js`: ES module service worker; batches of 10, 4 parallel calls, dedupe, 48 h cache keyed by hash of (text, PROMPT_VERSION, model), pruning.
- `src/content.js` (watch pages) and `src/chat.js` (live chat iframe, all_frames): classic scripts that load `judge.js` via dynamic import (web_accessible_resources). They keep raw results per element and re-apply `action()` on storage changes, so popup sliders never trigger API calls. YouTube recycles elements: processed state is a text fingerprint, not a flag.
- `popup.*`: on/off, sliders, heatmap toggle. `options.*` + `src/settings.js`: API key, model, USD/HUF rate.
- `design/icon.svg` is the icon source; `icons/*.png` are rendered with `rsvg-convert`.
