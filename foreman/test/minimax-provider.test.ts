import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../src/config.js';
import { detectApiAuth, MINIMAX_DEFAULT_BASE_URL, miniMaxError, redactAuthSecrets, withMiniMax } from '../src/agents/claude/auth.js';
import { ClaudeBackend } from '../src/agents/claude/index.js';
import { makeForeman, rmrf, tempDir, type Harness } from './helpers.js';

let home: string | undefined;
let h: Harness | undefined;
afterEach(async () => {
  await h?.fm.close();
  if (home) rmrf(home);
  home = undefined;
  h = undefined;
  vi.unstubAllEnvs();
});

function config(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  home ??= tempDir();
  return loadConfig(['--home', home, ...args], env);
}

describe('MiniMax provider config', () => {
  it('selects MiniMax without changing the backend or storing credentials', () => {
    const cfg = config(['--provider', 'minimax'], { MINIMAX_API_KEY: 'sk-cp-test-secret' });
    expect(cfg.backend).toBe('claude');
    expect(cfg.claude.provider).toBe('minimax');
    expect(cfg.claude.leadModel).toBe('MiniMax-M3');
    expect(cfg.claude.workerModel).toBe('MiniMax-M3');
    expect(cfg.claude.minimaxBaseUrl).toBe(MINIMAX_DEFAULT_BASE_URL);
    expect(JSON.stringify(cfg)).not.toContain('sk-cp-test-secret');
  });

  it('supports env selection, endpoint and separate lead/worker overrides', () => {
    const cfg = config([], { AGENTCRAFT_PROVIDER: 'minimax', MINIMAX_BASE_URL: 'https://api.example.test/anthropic/', MINIMAX_MODEL: 'MiniMax-new', MINIMAX_LEAD_MODEL: 'MiniMax-lead', MINIMAX_WORKER_MODEL: 'MiniMax-worker' });
    expect(cfg.claude.minimaxBaseUrl).toBe('https://api.example.test/anthropic');
    expect([cfg.claude.leadModel, cfg.claude.workerModel]).toEqual(['MiniMax-lead', 'MiniMax-worker']);
    expect(config([], { AGENTCRAFT_PROVIDER: 'minimax', MINIMAX_MODEL: 'MiniMax-new' }).claude.workerModel).toBe('MiniMax-new');
    expect(config(['--provider', 'anthropic'], { AGENTCRAFT_PROVIDER: 'minimax' }).claude.provider).toBe('anthropic');
  });

  it('gives CLI model overrides priority and keeps legacy aliases internal', () => {
    const env = { AGENTCRAFT_PROVIDER: 'minimax', MINIMAX_MODEL: 'MiniMax-new', MINIMAX_LEAD_MODEL: 'MiniMax-lead' };
    expect(config(['--model', 'MiniMax-cli', '--lead-model', 'MiniMax-cli-lead'], env).claude).toMatchObject({ leadModel: 'MiniMax-cli-lead', workerModel: 'MiniMax-cli' });
    expect(config(['--lead-model', 'opus', '--worker-model', 'haiku'], env).claude).toMatchObject({ leadModel: 'MiniMax-new', workerModel: 'MiniMax-new' });
  });

  it('reads non-secret provider config and maps saved Claude aliases', () => {
    home = tempDir();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ claude: { provider: 'minimax', leadModel: 'opus', workerModel: 'sonnet', minimaxBaseUrl: 'https://gateway.example/anthropic' } }));
    expect(config().claude).toMatchObject({ provider: 'minimax', leadModel: 'MiniMax-M3', workerModel: 'MiniMax-M3', minimaxBaseUrl: 'https://gateway.example/anthropic' });
  });

  it('rejects login/provider conflicts and credential-bearing endpoints without printing them', () => {
    expect(() => config(['--provider', 'minimax', '--use-claude-login'])).toThrow(/cannot be combined/);
    expect(config(['--provider', 'minimax', '--no-use-claude-login'], { AGENTCRAFT_USE_CLAUDE_LOGIN: '1' }).claude.useClaudeLogin).toBe(false);
    for (const value of ['file:///tmp/gateway', 'https://user:secret@gw.test/anthropic', 'https://gw.test/anthropic?token=secret', 'bad-secret-url']) {
      expect(() => config(['--provider', 'minimax'], { MINIMAX_BASE_URL: value })).toThrow('MINIMAX_BASE_URL must be');
      try { config(['--provider', 'minimax'], { MINIMAX_BASE_URL: value }); } catch (e) { expect(String(e)).not.toContain('secret'); }
    }
    expect(() => config(['--provider'])).toThrow(/unknown provider/);
  });

  it('leaves Anthropic and sim settings unchanged even with MiniMax environment present', () => {
    expect(config([], { MINIMAX_MODEL: 'MiniMax-new', MINIMAX_API_KEY: 'k' }).claude).toMatchObject({ provider: 'anthropic', leadModel: 'opus', workerModel: 'sonnet' });
    const args = ['--backend', 'sim', '--model', 'sonnet', '--use-claude-login'];
    expect(config(args, { AGENTCRAFT_PROVIDER: 'bad-provider', MINIMAX_BASE_URL: 'bad-url', MINIMAX_MODEL: 'MiniMax-new' }).claude).toEqual(config(args).claude);
  });
});

