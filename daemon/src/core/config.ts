import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ActiveHoursConfig {
  start: number;   // Hour 0-23 (e.g., 23 = 11pm)
  end: number;     // Hour 0-23 (e.g., 7 = 7am)
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  wakeTime?: string;  // HH:MM — when to send morning report
}

export interface CloudLLMConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
}

export interface LocalLLMConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
}

export interface CopilotLLMConfig {
  githubToken: string;    // GitHub PAT with models:read scope
  model: string;          // e.g., "openai/gpt-4.1" — all models accessed via Copilot
}

/**
 * Five-tier model routing.
 * Each tier uses a different provider/model combination optimized for its purpose:
 *   background → mindless tasks, simple operations — local/free
 *   chat       → understanding, conversing, organising — mid-tier
 *   planning   → planning, approach breakdown — codex/reasoning
 *   coding     → implementation — premium coder
 *   review     → code review — codex/reasoning
 */
export type LLMTierProvider = 'local' | 'copilot' | 'cloud' | 'openai';

export interface LLMTierConfig {
  provider: LLMTierProvider;
  model: string;
  fallback?: {             // Optional fallback — used when primary provider is unavailable
    provider: LLMTierProvider;
    model: string;
  };
}

export interface LLMTiers {
  background: LLMTierConfig;  // Mindless background tasks (local Ollama, fallback to cheap Copilot)
  chat: LLMTierConfig;        // Understanding, conversing, organising (Codex 5.3)
  planning: LLMTierConfig;    // Planning, breaking down approaches (Opus 4.6)
  coding: LLMTierConfig;      // Implementation (Codex 5.3)
  review: LLMTierConfig;      // Code review (Codex 5.3)
}

export interface OpenAIOAuthConfig {
  apiKey: string;              // Exchanged API key (use this for OpenAI API calls)
  accessToken: string;         // OAuth access token
  refreshToken: string;        // For auto-refresh when expired
  idToken: string;             // ID token (for API key re-exchange)
  expires: number;             // Epoch ms when tokens expire
  accountId: string;           // OpenAI account ID from JWT claims
}

export interface LLMConfig {
  githubToken?: string;          // Shared GitHub PAT for all copilot tiers
  openaiApiKey?: string;         // Direct OpenAI API key (for openai provider)
  openaiOAuth?: OpenAIOAuthConfig; // ChatGPT subscription OAuth tokens
  local?: LocalLLMConfig;        // Ollama/local model config
  cloud?: CloudLLMConfig;        // Direct cloud API config (fallback)
  copilot?: CopilotLLMConfig;    // Legacy single-tier config (still supported)
  tiers?: LLMTiers;              // Three-tier model routing
}

export interface BudgetConfig {
  perNight: number;    // Max spend per session in currency units
  globalCap?: number;  // Absolute lifetime cap — hard stop across all sessions
  currency: string;    // e.g., "GBP", "USD"
}

export interface WorkspaceConfig {
  repoPath: string;     // Absolute path to the target repo
  branch: string;       // Branch to commit verified work to
}

export interface ApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  bearerToken?: string;
}

export interface DaemonConfig {
  activeHours: ActiveHoursConfig;
  timezone: string;
  budget: BudgetConfig;
  telegram: TelegramConfig;
  llm: LLMConfig;
  workspace?: WorkspaceConfig;    // Optional — projects managed via Telegram/DB
  heartbeatMinutes?: number;      // Default: 15
  api?: ApiConfig;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class ConfigError extends Error {
  readonly code = 'CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  const aliases: Record<string, string> = {
    'openai/gpt-5.3-codex': 'openai/gpt-5',
    'gpt-5.3-codex': 'gpt-5',
  };
  return aliases[trimmed] ?? trimmed;
}

