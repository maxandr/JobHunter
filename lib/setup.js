// First-run setup (the Setup tab): is Claude Code installed and logged in, is there a resume.
// Can install Claude Code with the official script and open a window to log in.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const store = require('./store');
const { resolveClaude, resetClaude, claudeVersion, claudeAuth, taskContext } = require('./claude');

async function status() {
  const config = store.config();
  resetClaude();
  const claude = await claudeVersion(config.claudeBin);
  const auth = claude.ok ? await claudeAuth(config.claudeBin) : { loggedIn: false };
  const resume = !!store.readText(store.FILES.resume).trim();
  const profile = !!store.readText(store.FILES.profile).trim();
  return {
    platform: process.platform,
    claude, auth, resume, profile,
    resumeSource: config.resumePdfPath || config.resumeDrive || '',
    done: claude.ok && auth.loggedIn && resume,
  };
}

// The installer puts claude.exe into %USERPROFILE%\.local\bin but does not always add it to PATH.
function addToUserPath(dir, log) {
  const cur = String(execFileSync('powershell', ['-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8', windowsHide: true })).trim();
  const has = cur.split(';').some(d => d.trim().replace(/\\$/, '').toLowerCase() === dir.toLowerCase());
  if (!has) {
    const next = cur ? cur.replace(/;$/, '') + ';' + dir : dir;
    execFileSync('powershell', ['-NoProfile', '-Command',
      `[Environment]::SetEnvironmentVariable('Path', '${next.replace(/'/g, "''")}', 'User')`], { windowsHide: true });
    log('Added ' + dir + ' to your PATH');
  }
  if (!process.env.PATH.toLowerCase().includes(dir.toLowerCase())) process.env.PATH += ';' + dir;
}

// Runs the official installer (https://claude.ai/install.ps1, or install.sh on Mac/Linux) as a task.
function installClaude(onLog) {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']]
    : ['bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']];
  const signal = taskContext.getStore() && taskContext.getStore().signal;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const onAbort = () => { child.kill(); reject(new Error('Cancelled')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let tail = '';
    const onData = d => {
      tail = (tail + d).slice(-2000);
      String(d).split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(onLog);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => reject(new Error(`Cannot start ${cmd}: ${e.message}`)));
    child.on('close', async code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code !== 0) return reject(new Error(`Installer exited with code ${code}: ${tail.trim().slice(-400)}`));
      const bin = path.join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'bin');
      if (win) {
        try { addToUserPath(bin, onLog); } catch (e) { onLog('Could not add to PATH: ' + e.message); }
      } else if (!process.env.PATH.includes(bin)) process.env.PATH += ':' + bin;
      resetClaude();
      const v = await claudeVersion(store.config().claudeBin);
      if (!v.ok) return reject(new Error(`Installed, but claude does not start (${v.cmd}): ${v.error}`));
      resolve({ version: v.version });
    });
  });
}

// Opens a console window with `claude auth login`: it shows a link to sign in to your claude.ai account.
function openLogin() {
  const launcher = resolveClaude(store.config().claudeBin);
  const exe = launcher.cmd.replace(/^"|"$/g, '');
  if (process.platform === 'win32') {
    // cmd /k drops the outer pair of quotes, so the quoted path survives even with spaces in it.
    spawn('cmd.exe', ['/c', 'start', '"Claude Code login"', 'cmd', '/k', `""${exe}" auth login"`],
      { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return { ok: true };
  }
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "'${exe}' auth login"`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  }
  return { ok: false, error: 'Open a terminal and run: claude auth login' };
}

module.exports = { status, installClaude, openLogin };
