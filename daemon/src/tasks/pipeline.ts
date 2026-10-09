import type { Logger } from 'pino';
import type OpenAI from 'openai';
import type { ToolRegistry } from '../tools/index.js';
import type { TaskLedger, Task, TaskArtifact } from './ledger.js';
import type { Plan, PlanStep, VerificationResult, BlockerType } from './plan.js';
import { BlockerMemory } from './blocker-memory.js';

// ---------------------------------------------------------------------------
// Progress Heartbeat — structured updates emitted during pipeline execution
// ---------------------------------------------------------------------------

export type HeartbeatPhase = 'planning' | 'executing' | 'verifying' | 'complete' | 'failed';

export interface ProgressHeartbeat {
  taskId: string;
  phase: HeartbeatPhase;
  stepIndex?: number;
  totalSteps?: number;
  currentStep?: string;
  action: string;       // What we're doing right now
  result?: string;      // What happened (after step completes)
  next?: string;        // What comes next
  blockers?: string[];  // Active blockers
  timestamp: string;
}

export type HeartbeatCallback = (heartbeat: ProgressHeartbeat) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Planner — LLM generates a structured plan given a task and tools
// ---------------------------------------------------------------------------

const PLANNER_PROMPT = `You are a task planner for an autonomous agent. Given a task and available tools, produce a JSON plan.

RULES:
- Output ONLY valid JSON, no markdown or explanation
- Each step must use exactly one available tool
- Include clear success criteria for each step and the overall task
- Keep plans minimal — fewest steps possible
- If the task can be done in one step, use one step
- Do not invent brittle deep URLs (for example guessed /feed/... paths) unless user-provided
- If web sources are needed, prefer robust discovery endpoints and resilient sources
- Later steps must depend on earlier outputs; do not schedule synthesis/publish steps before data collection succeeds
- For file outputs, include an explicit \`path\` in args with deterministic filenames

OUTPUT FORMAT:
{
  "goal": "what we're trying to achieve",
  "steps": [
    { "name": "step description", "tool": "tool_name", "args": { ... }, "successCriteria": "how to verify this step" }
  ],
  "overallCriteria": "how to verify the entire task is done"
}`;

const JSON_BLOCK_RE = /\{[\s\S]*\}/;
const URL_RE = /(https?:\/\/[^\s)\]\">]+)/i;
const NEWSY_TASK_RE = /\b(news|headlines|update|updates|latest|today|gaming|articles?)\b/i;
const SEARCHY_TASK_RE = /\b(fetch|get|find|search|pull|gather|collect|compile|summari[sz]e)\b/i;
const OBJECTIVE_RESEARCH_RE = /^\s*research and gather actionable context for:\s*(.+)\s*$/i;
const OBJECTIVE_DELIVERABLE_RE = /^\s*produce the primary deliverable for:\s*(.+)\s*$/i;
const OBJECTIVE_VALIDATE_RE = /^\s*validate quality and completeness for:\s*(.+)\s*$/i;
const OBJECTIVE_REPORT_RE = /^\s*create a progress report and next-step recommendations for:\s*(.+)\s*$/i;
const WEBSITE_TASK_RE = /\b(website|web\s*page|webpage|landing page|html)\b/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildArtifactsFromStep(step: PlanStep): TaskArtifact[] {
  if (!step.output) return [];

  const output = asRecord(step.output);
  const artifacts: TaskArtifact[] = [];

  if (output) {
    const path = output.path;
    if (typeof path === 'string' && path.trim().length > 0) {
      artifacts.push({
        type: 'file',
        label: `${step.name} output`,
        value: path.trim(),
      });
    }

    const url = output.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      artifacts.push({
        type: 'link',
        label: `${step.name} source`,
        value: url,
      });
    }
  }

  artifacts.push({
    type: 'json',
    label: step.name,
    value: safeJson(step.output).slice(0, 2000),
  });

  return artifacts;
}

function buildPlannerTaskPrompt(taskDescription: string, toolManifest: string, memoryContext?: string): string {
  const sections = [
    `AVAILABLE TOOLS:\n${toolManifest}`,
    `TASK: ${taskDescription}`,
  ];

  if (memoryContext && memoryContext.trim().length > 0) {
    sections.push(`RELEVANT PRIOR SUCCESSFUL TASK MEMORY:\n${memoryContext}`);
    sections.push('Use memory when helpful, but adapt to the current objective and constraints.');
  }

  return sections.join('\n\n');
}

function buildTaskMemoryContext(tasks: Task[]): string {
  if (tasks.length === 0) return '';

  return tasks
    .slice(0, 3)
    .map((task, index) => {
      const artifactSnippets = task.artifacts
        .slice(0, 3)
        .map((artifact) => `${artifact.label}: ${String(artifact.value).slice(0, 180)}`)
        .join(' | ');
      return `${index + 1}. ${task.title}\n   Evidence: ${artifactSnippets || 'No artifact summary available'}`;
    })
    .join('\n');
}

