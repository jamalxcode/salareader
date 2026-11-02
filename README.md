# Sala Reader

The old Google Reader, with the AI search Feedly has. It's a fast RSS reader with folders, unread counts and `j`/`k` keys, plus AI search that finds articles by meaning. It runs on GitHub Pages with no server and no account, and **everything about you stays on your device** ([privacy policy](#privacy-policy)). Open source under the [MIT license](LICENSE).

**Open it:** https://reader.sala.company/

## What it does

- **Reader layout:** subscriptions in folders with unread counts, All items, Starred, a list view and an expanded view, and Mark all as read.
- **Keyboard first:** `j`/`k` next/previous, `o` open, `s` star, `m` read/unread, `v` open original, `Shift`+`A` mark all read, `/` search, `g h`/`g a`/`g s` to jump. Press `?` for the full list.
- **✨ AI search:** search by meaning, so “cheap electric cars” also finds “EV prices drop below $25k”. A small AI model runs in your browser, so it's free and private. ⚙ Settings → *Languages* picks it: **English** (all-MiniLM-L6-v2, about 25 MB, the default) or **Multilingual** (paraphrase-multilingual-MiniLM-L12-v2, about 120 MB, 50+ languages including Arabic, Persian, Russian and Armenian), which matches by meaning across languages, so an English topic also finds Arabic articles on the same story. The catalog has search data for both; your own feeds and topics are worked out again for the new model in the background.
- **✨ AI topics:** follow a subject across every feed, like Feedly's Leo. Each topic gets its own unread count in the sidebar.
- **🔗 More like this** on every article, which also flags the same story covered by other feeds.
- **✨ Summarize** and **✨ Brief me** (optional): pick an AI assistant in ⚙ Settings, the same six as [jamalterm](https://github.com/jamalxcode/jamalterm): **Claude, ChatGPT, DeepSeek, Grok, OpenRouter or Gemini**. It summarizes an article or writes a short briefing on any list, with numbered links to the stories. Switch assistants with `Alt`+`1`–`6`.
  - Claude, ChatGPT, DeepSeek and Grok use an API key from their company. Gemini takes a free key from [aistudio.google.com](https://aistudio.google.com/apikey). OpenRouter has **Sign in with OpenRouter** (your browser approves and the key is saved) or a key.
  - The model is picked automatically: the newest general model your key can use, DeepSeek's `deepseek-v4-flash`, or OpenRouter's Auto Router. Claude defaults to Opus 5.5. Use **Show available models** to choose another.
  - Keys stay in your browser and are sent only to that assistant's API. Usage is billed to that API account; a ChatGPT Plus subscription doesn't cover it.
  - Gemini, ChatGPT and OpenRouter accept requests from web pages. If DeepSeek or Grok refuse them, the error says so: use their models through OpenRouter instead.
- **🖥️ Made for the desktop:**
  - **◫ Reading pane** (`3`): the article list on the left and the open article on the right, as in Outlook or Reeder. `j`/`k` move through the list, `Space` pages through the article and then on to the next one, and the line between them can be dragged. Windows narrower than 1,000 points use the list view instead.
  - **Install it as an app** (⤓ in the top bar, in Chrome and Edge; in Safari on a Mac, *File → Add to Dock*): its own window, a Dock or taskbar icon showing your unread count, and it opens offline. It also asks the browser to keep your data permanently.
  - **Automatic backup to a folder** (⚙ Settings, Chrome and Edge): a backup every day into a folder you pick, the last 7 days kept. Pick a folder in iCloud Drive, Dropbox, OneDrive or Google Drive and your other computers get it too. Optionally encrypted with a passphrase (AES-256), which then includes your API keys.
  - **Right-click menus** on articles (star, mark read, mark everything above or below as read, open or copy the link, dig deeper), feeds (refresh, edit, copy the address, share, unsubscribe), folders, topics, smart folders and investigations. Text and links inside an article keep the browser's own menu.
  - **Command palette** (`Ctrl`+`K` or `⌘`+`K`): type to go to any feed, folder, topic or investigation, or run any command (layout, sort, theme, text size, AI assistant, backup…). Typing anything else offers to search for it by meaning, investigate it, or follow it as a news search.
  - **Text size and font** (**Aa** in the top bar, or `+` and `−`): size, serif or sans-serif, line width and line spacing for articles, kept with your settings.
- **Fun bits:** a 🔥 reading streak, 🎲 Surprise me, confetti at inbox zero, and themes (Light, Dark, Paper and Classic 2008).
- **News searches:** type words instead of an address in ＋ Subscribe (for example `tbilisi`) to follow a news search for them (Bing News RSS). Google Reader-era Google News search feeds in an OPML import keep working: Google blocks relays, so the same search comes from Bing News (also when Google answers with nothing), and the feed page shows its address and says where results come from. All Google News search formats are recognised: `?q=…` (Google Reader-era and current) and `/search/section/q/…`. Search words are passed as they are: quotes ("exact phrase") and -minus work as usual. Bing's RSS returns nothing for OR, so a search with OR runs one search per term and merges the results (each article once).
- **Moved feeds are found automatically:** when a feed is gone (404) or its address now shows a web page, the reader follows the page to the feed it advertises, checks a short list of known moves (sites that changed domain), and tries the usual feed paths on the site (`/rss`, `/feed`, `/rss.xml`, …, at most weekly per feed). The subscription keeps its read and starred marks; its page says where it's now read from.
- **Broken feeds:** each one says why (gone, refuses automated readers, site down) and has **Try again**. Feeds that are gone for good (no new address found, a YouTube channel with no feed) or failing for over a week move to **📦 Retired feeds** at the bottom of the sidebar and aren't fetched any more. There you choose per feed: **Keep trying** (back in its folders, tried daily, not retired again) or **Unsubscribe**, or **Delete all retired feeds**.
- **🕵️ Investigations:** dig into a subject with an AI assistant in a side panel. Start one with **🕵️ Investigate** on a search, an AI topic or a news-search feed, or **🕵️ Dig deeper** on an article.
  - Ask anything and keep asking: the assistant reads the articles in your reader about it (cited as [1], [2]…) and remembers the conversation. Quick questions: *What's X saying?*, *YouTube videos*, *Timeline*, *Who & what*, *Where sources disagree*, *Still unknown*.
  - **With a Grok (xAI) key it searches X and the web live** (xAI's `x_search` and `web_search` tools), and lists every post, page and video it used. *YouTube videos* searches youtube.com; videos play in the panel from YouTube's no-cookie player when you press play. Without a Grok key, your chosen assistant answers from your articles.
  - **Follow** it as an ✨ AI topic, a 📰 news search feed and an 𝕏 X watch. Reopening it shows the new articles since you last looked, and with the X watch on, Grok checks X and the web for news (at most every 30 minutes).
  - Investigations are listed in the sidebar with their new-article counts, kept on your device (and in backups), and can be exported as Markdown notes. Questions go only to the assistant's company, with your key; xAI bills each search Grok makes.
  - Drag the line between the articles and the panel to make the panel wider or narrower (or focus it and use the arrow keys); double-click it to reset. The sidebar has the same handle on its right edge. Widths are remembered on this device.
- **Smart folders** under Starred, sorted automatically and showing only unread articles:
  - **🌐 Languages:** English, French, Arabic, Persian, Russian, Armenian and others, from the article's own words (its script, or common words for Latin-script languages), with the feed's declared language as a hint.
  - **🧭 Topics:** Politics, Conflict & security, Business & money, Tech, AI, Crypto, Science & space, Health, Climate, Cybersecurity, Sport, Games, Culture and Programming, from the headline, summary, the feed's categories and your folder names (a feed in a "Crypto" folder counts as crypto).
  - **🔎 By kind:** Last 24 hours, Videos, Podcasts & audio (from the feed's attached files), Long reads (1,200+ words) and Opinion & analysis.
  - Empty ones are hidden. It all happens on your device.
- **📄 Full article:** for feeds that send only a summary, the button gets the article's text and pictures through the relay (no ads, scripts or trackers), and **Feed version** switches back.
- **Organise:** ✎ Edit on a feed renames it, changes its folders (it can be in several) or shows its address. Drag a feed onto a folder to move it. Folders have ✎ Rename, ⇪ Share folder and Delete folder (keep its feeds, or unsubscribe them too).
- **Reading your way:** newest or oldest first and unread or all, remembered per feed, folder and topic; the layout (list, expanded or reading pane) applies everywhere. ✓ Mark read ▾ marks all, or only articles older than a day or a week. On phones, swipe an article right to star it, left to mark it read, and pull down to refresh.
- **Discover:** ＋ Subscribe lists hand-picked feeds by category, with a *For you* row matched to your folders and topics, and a filter box.
- **Share without sharing your data:** ⇪ Share folder saves a folder's feeds as an OPML file you send to whoever you like. Nothing goes through Sala Reader; the file holds feed addresses only, never what you read or starred.
- **Bring your feeds:** import OPML from Feedly, Inoreader or any reader, and export OPML. A feed can be in several folders, as in Google Reader and Feedly: it shows in each, and its articles count once. Re-importing a file adds missing folders to feeds you already have.
- **YouTube channels:** Feedly-style addresses (`youtube.com/playlist?list=UU…`, `/channel/UC…`, `/user/…`) are read through YouTube's RSS feed, with thumbnails and descriptions.
- **Many feeds:** each of your own feeds is fetched as often as it posts (every 30 minutes for busy feeds, up to twice a day for quiet ones, daily for silent ones). Failing feeds back off: hourly, every 6 hours, then daily. This keeps even a 1,000-feed reader within the shared relay's allowance.
- **Move devices:** ⚙ Settings → *Export backup* saves everything to one file. *Import backup* on the other device restores it. API keys are left out unless you tick the box.

## Rules

These are the rules Sala Reader is built to. Every feature has to fit them; a feature that can't is left out.

### Business rules

1. **Free, with no account.** There is no sign-up, no subscription and nothing to pay Sala Reader. Optional AI features use the reader's own API key, billed by that AI company to the reader directly.
2. **No ads, no tracking, no selling data.** Sala Reader shows no adverts, uses no trackers or cookies, and has no user data to sell, because it never collects any.
3. **Nothing to run.** The site is static files on GitHub Pages. The only moving parts are a scheduled GitHub Action and a small Cloudflare Worker, both on free plans. When a free allowance runs out, things wait until the next day; nothing is ever billed.
4. **The shared parts cost the same for everyone.** The catalog is fetched once for all readers, and the relay caches each feed for 10 minutes, so a feed read by many people costs one fetch.
5. **Open source** under the [MIT license](#license). Anyone can run their own copy, their own relay, or both.

### App rules

1. **Your data stays on your device** (see the [privacy policy](#privacy-policy)). Subscriptions, folders, read and starred marks, topics, investigations, settings and keys live in the browser's own storage, and nothing about the reader is written to a server.
2. **You can always leave with everything.** *Export backup* saves it all to one file, and *Export OPML* gives your subscriptions to any other reader. Import puts it back on another device.
3. **Sharing is your choice, and shares only feeds.** ⇪ Share folder saves an OPML file that you send yourself. It holds feed addresses, never what you read or starred, and it never passes through Sala Reader.
4. **AI is opt-in and goes only where you send it.** The search model runs in your browser. Text goes to an AI company only when you press a button that says so (✨ Summarize, ✨ Brief me, an investigation question), only to the assistant you chose, and with your key.
5. **Articles first.** The article column stays the widest part of the page: side columns can be resized, but the articles always keep at least 460 points (the reading pane at least 380), and on medium windows the sidebar tucks behind ☰ while an investigation is open.
6. **Desktop-class, browser-native.** Installing, offline use, backups to a folder and badges use the browser's own features, with no app store, account or server; where a browser lacks one, the reader says so and offers the manual way.
7. **One story, once.** A feed in several folders, or the same article in several feeds, counts and shows once in mixed views, and reading one copy reads them all.
8. **Feeds only through the relay.** The relay returns RSS or Atom, a list of feed links, or an article's plain text blocks. It never passes web pages through, so it can't be used as a general proxy.
9. **Accessible and readable.** Every colour pair meets WCAG AA contrast (4.5:1) in light and dark themes, everything works from the keyboard, and the live site check runs an axe-core accessibility scan.
10. **Fail politely.** A broken feed says why and offers *Try again*; feeds gone for good retire to their own folder instead of failing silently.

## Privacy policy

*Last updated 2 November 2026.*

Sala Reader is a web app at reader.sala.company. This policy covers the app, the shared relay and the scheduled feed updates. In short: **Sala Reader does not collect, store, share or sell your personal data. Your reader lives on your device.**

### What is stored, and where

Everything you do in Sala Reader is stored **only on your device**, in the browser's own storage (IndexedDB) for this site:

- your subscriptions and folders, and anything you imported (OPML);
- which articles you've read and starred (starred articles are kept even after they leave the feed);
- AI topics, investigations and their conversations, and smart-folder results;
- your settings, the relay you chose, and any AI API keys you entered;
- the AI search model and article search data, cached so they aren't downloaded again;
- a copy of the site's own files (not your data), so the installed app opens offline.

Your phone and your laptop each have their own reader, and clearing the browser's site data erases it. Sala Reader has no copy and cannot recover it. A few display preferences (such as the width of the sidebar) are kept in the browser's local storage on that device.

If you turn on **automatic backup**, the browser also writes a backup file each day into the folder you picked on your computer. It goes straight from the browser to that folder; if the folder is in a cloud drive (iCloud Drive, Dropbox, OneDrive, Google Drive), that company stores it under your account and its terms. With a passphrase the file is encrypted (AES-256-GCM, key derived with PBKDF2-SHA-256) before it's written, so the cloud drive can't read it. The passphrase is kept on your device only and can't be recovered.

### Your control

- **Export backup** (⚙ Settings) saves everything to one file, which you can keep or import on another device. API keys are left out unless you tick the box.
- **Export OPML** saves your subscriptions in the standard format any feed reader can import.
- **Automatic backup** (⚙ Settings) can be stopped at any time; the files already in the folder are yours to keep or delete.
- **Erase all data on this device** (⚙ Settings) deletes everything above.
- Investigations can be exported as Markdown notes or deleted one by one.

### What leaves your device

Only the requests needed to show you feeds and answer what you ask. None of them carry your reading history, and none carry an account, because there isn't one.

| What | Goes to | When |
|---|---|---|
| The shared catalog (`data/`) | this site (GitHub Pages) | on load. Everyone gets the same files, including all catalog articles, so the site can't tell what you follow or read |
| Your own feeds | the feed's site, or the relay you chose: [shared](#the-relay) by default, your own, or none | when they're refreshed. The relay sees only the feed's address |
| 📄 Full article | the relay, which fetches the article page | only when you press 📄 Full article. The relay sees the article's address |
| Images inside articles | their own sites, with no referrer | when you open an article |
| The AI search model | jsDelivr and Hugging Face | once (the multilingual model once more if you pick it). Searches run on the device |
| An article, a list of headlines, or an investigation's question with the matching headlines | the AI assistant you chose (Anthropic, OpenAI, DeepSeek, xAI, OpenRouter or Google), with your key | only when you press ✨ Summarize, ✨ Brief me or Ask, or when an investigation you set to watch X is reopened |
| YouTube thumbnails and videos | YouTube (thumbnails from i.ytimg.com; videos from youtube-nocookie.com) | thumbnails when an investigation answer lists videos; a video only when you press play |
| A page visit | GoatCounter (no cookies) | on load. Only the page address, never feeds, articles, searches or the `?…` part of the address |

The AI companies, feed sites and YouTube handle what they receive under their own privacy policies. Feed icons are letters drawn on the device, so no favicon service learns which sites you follow. Public CORS proxies are never used.

### The shared relay

The relay (a Cloudflare Worker, `relay/worker.js`) fetches feeds and article pages that browsers can't read directly. It keeps no logs (Cloudflare Workers Logs are off), stores nothing, sends feed sites only a generic user agent, and receives nothing that identifies you beyond what any web request carries (Cloudflare sees your IP address to deliver the response, and uses it for the per-visitor rate limit). Answers are cached for 10 minutes by feed address only. You can run [your own relay](#your-own-relay) or use none.

### What Sala Reader doesn't do

- No accounts, sign-ups or email addresses.
- No cookies, advertising, fingerprinting or third-party trackers.
- No server-side storage of your subscriptions, reading or searches.
- No selling, renting or sharing of data, since none is collected.

### Children

Sala Reader is a general-audience tool. It collects no personal information from anyone, including children.

### Changes

Changes to this policy are made in this file, and its history is public in this repository's commits.

### Contact

Questions about privacy: open an issue on [github.com/jamalxcode/salareader](https://github.com/jamalxcode/salareader/issues).

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
  - `data/vectors.json` and `data/vectors-multi.json`: the AI vectors for the English and multilingual models, loaded when you search;
  - `data/seen.json`: when each item was first seen, so feeds without dates still sort sensibly.
- **The `data` branch** keeps the last run's data, so history survives between runs. It's force-pushed as a single commit, so the repo doesn't grow.
- **Your own feeds** (＋ Subscribe or OPML import, when not in the catalog) are fetched by the page itself, when it opens and about every 25 minutes while it's open. Requests to the relay are paced to its limit of 60 a minute, so a big OPML import takes a few minutes, with articles appearing as each feed arrives. It asks the feed's site directly. Most sites block that, so it then asks [the relay](#the-relay).

## How it's arranged

```
index.html          the page: header, sidebar, article column, investigation panel, dialogs
style.css           layout, themes (Light, Dark, Paper, Classic 2008), colour tokens
app.js              the reader: storage, feeds, views, search, smart folders, investigations
sw.js               offline worker: lets the app install and open offline (this site's own files only)
manifest.webmanifest, icon-*.png   the installable app's name and icons
ai.js               AI: the six assistants, Grok live search, the embedding worker pool
embed-worker.js     runs the AI search model in a Web Worker, so the page never freezes
smart.js            smart folders: language detection, topics and kinds
feeds.json          the shared catalog
directory.json      hand-picked feeds for ＋ Subscribe → Discover
scripts/fetch.mjs   the scheduled feed fetch (catalog → data/)
scripts/check-directory.mjs   checks every Discover feed through the relay
relay/worker.js     the Cloudflare Worker relay (feeds and Full article)
tests/site-check.mjs          end-to-end check of the live site in Chromium
.github/workflows/  update (fetch + deploy), site check, relay check, directory check
```

**Inside the browser.** `app.js` keeps everything in one IndexedDB database (`salareader`), in a key-value store plus a separate store for article bodies, and syncs open tabs through a BroadcastChannel. Feeds are parsed on the device (RSS, RDF and Atom). The AI search model (MiniLM, about 25 MB, or the multilingual one, about 120 MB) runs in up to four Web Workers; vectors for your own articles are worked out in the background, newest first, and saved per feed. Smart folders and the "same story in several feeds" check run in small chunks so scrolling stays smooth.

**The screen.** In the reading pane layout, the middle splits into the article list and the open article. Otherwise: a narrow, shaded sidebar on the left (Home, All items, Starred, smart folders, AI topics, investigations, subscriptions); the article column in the middle, white and widest, with a one-line header of compact coloured commands; and, when you dig into something, a grey investigation panel on the right. Both side columns can be dragged wider or narrower. On phones the sidebar slides in from ☰ and an investigation takes the whole screen.

### How it was built

Sala Reader was built in two days (1–2 November 2026) in conversation with Claude, in this order:

1. **Reader basics:** Google Reader's layout and keys, the shared catalog fetched by GitHub Actions and started by cron-job.org, in-browser AI search, AI topics, and jamalterm's six AI assistants for ✨ Summarize and ✨ Brief me.
2. **Privacy first:** every reader's data moved onto the device, with backup and restore, and the relay made safe to share (feeds only, rate-limited, no logs), plus the option of your own relay.
3. **Hardening:** several review passes for security, multi-tab safety, storage, character sets, accessibility and keyboard use, with an automated live-site check (including phone layout and axe-core scans) and a relay check.
4. **Real-world feeds:** big OPML imports paced to the relay, news searches (Bing News, including old Google News search feeds), YouTube channels, feeds in several folders, moved feeds found automatically, and a 📦 Retired feeds folder.
5. **Discovery and reading:** the Discover directory, folder sharing as OPML, 📄 Full article through the relay, and the multilingual AI model.
6. **Speed:** the AI model moved into Web Workers so search never freezes the page, with faster batching and keyword matches shown straight away.
7. **Smart folders:** unread articles grouped by language, topic and kind, worked out on the device.
8. **Investigations:** a side panel to question an AI about a subject, with Grok searching X, the web and YouTube live.
9. **Look and feel:** colour-coded commands and topics, a shaded sidebar, the same story shown once across feeds, the articles given centre stage, and resizable side columns.
10. **Desktop:** a reading pane, an installable app with an unread badge and offline use, daily (optionally encrypted) backups to a folder, right-click menus, a `Ctrl`+`K` command palette, and text size and font controls.

## The relay

Most websites don't let web pages read their feeds (CORS). For those, Sala Reader asks a relay: `relay/worker.js`, a small Cloudflare Worker. In ⚙ Settings → **Your feeds** each reader picks one of three:

- **Shared Sala Reader relay** (default): `https://salareader-relay.jamal-akuna-matata.workers.dev`. It works with no setup.
- **My own relay**: your own copy of the Worker, so no one else sees even which feed addresses you fetch.
- **No relay**: only the catalog, plus feeds whose sites allow web pages to read them.

The Worker is built to be shared safely:
- **Feeds only.** It returns a response only if it's RSS or Atom. Given a web page, it returns just the feed links on it, never the page, so it can't be used as a general proxy.
- **Full article** (`?mode=article`): for an article page it returns only the article's text blocks and picture addresses as JSON, never the page's markup or scripts.
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

## Checks

Three workflows can be run by hand from the Actions tab:

- **Check the live site** (`tests/site-check.mjs`) opens reader.sala.company in Chromium and goes through subscribing, reading, searching, smart folders, investigations, the phone layout and accessibility scans.
- **Check the relay** tries the live relay with feeds, web pages and things it must refuse.
- **Check the directory** fetches every Discover feed through the relay and reports the broken ones.

## License

[MIT](LICENSE) © 2026 Sala Company. You may use, copy, change and share Sala Reader, including commercially, as long as the copyright and license notice stay with it. It comes with no warranty.
