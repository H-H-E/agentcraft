// Real Foreman/MCP/task/worktree/CI/merge paths with a fake inference stream. No API usage.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

let h: Harness | undefined;
let repo: string | undefined;
let home: string | undefined;
afterEach(async () => {
  await h?.fm.close();
  if (home) rmrf(home);
  if (repo) rmrf(path.dirname(repo));
  h = undefined;
  home = undefined;
  repo = undefined;
  vi.unstubAllEnvs();
});

const msg = (value: object) => value as SDKMessage;
const init = (id: string) => msg({ type: 'system', subtype: 'init', session_id: id });
const tool = (id: string, name: string, input: object) => msg({ type: 'assistant', session_id: id, message: { content: [{ type: 'tool_use', id: name, name, input }] } });
const done = (id: string) => msg({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2, session_id: id });

async function call(options: Options, name: string, args: object) {
  const server = options.mcpServers!.agentcraft as unknown as { instance: { _registeredTools: Record<string, { handler(a: object, extra: object): Promise<unknown> }> } };
  return server.instance._registeredTools[name]!.handler(args, {});
}

async function makeHarness() {
  vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-test-secret');
  vi.stubEnv('ANTHROPIC_API_KEY', 'old-anthropic-key');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'old-login-token');
  home = tempDir();
  repo = await demoRepo();
  h = makeForeman(home, ['--provider', 'minimax', '--workers', 'kit', '--lead-model', 'MiniMax-lead', '--worker-model', 'MiniMax-worker', '--repo', repo]);
  return h;
}