function assertString(obj: Record<string, unknown>, path: string): string {
  const value = obj[path];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function assertNumber(obj: Record<string, unknown>, path: string): number {
  const value = obj[path];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${path} must be a finite number`);
  }
  return value;
}

function validateActiveHours(raw: unknown): ActiveHoursConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('activeHours must be an object with start and end');
  }
  const obj = raw as Record<string, unknown>;
  const start = assertNumber(obj, 'start');
  const end = assertNumber(obj, 'end');
  if (start < 0 || start > 23 || end < 0 || end > 23) {
    throw new ConfigError('activeHours start/end must be 0-23');
  }
  return { start, end };
}

function validateTelegram(raw: unknown): TelegramConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('telegram must be an object with botToken and chatId');
  }
  const obj = raw as Record<string, unknown>;
  return {
    botToken: assertString(obj, 'botToken'),
    chatId: assertString(obj, 'chatId'),
    wakeTime: typeof obj['wakeTime'] === 'string' ? obj['wakeTime'] : undefined,
  };
}

function validateCloudLLM(raw: unknown): CloudLLMConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('llm.cloud must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const provider = assertString(obj, 'provider');
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new ConfigError('llm.cloud.provider must be "anthropic" or "openai"');
  }
  return {
    provider,
    apiKey: assertString(obj, 'apiKey'),
    model: assertString(obj, 'model'),
  };
}

function validateCopilotLLM(raw: unknown): CopilotLLMConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (!obj['githubToken'] || !obj['model']) return undefined;
  return {
    githubToken: assertString(obj, 'githubToken'),
    model: normalizeModelId(assertString(obj, 'model')),
  };
}

function validateLLM(raw: unknown): LLMConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('llm must be an object with tiers, copilot, or cloud config');
  }
  const obj = raw as Record<string, unknown>;

  const githubToken = typeof obj['githubToken'] === 'string' ? obj['githubToken'] : undefined;
  const copilot = validateCopilotLLM(obj['copilot']);
  const hasCloud = obj['cloud'] && typeof obj['cloud'] === 'object';
  const hasTiers = obj['tiers'] && typeof obj['tiers'] === 'object';

  // Must have at least one LLM source
  const openaiApiKey = typeof obj['openaiApiKey'] === 'string' ? obj['openaiApiKey'] : undefined;
  const hasOpenaiOAuth = obj['openaiOAuth'] && typeof obj['openaiOAuth'] === 'object';
  if (!copilot && !hasCloud && !hasTiers && !githubToken && !openaiApiKey && !hasOpenaiOAuth) {
    throw new ConfigError('llm must have tiers, copilot, cloud, githubToken, or openai config');
  }

  let tiers: LLMTiers | undefined;
  if (hasTiers) {
    const t = obj['tiers'] as Record<string, unknown>;
    tiers = {
      background: validateTierConfig(t['background'], 'background'),
      chat: validateTierConfig(t['chat'], 'chat'),
      planning: validateTierConfig(t['planning'], 'planning'),
      coding: validateTierConfig(t['coding'], 'coding'),
      review: validateTierConfig(t['review'], 'review'),
    };
  }

  // Parse OpenAI OAuth credentials
  let openaiOAuth: OpenAIOAuthConfig | undefined;
  if (hasOpenaiOAuth) {
    const o = obj['openaiOAuth'] as Record<string, unknown>;
    openaiOAuth = {
      apiKey: typeof o['apiKey'] === 'string' ? o['apiKey'] : '',
      accessToken: typeof o['accessToken'] === 'string' ? o['accessToken'] : '',
      refreshToken: typeof o['refreshToken'] === 'string' ? o['refreshToken'] : '',
      idToken: typeof o['idToken'] === 'string' ? o['idToken'] : '',
      expires: typeof o['expires'] === 'number' ? o['expires'] : 0,
      accountId: typeof o['accountId'] === 'string' ? o['accountId'] : '',
    };
  }

  return {
    githubToken,
    openaiApiKey,
    openaiOAuth,
    copilot,
    cloud: hasCloud ? validateCloudLLM(obj['cloud']) : undefined,
    tiers,
  };
}

function validateTierConfig(raw: unknown, tierName: string): LLMTierConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError(`llm.tiers.${tierName} must be an object with provider and model`);
  }
  const obj = raw as Record<string, unknown>;
  const provider = assertString(obj, 'provider') as LLMTierProvider;
  if (!['local', 'copilot', 'cloud', 'openai'].includes(provider)) {
    throw new ConfigError(`llm.tiers.${tierName}.provider must be local, copilot, cloud, or openai`);
  }

  let fallback: LLMTierConfig['fallback'];
  if (obj['fallback'] && typeof obj['fallback'] === 'object') {
    const fb = obj['fallback'] as Record<string, unknown>;
    const fbProvider = assertString(fb, 'provider') as LLMTierProvider;
    if (!['local', 'copilot', 'cloud', 'openai'].includes(fbProvider)) {
      throw new ConfigError(`llm.tiers.${tierName}.fallback.provider must be local, copilot, cloud, or openai`);
    }
    fallback = { provider: fbProvider, model: normalizeModelId(assertString(fb, 'model')) };
  }

  return {
    provider,
    model: normalizeModelId(assertString(obj, 'model')),
    fallback,
  };
}

function validateBudget(raw: unknown): BudgetConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('budget must be an object with perNight and currency');
  }
  const obj = raw as Record<string, unknown>;
  const perNight = assertNumber(obj, 'perNight');
  if (perNight <= 0) {
    throw new ConfigError('budget.perNight must be greater than 0');
  }
  return {
    perNight,
    currency: assertString(obj, 'currency'),
  };
}

function validateWorkspace(raw: unknown): WorkspaceConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('workspace must be an object with repoPath and branch');
  }
  const obj = raw as Record<string, unknown>;
  const repoPath = assertString(obj, 'repoPath');
  if (!existsSync(repoPath)) {
    throw new ConfigError(`workspace.repoPath does not exist: ${repoPath}`);
  }
  return {
    repoPath,
    branch: assertString(obj, 'branch'),
  };
}

function validateApi(raw: unknown): ApiConfig {
  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('api must be an object when provided');
  }
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj['enabled'] === 'boolean' ? obj['enabled'] : true;
  const host = typeof obj['host'] === 'string' && obj['host'].trim().length > 0
    ? obj['host']
    : '127.0.0.1';
  const port = typeof obj['port'] === 'number' ? obj['port'] : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('api.port must be an integer between 1 and 65535');
  }
  const bearerToken = typeof obj['bearerToken'] === 'string' && obj['bearerToken'].trim().length > 0
    ? obj['bearerToken']
    : undefined;
  return { enabled, host, port, bearerToken };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Default config file location: ~/.mother-brain-daemon/config.json */
export function defaultConfigPath(): string {
  return join(homedir(), '.mother-brain-daemon', 'config.json');
}

/**
 * Load and validate configuration from a JSON file.
 * Fails fast with clear error messages on invalid config.
 */
export function loadConfig(configPath: string, logger: Logger): DaemonConfig {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `Config file not found: ${configPath}\n` +
      `Create it at ${defaultConfigPath()} or pass --config <path>`
    );
  }

  let raw: unknown;
  try {
    // Tolerate UTF-8 BOM to avoid config parse failures from some editors/tools.
    const text = readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Failed to parse config file: ${configPath} — ${error}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new ConfigError('Config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  const config: DaemonConfig = {
    activeHours: validateActiveHours(obj['activeHours']),
    timezone: assertString(obj as Record<string, unknown>, 'timezone'),
    budget: validateBudget(obj['budget']),
    telegram: validateTelegram(obj['telegram']),
    llm: validateLLM(obj['llm']),
    workspace: obj['workspace'] ? validateWorkspace(obj['workspace']) : undefined,
    heartbeatMinutes: typeof obj['heartbeatMinutes'] === 'number' ? obj['heartbeatMinutes'] : 15,
    api: obj['api'] ? validateApi(obj['api']) : undefined,
  };

  logger.info({ configPath }, 'Configuration loaded and validated');
  return config;
}
