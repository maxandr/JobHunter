# Job Hunter

A local web app for job hunting. Under the hood it calls Claude Code (`claude -p`),
so it runs on your Claude subscription, with no separate API billing.

What it does:
- **Find new jobs** — Claude searches for open positions matching your profile, drops duplicates and closed listings, and gives each a 0–100 match score.
- **Companies** — on the "Extra sources" tab, paste a company's job board link on Greenhouse, Lever, Ashby or Workable
  (e.g. `job-boards.greenhouse.io/discord`), or its careers page if one of these boards is embedded there.
  The app downloads all of the company's open postings through the platform's public API (free, no Claude tokens),
  keeps new ones whose titles have your "Look for" words and none of the "Hide" words, and only those go to Claude for scoring
  (up to 30 per company). With "Search only these sources", if nothing is new, Claude is not run at all.
- **Extra sources** — additional (optional) job sites and Telegram channels (`@channel`, `t.me/channel`, or a link to a site/search page).
  "Find new jobs" checks them first, and the "Search only these sources" button searches only them.
  Channels must be public: Claude reads the latest posts via the `t.me/s/<channel>` web preview. The list lives in `data\sources.json`.
  For sites, the app itself collects job links from the page and from the sitemap (on sites like Hitmarker the list
  is rendered by JavaScript, so Claude would see an empty page) and filters them by the words in the **Filter** block on the same tab:
  "Look for" — what to look for in a link, "Hide" — what to hide (such jobs are also removed from the results of any search).
  The filter is stored in `data\source-filter.json`.
- **Salary** — every job has a salary block. If the posting lists a range, that range is shown (green badge in the list).
  If there are no numbers, Claude looks up salary data (Glassdoor, Levels.fyi, Djinni, etc.) and shows an approximate range marked
  "estimate", with an explanation and source links (a "≈ …" badge in the list). For older jobs the estimate appears after "↻ Refresh".
- **Add a job manually** — paste a job link or the job text into the field at the top.
- **People to contact** — the "Find HR & referrals" button in the job window. Claude searches (mostly LinkedIn via web search,
  plus the company site and the rest of the web) for a recruiter or hiring manager for the role, checks whether the company has a
  referral program, and picks 3 employees you could ask for a referral (engineers with a similar profile, ideally with
  something in common with you). People from the job's city / office come first, then from the same country:
  each one shows where they work and a "job location" / "same country" / "other location" badge; people from elsewhere
  go to the end of the list. Each entry has a profile link, why this person, a confidence level, and a ready-made note
  for a LinkedIn request (up to 300 characters) with a "Copy message" button. Nothing is sent. Results are stored in `jobs.json`.
- **Statuses and notes** — New → Interested → Applied → Interview → Offer / Rejected / Skipped.
  The application date is recorded the first time a job moves to Applied (an "applied 5d ago" badge in the list).
  When skipping, you can give a reason ("Unity only", "US residents only") — it is added to the
  "Not interested in" list in your profile, and future searches will skip such jobs.
- **Generate** — a resume tailored to a specific job (ATS keywords, no invented experience) + a cover letter + a list of requirements you don't meet.
  After Claude responds, the code checks the resume itself: it replaces "AI words" (leveraged → used, em dash → comma),
  looks for numbers and skills that are not in your base resume and profile, and for job keywords you have but that didn't make it into the CV.
  If anything is found, Claude does a short second pass to fix it (about +1 minute). The same pass rewrites
  weak bullets ("Worked on…", first person, too long). If a number disappears or something made up appears after the second pass,
  the first version is kept. The letter opens with a plain "Hello,".
