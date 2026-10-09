import type { Tool, ToolResult } from '../types.js';
import { getBrowserOperatorRuntime } from './browser-operator.js';
import { waitForOtpCode } from './inbox-otp.js';

const SENSITIVE_WEB_RE = /\b(payment|checkout|bank|billing|wire|crypto|wallet|card|paypal|stripe)\b/i;

export interface WebAuthToolOptions {
  resolveSecret?: (key: string) => string | null | Promise<string | null>;
  requestSecret?: (key: string, context?: string) => void | Promise<void>;
}

function isSensitiveAuthFlow(url: string): boolean {
  return SENSITIVE_WEB_RE.test(url.toLowerCase());
}

function hostSecretPrefix(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  } catch {
    return 'GENERIC_WEB';
  }
}

function parseSecretReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('env:')) return trimmed.slice(4).trim().toUpperCase();
  if (trimmed.startsWith('secret:')) return trimmed.slice(7).trim().toUpperCase();
  return null;
}

async function lookupSecretValue(
  key: string,
  resolver?: WebAuthToolOptions['resolveSecret'],
): Promise<string | null> {
  const envValue = process.env[key];
  if (envValue && envValue.trim().length > 0) return envValue;
  if (!resolver) return null;
  const resolved = await resolver(key);
  return resolved && resolved.trim().length > 0 ? resolved : null;
}

async function resolveCredential(
  rawValue: string,
  fallbackKey: string,
  options: WebAuthToolOptions,
  context: string,
): Promise<string> {
  const trimmed = rawValue.trim();
  const secretRef = parseSecretReference(trimmed);
  if (secretRef) {
    const resolved = await lookupSecretValue(secretRef, options.resolveSecret);
    if (!resolved) {
      await options.requestSecret?.(secretRef, context);
      throw new Error(`CREDENTIAL_REQUIRED:${secretRef}`);
    }
    return resolved;
  }

  if (trimmed.length > 0) return trimmed;

  const fallback = await lookupSecretValue(fallbackKey, options.resolveSecret);
  if (!fallback) {
    await options.requestSecret?.(fallbackKey, context);
    throw new Error(`CREDENTIAL_REQUIRED:${fallbackKey}`);
  }
  return fallback;
}

