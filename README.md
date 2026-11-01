# Sala Reader

The old Google Reader, with the AI search Feedly has. It's a fast RSS reader with folders, unread counts and `j`/`k` keys, plus AI search that finds articles by meaning. It runs on GitHub Pages with no server and no account.

**Open it:** https://salareader.sala.company/

## What it does

- **Reader layout:** subscriptions in folders with unread counts, All items, Starred, a list view and an expanded view, and Mark all as read.
- **Keyboard first:** `j`/`k` next/previous, `o` open, `s` star, `m` read/unread, `v` open original, `Shift`+`A` mark all read, `/` search, `g h`/`g a`/`g s` to jump. Press `?` for the full list.
- **✨ AI search:** search by meaning, so “cheap electric cars” also finds “EV prices drop below $25k”. A small AI model (all-MiniLM-L6-v2, about 25 MB) runs in your browser, so it's free and private.
- **✨ AI topics:** follow a subject across every feed, like Feedly's Leo. Each topic gets its own unread count in the sidebar.
- **🔗 More like this** on every article, which also flags the same story covered by other feeds.
- **✨ Summarize** and **✨ Brief me** (optional): pick an AI assistant in ⚙ Settings, the same six as [jamalterm](https://github.com/jamalxcode/jamalterm): **Claude, ChatGPT, DeepSeek, Grok, OpenRouter or Gemini**. It summarizes an article or writes a short briefing on any list, with numbered links to the stories. Switch assistants with `Alt`+`1`–`6`.
  - Claude, ChatGPT, DeepSeek and Grok use an API key from their company. Gemini takes a free key from [aistudio.google.com](https://aistudio.google.com/apikey). OpenRouter has **Sign in with OpenRouter** (your browser approves and the key is saved) or a key.
  - The model is picked automatically: the newest general model your key can use, DeepSeek's `deepseek-v4-flash`, or OpenRouter's Auto Router. Claude defaults to Opus 5.5. Use **Show available models** to choose another.
  - Keys stay in your browser and are sent only to that assistant's API. Usage is billed to that API account; a ChatGPT Plus subscription doesn't cover it.
  - Gemini, ChatGPT and OpenRouter accept requests from web pages. If DeepSeek or Grok refuse them, the error says so: use their models through OpenRouter instead.
- **Fun bits:** a 🔥 reading streak, 🎲 Surprise me, confetti at inbox zero, and themes (Light, Dark, Paper and Classic 2008).
- **Bring your feeds:** import OPML from Feedly, Inoreader or any reader, and export OPML or `feeds.json`.

Read and starred articles, topics, settings and feeds added in the browser are saved in your browser (localStorage). Starred articles are kept even after they leave the feed.

## How it works

```
cron-job.org ──(every 30 min)──▶ GitHub API: run update.yml
                                        │
                     scripts/fetch.mjs  ▼
     feeds.json ──▶ fetch every feed, merge with last run, add AI vectors
                                        │
               data branch ◀── saved ───┤
                                        ▼
                         GitHub Pages: site + data/
                                        │
                                        ▼
            your browser: reader UI, AI search, read/starred state
```

- **`feeds.json`** lists the feeds the server fetches, in folders. Edit it on GitHub to add or remove feeds; the push triggers an update straight away.
- **`.github/workflows/update.yml`** fetches the feeds, saves the data and deploys the site. It runs on every push to `main`, and whenever cron-job.org calls it.
- **`scripts/fetch.mjs`** parses RSS, RSS 1.0 (RDF) and Atom. It keeps 60 days of items, at most 150 per feed, and computes an AI vector for each new item. It writes:
  - `data/index.json`: the feeds and the article list;
  - `data/content/<feed>.json`: full article text, loaded when you open an article;
  - `data/vectors.json`: the AI vectors, loaded when you search.
- **The `data` branch** keeps the last run's data, so history survives between runs. It's force-pushed as a single commit, so the repo doesn't grow.
- **Feeds added in the browser** (＋ Subscribe, or OPML import) are fetched through a public CORS proxy and saved only in that browser. To make them permanent, use ⚙ Settings → *Download feeds.json* and replace the file in the repo.

## Updates with cron-job.org

GitHub's own schedule is unreliable, so [cron-job.org](https://console.cron-job.org/dashboard) starts the update instead. It calls GitHub's API to run the workflow.

**1. Make a GitHub token that can only start this workflow.**
Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) and fill in:
- **Token name:** `salareader cron`
- **Expiration:** the longest you're comfortable with (set a reminder to renew it)
- **Repository access:** *Only select repositories* → `jamalxcode/salareader`
- **Permissions:** *Repository permissions* → **Actions: Read and write** (nothing else)

Copy the token (`github_pat_…`).

**2. Create the cron job.** In [cron-job.org](https://console.cron-job.org/dashboard), go to *Cronjobs* → *Create cronjob* and fill in:
- **Title:** `Sala Reader update`
- **URL:** `https://api.github.com/repos/jamalxcode/salareader/actions/workflows/update.yml/dispatches`
- **Execution schedule:** every 30 minutes, or what you like. Each run takes about 1 to 2 minutes, and Actions is free for public repos.
- **Advanced** tab:
  - **Request method:** `POST`
  - **Headers:**
    | Key | Value |
    |---|---|
    | `Authorization` | `Bearer github_pat_…` (your token) |
    | `Accept` | `application/vnd.github+json` |
    | `X-GitHub-Api-Version` | `2022-11-28` |
    | `Content-Type` | `application/json` |
  - **Request body:** `{"ref":"main"}`

Save it, then use *Test run*. GitHub answers **204 No Content** when it works, and a run appears under [Actions](https://github.com/jamalxcode/salareader/actions). If you get **401**, the token is wrong or expired. If you get **404**, the token can't see the repo, or it lacks the *Actions* permission.

## Run it locally

```bash
npm ci
node scripts/fetch.mjs          # writes data/ (add SKIP_EMBED=1 to skip AI vectors)
python3 -m http.server 8000     # then open http://localhost:8000
```
