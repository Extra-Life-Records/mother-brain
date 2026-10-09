import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { AutoPublishInput, AutoPublishResult } from '../tasks/index.js';

type HostingProvider = 'vercel' | 'netlify' | 'cloudflare_pages';

interface DeployTarget {
  deployDir: string;
  sourcePath: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface DeployAttempt {
  ok: boolean;
  url?: string;
  reason?: string;
}

const WEBSITE_TASK_RE = /\b(website|web\s*site|landing\s*page|homepage|portfolio|blog|static\s*site|web\s*app)\b/i;
const WEBSITE_FILE_RE = /\.(html?|css|js|json)$/i;

export class AutoPublisher {
  constructor(private logger: Logger) {}

  async publishIfNeeded(input: AutoPublishInput): Promise<AutoPublishResult | null> {
    if (!isAutoPublishEnabled()) return null;

    const candidatePaths = extractCandidatePaths(input);
    if (!looksLikeWebsiteTask(input, candidatePaths)) return null;

    const target = await resolveDeployTarget(candidatePaths);
    if (!target) {
      return blockedResult(
        'No deployable web artifact found. Expected an HTML file or directory with index.html.',
      );
    }

    const providerOrder = resolveProviderOrder();
    const blockedReasons: string[] = [];

    for (const provider of providerOrder) {
      const readiness = await this.checkProviderReadiness(provider);
      if (!readiness.ready) {
        blockedReasons.push(`${provider}: ${readiness.reason}`);
        continue;
      }

      const attempt = await this.deployWithProvider(provider, target);
      if (attempt.ok && attempt.url) {
        return {
          artifacts: [
            { type: 'link', label: `Published site (${provider})`, value: attempt.url },
            { type: 'text', label: 'publish_provider', value: provider },
            { type: 'text', label: 'publish_url', value: attempt.url },
          ],
          evidenceNote: `Published to ${provider}: ${attempt.url}`,
        };
      }

      blockedReasons.push(`${provider}: ${attempt.reason ?? 'unknown deployment error'}`);
    }

    const setupHint = providerSetupHint();
    const reason = blockedReasons.length > 0
      ? `${blockedReasons.join(' | ')}. ${setupHint}`
      : `No hosting providers are configured. ${setupHint}`;
    return blockedResult(reason);
  }

  private async checkProviderReadiness(provider: HostingProvider): Promise<{ ready: boolean; reason?: string }> {
    switch (provider) {
      case 'vercel': {
        if (!resolveToken('VERCEL_TOKEN')) return { ready: false, reason: 'missing VERCEL_TOKEN' };
        const command = resolveCommand('MB_HOSTING_VERCEL_CMD', 'vercel');
        const installed = await commandAvailable(command);
        return installed ? { ready: true } : { ready: false, reason: `${command} not installed` };
      }
      case 'netlify': {
        if (!resolveToken('NETLIFY_AUTH_TOKEN')) return { ready: false, reason: 'missing NETLIFY_AUTH_TOKEN' };
        if (!resolveToken('NETLIFY_SITE_ID')) return { ready: false, reason: 'missing NETLIFY_SITE_ID' };
        const command = resolveCommand('MB_HOSTING_NETLIFY_CMD', 'netlify');
        const installed = await commandAvailable(command);
        return installed ? { ready: true } : { ready: false, reason: `${command} not installed` };
      }
      case 'cloudflare_pages': {
        if (!resolveToken('CLOUDFLARE_API_TOKEN')) return { ready: false, reason: 'missing CLOUDFLARE_API_TOKEN' };
        const project = resolveToken('CLOUDFLARE_PAGES_PROJECT') ?? resolveToken('CLOUDFLARE_PAGES_PROJECT_NAME');
        if (!project) return { ready: false, reason: 'missing CLOUDFLARE_PAGES_PROJECT' };
        const command = resolveCommand('MB_HOSTING_CLOUDFLARE_CMD', 'wrangler');
        const installed = await commandAvailable(command);
        return installed ? { ready: true } : { ready: false, reason: `${command} not installed` };
      }
      default:
        return { ready: false, reason: 'unknown provider' };
    }
  }

  private async deployWithProvider(provider: HostingProvider, target: DeployTarget): Promise<DeployAttempt> {
    try {
      switch (provider) {
        case 'vercel':
          return await deployWithVercel(target, this.logger);
        case 'netlify':
          return await deployWithNetlify(target, this.logger);
        case 'cloudflare_pages':
          return await deployWithCloudflarePages(target, this.logger);
        default:
          return { ok: false, reason: 'unsupported provider' };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ provider, error: message }, 'Auto-publish provider attempt failed');
      return { ok: false, reason: message };
    }
  }
}

function resolveProviderOrder(): HostingProvider[] {
  const defaultOrder: HostingProvider[] = ['vercel', 'netlify', 'cloudflare_pages'];
  const preferred = (process.env['MB_HOSTING_DEFAULT_PROVIDER'] ?? '').trim().toLowerCase();
  if (preferred === 'off') return [];

  if (preferred === 'vercel' || preferred === 'netlify' || preferred === 'cloudflare_pages') {
    return [preferred, ...defaultOrder.filter((item) => item !== preferred)];
  }

  return defaultOrder;
}

