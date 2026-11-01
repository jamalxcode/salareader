# Sala Reader

The old Google Reader, with the AI search Feedly has. It's a fast RSS reader with folders, unread counts and `j`/`k` keys, plus AI search that finds articles by meaning. It runs on GitHub Pages with no server and no account, and **everything about you stays on your device**.

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
- **Bring your feeds:** import OPML from Feedly, Inoreader or any reader, and export OPML.
- **Move devices:** ⚙ Settings → *Export backup* saves everything to one file. *Import backup* on the other device restores it. API keys are left out unless you tick the box.

## Privacy

Sala Reader has no accounts and stores nothing about you on a server. Your subscriptions, folders, read and starred articles, AI topics, settings and API keys are kept only on your device, in the browser's IndexedDB storage. Starred articles are kept even after they leave the feed. *Erase all data on this device* in Settings deletes it all.

Here is everything that leaves the device:

| What | Goes to | When |
|---|---|---|
| The shared catalog (`data/`) | this site | on load. Everyone gets the same files, including all articles in one `content.json`, so the site can't tell what you follow or read |
| Your own feeds | the feed's site, or the relay: [shared](#the-relay) by default, or your own | when the page refreshes them. The relay sees only the feed's address, keeps no logs, and gets nothing that identifies you |
| Images inside articles | their own sites, with no referrer | when you open an article |
| The AI search model | jsDelivr and Hugging Face | once. Searches run on the device |
| An article or a list of headlines | the AI assistant you chose | only when you press ✨ Summarize or ✨ Brief me |
| A page visit | GoatCounter (no cookies) | on load. Only the page address, never feeds, articles, searches or the `?…` part of the address |

Feed icons are letters drawn on the device, so no favicon service learns which sites you follow. Public CORS proxies are never used.

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

- **`feeds.json`** is the shared **catalog**: feeds the server fetches for everyone. A new reader starts subscribed to all of them and can unsubscribe from any. The rest are listed under ＋ Subscribe. Edit the file on GitHub to change the catalog; the push triggers an update straight away. Your own subscriptions are never written here.
- **`.github/workflows/update.yml`** fetches the feeds, saves the data and deploys the site. It runs on every push to `main`, and whenever cron-job.org calls it.
- **`scripts/fetch.mjs`** parses RSS, RSS 1.0 (RDF) and Atom. It keeps 60 days of items, at most 150 per feed, and computes an AI vector for each new item. It writes:
  - `data/index.json`: the feeds and the article list;
  - `data/content.json`: full article text for every feed in one file, loaded when you open an article;
  - `data/vectors.json`: the AI vectors, loaded when you search.
- **The `data` branch** keeps the last run's data, so history survives between runs. It's force-pushed as a single commit, so the repo doesn't grow.
- **Your own feeds** (＋ Subscribe or OPML import, when not in the catalog) are fetched by the page itself, every time it opens and every 30 minutes while it's open. It asks the feed's site directly. Most sites block that, so it then asks [the relay](#the-relay).

## The relay

Most websites don't let web pages read their feeds (CORS). For those, Sala Reader asks a relay: `relay/worker.js`, a small Cloudflare Worker. In ⚙ Settings → **Your feeds** each reader picks one of three:

- **Shared Sala Reader relay** (default): `https://salareader-relay.jamal-akuna-matata.workers.dev`. It works with no setup.
- **My own relay**: your own copy of the Worker, so no one else sees even which feed addresses you fetch.
- **No relay**: only the catalog, plus feeds whose sites allow web pages to read them.

The Worker is built to be shared safely:
- **Feeds only.** It returns a response only if it's RSS or Atom. Given a web page, it returns just the feed links on it, never the page, so it can't be used as a general proxy.
- **Rate limit:** 60 requests a minute per visitor.
- **Cache:** 10 minutes per feed, so many readers of one feed cost one fetch.
- **Only Sala Reader pages:** it checks the Origin header, blocks private and local addresses, and caps responses at 5 MB.
- **No logs.** Workers Logs are off, it stores nothing, and it sends only a generic user agent to feed sites.

On Cloudflare's free plan it handles 100,000 requests a day, roughly 100 to 200 active readers with 20 own feeds each. Past that, requests fail until the next day; the free plan never bills.

### Your own relay

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) (the free plan is plenty). Go to **Compute (Workers)** → **Workers & Pages** → **Create** → **Create Worker**, name it `salareader-relay`, and click **Deploy**.
2. Click **Edit code**, replace everything with the contents of [`relay/worker.js`](relay/worker.js), and click **Deploy**.
3. Optional, for a private relay: in the Worker's **Settings → Runtime variables and secrets**, add a **Secret** named `TOKEN` (Production) with any long random text. Then only requests with that token are answered. Leave `TOKEN` out for a shared relay.
4. In the Worker's **Settings → Observability**, make sure **Workers Logs** is off.
5. In Sala Reader, go to ⚙ Settings → **Your feeds** → **My own relay**. Paste the Worker's address (`https://salareader-relay.<you>.workers.dev`), add the token if you set one, and click **Test relay**.

If you run Sala Reader at another address, add a variable `ALLOWED_ORIGIN` with that address (for example `https://reader.example.com`). With Node installed, `npx wrangler deploy` in `relay/` deploys it. That also adds a rate limit shared across all of Cloudflare's locations (see `wrangler.toml`).

The relay address and token are part of your settings, so they're stored on your device and can travel in your backup.

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
