# Job Hunter

**A local job-search assistant that runs on your own Claude Code or Codex account.**
It finds open positions, scores them against your resume, writes a tailored CV and cover letter
for each one, and fills in application forms. You still press Submit.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078d4)
![Node.js 18+](https://img.shields.io/badge/node-18%2B-339933)
![No dependencies](https://img.shields.io/badge/dependencies-none-lightgrey)

- **Free.** No subscription of its own, no API key: AI runs use your Claude Code or Codex plan.
- **Private.** Everything stays in a folder on your computer; the server is reachable only from it.
- **Honest CVs.** The code checks every CV for numbers and skills that aren't in your resume.

## Features

| | |
|---|---|
| 🔎 **Job search** | Claude searches the web for jobs that fit your profile, drops duplicates and closed listings, and scores each 0–100. |
| 🏢 **Company boards** | Paste a Greenhouse, Lever, Ashby or Workable board: all its postings come in through the public API, free. |
| 💼 **LinkedIn** | Every search also reads LinkedIn's public job pages for your keywords, in your country and remote. No login. |
| 📡 **Extra sources** | Any job site or public Telegram channel, filtered by your "Look for" and "Hide" words before Claude sees them. |
| 💰 **Salary** | The posted range, or an estimate from Glassdoor, Levels.fyi and others, with sources. |
| 📝 **Tailored CV + letter** | ATS keywords, no invented experience, plus a list of requirements you don't meet. |
| ✅ **ATS score & check** | How well the CV matches the job, and the PDF text the way an ATS reads it. |
| 🤝 **People to contact** | A recruiter and three possible referrers at the company, with a ready LinkedIn note. |
| 🖊️ **Form filling** | Fills the application in your own browser via the extension. Auto apply only when you ask for it. |
| 📋 **Tracking** | New → Interested → Applied → Interview → Offer, with notes; skip reasons teach future searches. |

## Quick start

**You need:** Windows, [Node.js](https://nodejs.org) 18+, and [Claude Code](https://claude.ai/code) logged in
(in PowerShell: `irm https://claude.ai/install.ps1 | iex`, then run `claude` once).
Prefer Codex? `npm install -g @openai/codex`, `codex login`, then pick it in Settings → AI provider.

1. **Code → Download ZIP** on this page and unpack it anywhere (or `git clone`).
2. Double-click **`start.bat`**. The app opens at `http://localhost:4317`; keep the black window open.
3. Fill in **Resume & profile** (or import your resume from a PDF or Google Drive link on the Setup tab).
4. Press **Find new jobs**. The first search takes 3–15 minutes.

**Browser extension** (for filling forms in your own browser, with your logins):
open `chrome://extensions` (or `brave://`, `edge://`), turn on **Developer mode**,
**Load unpacked** → the `extension` folder. Without it, forms open in a separate browser window.

**Updating:** unpack the new version over the old one (or `git pull`) and restart `start.bat`.
Your `data\` folder and `config.json` aren't in the download, so nothing is lost. Press ↻ on the extension.

## Good to know

- **Costs.** Every action is a separate `claude -p` (or `codex exec`) run on your plan. A search uses a noticeable share
  of your limits, a CV a little. Settings has presets from Economy to Maximum and shows usage.
- **Settings.** Everything is on the Settings tab: models and effort per action, timeouts, auto search every N hours,
  languages, CV length, browsers. It is stored in `config.json` (see `config.example.json`).
- **Perplexity.** If your claude.ai account has the Perplexity connector, searches use it automatically.
  Otherwise you can add your own key: copy `mcp-perplexity.example.json` to `mcp-perplexity.json`.
- **Your data** lives in `data\` as plain files: `jobs.json`, `resume.md`, `profile.md`, and `applications\<id>\`
  with the CV and letter for each job. Back it up like any folder.
- **LinkedIn** may answer "429" if you search too often; it can be turned off in Settings → Search.

<details>
<summary><b>FAQ</b></summary>

**Will it apply to jobs without asking me?**
No. Only the **Try to auto apply** button submits, and only the one application you pressed it for.

**Will the CV make up experience?**
It shouldn't. Claude may use only your resume and profile, then the code checks the CV for numbers and skills
that aren't there and fixes them. The ATS score tab marks anything new in red. Still, read every CV before sending.

**Where does my resume go?**
Only to the AI you picked (Anthropic or OpenAI), through their own CLI and your account. Nothing goes to us.

**Can LinkedIn block my account?**
Search reads public pages without logging in, so your account isn't involved. Form filling uses your logins,
so use auto apply at your own risk.

**macOS or Linux?**
Not yet: it is built and tested on Windows.

</details>

<details>
<summary><b>For developers</b></summary>

- `server.js` is the web server, `public/` the page, `extension/` the form-filling extension, `lib/` the rest.
- Agents are behind one interface in `lib/ai.js`: `runAgent({ prompt, schema, tools, config, ... })` returns
  `{ data, costUsd, durationMs }`; `checkAgent(config)` reports install and login status.
  Adapters: `lib/claude.js`, `lib/codex.js`.
- `npm test` runs the tests. `node test/settings-browser.js` checks Settings in a real browser;
  `node test/agent-smoke.js` runs live Codex checks (uses your limits).
- `search.js` runs one search without the UI; `schedule-daily-search.bat` registers it as a daily Windows task.

</details>

## Security & disclaimer

The server listens only on `127.0.0.1` and rejects requests from other sites. The extension asks for access to all sites
because forms can be anywhere, but acts only when you press a button in the app. See [SECURITY.md](SECURITY.md).

Use at your own risk. Not affiliated with LinkedIn, Anthropic, OpenAI or any job site. Reading job sites and filling forms
automatically may go against some sites' terms, and a site may limit you for it. Check every CV, letter and form before it goes out.

## License

[MIT](LICENSE). Inter font under the SIL Open Font License. ATS scoring logic ported from
[Resume Matcher](https://github.com/srbhr/Resume-Matcher) (Apache-2.0).
