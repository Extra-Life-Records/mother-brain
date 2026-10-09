import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { ensureDataDir } from '../../core/logger.js';
import type { Tool, ToolResult } from '../types.js';

const CHROMIUM_PATH = process.platform === 'linux' ? '/usr/bin/chromium' : undefined;
const PROFILE_ROOT = join(ensureDataDir(), 'browser-profiles');
const SCREENSHOT_ROOT = join(ensureDataDir(), 'artifacts', 'screenshots');

type BrowserOperatorAction =
  | 'open_session'
  | 'list_sessions'
  | 'close_session'
  | 'goto'
  | 'click'
  | 'type'
  | 'press'
  | 'wait_for'
  | 'extract_text'
  | 'screenshot'
  | 'current_url'
  | 'storage_state';

export interface SessionRecord {
  id: string;
  context: BrowserContext;
  page: Page;
  profileDir: string;
  createdAt: string;
  updatedAt: string;
}

export class BrowserOperatorRuntime {
  private sessions = new Map<string, SessionRecord>();

  constructor() {
    if (!existsSync(PROFILE_ROOT)) mkdirSync(PROFILE_ROOT, { recursive: true });
    if (!existsSync(SCREENSHOT_ROOT)) mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  }

  async openSession(input: { sessionId?: string; startUrl?: string; headless?: boolean }): Promise<SessionRecord> {
    const sessionId = input.sessionId?.trim().length ? input.sessionId.trim() : randomUUID().slice(0, 8);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      if (input.startUrl) {
        await existing.page.goto(input.startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
      return existing;
    }

    const profileDir = join(PROFILE_ROOT, sessionId);
    if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROMIUM_PATH,
      headless: input.headless ?? true,
      viewport: { width: 1366, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
      ],
    });

    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(30_000);
    if (input.startUrl) {
      await page.goto(input.startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }

    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: sessionId,
      context,
      page,
      profileDir,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  listSessions(): Array<{
    sessionId: string;
    currentUrl: string;
    title: string;
    profileDir: string;
    createdAt: string;
    updatedAt: string;
  }> {
    return Array.from(this.sessions.values()).map((session) => ({
      sessionId: session.id,
      currentUrl: safeUrl(session.page),
      title: safeTitle(session.page),
      profileDir: session.profileDir,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }));
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.context.close();
    this.sessions.delete(sessionId);
    return true;
  }

  getSession(sessionId: string): SessionRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.updatedAt = new Date().toISOString();
    return session;
  }

  async disposeAll(): Promise<void> {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of all) {
      await session.context.close().catch(() => {});
    }
  }
}

const runtime = new BrowserOperatorRuntime();

process.once('beforeExit', () => {
  void runtime.disposeAll();
});

