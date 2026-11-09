'use strict';

const claude = require('./claude');
const codex = require('./codex');
const { taskContext } = require('./task');

// Provider adapters implement the same run/check contract. Application code only
// supplies a task, output schema and capabilities (web/readFiles).
const agents = Object.freeze({
  claude: {
    id: 'claude', name: 'Claude Code',
    capabilities: { web: true, readFiles: true, perplexity: true },
    run: options => claude.runClaude({ ...options, allowedTools: (options.tools || []).flatMap(tool =>
      tool === 'web' ? ['WebSearch', 'WebFetch'] : tool === 'readFiles' ? ['Read'] : [tool]) }),
    async check(config) {
      claude.resetClaude();
      const version = await claude.claudeVersion(config.claudeBin);
      const auth = version.ok ? await claude.claudeAuth(config.claudeBin) : { loggedIn: false };
      return { ...version, installed: version.ok, ok: version.ok && auth.loggedIn, ...auth,
        error: version.error || auth.error || (!auth.loggedIn ? 'Run claude auth login to sign in.' : undefined) };
    },
  },
  codex: {
    id: 'codex', name: 'OpenAI Codex',
    capabilities: { web: true, readFiles: true, perplexity: false },
    run: options => codex.runCodex(options),
    check: config => codex.codexStatus(config.codexBin),
  },
});

function getAgent(config = {}) {
  const id = config.aiProvider || 'claude';
  if (!Object.hasOwn(agents, id)) throw new Error(`Unknown AI provider: ${id}`);
  return agents[id];
}

/**
 * Run an agent task. Both adapters return { data, costUsd, durationMs } and
 * honor the AbortSignal in taskContext. tools: web, readFiles, or custom tools.
 */
async function runAgent(options) {
  const agent = getAgent(options.config);
  const cfg = options.config;
  const isCodex = agent.id === 'codex';
  const model = isCodex ? cfg.codexModels?.[options.action] || cfg.codexModel : cfg.models?.[options.action] || cfg.model;
  const onAgent = taskContext.getStore()?.onAgent;
  onAgent?.({ provider: agent.id, name: agent.name, model: model || '', action: options.action || '' });
  options.onLog?.(`${agent.name}: ${options.action || 'task'}`);
  try { return await agent.run(options); }
  finally { onAgent?.(null); }
}

async function checkAgent(config) {
  const agent = getAgent(config);
  return { ...await agent.check(config), provider: agent.id, name: agent.name, capabilities: agent.capabilities };
}

module.exports = { runAgent, checkAgent, getAgent };