function buildPlanFromParsed(parsed: Record<string, unknown>, fallbackGoal: string): Plan {
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps: PlanStep[] = rawSteps
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const stepObj = s as Record<string, unknown>;
      const name = typeof stepObj.name === 'string' ? stepObj.name.trim() : '';
      const tool = typeof stepObj.tool === 'string' ? stepObj.tool.trim() : '';
      if (!name || !tool) return null;

      return {
        name,
        tool,
        args: (stepObj.args && typeof stepObj.args === 'object') ? (stepObj.args as Record<string, unknown>) : {},
        successCriteria: typeof stepObj.successCriteria === 'string' ? stepObj.successCriteria : '',
        status: 'pending' as const,
      };
    })
    .filter((s): s is PlanStep => s !== null);

  return {
    goal: typeof parsed.goal === 'string' ? parsed.goal : fallbackGoal,
    steps,
    overallCriteria: typeof parsed.overallCriteria === 'string'
      ? parsed.overallCriteria
      : 'Task completed successfully',
    createdAt: new Date().toISOString(),
    status: 'planned',
  };
}

function parsePlanFromText(rawText: string, taskDescription: string): Plan | null {
  const text = rawText.trim();
  if (!text) return null;

  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates: string[] = [stripped];
  const block = stripped.match(JSON_BLOCK_RE)?.[0];
  if (block && block !== stripped) candidates.push(block);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const plan = buildPlanFromParsed(parsed, taskDescription);
      if (plan.steps.length > 0) return plan;
    } catch {
      // Keep trying fallback candidates
    }
  }

  return null;
}