function isAutoPublishEnabled(): boolean {
  const mode = (process.env['MB_HOSTING_MODE'] ?? 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === 'disabled') return false;

  const flag = (process.env['MB_HOSTING_AUTO_PUBLISH'] ?? '1').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  return true;
}

function looksLikeWebsiteTask(input: AutoPublishInput, candidatePaths: string[]): boolean {
  const combined = `${input.task.title} ${input.plan.goal}`;
  if (WEBSITE_TASK_RE.test(combined)) return true;

  if (candidatePaths.some((item) => /\.(html?|css|js)$/i.test(item))) return true;

  for (const step of input.plan.steps) {
    if (step.tool !== 'file_write') continue;
    const path = step.args['path'];
    if (typeof path === 'string' && WEBSITE_FILE_RE.test(path)) return true;
  }

  return false;
}

function extractCandidatePaths(input: AutoPublishInput): string[] {
  const ordered = new Set<string>();

  for (const artifact of input.artifacts) {
    if (artifact.type === 'file' && artifact.value.trim().length > 0) {
      ordered.add(artifact.value.trim());
      continue;
    }

    if (artifact.type !== 'json') continue;
    try {
      const parsed = JSON.parse(artifact.value) as Record<string, unknown>;
      const path = parsed['path'];
      if (typeof path === 'string' && path.trim().length > 0) {
        ordered.add(path.trim());
      }
    } catch {
      // Ignore malformed JSON artifacts.
    }
  }

  for (const step of input.plan.steps) {
    if (step.tool !== 'file_write') continue;
    const path = step.args['path'];
    if (typeof path === 'string' && path.trim().length > 0) {
      ordered.add(path.trim());
    }
  }

  return Array.from(ordered);
}

async function resolveDeployTarget(paths: string[]): Promise<DeployTarget | null> {
  const resolved = paths
    .map((item) => resolve(item))
    .filter((item, index, all) => all.indexOf(item) === index);

  for (const candidate of resolved) {
    const info = await tryStat(candidate);
    if (!info?.isDirectory()) continue;
    if (await hasIndexHtml(candidate)) {
      return { deployDir: candidate, sourcePath: candidate };
    }
  }

  for (const candidate of resolved) {
    const info = await tryStat(candidate);
    if (!info?.isFile()) continue;
    if (!isHtmlFile(candidate)) continue;
    if (basename(candidate).toLowerCase() === 'index.html') {
      return { deployDir: dirname(candidate), sourcePath: candidate };
    }
  }

  for (const candidate of resolved) {
    const info = await tryStat(candidate);
    if (!info?.isFile()) continue;
    if (!isHtmlFile(candidate)) continue;
    const tempDir = await mkdtemp(join(tmpdir(), 'mb-publish-'));
    await copyFile(candidate, join(tempDir, 'index.html'));
    return { deployDir: tempDir, sourcePath: candidate };
  }

  for (const candidate of resolved) {
    const info = await tryStat(candidate);
    if (!info?.isDirectory()) continue;
    return { deployDir: candidate, sourcePath: candidate };
  }

  return null;
}

async function deployWithVercel(target: DeployTarget, logger: Logger): Promise<DeployAttempt> {
  const token = resolveToken('VERCEL_TOKEN');
  if (!token) return { ok: false, reason: 'missing VERCEL_TOKEN' };

  const command = resolveCommand('MB_HOSTING_VERCEL_CMD', 'vercel');
  const args = ['deploy', '--prod', '--yes', '--token', token];

  const scope = resolveToken('VERCEL_SCOPE') ?? resolveToken('VERCEL_TEAM_ID');
  if (scope) args.push('--scope', scope);

  const projectName = resolveToken('VERCEL_PROJECT_NAME');
  if (projectName) args.push('--name', projectName);

  logger.info({ provider: 'vercel', deployDir: target.deployDir, sourcePath: target.sourcePath }, 'Auto-publish attempt');
  const result = await runCommand(command, args, { cwd: target.deployDir, timeoutMs: 240_000 });
  if (result.exitCode !== 0) {
    return { ok: false, reason: compactCommandError(result) };
  }

  const url = extractUrl(result.stdout + '\n' + result.stderr, /\.vercel\.app/i);
  return url ? { ok: true, url } : { ok: false, reason: 'deploy succeeded but URL was not detected in Vercel output' };
}

