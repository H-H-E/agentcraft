// How the agents authenticate with Claude.
//
// Default: API authentication, the way Anthropic's Agent SDK docs require for third-party tools:
// ANTHROPIC_API_KEY, or a cloud provider (Amazon Bedrock, Google Vertex, Microsoft Foundry, Claude
// Platform on AWS). The user's claude.ai login (the `claude` CLI's subscription/OAuth session) is
// only used when explicitly opted into with --use-claude-login, for one's own personal use:
// "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
// login or rate limits for their products" (https://code.claude.com/docs/en/agent-sdk/overview).

/** Env switches the Agent SDK / Claude Code CLI read to use a cloud provider instead of the Claude API. */
export const PROVIDER_SWITCHES: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: 'Amazon Bedrock',
  CLAUDE_CODE_USE_VERTEX: 'Google Vertex AI',
  CLAUDE_CODE_USE_FOUNDRY: 'Microsoft Foundry',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: 'Claude Platform on AWS',
};

/** Variables that carry a claude.ai (subscription) login into the CLI; removed unless opted in. */
export const CLAUDE_LOGIN_VARS = ['CLAUDE_CODE_OAUTH_TOKEN'];

export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic';
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3';
export type InferenceProvider = 'anthropic' | 'minimax';

/** Keep Claude aliases internal when reusing an existing config in MiniMax mode. */
export function miniMaxModel(model: string, fallback: string): string {
  return /^(opus|sonnet|haiku)(\[1m\])?$/i.test(model) ? fallback : model;
}

/** Validate without echoing a URL that might accidentally contain a credential. */
export function validateMiniMaxBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return value.replace(/\/+$/, '');
  } catch {
    throw new Error('MINIMAX_BASE_URL must be an HTTP(S) URL without credentials, query parameters or a fragment.');
  }
}

/** Only the child SDK environment is adapted; never mutate process.env or store a key in config. */
export function withMiniMax(env: Record<string, string | undefined>, baseUrl: string, model: string): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of [...Object.keys(PROVIDER_SWITCHES), ...CLAUDE_LOGIN_VARS, 'ANTHROPIC_API_KEY', 'MINIMAX_API_KEY', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT']) delete out[k];
  out.ANTHROPIC_AUTH_TOKEN = env.MINIMAX_API_KEY?.trim() || undefined;
  out.ANTHROPIC_BASE_URL = baseUrl;
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) out[k] = model;
  return out;
}

/** SDK errors/stderr may echo credentials. Redact before logs, status or state see them. */
export function redactAuthSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const k of ['MINIMAX_API_KEY', 'COMMANDCODE_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', ...CLAUDE_LOGIN_VARS]) {
    const secret = env[k]?.trim();
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

export const isAuthenticationFailure = (message: string): boolean => /authentication|not logged in|invalid[_ ]api[_ ]key|oauth|\b401\b|\b403\b|credential/i.test(message);

/** Do not mistake a model/quota/network failure for a request to log in to Claude. */
export function miniMaxError(message: string): string {
  const safe = redactAuthSecrets(message);
  const kind = isAuthenticationFailure(safe) ? 'authentication rejected. Check MINIMAX_API_KEY'
    : /429|rate[_ -]?limit|quota|billing|balance|credit|exhaust/i.test(safe) ? 'rate limit or quota exhausted. Check your Coding/Token Plan limits'
    : /404|model.*(not found|unavailable|unsupported|does not exist)|selected model|unknown model|invalid model/i.test(safe) ? 'model or endpoint unavailable. Check MINIMAX_MODEL and MINIMAX_BASE_URL'
    : /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|unreachable|timed out|connection/i.test(safe) ? 'endpoint unreachable. Check MINIMAX_BASE_URL and your network'
    : 'request failed';
  return `MiniMax ${kind}: ${safe}`;
}

export type ApiAuth = { ok: true; source: string } | { ok: false };

const truthy = (v: string | undefined) => !!v && v !== '0' && v.toLowerCase() !== 'false';

/** Which API authentication the environment provides, if any. */
export function detectApiAuth(env: NodeJS.ProcessEnv = process.env): ApiAuth {
  if (env.ANTHROPIC_API_KEY?.trim()) return { ok: true, source: 'API key' };
  for (const [k, name] of Object.entries(PROVIDER_SWITCHES)) if (truthy(env[k])) return { ok: true, source: name };
  if (env.ANTHROPIC_AUTH_TOKEN?.trim() && env.ANTHROPIC_BASE_URL?.trim()) return { ok: true, source: 'API gateway' };
  return { ok: false };
}

/**
 * The environment for agent CLI processes: in API mode, no claude.ai login token is passed on (the
 * CLI then authenticates with the key/provider); with --use-claude-login it is left untouched.
 */
export function withAuthMode(env: Record<string, string | undefined>, useClaudeLogin: boolean): Record<string, string | undefined> {
  if (useClaudeLogin) return env;
  const out = { ...env };
  for (const k of CLAUDE_LOGIN_VARS) delete out[k];
  return out;
}

export const NO_API_AUTH_MESSAGE =
  'No Claude API key. Set ANTHROPIC_API_KEY (from console.anthropic.com) or a cloud provider ' +
  '(CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY), then restart the Foreman. For your own personal ' +
  'use only, --use-claude-login uses your claude.ai login instead. The sim backend works without either.';
