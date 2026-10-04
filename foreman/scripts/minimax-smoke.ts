// Opt-in live test: real Agent SDK + MiniMax inference, Foreman, MCP, worktrees, CI and review.
// Uses an isolated temporary repo and never answers a merge/permission decision automatically.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { redactAuthSecrets } from '../src/agents/claude/auth.js';
import { loadConfig } from '../src/config.js';
import { consoleLogger } from '../src/context.js';
import { Foreman } from '../src/foreman.js';
import { ForemanServer } from '../src/server.js';

async function main() {
  if (!process.env.MINIMAX_API_KEY?.trim()) throw new Error('MiniMax key missing. Set MINIMAX_API_KEY to your Coding/Token Plan key before running npm run smoke:minimax.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcraft-minimax-smoke-'));
  const repo = path.join(root, 'smoke-repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'sum.mjs'), 'export function add(a, b) { return a - b; }\n');
  fs.writeFileSync(path.join(repo, 'sum.test.mjs'), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './sum.mjs';\ntest('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0); });\n");
  let fm: Foreman | undefined;
  let server: ForemanServer | undefined;
  try {
    for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=AgentCraft Smoke', '-c', 'user.email=smoke@agentcraft.local', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Smoke fixture']]) execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    const cfg = loadConfig(['--home', path.join(root, 'state'), '--profile', 'minimax-smoke', '--provider', 'minimax', '--no-use-claude-login', '--workers', 'kit', '--max-concurrent', '1', '--max-turns', '30', '--no-notify', '--repo', repo, '--ci', 'node --test']);
    const log = consoleLogger('minimax-smoke');
    fm = new Foreman({ config: cfg, logger: log });
    server = new ForemanServer(fm, { host: '127.0.0.1', port: 0, log });
    await server.start();
    await fm.start(new ClaudeBackend(fm, cfg.claude));
    assert.equal(fm.status.auth, 'ok', fm.status.message);
    const goal = await fm.submitGoal('Fix the add(a, b) function in sum.mjs. Create exactly one coding task assigned to kit using create_task. The worker must Read sum.mjs, edit it, run Bash command node --test, send_message to marlow with the result, and update_task to review. The lead must review it and use request_merge. Use AgentCraft MCP tools for coordination. Do not ask for additional requirements or merge anything.');
    const deadline = Date.now() + 5 * 60_000;
    while (!fm.decisions.open().some(d => d.kind === 'merge')) {
      assert.notEqual(fm.status.auth, 'failed', fm.status.message);
      const waiting = fm.decisions.open().find(d => d.kind !== 'merge');
      assert(!waiting, `Smoke needs user input: ${waiting?.question}. No permissions were auto-approved.`);
      assert(!fm.agents().some(a => a.state === 'error'), 'An agent turn failed; inspect the provider error above.');
      assert(Date.now() < deadline, 'Smoke timed out after five minutes.');
      await new Promise(r => setTimeout(r, 250));
    }
    // Wait for the review turn's terminal stream event/session record.
    while (Object.keys((fm.store.data.backend.claude as { inflight: object }).inflight).length) {
      assert(Date.now() < deadline, 'Review turn did not terminate.');
      await new Promise(r => setTimeout(r, 100));
    }
    fm.flushLogs();
    fm.store.flush();
    const task = fm.tasks.list()[0]!;
    assert.equal(fm.tasks.list().length, 1);
    assert.equal(task.status, 'review');
    assert.equal(task.assignee, 'kit');
    assert.equal(task.ci, 'pass');
    const worker = fm.store.logTail('kit');
    const lead = fm.store.logTail('marlow');
    for (const label of ['Read', 'Edit', '$ node --test']) assert(worker.some(e => e.kind === 'tool' && e.text.startsWith(label)), `Missing streamed ${label} event`);
    assert(lead.some(e => e.kind === 'tool' && /create_task/.test(e.text)), 'Missing lead MCP create_task event');
    assert(worker.some(e => e.kind === 'tool' && /send_message/.test(e.text)), 'Missing worker MCP message event');
    assert(fm.store.data.sessions[`marlow:${goal.id}`]?.sessionId, 'Missing lead session');
    assert(fm.store.data.sessions[`kit:${task.id}`]?.sessionId, 'Missing worker session');
    const worktree = fm.repos.requireWorktree(task.repoId!, task.worktree!);
    execFileSync(process.execPath, ['--test'], { cwd: worktree.path, stdio: 'ignore' });
    assert(fs.readFileSync(path.join(repo, 'sum.mjs'), 'utf8').includes('return a - b'), 'Base checkout changed without merge approval');
    const state = fs.readFileSync(path.join(cfg.dataDir, 'state.json'), 'utf8');
    assert(!state.includes(process.env.MINIMAX_API_KEY!.trim()), 'Key leaked into state');
    console.log(JSON.stringify({ ok: true, endpoint: cfg.claude.minimaxBaseUrl, leadModel: cfg.claude.leadModel, workerModel: cfg.claude.workerModel, checks: ['lead MCP task', 'worker worktree/read/edit', 'Bash test', 'stream events', 'agent messaging', 'session persistence/resumed review', 'CI', 'pending merge approval', 'base unchanged', 'no key in state'] }, null, 2));
  } finally {
    await server?.stop();
    await fm?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(e => {
  console.error(redactAuthSecrets(e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