- **ATS score** — a tab next to the resume: how well the CV matches the job for an applicant tracking system (ATS), 0–100, "base → tailored".
  It is computed by code, without Claude: job keywords (40%), skills (20%), exact job title under your name (15%), sections and contacts (15%),
  consistent date format (10%). It also lists missing keywords, tips, and, in red, things that are not in your resume (check they aren't made up).
  The score is recalculated after you edit the CV by hand. For older CVs, press Generate again.
- **ATS check** — a button next to .pdf: builds the PDF and shows the text the way an ATS will read it, plus checks
  (single column, contacts at the top, Experience / Education / Skills headings, no more than 2 pages, no lost keywords).
  "Check another PDF…" lets you check any PDF of your own. To read PDFs, the page loads pdf.js from cdnjs (needs internet).
  The scoring and check logic is ported from [Resume Matcher](https://github.com/srbhr/Resume-Matcher) (Apache-2.0).
- Editing, copying, .md download and **Print / PDF** for resumes.
- **Open & fill form** — opens the application page in a separate Edge/Chrome window and fills in the fields (name, contacts,
  answers to questions, attaches the resume PDF). Nothing is submitted: filled fields are outlined in yellow, the rest and Submit are up to you.
  - If the form is on a different page, paste it into the **Application form link** field (it is remembered for the job).
  - **Try to auto apply** — if there is no tailored CV yet, it creates one first (1–3 minutes), then opens the application page, fills in the form, ticks consent boxes (data processing, privacy policy, terms — but not newsletters) and **clicks Send**. The job status becomes Applied. If required fields are left empty, the submit button isn't found, or the site doesn't confirm submission, it shows an error. After updating the code, reload the extension (the ↻ button on brave://extensions).
  - **With the extension** (recommended) the form is filled right in your own browser, with your logins. One-time setup:
    1. Open `brave://extensions` (`chrome://extensions` in Chrome, `edge://extensions` in Edge).
    2. Turn on **Developer mode**.
    3. **Load unpacked** → select the `extension` folder inside job-hunter.
    4. Reload the app page. "Fills in this browser (extension connected)" appears under the buttons.
    The extension only works together with the open app page and sends nothing anywhere except your local server.
  - **Without the extension** the form opens in the same browser the app is open in (Brave, Chrome, Edge, Opera, Yandex, Vivaldi;
    Firefox is not supported). You can set a different browser in `config.json`: `"applyBrowserBin": "C:\\...\\brave.exe"`.
  - This is a separate window with its own profile (`data\.browser-profile-<browser>`) — browsers don't allow controlling your main profile.
    Log in to LinkedIn etc. there once, and the logins will be kept.

## Requirements

- Node.js 18+ (you already have it if you installed Claude Code via npm).
- Claude Code logged in with your subscription: running `claude` in a terminal should work without errors.

## Getting started

1. Unpack the folder wherever you like, e.g. `C:\Users\<you>\Projects\job-hunter`.
2. Double-click **start.bat** — `http://localhost:4317` opens. Keep the console window open while you use the app.
3. On the **Resume & profile** tab, fill in or check your resume and profile.
4. Click **Find new jobs**. The first search takes 3–15 minutes.

## Settings (config.json)

| Field | What it does |
|---|---|
| `port` | Web page port (default 4317). |
| `claudeBin` | Path to `claude` if it isn't on PATH. |
| `models` | Model for each action: `search` (job search), `analyze` (job analysis), `tailor` (CV + letter), `people` (HR and referral search). Options: `haiku`, `sonnet`, `opus`. Default is `sonnet` everywhere. |
| `effort` | How long the model thinks: `low`, `medium`, `high`. Default is `medium` everywhere. |
| `perplexity` | Use Perplexity from your claude.ai account when searching (`true`/`false`, see below). |
| `mcpConfig` | Path to a JSON file with MCP servers (e.g. Perplexity, see below). |
| `extraAllowedTools` | Which MCP tools to allow, e.g. `["mcp__perplexity"]`. |
| `maxJobsPerSearch` | Maximum number of jobs per search. |
| `maxParallel` | How many Claude runs go at once (default 2). Search, form filling and resume sync always run one at a time. |
| `searchTimeoutMinutes` | Search timeout. |
| `timeouts` | Timeout in minutes for the other actions: `analyze`, `tailor`, `people`, `apply`, `resume`. |
| `resumeSyncOnStart` | Check the resume on Google Drive on every start (`true`/`false`). |
| `cvTwoPages` | Always fit the tailored CV on 2 pages (`true`/`false`, default `false`). Generate builds the PDF, counts the pages and, if there are more, asks Claude to shorten the CV (+1–2 minutes). |
| `autoSearch` | Automatic search while the server is running: `enabled`, `everyHours`, `maxAgeDays`, `sourcesOnly`. |
| `languages` | Text language: `cv` (resume), `letter` (cover letter), `messages` (LinkedIn notes), `forms` (form answers). `"auto"` means the job's language, otherwise a language name, e.g. `"English"`. By default the resume and forms are in English, and the letter and notes are in the job's language. For a single CV you can pick the language under "Options" above the Generate button. |
| `applyBrowserBin`, `browserBin`, `applyBrowserPort` | Browser for filling forms, browser for PDFs, debug port of the form browser. |

All of this can be changed on the **Settings** tab in the app: models and effort for each action (plus the presets
Economy / Balanced / Best quality / Maximum), timeouts, auto search, resume, browsers, the Claude path with a
"Test Claude" button, and run statistics (`data\usage.json`). Changes apply immediately, except the port, which needs ↻ Restart.

## Perplexity

Job search uses Perplexity together with the built-in WebSearch/WebFetch: Perplexity finds fresh postings,
and Claude then opens each one via WebFetch and verifies it. When analyzing a job or generating a CV, Perplexity
helps if the job page doesn't open.

It works through the Perplexity connector in your claude.ai account (the same one Claude Code is logged in with),
so no API key is needed. To turn it off: `"perplexity": false` in `config.json`.

If you don't have the connector in claude.ai, you can connect Perplexity with your own API key (paid, separate from the subscription):

1. Copy `mcp-perplexity.example.json` to `mcp-perplexity.json` and paste in your key.
2. In `config.json`: `"mcpConfig": "mcp-perplexity.json"`, `"extraAllowedTools": ["mcp__perplexity"]`.

## Where the data lives

Everything is in the `data\` folder: `jobs.json` (jobs), `resume.md`, `profile.md`, `applications\<id>\` (resumes and letters for each job).
These are plain files — you can back them up or put them in git (the data folder is excluded in `.gitignore` because it contains personal data).

## Important

- The server listens only on `127.0.0.1` — it isn't reachable from other devices. Don't expose it to the internet: it runs on your subscription.
- Every action is a separate `claude -p` run. Up to `maxParallel` (2) runs go at once; short tasks (link analysis, CV, form) are queued ahead of searches. A search uses a noticeable share of your limits, CV tailoring uses a little.
- The app submits an application only via the **Try to auto apply** button; everything else you submit yourself.
- Claude can misjudge jobs — open the link before applying and reread the resume before sending.