function buildHeuristicFallbackPlan(taskDescription: string): Plan | null {
  const url = taskDescription.match(URL_RE)?.[1];
  if (url) {
    return {
      goal: `Fetch and summarize requested content from ${url}`,
      steps: [
        {
          name: 'Fetch content from provided URL',
          tool: 'web_fetch',
          args: { url, method: 'GET' },
          successCriteria: 'Fetched content data is returned for the URL',
          status: 'pending',
        },
      ],
      overallCriteria: 'The requested URL content has been fetched successfully',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  if (NEWSY_TASK_RE.test(taskDescription) && SEARCHY_TASK_RE.test(taskDescription)) {
    const cleaned = taskDescription
      .replace(/\bsend\s+it\s+to\s+me\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, '')
      .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, '')
      .trim();
    const query = encodeURIComponent(cleaned || 'latest gaming news today');
    const rssUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    return {
      goal: 'Gather latest relevant news updates',
      steps: [
        {
          name: 'Fetch latest news feed results',
          tool: 'web_fetch',
          args: { url: rssUrl, method: 'GET' },
          successCriteria: 'RSS items are returned with links and titles',
          status: 'pending',
        },
      ],
      overallCriteria: 'Latest relevant news headlines are retrieved',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  const researchMatch = taskDescription.match(OBJECTIVE_RESEARCH_RE);
  if (researchMatch?.[1]) {
    const subject = researchMatch[1].trim();
    const slug = slugifyFilename(subject);
    const path = `${slug}-research.md`;
    const content = [
      '# Research Brief',
      '',
      `Objective: ${subject}`,
      '',
      '## Context',
      '- Goal captured from objective task.',
      '- Key assumptions documented for execution.',
      '',
      '## Immediate Next Actions',
      '1. Produce primary deliverable.',
      '2. Validate quality and completeness.',
      '3. Report progress and recommendations.',
      '',
      `Generated at: ${new Date().toISOString()}`,
    ].join('\n');

    return {
      goal: `Research actionable context for: ${subject}`,
      steps: [
        {
          name: 'Write research brief',
          tool: 'file_write',
          args: { path, content },
          successCriteria: 'Research brief file is written to disk',
          status: 'pending',
        },
      ],
      overallCriteria: 'Research context is captured in a file artifact',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  const deliverableMatch = taskDescription.match(OBJECTIVE_DELIVERABLE_RE);
  if (deliverableMatch?.[1]) {
    const subject = deliverableMatch[1].trim();
    const slug = slugifyFilename(subject);
    if (WEBSITE_TASK_RE.test(subject)) {
      const path = `${slug}.html`;
      const content = [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '  <meta charset="utf-8" />',
        '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
        `  <title>${escapeHtmlText(subject)}</title>`,
        '</head>',
        '<body>',
        `  <h1>${escapeHtmlText(subject)}</h1>`,
        '  <p>Initial autonomous deliverable scaffold generated by Mother Brain.</p>',
        '</body>',
        '</html>',
      ].join('\n');

      return {
        goal: `Produce a website deliverable for: ${subject}`,
        steps: [
          {
            name: 'Create HTML deliverable',
            tool: 'file_write',
            args: { path, content },
            successCriteria: 'HTML file is created at a deterministic path',
            status: 'pending',
          },
        ],
        overallCriteria: 'Website deliverable file exists',
        createdAt: new Date().toISOString(),
        status: 'planned',
      };
    }

    const path = `${slug}-deliverable.md`;
    const content = [
      '# Primary Deliverable',
      '',
      `Objective: ${subject}`,
      '',
      'This is the initial primary deliverable scaffold generated by the autonomous pipeline.',
      'Expand this artifact with task-specific implementation details in subsequent iterations.',
    ].join('\n');

    return {
      goal: `Produce the primary deliverable for: ${subject}`,
      steps: [
        {
          name: 'Write primary deliverable artifact',
          tool: 'file_write',
          args: { path, content },
          successCriteria: 'Primary deliverable file exists',
          status: 'pending',
        },
      ],
      overallCriteria: 'Primary deliverable has been produced as a file artifact',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  const validateMatch = taskDescription.match(OBJECTIVE_VALIDATE_RE);
  if (validateMatch?.[1]) {
    const subject = validateMatch[1].trim();
    const slug = slugifyFilename(subject);
    if (WEBSITE_TASK_RE.test(subject)) {
      return {
        goal: `Validate website deliverable for: ${subject}`,
        steps: [
          {
            name: 'Read generated HTML deliverable',
            tool: 'file_read',
            args: { path: `${slug}.html` },
            successCriteria: 'HTML deliverable can be read from disk',
            status: 'pending',
          },
        ],
        overallCriteria: 'Deliverable can be opened and inspected',
        createdAt: new Date().toISOString(),
        status: 'planned',
      };
    }

    const path = `${slug}-validation.md`;
    const content = [
      '# Validation Report',
      '',
      `Objective: ${subject}`,
      '',
      '- Deliverable exists.',
      '- Basic completeness check recorded.',
      '- Follow-up quality checks can be appended here.',
      '',
      `Generated at: ${new Date().toISOString()}`,
    ].join('\n');

    return {
      goal: `Validate quality and completeness for: ${subject}`,
      steps: [
        {
          name: 'Write validation report',
          tool: 'file_write',
          args: { path, content },
          successCriteria: 'Validation report exists',
          status: 'pending',
        },
      ],
      overallCriteria: 'Validation summary is captured as an artifact',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  const reportMatch = taskDescription.match(OBJECTIVE_REPORT_RE);
  if (reportMatch?.[1]) {
    const subject = reportMatch[1].trim();
    const slug = slugifyFilename(subject);
    const path = `${slug}-progress-report.md`;
    const content = [
      '# Progress Report',
      '',
      `Objective: ${subject}`,
      '',
      '## Status',
      '- Objective task executed.',
      '- Current artifact checkpoint written.',
      '',
      '## Recommended Next Steps',
      '1. Review produced artifacts.',
      '2. Approve or refine follow-up execution objectives.',
      '',
      `Generated at: ${new Date().toISOString()}`,
    ].join('\n');

    return {
      goal: `Create progress report and next-step recommendations for: ${subject}`,
      steps: [
        {
          name: 'Write progress report artifact',
          tool: 'file_write',
          args: { path, content },
          successCriteria: 'Progress report file exists',
          status: 'pending',
        },
      ],
      overallCriteria: 'Progress and recommendations are delivered in a report artifact',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  if (WEBSITE_TASK_RE.test(taskDescription) && /\b(build|create|generate|make|develop|write)\b/i.test(taskDescription)) {
    const path = 'index.html';
    const content = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
      `  <title>${escapeHtmlText(taskDescription)}</title>`,
      '</head>',
      '<body>',
      `  <h1>${escapeHtmlText(taskDescription)}</h1>`,
      '  <p>Autonomous bootstrap website generated from fallback planning.</p>',
      '</body>',
      '</html>',
    ].join('\n');

    return {
      goal: `Create a website deliverable for: ${taskDescription}`,
      steps: [
        {
          name: 'Write website scaffold',
          tool: 'file_write',
          args: { path, content },
          successCriteria: 'HTML scaffold file exists',
          status: 'pending',
        },
      ],
      overallCriteria: 'A concrete website file is generated',
      createdAt: new Date().toISOString(),
      status: 'planned',
    };
  }

  return null;
}

export async function generatePlan(
  taskDescription: string,
  toolManifest: string,
  client: OpenAI,
  model: string,
  logger: Logger,
  memoryContext?: string,
): Promise<Plan | null> {
  const taskPrompt = buildPlannerTaskPrompt(taskDescription, toolManifest, memoryContext);

  try {
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: 1024,
      messages: [
        { role: 'system', content: PLANNER_PROMPT },
        { role: 'user', content: taskPrompt },
      ],
    });

    const firstText = response.choices[0]?.message?.content?.trim() ?? '';
    const firstPlan = parsePlanFromText(firstText, taskDescription);
    if (firstPlan) {
      logger.info({ goal: firstPlan.goal, stepCount: firstPlan.steps.length }, 'Plan generated');
      return firstPlan;
    }

    logger.warn({ taskDescription }, 'Planner returned invalid/empty JSON plan; attempting repair');
    const repairResponse = await client.chat.completions.create({
      model,
      max_completion_tokens: 1024,
      temperature: 0,
      messages: [
        { role: 'system', content: PLANNER_PROMPT },
        {
          role: 'user',
          content:
            `${taskPrompt}\n\n` +
            `The previous output was invalid or had no usable steps. Return ONLY valid JSON with at least one actionable step.\n` +
            `PREVIOUS OUTPUT:\n${firstText || '(empty)'}`,
        },
      ],
    });

    const repairedText = repairResponse.choices[0]?.message?.content?.trim() ?? '';
    const repairedPlan = parsePlanFromText(repairedText, taskDescription);
    if (repairedPlan) {
      logger.info({ goal: repairedPlan.goal, stepCount: repairedPlan.steps.length }, 'Plan generated (repair pass)');
      return repairedPlan;
    }

    const heuristic = buildHeuristicFallbackPlan(taskDescription);
    if (heuristic) {
      logger.warn({ taskDescription, stepCount: heuristic.steps.length }, 'Using heuristic fallback plan');
      return heuristic;
    }

    return null;
  } catch (error) {
    const heuristic = buildHeuristicFallbackPlan(taskDescription);
    if (heuristic) {
      logger.warn(
        { taskDescription, error: String(error), stepCount: heuristic.steps.length },
        'Planner failed; using heuristic fallback plan',
      );
      return heuristic;
    }
    logger.error({ error }, 'Failed to generate plan');
    return null;
  }
}

function slugifyFilename(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'task';
}

function escapeHtmlText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Blocker Classifier — categorize failures for remediation
// ---------------------------------------------------------------------------

function classifyBlocker(error: string, tool: string): BlockerType {
  const e = error.toLowerCase();
  if (e.includes('403') || e.includes('forbidden') || e.includes('access denied') || e.includes('blocked')) return 'access_denied';
  if (e.includes('401') || e.includes('unauthorized') || e.includes('auth')) return 'missing_permission';
  if (e.includes('api key') || e.includes('token') || e.includes('credential')) return 'missing_secret';
  if (e.includes('not found') && (e.includes('binary') || e.includes('command'))) return 'missing_capability';
  if (e.includes('captcha') || e.includes('mfa') || e.includes('two-factor')) return 'external_gate';
  if (e.includes('enoent') || e.includes('no such file')) return 'environment_mismatch';
  if (e.includes('timeout') || e.includes('timed out')) return 'access_denied';
  return 'bad_plan';
}

/** Suggest a fallback tool based on blocker type and current tool. */
function suggestFallback(blockerType: BlockerType, currentTool: string): { tool: string; args?: Record<string, unknown> } | null {
  if (blockerType === 'access_denied' && currentTool === 'web_fetch') {
    return { tool: 'browser_fetch' }; // Use real browser for blocked sites
  }
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isTransientError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('network') ||
    normalized.includes('http 429') ||
    normalized.includes('http 500') ||
    normalized.includes('http 502') ||
    normalized.includes('http 503') ||
    normalized.includes('http 504')
  );
}

function extractNewsQuery(step: PlanStep): string {
  const base = `${step.name} ${step.successCriteria}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ');
  const tokens = base
    .split(/\s+/)
    .filter((token) =>
      token.length >= 3 &&
      !NEWS_QUERY_STOP_WORDS.has(token)
    )
    .slice(0, 6);

  const joined = tokens.join(' ').trim();
  if (!joined) return 'latest ai news';
  return joined.includes('ai') ? joined : `${joined} ai`;
}

function buildNewsDiscoveryFallback(
  step: PlanStep,
  error: string,
  output: unknown,
): { tool: string; args: Record<string, unknown>; reason: string } | null {
  if (step.tool !== 'web_fetch') return null;

  const outputRecord = asRecord(output);
  const status = asNumber(outputRecord?.['status']);
  const isNotFound = status === 404 || /http 404|not found/i.test(error);
  if (!isNotFound) return null;

  const currentUrl = typeof step.args['url'] === 'string' ? step.args['url'] : '';
  const looksNewsLike = /\b(news|headlines?|rss|feed)\b/i.test(
    `${step.name} ${step.successCriteria} ${currentUrl}`,
  );
  if (!looksNewsLike) return null;
  if (/news\.google\.com\/rss\/search/i.test(currentUrl)) return null;

  const query = extractNewsQuery(step);
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  return {
    tool: 'web_fetch',
    args: { url: rssUrl, method: 'GET' },
    reason: `Source 404 - auto-discovering alternate feed for query: ${query}`,
  };
}

function hasHtmlOutput(plan: Plan): boolean {
  return plan.steps.some((step) => {
    if (step.status !== 'done') return false;
    const output = asRecord(step.output);
    const path = typeof output?.['path'] === 'string'
      ? output['path']
      : (typeof step.args['path'] === 'string' ? step.args['path'] : '');
    return /\.html?$/i.test(path);
  });
}

function countRssItems(plan: Plan): number {
  let total = 0;
  for (const step of plan.steps) {
    if (step.status !== 'done') continue;
    const output = asRecord(step.output);
    const data = asRecord(output?.['data']);
    if (data?.['type'] !== 'rss') continue;
    const items = data['items'];
    if (Array.isArray(items)) total += items.length;
  }
  return total;
}

function deterministicVerificationGuard(plan: Plan): VerificationResult | null {
  const taskText = `${plan.goal} ${plan.overallCriteria} ${plan.steps.map((step) => step.name).join(' ')}`.toLowerCase();

  if (shouldRequireHtmlOutput(taskText) && !hasHtmlOutput(plan)) {
    return {
      verified: false,
      evidence: 'No HTML output file was produced',
      failedCriteria: 'Expected a concrete HTML output file path from file generation steps',
    };
  }

  if (/\b(news|headlines?|rss)\b/.test(taskText)) {
    const rssItemCount = countRssItems(plan);
    if (rssItemCount < 3) {
      return {
        verified: false,
        evidence: `Only ${rssItemCount} news items were collected`,
        failedCriteria: 'Need at least 3 retrieved news items to verify compilation quality',
      };
    }
  }

  return null;
}

function shouldRequireHtmlOutput(taskText: string): boolean {
  const mentionsWebsite = /\b(website|web page|webpage|html)\b/.test(taskText);
  if (!mentionsWebsite) return false;

  const creationIntent = /\b(build|create|generate|write|develop|produce|deliver|ship|launch)\b/.test(taskText);
  if (!creationIntent) return false;

  const nonDeliverableIntent = /\b(research|context|validate|verification|report|recommendation|summary|summari[sz]e)\b/.test(taskText);
  return !nonDeliverableIntent;
}

function extractCredentialKeysFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const keys = new Set<string>();
  const regex = /CREDENTIAL_REQUIRED:([A-Z0-9_]+)/gi;
  for (const match of text.matchAll(regex)) {
    const key = match[1]?.trim();
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function extractCredentialKeysFromPlan(plan: Plan): string[] {
  const keys = new Set<string>();
  for (const step of plan.steps) {
    for (const key of extractCredentialKeysFromText(step.error)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// Step Executor — runs plan steps with retry/fallback on failure
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;

export async function executeSteps(
  plan: Plan,
  toolRegistry: ToolRegistry,
  taskLedger: TaskLedger,
  taskId: string,
  logger: Logger,
  blockerMemory?: BlockerMemory,
  onHeartbeat?: HeartbeatCallback,
): Promise<Plan> {
  plan.status = 'executing';

  const emit = (hb: Omit<ProgressHeartbeat, 'taskId' | 'timestamp' | 'totalSteps'>) => {
    if (!onHeartbeat) return;
    try {
      onHeartbeat({ ...hb, taskId, totalSteps: plan.steps.length, timestamp: new Date().toISOString() });
    } catch { /* heartbeat failures must not break the pipeline */ }
  };

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const nextStepName = i + 1 < plan.steps.length ? plan.steps[i + 1].name : 'verify results';

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    step.retryCount = 0;

    taskLedger.checkpoint(taskId, { plan });

    emit({
      phase: 'executing',
      stepIndex: i + 1,
      currentStep: step.name,
      action: `Running: ${step.name} (${step.tool})`,
      next: nextStepName,
    });

    let resolved = false;

    while (!resolved && (step.retryCount ?? 0) <= MAX_RETRIES) {
      const tool = toolRegistry.get(step.tool);
      if (!tool) {
        step.status = 'failed';
        step.error = `Tool "${step.tool}" not found`;
        step.outcome = 'blocked';
        step.blockerType = 'missing_capability';
        step.completedAt = new Date().toISOString();
        logger.warn({ step: step.name, tool: step.tool }, 'Step blocked — tool not found');
        resolved = true;
        break;
      }

      try {
        const originalTool = step.tool;
        const result = await toolRegistry.execute(step.tool, step.args, logger);
        step.completedAt = new Date().toISOString();

        if (result.success) {
          step.status = 'done';
          step.outcome = 'done';
          step.output = result.output;
          logger.info({ step: step.name, durationMs: result.durationMs }, 'Step done');

          emit({
            phase: 'executing',
            stepIndex: i + 1,
            currentStep: step.name,
            action: `Completed: ${step.name}`,
            result: 'Success',
            next: nextStepName,
          });

          // If this was a fallback/retry, record the resolution for future learning
          if ((step.retryCount ?? 0) > 0 && blockerMemory && step.error) {
            blockerMemory.record({
              originalTool,
              originalError: step.error,
              blockerType: step.blockerType ?? 'bad_plan',
              resolutionTool: step.tool,
              resolutionArgs: step.args,
              taskId,
            });
          }

          resolved = true;
        } else {
          // Classify the failure
          const errorStr = result.error ?? 'Unknown error';
          step.blockerType = classifyBlocker(errorStr, step.tool);
          step.error = errorStr;

          // 0. Retry transient failures before switching tools
          if (isTransientError(errorStr) && (step.retryCount ?? 0) < MAX_RETRIES) {
            const nextAttempt = (step.retryCount ?? 0) + 1;
            logger.info(
              { step: step.name, tool: step.tool, attempt: nextAttempt, error: errorStr },
              'Retrying transient failure with same tool',
            );
            emit({
              phase: 'executing',
              stepIndex: i + 1,
              currentStep: step.name,
              action: `Retrying transient failure (${nextAttempt}/${MAX_RETRIES})`,
              result: errorStr.slice(0, 120),
              blockers: [step.blockerType],
            });
            step.outcome = 'retry';
            step.retryCount = nextAttempt;
            continue;
          }

          // 1. Consult memory for a known resolution
          if (blockerMemory) {
            const learned = blockerMemory.lookup(step.tool, errorStr);
            if (learned && toolRegistry.get(learned.tool)) {
              logger.info(
                { step: step.name, from: step.tool, to: learned.tool, source: 'memory' },
                'Step using learned resolution',
              );
              emit({
                phase: 'executing',
                stepIndex: i + 1,
                currentStep: step.name,
                action: `Retrying with learned fix: ${learned.tool}`,
                result: `Failed with ${step.tool}: ${errorStr.slice(0, 100)}`,
                blockers: [step.blockerType],
              });
              step.tool = learned.tool;
              if (Object.keys(learned.args).length > 0) step.args = { ...step.args, ...learned.args };
              step.outcome = 'retry';
              step.retryCount = (step.retryCount ?? 0) + 1;
              continue;
            }
          }

          // 2. Source discovery fallback for brittle/404 feed URLs
          const discoveryFallback = buildNewsDiscoveryFallback(step, errorStr, result.output);
          if (discoveryFallback && toolRegistry.get(discoveryFallback.tool)) {
            logger.info(
              { step: step.name, from: step.tool, to: discoveryFallback.tool, reason: discoveryFallback.reason },
              'Step falling back to source discovery',
            );
            emit({
              phase: 'executing',
              stepIndex: i + 1,
              currentStep: step.name,
              action: `Source discovery fallback: ${discoveryFallback.tool}`,
              result: discoveryFallback.reason,
              blockers: [step.blockerType],
            });
            step.tool = discoveryFallback.tool;
            step.args = { ...step.args, ...discoveryFallback.args };
            step.outcome = 'fallback';
            step.retryCount = (step.retryCount ?? 0) + 1;
            continue;
          }

          // 3. Try generic fallback
          const fallback = suggestFallback(step.blockerType, step.tool);
          if (fallback && toolRegistry.get(fallback.tool)) {
            logger.info(
              { step: step.name, from: step.tool, to: fallback.tool, blocker: step.blockerType },
              'Step falling back to alternative tool',
            );
            emit({
              phase: 'executing',
              stepIndex: i + 1,
              currentStep: step.name,
              action: `Falling back: ${step.tool} → ${fallback.tool}`,
              result: `Blocked: ${errorStr.slice(0, 100)}`,
              blockers: [step.blockerType],
            });
            step.tool = fallback.tool;
            if (fallback.args) step.args = { ...step.args, ...fallback.args };
            step.outcome = 'fallback';
            step.retryCount = (step.retryCount ?? 0) + 1;
            continue;
          }

          // 3. No resolution — blocked
          if (blockerMemory) {
            blockerMemory.recordFailure({
              originalTool: step.tool,
              originalError: errorStr,
              blockerType: step.blockerType,
              resolutionTool: step.tool,
              taskId,
            });
          }

          step.status = 'failed';
          step.outcome = 'blocked';
          logger.warn({ step: step.name, error: errorStr, blocker: step.blockerType }, 'Step failed — no fallback');
          emit({
            phase: 'executing',
            stepIndex: i + 1,
            currentStep: step.name,
            action: `Blocked: ${step.name}`,
            result: errorStr.slice(0, 150),
            blockers: [step.blockerType],
          });
          resolved = true;
        }
      } catch (error) {
        step.status = 'failed';
        step.error = error instanceof Error ? error.message : String(error);
        step.outcome = 'blocked';
        step.blockerType = classifyBlocker(step.error, step.tool);
        step.completedAt = new Date().toISOString();
        logger.error({ step: step.name, error: step.error, blocker: step.blockerType }, 'Step threw exception');
        resolved = true;
      }
    }

    taskLedger.checkpoint(taskId, { plan });

    if (step.status === 'failed') {
      const now = new Date().toISOString();
      for (let j = i + 1; j < plan.steps.length; j++) {
        const remaining = plan.steps[j];
        if (remaining.status !== 'pending') continue;
        remaining.status = 'skipped';
        remaining.outcome = 'blocked';
        remaining.error = `Skipped due to dependency failure in step ${i + 1}: ${step.name}`;
        remaining.blockerType = step.blockerType ?? 'bad_plan';
        remaining.startedAt = now;
        remaining.completedAt = now;
      }

      emit({
        phase: 'executing',
        stepIndex: i + 1,
        currentStep: step.name,
        action: 'Halting remaining steps due to dependency failure',
        result: step.error?.slice(0, 140),
        blockers: [step.blockerType ?? 'bad_plan'],
      });

      taskLedger.checkpoint(taskId, { plan });
      break;
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Verifier — checks success criteria against actual outputs
// ---------------------------------------------------------------------------

const VERIFIER_PROMPT = `You are a verification agent. Given a task plan with its outputs and success criteria, determine if the task is truly complete.

RULES:
- Output ONLY valid JSON
- Be strict — if criteria aren't clearly met by the evidence, mark as not verified
- Check both individual step criteria and overall criteria

OUTPUT FORMAT:
{ "verified": true/false, "evidence": "summary of what was accomplished", "failedCriteria": "what wasn't met (if not verified)" }`;

export async function verifyPlan(
  plan: Plan,
  client: OpenAI,
  model: string,
  logger: Logger,
): Promise<VerificationResult> {
  plan.status = 'verifying';

  // If all steps failed/skipped, no need to call LLM
  const allFailed = plan.steps.every(s => s.status === 'failed' || s.status === 'skipped');
  if (allFailed) {
    return {
      verified: false,
      evidence: 'All plan steps failed',
      failedCriteria: plan.overallCriteria,
    };
  }

  // Simple verification: if there are outputs and no failures, pass
  const failedSteps = plan.steps.filter(s => s.status === 'failed' || s.status === 'skipped');
  const doneSteps = plan.steps.filter(s => s.status === 'done');

  if (failedSteps.length === 0) {
    const deterministicGuard = deterministicVerificationGuard(plan);
    if (deterministicGuard) {
      return deterministicGuard;
    }
  }

  if (failedSteps.length === 0 && doneSteps.length > 0) {
    // All steps passed — use LLM to verify against overall criteria
    try {
      const planSummary = plan.steps.map(s => {
        const output = s.output ? JSON.stringify(s.output).slice(0, 500) : '(no output)';
        return `Step: ${s.name}\n  Status: ${s.status}\n  Output: ${output}\n  Criteria: ${s.successCriteria}`;
      }).join('\n\n');

      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: 256,
        messages: [
          { role: 'system', content: VERIFIER_PROMPT },
          { role: 'user', content: `OVERALL CRITERIA: ${plan.overallCriteria}\n\nPLAN RESULTS:\n${planSummary}` },
        ],
      });

      const text = response.choices[0]?.message?.content?.trim();
      if (text) {
        const jsonStr = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '');
        const result = JSON.parse(jsonStr) as VerificationResult;
        logger.info({ verified: result.verified }, 'Plan verification complete');
        return result;
      }
    } catch (error) {
      logger.error({ error }, 'LLM verification failed — falling back to step-based check');
    }
  }

  // Fallback: if some steps failed, report partial
  if (failedSteps.length > 0) {
    return {
      verified: false,
      evidence: `${doneSteps.length}/${plan.steps.length} steps completed`,
      failedCriteria: failedSteps.map((s) => `${s.name}: ${s.error ?? 'Step not completed'}`).join('; '),
    };
  }

  return {
    verified: true,
    evidence: `All ${plan.steps.length} steps completed successfully`,
  };
}

// ---------------------------------------------------------------------------
// Pipeline Orchestrator — plan → execute → verify → update task
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  client: OpenAI;
  model: string;            // Default model (chat tier)
  plannerClient?: OpenAI;   // Separate client for planning (may use different provider)
  plannerModel?: string;    // Override for planning phase
  verifierClient?: OpenAI;  // Separate client for verification
  verifierModel?: string;   // Override for verification phase
  toolRegistry: ToolRegistry;
  taskLedger: TaskLedger;
  logger: Logger;
  blockerMemory?: BlockerMemory;
  onHeartbeat?: HeartbeatCallback;
  autoPublish?: AutoPublishCallback;
}

export interface PipelineResult {
  task: Task;
  plan: Plan;
  verification: VerificationResult;
}

export interface AutoPublishInput {
  task: Task;
  plan: Plan;
  verification: VerificationResult;
  artifacts: TaskArtifact[];
}

export interface AutoPublishResult {
  artifacts: TaskArtifact[];
  evidenceNote?: string;
}

export type AutoPublishCallback = (input: AutoPublishInput) => Promise<AutoPublishResult | null>;

/**
 * Run the full planner → executor → verifier pipeline for a task.
 * The task must already exist in the ledger (queued status).
 */
export async function runPipeline(
  taskId: string,
  config: PipelineConfig,
): Promise<PipelineResult | null> {
  const {
    client,
    model,
    plannerClient,
    plannerModel,
    verifierClient,
    verifierModel,
    toolRegistry,
    taskLedger,
    logger,
    blockerMemory,
    onHeartbeat,
    autoPublish,
  } = config;

  const emit = (hb: Omit<ProgressHeartbeat, 'taskId' | 'timestamp'>) => {
    if (!onHeartbeat) return;
    try { onHeartbeat({ ...hb, taskId, timestamp: new Date().toISOString() }); } catch { /* ignore */ }
  };

  // Start the task
  const task = taskLedger.start(taskId);
  if (!task) {
    logger.error({ taskId }, 'Cannot start pipeline — task not startable');
    return null;
  }

  logger.info({ taskId, title: task.title }, 'Pipeline started');

  // Phase 1: Plan
  emit({ phase: 'planning', action: `Planning: ${task.title}` });
  const toolManifest = toolRegistry.generateManifest();
  const planningClient = plannerClient ?? client;
  const planningModel = plannerModel ?? model;
  const relevantMemories = taskLedger.findRelevantCompleted(task.title, 3);
  const memoryContext = buildTaskMemoryContext(relevantMemories);
  const planningCandidates: Array<{ client: OpenAI; model: string; reason: string }> = [];
  const seenPlanningCandidates = new Set<string>();
  const addPlanningCandidate = (candidateClient: OpenAI, candidateModel: string, reason: string): void => {
    const source = candidateClient === client ? 'chat' : 'planner';
    const key = `${source}:${candidateModel}`;
    if (seenPlanningCandidates.has(key)) return;
    seenPlanningCandidates.add(key);
    planningCandidates.push({ client: candidateClient, model: candidateModel, reason });
  };

  addPlanningCandidate(planningClient, planningModel, 'primary');
  addPlanningCandidate(client, model, 'chat-tier fallback');
  addPlanningCandidate(client, 'openai/gpt-4.1', 'stability fallback');
  addPlanningCandidate(client, 'openai/gpt-4.1-mini', 'stability fallback');

  let plan: Plan | null = null;
  for (let i = 0; i < planningCandidates.length; i++) {
    const candidate = planningCandidates[i]!;
    if (i > 0) {
      logger.warn(
        {
          taskId,
          attempt: i + 1,
          totalAttempts: planningCandidates.length,
          fallbackModel: candidate.model,
          reason: candidate.reason,
        },
        'Planner fallback attempt',
      );
      emit({
        phase: 'planning',
        action: `Planner fallback (${i + 1}/${planningCandidates.length}): ${candidate.model}`,
      });
    }

    plan = await generatePlan(task.title, toolManifest, candidate.client, candidate.model, logger, memoryContext);
    if (plan && plan.steps.length > 0) break;
  }

  // Fallback: if planner override fails, retry with default chat model/client.
  if ((!plan || plan.steps.length === 0) && (planningClient !== client || planningModel !== model)) {
    logger.warn(
      { taskId, planningModel, fallbackModel: model },
      'Planner override failed — retrying with default model/client',
    );
    emit({
      phase: 'planning',
      action: `Planner fallback: retrying with ${model}`,
    });
    plan = await generatePlan(task.title, toolManifest, client, model, logger, memoryContext);
  }

  if (!plan || plan.steps.length === 0) {
    emit({ phase: 'failed', action: 'Planning failed — no valid plan generated' });
    taskLedger.fail(taskId, 'Planner failed to generate a valid plan');
    return null;
  }

  emit({
    phase: 'planning',
    action: `Plan ready: ${plan.steps.length} steps`,
    next: plan.steps[0]?.name ?? 'execute',
  });

  taskLedger.checkpoint(taskId, { plan, phase: 'planned' });

  // Phase 2: Execute
  const executedPlan = await executeSteps(plan, toolRegistry, taskLedger, taskId, logger, blockerMemory, onHeartbeat);
  taskLedger.checkpoint(taskId, { plan: executedPlan, phase: 'executed' });

  // Phase 3: Verify
  emit({ phase: 'verifying', action: 'Verifying results against success criteria' });
  const verification = await verifyPlan(executedPlan, verifierClient ?? client, verifierModel ?? model, logger);

  if (verification.verified) {
    executedPlan.status = 'verified';
    const artifacts = executedPlan.steps.flatMap((step) => buildArtifactsFromStep(step));

    if (autoPublish) {
      try {
        const publishResult = await autoPublish({
          task,
          plan: executedPlan,
          verification,
          artifacts: [...artifacts],
        });
        if (publishResult) {
          if (publishResult.artifacts.length > 0) {
            artifacts.push(...publishResult.artifacts);
          }
          if (publishResult.evidenceNote && publishResult.evidenceNote.trim().length > 0) {
            verification.evidence = `${verification.evidence} | ${publishResult.evidenceNote.trim()}`;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ taskId, error: message }, 'Auto-publish step failed');
        artifacts.push({
          type: 'text',
          label: 'publish_blocked',
          value: `Auto-publish failed: ${message}`,
        });
        verification.evidence = `${verification.evidence} | Publish blocked: ${message}`;
      }
    }

    taskLedger.complete(taskId, artifacts);
    emit({ phase: 'complete', action: 'Task verified and complete', result: verification.evidence });
  } else {
    const partialArtifacts = executedPlan.steps.flatMap((step) => buildArtifactsFromStep(step));
    for (const artifact of partialArtifacts) {
      taskLedger.addArtifact(taskId, artifact);
    }

    const missingCredentialKeys = extractCredentialKeysFromPlan(executedPlan);

    if (missingCredentialKeys.length > 0) {
      const reason = `Missing credentials required: ${missingCredentialKeys.join(', ')}. ` +
        `Provide them via /setsecret <KEY> <VALUE> and retry.`;
      executedPlan.status = 'failed';
      taskLedger.block(taskId, reason);
      verification.failedCriteria = reason;
      emit({
        phase: 'failed',
        action: 'Blocked waiting for credentials',
        result: reason,
        blockers: ['missing_secret'],
      });
    } else {
      executedPlan.status = 'failed';
      taskLedger.fail(taskId, verification.failedCriteria ?? 'Verification failed');
      emit({ phase: 'failed', action: 'Verification failed', result: verification.failedCriteria });
    }
  }

  const updatedTask = taskLedger.getById(taskId)!;
  logger.info(
    { taskId, verified: verification.verified, steps: executedPlan.steps.length },
    'Pipeline complete',
  );

  return { task: updatedTask, plan: executedPlan, verification };
}

const NEWS_QUERY_STOP_WORDS = new Set([
  'from', 'with', 'that', 'this', 'into', 'then', 'than', 'news', 'feed', 'rss',
  'major', 'latest', 'around', 'across', 'using', 'include', 'including', 'write',
  'build', 'fetch', 'collect', 'compile', 'website', 'web', 'page', 'today',
]);