export function createWebAuthFlowTool(options: WebAuthToolOptions = {}): Tool {
  return {
    name: 'web_auth_flow',
    description:
      'Run an authenticated browser login flow with optional OTP retrieval. Supports persistent browser sessions and secret fallback keys.',
    inputSchema: {
      parameters: {
        url: { type: 'string', description: 'Login URL', required: true },
        sessionId: { type: 'string', description: 'Existing browser session id (optional)', required: false },
        username: {
          type: 'string',
          description: 'Username/email literal, env:VAR, secret:KEY, or omitted to use host default key',
          required: false,
        },
        password: {
          type: 'string',
          description: 'Password literal, env:VAR, secret:KEY, or omitted to use host default key',
          required: false,
        },
        usernameSelector: { type: 'string', description: 'CSS selector for username input', required: true },
        passwordSelector: { type: 'string', description: 'CSS selector for password input', required: true },
        submitSelector: { type: 'string', description: 'Optional CSS selector for submit button', required: false },
        otpSelector: { type: 'string', description: 'Optional CSS selector for OTP input', required: false },
        otpSource: {
          type: 'string',
          description: 'OTP source when otpSelector is provided: env | file | command',
          required: false,
          enum: ['env', 'file', 'command'],
        },
        otpEnvVar: { type: 'string', description: 'Env var name for otpSource=env', required: false },
        otpFilePath: { type: 'string', description: 'File path for otpSource=file', required: false },
        otpCommand: { type: 'string', description: 'Command for otpSource=command', required: false },
        otpTimeoutMs: { type: 'number', description: 'Timeout for waiting OTP', required: false },
        otpRegex: { type: 'string', description: 'Regex to extract OTP code', required: false },
        headless: { type: 'boolean', description: 'Headless mode when opening a new session', required: false },
        allowSensitive: { type: 'boolean', description: 'Allow login flows on sensitive financial domains', required: false },
      },
    },
    riskLevel: 'high',
    builtin: true,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const started = Date.now();
      try {
        const url = String(params['url'] ?? '').trim();
        if (!url) throw new Error('url is required');

        const allowSensitive = params['allowSensitive'] === true;
        if (isSensitiveAuthFlow(url) && !allowSensitive) {
          throw new Error(
            'Sensitive auth flow blocked by policy. Re-run with allowSensitive=true if explicitly approved.',
          );
        }

        const usernameSelector = String(params['usernameSelector'] ?? '').trim();
        const passwordSelector = String(params['passwordSelector'] ?? '').trim();
        if (!usernameSelector || !passwordSelector) {
          throw new Error('usernameSelector and passwordSelector are required');
        }

        const prefix = hostSecretPrefix(url);
        const usernameKey = `WEB_${prefix}_USERNAME`;
        const passwordKey = `WEB_${prefix}_PASSWORD`;

        const usernameRaw = typeof params['username'] === 'string' ? params['username'] : '';
        const passwordRaw = typeof params['password'] === 'string' ? params['password'] : '';

        const username = await resolveCredential(
          usernameRaw,
          usernameKey,
          options,
          `Login username required for ${url}`,
        );
        const password = await resolveCredential(
          passwordRaw,
          passwordKey,
          options,
          `Login password required for ${url}`,
        );

        const runtime = getBrowserOperatorRuntime();
        const session = await runtime.openSession({
          sessionId: typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined,
          startUrl: url,
          headless: typeof params['headless'] === 'boolean' ? params['headless'] : undefined,
        });

        await session.page.waitForSelector(usernameSelector, { timeout: 30_000 });
        await session.page.fill(usernameSelector, '');
        await session.page.type(usernameSelector, username, { delay: 22 });

        await session.page.waitForSelector(passwordSelector, { timeout: 30_000 });
        await session.page.fill(passwordSelector, '');
        await session.page.type(passwordSelector, password, { delay: 18 });

        const submitSelector = typeof params['submitSelector'] === 'string' ? params['submitSelector'].trim() : '';
        if (submitSelector) {
          await session.page.click(submitSelector, { timeout: 15_000 });
        } else {
          await session.page.keyboard.press('Enter');
        }

        let otpUsed = false;
        const otpSelector = typeof params['otpSelector'] === 'string' ? params['otpSelector'].trim() : '';
        if (otpSelector) {
          await session.page.waitForSelector(otpSelector, { timeout: 45_000 });
          const otpSource = (typeof params['otpSource'] === 'string' ? params['otpSource'] : 'env') as 'env' | 'file' | 'command';
          const otp = await waitForOtpCode({
            source: otpSource,
            timeoutMs: typeof params['otpTimeoutMs'] === 'number' ? params['otpTimeoutMs'] : 180_000,
            codeRegex: typeof params['otpRegex'] === 'string' ? params['otpRegex'] : undefined,
            envVar: typeof params['otpEnvVar'] === 'string' ? params['otpEnvVar'] : undefined,
            filePath: typeof params['otpFilePath'] === 'string' ? params['otpFilePath'] : undefined,
            command: typeof params['otpCommand'] === 'string' ? params['otpCommand'] : undefined,
            clearAfterRead: false,
          });

          await session.page.fill(otpSelector, '');
          await session.page.type(otpSelector, otp.code, { delay: 28 });
          await session.page.keyboard.press('Enter');
          otpUsed = true;
        }

        await session.page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});

        return {
          success: true,
          output: {
            sessionId: session.id,
            currentUrl: session.page.url(),
            title: await session.page.title(),
            otpUsed,
            status: 'submitted',
            credentialKeysTried: { usernameKey, passwordKey },
          },
          durationMs: Date.now() - started,
        };
      } catch (error) {
        return {
          success: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        };
      }
    },
  };
}

export const webAuthFlowTool: Tool = createWebAuthFlowTool();

