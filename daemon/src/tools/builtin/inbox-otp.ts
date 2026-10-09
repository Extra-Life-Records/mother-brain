import { exec as execCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ensureDataDir } from '../../core/logger.js';
import type { Tool, ToolResult } from '../types.js';

const exec = promisify(execCb);

export type OtpSource = 'env' | 'file' | 'command';

export interface WaitForOtpInput {
  source: OtpSource;
  timeoutMs?: number;
  pollMs?: number;
  codeRegex?: string;
  envVar?: string;
  filePath?: string;
  command?: string;
  clearAfterRead?: boolean;
}

export interface WaitForOtpResult {
  code: string;
  source: OtpSource;
  matchedTextSnippet: string;
  elapsedMs: number;
}

const DEFAULT_OTP_REGEX = '\\b(\\d{6})\\b';

export async function waitForOtpCode(input: WaitForOtpInput): Promise<WaitForOtpResult> {
  const source = input.source;
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 120_000;
  const pollMs = typeof input.pollMs === 'number' ? input.pollMs : 3_000;
  const regex = compileOtpRegex(input.codeRegex ?? DEFAULT_OTP_REGEX);
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    const payload = await readOtpPayload(source, input);
    const matched = extractLatestOtp(payload, regex);
    if (matched) {
      if (source === 'file' && input.clearAfterRead) {
        const filePath = resolveInboxFilePath(input.filePath);
        await writeFile(filePath, '', 'utf-8').catch(() => {});
      }
      if (source === 'env' && input.clearAfterRead) {
        const envVar = input.envVar?.trim() || 'MB_OTP_CODE';
        delete process.env[envVar];
      }
      return {
        code: matched,
        source,
        matchedTextSnippet: payload.slice(-220),
        elapsedMs: Date.now() - start,
      };
    }
    await sleep(pollMs);
  }

  throw new Error(`OTP code not found within ${timeoutMs}ms from source=${source}`);
}

function compileOtpRegex(input: string): RegExp {
  try {
    return new RegExp(input, 'g');
  } catch {
    return new RegExp(DEFAULT_OTP_REGEX, 'g');
  }
}

async function readOtpPayload(source: OtpSource, input: WaitForOtpInput): Promise<string> {
  switch (source) {
    case 'env': {
      const envVar = input.envVar?.trim() || 'MB_OTP_CODE';
      return process.env[envVar] ?? '';
    }
    case 'file': {
      const path = resolveInboxFilePath(input.filePath);
      if (!existsSync(path)) return '';
      return await readFile(path, 'utf-8');
    }
    case 'command': {
      const command = input.command?.trim() || process.env['MB_INBOX_FETCH_CMD']?.trim();
      if (!command) return '';
      try {
        const { stdout, stderr } = await exec(command, { timeout: 20_000, maxBuffer: 512 * 1024 });
        return `${stdout}\n${stderr}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return message;
      }
    }
    default:
      return '';
  }
}

function extractLatestOtp(payload: string, regex: RegExp): string | null {
  let match: RegExpExecArray | null = null;
  let latest: string | null = null;
  while ((match = regex.exec(payload)) !== null) {
    const group = match[1] ?? match[0];
    if (group && group.trim().length > 0) latest = group.trim();
  }
  return latest;
}

function resolveInboxFilePath(inputPath?: string): string {
  const fallback = join(ensureDataDir(), 'otp-inbox.txt');
  const raw = inputPath?.trim();
  if (!raw) return fallback;
  return isAbsolute(raw) ? raw : resolve(raw);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export const inboxOtpWaitTool: Tool = {
  name: 'inbox_otp_wait',
  description:
    'Wait for a one-time code from env/file/command inbox adapters. Use this for email/SMS OTP handoffs during authenticated browser flows.',
  inputSchema: {
    parameters: {
      source: {
        type: 'string',
        description: 'OTP source adapter: env | file | command',
        required: true,
        enum: ['env', 'file', 'command'],
      },
      timeoutMs: { type: 'number', description: 'Total time to wait for OTP code', required: false },
      pollMs: { type: 'number', description: 'Polling interval in milliseconds', required: false },
      codeRegex: { type: 'string', description: 'Regex pattern with capture group for OTP code', required: false },
      envVar: { type: 'string', description: 'Env var name when source=env', required: false },
      filePath: { type: 'string', description: 'Inbox file path when source=file', required: false },
      command: { type: 'string', description: 'Command that returns inbox content when source=command', required: false },
      clearAfterRead: { type: 'boolean', description: 'Clear source payload after reading OTP', required: false },
    },
  },
  riskLevel: 'medium',
  builtin: true,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    try {
      const source = String(params['source'] ?? '').trim().toLowerCase() as OtpSource;
      if (!['env', 'file', 'command'].includes(source)) {
        throw new Error('source must be one of: env, file, command');
      }

      const result = await waitForOtpCode({
        source,
        timeoutMs: typeof params['timeoutMs'] === 'number' ? params['timeoutMs'] : undefined,
        pollMs: typeof params['pollMs'] === 'number' ? params['pollMs'] : undefined,
        codeRegex: typeof params['codeRegex'] === 'string' ? params['codeRegex'] : undefined,
        envVar: typeof params['envVar'] === 'string' ? params['envVar'] : undefined,
        filePath: typeof params['filePath'] === 'string' ? params['filePath'] : undefined,
        command: typeof params['command'] === 'string' ? params['command'] : undefined,
        clearAfterRead: params['clearAfterRead'] === true,
      });

      return {
        success: true,
        output: result,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    }
  },
};