function requireSession(params: Record<string, unknown>): SessionRecord {
  const sessionId = String(params['sessionId'] ?? '').trim();
  if (!sessionId) {
    throw new Error('sessionId is required for this action');
  }
  const session = runtime.getSession(sessionId);
  if (!session) {
    throw new Error(`Browser session not found: ${sessionId}. Call action=open_session first.`);
  }
  return session;
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function resolveScreenshotPath(pathLike: string | undefined, sessionId: string): string {
  if (pathLike && pathLike.trim().length > 0) {
    return isAbsolute(pathLike) ? pathLike : resolve(pathLike);
  }
  const filename = `session-${sessionId}-${Date.now()}.png`;
  return join(SCREENSHOT_ROOT, filename);
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function safeTitle(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

export function getBrowserOperatorRuntime(): BrowserOperatorRuntime {
  return runtime;
}

export const browserOperatorTool: Tool = {
  name: 'browser_operator',
  description:
    'Operate a persistent Chromium session like a user: open session, navigate, click, type, wait, extract content, screenshot, and save storage state.',
  inputSchema: {
    parameters: {
      action: {
        type: 'string',
        description:
          'Action: open_session | list_sessions | close_session | goto | click | type | press | wait_for | extract_text | screenshot | current_url | storage_state',
        required: true,
        enum: [
          'open_session', 'list_sessions', 'close_session', 'goto', 'click', 'type', 'press',
          'wait_for', 'extract_text', 'screenshot', 'current_url', 'storage_state',
        ],
      },
      sessionId: { type: 'string', description: 'Browser session id', required: false },
      url: { type: 'string', description: 'URL to navigate to', required: false },
      selector: { type: 'string', description: 'CSS selector for the action', required: false },
      text: { type: 'string', description: 'Text to type', required: false },
      key: { type: 'string', description: 'Keyboard key to press (for action=press)', required: false },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds', required: false },
      clear: { type: 'boolean', description: 'Whether to clear input before typing', required: false },
      delayMs: { type: 'number', description: 'Per-character typing delay in ms', required: false },
      fullPage: { type: 'boolean', description: 'Take full-page screenshot', required: false },
      path: { type: 'string', description: 'File path for screenshot/storage_state', required: false },
      headless: { type: 'boolean', description: 'Headless mode for open_session', required: false },
    },
  },
  riskLevel: 'high',
  builtin: true,

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const start = Date.now();
    try {
      const action = String(params['action'] ?? '') as BrowserOperatorAction;
      const timeoutMs = coerceNumber(params['timeoutMs'], 30_000);

      switch (action) {
        case 'open_session': {
          const opened = await runtime.openSession({
            sessionId: typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined,
            startUrl: typeof params['url'] === 'string' ? params['url'] : undefined,
            headless: typeof params['headless'] === 'boolean' ? params['headless'] : undefined,
          });
          return {
            success: true,
            output: {
              sessionId: opened.id,
              profileDir: opened.profileDir,
              currentUrl: safeUrl(opened.page),
              createdAt: opened.createdAt,
            },
            durationMs: Date.now() - start,
          };
        }
        case 'list_sessions':
          return { success: true, output: { items: runtime.listSessions() }, durationMs: Date.now() - start };
        case 'close_session': {
          const sessionId = String(params['sessionId'] ?? '').trim();
          if (!sessionId) throw new Error('sessionId is required for close_session');
          const closed = await runtime.closeSession(sessionId);
          return { success: true, output: { sessionId, closed }, durationMs: Date.now() - start };
        }
        case 'goto': {
          const session = requireSession(params);
          const url = String(params['url'] ?? '').trim();
          if (!url) throw new Error('url is required for goto');
          await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          return {
            success: true,
            output: { sessionId: session.id, currentUrl: session.page.url(), title: await session.page.title() },
            durationMs: Date.now() - start,
          };
        }
        case 'click': {
          const session = requireSession(params);
          const selector = String(params['selector'] ?? '').trim();
          if (!selector) throw new Error('selector is required for click');
          await session.page.click(selector, { timeout: timeoutMs });
          return { success: true, output: { sessionId: session.id, clicked: selector }, durationMs: Date.now() - start };
        }
        case 'type': {
          const session = requireSession(params);
          const selector = String(params['selector'] ?? '').trim();
          const text = String(params['text'] ?? '');
          if (!selector) throw new Error('selector is required for type');
          const clear = params['clear'] !== false;
          const delayMs = coerceNumber(params['delayMs'], 20);
          await session.page.waitForSelector(selector, { timeout: timeoutMs });
          if (clear) {
            await session.page.fill(selector, '');
          }
          await session.page.type(selector, text, { delay: delayMs });
          return {
            success: true,
            output: { sessionId: session.id, selector, charsTyped: text.length, clear, delayMs },
            durationMs: Date.now() - start,
          };
        }
        case 'press': {
          const session = requireSession(params);
          const key = String(params['key'] ?? 'Enter');
          const selector = typeof params['selector'] === 'string' ? params['selector'].trim() : '';
          if (selector) {
            await session.page.press(selector, key, { timeout: timeoutMs });
          } else {
            await session.page.keyboard.press(key);
          }
          return { success: true, output: { sessionId: session.id, key, selector: selector || null }, durationMs: Date.now() - start };
        }
        case 'wait_for': {
          const session = requireSession(params);
          const selector = String(params['selector'] ?? '').trim();
          if (!selector) throw new Error('selector is required for wait_for');
          await session.page.waitForSelector(selector, { timeout: timeoutMs });
          return { success: true, output: { sessionId: session.id, selector, ready: true }, durationMs: Date.now() - start };
        }
        case 'extract_text': {
          const session = requireSession(params);
          const selector = typeof params['selector'] === 'string' ? params['selector'].trim() : '';
          let text = '';
          if (selector) {
            const locator = session.page.locator(selector).first();
            text = (await locator.innerText({ timeout: timeoutMs })).trim();
          } else {
            text = (await session.page.evaluate(() => document.body?.innerText ?? '')).trim();
          }
          return {
            success: true,
            output: {
              sessionId: session.id,
              selector: selector || null,
              text: text.slice(0, 10_000),
              chars: text.length,
            },
            durationMs: Date.now() - start,
          };
        }
        case 'screenshot': {
          const session = requireSession(params);
          const fullPage = params['fullPage'] === true;
          const outputPath = resolveScreenshotPath(
            typeof params['path'] === 'string' ? params['path'] : undefined,
            session.id,
          );
          const buffer = await session.page.screenshot({ fullPage, type: 'png' });
          await writeFile(outputPath, buffer);
          return {
            success: true,
            output: { sessionId: session.id, path: outputPath, bytes: buffer.byteLength, fullPage },
            durationMs: Date.now() - start,
          };
        }
        case 'current_url': {
          const session = requireSession(params);
          return {
            success: true,
            output: { sessionId: session.id, currentUrl: session.page.url(), title: await session.page.title() },
            durationMs: Date.now() - start,
          };
        }
        case 'storage_state': {
          const session = requireSession(params);
          const outputPath = isAbsolute(String(params['path'] ?? ''))
            ? String(params['path'])
            : join(PROFILE_ROOT, `${session.id}-storage.json`);
          await session.context.storageState({ path: outputPath });
          return {
            success: true,
            output: { sessionId: session.id, path: outputPath },
            durationMs: Date.now() - start,
          };
        }
        default:
          throw new Error(`Unsupported browser_operator action: ${String(action)}`);
      }
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