async function deployWithNetlify(target: DeployTarget, logger: Logger): Promise<DeployAttempt> {
  const token = resolveToken('NETLIFY_AUTH_TOKEN');
  const siteId = resolveToken('NETLIFY_SITE_ID');
  if (!token || !siteId) {
    return { ok: false, reason: 'missing NETLIFY_AUTH_TOKEN or NETLIFY_SITE_ID' };
  }

  const command = resolveCommand('MB_HOSTING_NETLIFY_CMD', 'netlify');
  const args = ['deploy', '--prod', '--dir', target.deployDir, '--auth', token, '--site', siteId, '--json'];

  logger.info({ provider: 'netlify', deployDir: target.deployDir, sourcePath: target.sourcePath }, 'Auto-publish attempt');
  const result = await runCommand(command, args, { cwd: target.deployDir, timeoutMs: 240_000 });
  if (result.exitCode !== 0) {
    return { ok: false, reason: compactCommandError(result) };
  }

  const out = `${result.stdout}\n${result.stderr}`;
  const url = extractUrlFromJson(out, ['ssl_url', 'deploy_ssl_url', 'url']) ?? extractUrl(out, /netlify\.app/i);
  return url ? { ok: true, url } : { ok: false, reason: 'deploy succeeded but URL was not detected in Netlify output' };
}

async function deployWithCloudflarePages(target: DeployTarget, logger: Logger): Promise<DeployAttempt> {
  const token = resolveToken('CLOUDFLARE_API_TOKEN');
  const project = resolveToken('CLOUDFLARE_PAGES_PROJECT') ?? resolveToken('CLOUDFLARE_PAGES_PROJECT_NAME');
  if (!token || !project) {
    return { ok: false, reason: 'missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_PAGES_PROJECT' };
  }

  const command = resolveCommand('MB_HOSTING_CLOUDFLARE_CMD', 'wrangler');
  const branch = resolveToken('CLOUDFLARE_PAGES_BRANCH') ?? 'main';
  const args = ['pages', 'deploy', target.deployDir, '--project-name', project, '--branch', branch];

  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
  };
  const accountId = resolveToken('CLOUDFLARE_ACCOUNT_ID');
  if (accountId) env['CLOUDFLARE_ACCOUNT_ID'] = accountId;

  logger.info({ provider: 'cloudflare_pages', deployDir: target.deployDir, sourcePath: target.sourcePath }, 'Auto-publish attempt');
  const result = await runCommand(command, args, { cwd: target.deployDir, env, timeoutMs: 240_000 });
  if (result.exitCode !== 0) {
    return { ok: false, reason: compactCommandError(result) };
  }

  const url = extractUrl(result.stdout + '\n' + result.stderr, /\.pages\.dev/i);
  return url ? { ok: true, url } : { ok: false, reason: 'deploy succeeded but URL was not detected in Cloudflare output' };
}

function providerSetupHint(): string {
  return (
    'Set provider credentials and CLI. ' +
    'Vercel: VERCEL_TOKEN + vercel CLI. ' +
    'Netlify: NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID + netlify CLI. ' +
    'Cloudflare: CLOUDFLARE_API_TOKEN + CLOUDFLARE_PAGES_PROJECT + wrangler CLI.'
  );
}

function blockedResult(reason: string): AutoPublishResult {
  return {
    artifacts: [{ type: 'text', label: 'publish_blocked', value: reason.slice(0, 2000) }],
    evidenceNote: `Publish blocked: ${reason}`,
  };
}

function resolveToken(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveCommand(envName: string, defaultValue: string): string {
  const override = process.env[envName]?.trim();
  return override && override.length > 0 ? override : defaultValue;
}

function isHtmlFile(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === '.html' || extension === '.htm';
}

async function tryStat(path: string): Promise<import('node:fs').Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function hasIndexHtml(dir: string): Promise<boolean> {
  try {
    await access(join(dir, 'index.html'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  const result = await runCommand(command, ['--version'], { timeoutMs: 10_000 });
  if (result.error && result.error.toLowerCase().includes('enoent')) return false;
  return result.exitCode === 0 || result.stdout.length > 0 || result.stderr.length > 0;
}

function extractUrl(text: string, preferredHostPattern?: RegExp): string | undefined {
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  if (matches.length === 0) return undefined;
  if (preferredHostPattern) {
    const preferred = matches.find((item) => preferredHostPattern.test(item));
    if (preferred) return preferred;
  }
  return matches[0];
}

function extractUrlFromJson(text: string, keys: string[]): string | undefined {
  const block = text.match(/\{[\s\S]*\}/);
  if (!block) return undefined;
  try {
    const parsed = JSON.parse(block[0]) as Record<string, unknown>;
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
    }
  } catch {
    // Ignore invalid JSON block.
  }
  return undefined;
}

function compactCommandError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr.slice(0, 300);
  const stdout = result.stdout.trim();
  if (stdout.length > 0) return stdout.slice(0, 300);
  const error = result.error?.trim();
  return error ? error.slice(0, 300) : `command exited with code ${result.exitCode}`;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;

  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish({ exitCode: 1, stdout, stderr, error: error.message });
    });

    child.on('close', (code) => {
      finish({ exitCode: code ?? 1, stdout, stderr });
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        exitCode: 124,
        stdout,
        stderr,
        error: `command timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });
}