describe('MiniMax backend orchestration', () => {
  it('keeps MCP, tools, events, sessions, CI, and explicit merge approval working', async () => {
    const harness = await makeHarness();
    const calls: Options[] = [];
    let denied: string | undefined;
    const query = ({ prompt, options }: { prompt: unknown; options: Options }) => {
      calls.push(options);
      async function* run() {
        if (String(prompt).startsWith('New goal')) {
          yield init('minimax-lead-session');
          const args = { title: 'Add --version', description: 'Print version', assignee: 'kit' };
          yield tool('minimax-lead-session', 'mcp__agentcraft__create_task', args);
          await call(options, 'create_task', args);
          await call(options, 'send_message', { to: 'kit', text: 'Please implement --version.' });
          yield done('minimax-lead-session');
        } else if (options.cwd!.includes('kit-')) {
          yield init('minimax-worker-session');
          const cli = path.join(options.cwd!, 'src', 'cli.ts');
          const signal = new AbortController().signal;
          const extra = { signal, toolUseID: 'test' } as never;
          expect((await options.canUseTool!('Read', { file_path: cli }, extra))?.behavior).toBe('allow');
          yield tool('minimax-worker-session', 'Read', { file_path: cli });
          const old = fs.readFileSync(cli, 'utf8');
          expect((await options.canUseTool!('Edit', { file_path: cli, old_string: 'a', new_string: 'b' }, extra))?.behavior).toBe('allow');
          yield tool('minimax-worker-session', 'Edit', { file_path: cli, old_string: "case 'help':", new_string: "case '--version':" });
          fs.writeFileSync(cli, old.replace("      case 'help':", "      case '--version':\n        io.out('pocket-notes 0.2.0');\n        return 0;\n      case 'help':"));
          denied = (await options.canUseTool!('Bash', { command: 'npm install left-pad' }, extra))?.behavior;
          expect((await options.canUseTool!('Bash', { command: 'npm test' }, extra))?.behavior).toBe('allow');
          yield tool('minimax-worker-session', 'Bash', { command: 'npm test' });
          await promisify(execFile)(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: options.cwd! });
          await call(options, 'send_message', { to: 'marlow', text: 'Tests pass.' });
          await call(options, 'update_task', { task_id: 't1', status: 'review', summary: 'Added --version; tests pass.' });
          // Simulate an upstream diagnostic echoing the key; no secret may reach the observer.
          yield msg({ type: 'assistant', session_id: 'minimax-worker-session', message: { content: [{ type: 'text', text: 'diagnostic sk-cp-test-secret' }] } });
          yield done('minimax-worker-session');
        } else {
          yield init('minimax-lead-session');
          expect(options.resume).toBe('minimax-lead-session');
          yield tool('minimax-lead-session', 'mcp__agentcraft__request_merge', { task_id: 't1' });
          await call(options, 'request_merge', { task_id: 't1', summary: 'Tests pass; please approve.' });
          yield done('minimax-lead-session');
        }
      }
      return Object.assign(run(), { close() {}, accountInfo: async () => ({ tokenSource: 'ANTHROPIC_AUTH_TOKEN' }) });
    };
    await harness.fm.start(new ClaudeBackend(harness.fm, harness.cfg.claude, { queryFn: query as never }));
    const goal = await harness.fm.submitGoal('Add a --version flag');
    await until(() => harness.fm.decisions.open().some(d => d.kind === 'permission'));
    await harness.fm.answerDecision(harness.fm.decisions.open().find(d => d.kind === 'permission')!.id, 'Deny');
    await until(() => harness.fm.decisions.open().some(d => d.kind === 'merge'));
    expect(denied).toBe('deny');
    expect(harness.fm.tasks.get('t1')).toMatchObject({ status: 'review', assignee: 'kit', ci: 'pass' });
    expect(fs.readFileSync(path.join(repo!, 'src', 'cli.ts'), 'utf8')).not.toContain("case '--version':");
    expect(harness.fm.store.data.sessions['kit:t1']).toMatchObject({ sessionId: 'minimax-worker-session', model: 'MiniMax-worker' });
    expect(harness.fm.store.data.sessions[`marlow:${goal.id}`]?.sessionId).toBe('minimax-lead-session');
    expect(calls.some(c => c.model === 'MiniMax-worker')).toBe(true);
    for (const c of calls) {
      expect(c.effort).toBeUndefined();
      expect(c.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-cp-test-secret');
      expect(c.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(c.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(c.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(c.model ?? 'MiniMax-lead');
    }
    harness.fm.flushLogs();
    const logs = harness.fm.store.logTail('kit');
    for (const label of ['Read', 'Edit', '$ npm test']) expect(logs.some(l => l.kind === 'tool' && l.text.startsWith(label))).toBe(true);
    expect(logs.some(l => l.text.includes('[redacted]'))).toBe(true);
    expect(JSON.stringify([harness.events, harness.fm.store.data])).not.toContain('sk-cp-test-secret');
    const merge = harness.fm.decisions.open().find(d => d.kind === 'merge')!;
    await harness.fm.answerDecision(merge.id, 'Merge');
    await until(() => harness.fm.goal(goal.id)?.status === 'done');
    expect(fs.readFileSync(path.join(repo!, 'src', 'cli.ts'), 'utf8')).toContain("case '--version':");
    await harness.fm.close();
    expect(fs.readFileSync(path.join(harness.cfg.dataDir, 'state.json'), 'utf8')).not.toContain('sk-cp-test-secret');
    expect(fs.readFileSync(path.join(harness.cfg.dataDir, 'logs', 'kit.jsonl'), 'utf8')).not.toContain('sk-cp-test-secret');
  });

  it.each(['401 invalid API key', '403 authentication rejected', '429 rate limit exceeded'])('surfaces real request failures: %s', async (reason) => {
    const harness = await makeHarness();
    const query = () => Object.assign((async function* () { throw new Error(`${reason} sk-cp-test-secret`); yield done('unreachable'); })(), { close() {}, accountInfo: async () => ({ tokenSource: 'ANTHROPIC_AUTH_TOKEN' }) });
    await harness.fm.start(new ClaudeBackend(harness.fm, harness.cfg.claude, { queryFn: query as never }));
    await harness.fm.submitGoal('Add a --version flag');
    await until(() => harness.fm.agent('marlow')?.state === 'error');
    expect(harness.fm.status.auth).toBe(reason.startsWith('429') ? 'ok' : 'failed');
    expect(harness.fm.store.logTail('marlow').some(l => l.text.includes(reason.startsWith('429') ? 'quota exhausted' : 'authentication rejected'))).toBe(true);
    expect(JSON.stringify([harness.events, harness.fm.store.data, harness.fm.status])).not.toContain('sk-cp-test-secret');
  });
});
