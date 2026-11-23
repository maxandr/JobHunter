# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use **Security → Report a vulnerability**
on this repository's GitHub page instead (a private report only the maintainer sees).
Say what can go wrong and how to reproduce it.

## How the app is built

- The server listens only on `127.0.0.1`, so other devices on your network can't reach it.
  It also rejects requests whose `Host` or `Origin` is not the app itself, so other sites open
  in your browser can't read or change your data.
- Everything is stored as plain files in the `data\` folder: resume, profile, jobs, generated CVs and letters,
  and the browser profile used for form filling (with the logins you make there). Nothing is encrypted,
  so anyone with access to your Windows account can read it.
- Your resume and job texts are sent only to the AI you choose (Anthropic for Claude Code, OpenAI for Codex),
  through their own CLI and your own account. The app has no server of its own and sends nothing to its author.
- The browser extension asks for access to all sites because job forms can be on any site. It acts only
  when you press "Open & fill" or "Try to auto apply" in the app, and talks only to the local server.
- Claude runs with shell commands and file writing turned off (`--disallowedTools Bash,Edit,Write,…`);
  Codex runs in its read-only sandbox.