describe('MiniMax child environment', () => {
  it('maps the token and all model aliases only in a copy and removes competing auth', () => {
    const parent = { MINIMAX_API_KEY: 'sk-cp-test-secret', ANTHROPIC_API_KEY: 'anthropic-secret', ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_BASE_URL: 'https://old-gateway', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: 'true', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_ANTHROPIC_AWS: '1', CLAUDE_CODE_EFFORT_LEVEL: 'max', PATH: '/bin', GIT_ALLOW_PROTOCOL: 'agentcraft-none' };
    const snapshot = { ...parent };
    const child = withMiniMax(parent, MINIMAX_DEFAULT_BASE_URL, 'MiniMax-new');
    expect(parent).toEqual(snapshot);
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe(parent.MINIMAX_API_KEY);
    expect(child.ANTHROPIC_BASE_URL).toBe(MINIMAX_DEFAULT_BASE_URL);
    for (const key of ['MINIMAX_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_EFFORT_LEVEL']) expect(child).not.toHaveProperty(key);
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) expect(child[key]).toBe('MiniMax-new');
    expect(child.GIT_ALLOW_PROTOCOL).toBe('agentcraft-none');
    expect(detectApiAuth(child)).toEqual({ ok: true, source: 'API gateway' });
    expect(detectApiAuth(withMiniMax({ ANTHROPIC_AUTH_TOKEN: 'old-token' }, MINIMAX_DEFAULT_BASE_URL, 'MiniMax-M3'))).toEqual({ ok: false });
  });

  it('does not change the parent process token', () => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-test-secret');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'old-token');
    withMiniMax(process.env, MINIMAX_DEFAULT_BASE_URL, 'MiniMax-M3');
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('old-token');
  });
});

describe('MiniMax authentication and errors', () => {
  it('fails on a missing key even when Anthropic/cloud/login credentials exist', async () => {
    vi.stubEnv('MINIMAX_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'old-key');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    home = tempDir();
    h = makeForeman(home, ['--provider', 'minimax']);
    const query = vi.fn();
    expect(await new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: query as never }).checkAuth()).toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(h.fm.status.message).toMatch(/MiniMax key missing/);
  });

  it('uses gateway initialization metadata and sends only child-adapted auth to the SDK', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-test-secret');
    home = tempDir();
    h = makeForeman(home, ['--provider', 'minimax']);
    const close = vi.fn();
    const query = vi.fn((_input: { options: Options }) => ({ close, accountInfo: async () => ({ tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' }) }));
    expect(await new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: query as never }).checkAuth()).toBe(true);
    expect(query.mock.calls[0]?.[0].options.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-cp-test-secret');
    expect(query.mock.calls[0]?.[0].options.env?.MINIMAX_API_KEY).toBeUndefined();
    expect(h.fm.status.account).toBe('MiniMax API gateway');
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify([h.fm.status, h.events, h.fm.store.data])).not.toContain('sk-cp-test-secret');
  });

  it.each(['401', '403'])('reports %s auth rejection without echoing the key in status/feed/state', async (status) => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-test-secret');
    home = tempDir();
    h = makeForeman(home, ['--provider', 'minimax']);
    const query = () => ({ close() {}, accountInfo: async () => { throw new Error(`${status} rejected sk-cp-test-secret`); } });
    expect(await new ClaudeBackend(h.fm, h.cfg.claude, { queryFn: query as never }).checkAuth()).toBe(false);
    expect(h.fm.status.message).toMatch(/MiniMax authentication rejected/);
    await h.fm.close();
    expect(JSON.stringify([h.fm.status, h.events, h.fm.store.data])).not.toContain('sk-cp-test-secret');
    expect(fs.readFileSync(path.join(h.cfg.dataDir, 'state.json'), 'utf8')).not.toContain('sk-cp-test-secret');
  });

  it.each([
    ['404 model not found', 'model or endpoint unavailable'],
    ["There's an issue with the selected model (MiniMax-new). It may not exist.", 'model or endpoint unavailable'],
    ['429 rate_limit_error', 'rate limit or quota exhausted'],
    ['billing_error: insufficient balance', 'rate limit or quota exhausted'],
    ['ECONNREFUSED', 'endpoint unreachable'],
  ])('reports %s usefully', (raw, message) => expect(miniMaxError(raw)).toContain(`MiniMax ${message}`));

  it('redacts auth secrets from raw diagnostics', () => {
    vi.stubEnv('MINIMAX_API_KEY', 'sk-cp-test-secret');
    expect(redactAuthSecrets('Authorization: Bearer sk-cp-test-secret')).toBe('Authorization: Bearer [redacted]');
    expect(miniMaxError('401 sk-cp-test-secret')).not.toContain('sk-cp-test-secret');
  });
});
