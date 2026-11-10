# CLAUDE.md

This file guides Claude Code when working in this repository.

## Overview

Sala Reader (live at https://reader.sala.company) is a Google Reader-style RSS/Atom reader with in-browser AI semantic search, AI topics, smart folders, optional AI summaries/investigations (user's own API keys for Claude, ChatGPT, DeepSeek, Grok, OpenRouter or Gemini), and an installable PWA. The front end is vanilla HTML/CSS/JS (ES modules, no bundler). A shared feed catalog is fetched server-side by a Node script in GitHub Actions; users' own feeds are fetched by the browser, falling back to a Cloudflare Worker relay. All user data stays on the device (IndexedDB). The README's "Rules" section (business and app rules) is binding: features that break them are left out.

## Commands

```bash
npm ci                              # root deps: @huggingface/transformers, fast-xml-parser
node scripts/fetch.mjs              # = npm run fetch; builds data/ from feeds.json (SKIP_EMBED=1 skips AI vectors)
python3 -m http.server 8000         # serve the site locally

node --test tests/unit/*.test.mjs   # unit tests (catalog dead-or-alive rules in scripts/fetch.mjs)

cd tests/browser && npm ci && npx playwright install chromium
node run.mjs                        # all browser tests (in tests/browser)
node run.mjs t16 t39                # selected cases

SITE=https://reader.sala.company node tests/site-check.mjs   # live-site check (needs playwright installed)
node scripts/check-directory.mjs    # checks every directory.json feed through the relay
```

There is no lint script. `fetch.mjs` also honors `FEEDS_FILE`, `DATA_DIR`, `MODEL_CACHE`.

## Architecture

- `index.html`: page shell (header, sidebar, article column, investigation panel, dialogs). Loads DOMPurify from jsDelivr (pinned with SRI) and `app.js` as a module.
- `app.js`: the reader: storage (IndexedDB `salareader`: key-value store plus a separate store for article bodies; localStorage fallback and a few `sr.*` / `srl.*` display prefs such as `sr.theme`), multi-tab sync via `BroadcastChannel('salareader')`, feed fetching/parsing (RSS, RDF, Atom), views, keyboard, search, feed health/retirement, moved-feed discovery, investigations, backups (incl. AES-GCM encrypted folder backups via a separate handle DB).
- `ai.js`: the six AI assistants, Grok live search (`x_search`/`web_search`), embedding worker pool.
- `embed-worker.js`: runs the MiniLM embedding model (transformers.js) in Web Workers (up to four).
- `smart.js`: smart folders: language detection, topics, kinds.
- `style.css`: layout and themes (Light, Dark, Paper, Classic 2008), colour tokens (WCAG AA required).
- `sw.js`: service worker, same-origin files only, network-first with cached fallback; cache name `salareader-v2`, `SHELL` lists the app files.
- `manifest.webmanifest`, `icon*.png`, `icon.svg`: PWA install.
- `feeds.json`: the shared catalog (everyone starts subscribed). `directory.json`: hand-picked Discover feeds.
- `scripts/fetch.mjs`: scheduled catalog fetch: merges with the previous run, applies dead-or-alive rules, keeps 60 days / 150 items per feed, computes vectors, writes `data/index.json`, `data/content.json`, `data/vectors.json`, `data/vectors-multi.json`, `data/seen.json`, and a health report to the Actions step summary. Exports `failKind`, `judge`, `DEAD_AFTER` for tests.
- `relay/worker.js` + `relay/wrangler.toml`: Cloudflare Worker relay (feeds only, `?mode=article` for Full article text, Origin check, rate limit, 10-min cache, no logs). Deployed separately to Cloudflare (dashboard or `npx wrangler deploy` in `relay/`), not by Pages.
- `tests/unit/`: node:test. `tests/browser/`: own package.json; `run.mjs` starts local stand-ins (site with fixture data, fake feed servers in `servers/`, the relay) and runs `cases/t*.cjs` in headless Chromium; `tests.json` lists each case and the output lines it must print. Nothing hits the internet.

`data/` is gitignored; it lives on the force-pushed single-commit `data` branch.

## Deployment

- `.github/workflows/update.yml` ("Fetch feeds and deploy") runs on push to `main` and on `workflow_dispatch` (cron-job.org calls the dispatch API about every 30 min). It restores `data/` from the `data` branch, runs `fetch.mjs`, force-pushes `data`, assembles `_site/` from an explicit file list, and deploys via GitHub Pages Actions. Pushing to `main` deploys live.
- Custom domain `reader.sala.company` via `CNAME`; `.nojekyll` is copied into the site.
- `tests.yml` runs unit + browser tests on push to `main` and PRs. `site-check.yml`, `relay-check.yml`, `directory-check.yml` are manual (`workflow_dispatch`) only.

## Conventions and gotchas

- Adding a new top-level site file: add it to the `cp` list in `update.yml`'s "Assemble the site" step (otherwise it won't be deployed) and to `SHELL` in `sw.js` if the app needs it offline. Bump `CACHE` in `sw.js` when changing the shell list.
- Keep the GoatCounter snippet at the end of `index.html` intact (endpoint `https://salacompany.goatcounter.com/count`). It deliberately strips the query string (`p.split('?')[0]`) because the URL can carry an OAuth sign-in code; don't remove that.
- Privacy is a hard rule: no server-side user data, no trackers/cookies, no public CORS proxies, AI calls only on explicit user action and only to the chosen provider.
- The relay must never become a general proxy (only feeds, feed links, or article text JSON).
- Multilingual content (Arabic, Persian, Russian, Armenian, etc.) is expected in feeds; the multilingual model is optional in Settings.
- Desktop-first but phones are supported (sidebar behind the menu button, swipe gestures); browser tests cover phone layout and axe-core accessibility.
- When adding a browser test, add a `cases/tNN.cjs` and its expected output in `tests/browser/tests.json`.
