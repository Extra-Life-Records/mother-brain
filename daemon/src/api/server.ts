import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { Logger } from 'pino';
import type { DaemonModule } from '../core/lifecycle.js';
import type { ApiConfig } from '../core/config.js';
import type { AgentOSManager } from '../agent-os/manager.js';

interface ApiError {
  code: string;
  message: string;
}

interface GatewayTaskItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  objectiveId: string | null;
  objectiveTitle: string;
  assignedAgentId: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  elapsedSeconds: number | null;
  blockReason: string | null;
  lastError: string | null;
}

interface GatewayEventItem {
  id: number;
  objectiveId: string;
  objectiveTitle: string;
  eventType: string;
  message: string;
  createdAt: string;
}

interface GatewayOverview {
  generatedAt: string;
  counts: {
    objectives: number;
    requestedTasks: number;
    activeTasks: number;
    events: number;
  };
  objectives: Array<{
    id: string;
    title: string;
    status: string;
    requestedBy: string;
    ownerAgentId: string | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    taskTotal: number;
    taskDone: number;
    taskFailed: number;
    taskQueued: number;
    taskRunning: number;
  }>;
  requestedTasks: GatewayTaskItem[];
  activeTasks: GatewayTaskItem[];
  recentEvents: GatewayEventItem[];
}

export class AgentOSApiServer implements DaemonModule {
  readonly name = 'agent-os-api';
  private server: ReturnType<typeof createServer> | null = null;

  constructor(
    private config: ApiConfig,
    private logger: Logger,
    private agentOS: AgentOSManager,
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.server) return;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.logger.error({ error }, 'API request failed');
        if (!res.headersSent) {
          sendJson(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } as ApiError });
        } else {
          res.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => resolve());
    });

    this.logger.info({ host: this.config.host, port: this.config.port }, 'Agent OS API server started');
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.logger.info('Agent OS API server stopped');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const path = parsed.pathname;

    if (this.config.bearerToken && !isAuthorized(req, parsed, this.config.bearerToken)) {
      sendJson(res, 401, { error: { code: 'unauthorized', message: 'Missing or invalid bearer token' } as ApiError });
      return;
    }

    if (method === 'GET' && path === '/gateway') {
      sendHtml(res, 200, buildGatewayHtml());
      return;
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, service: this.name });
      return;
    }

    if (method === 'GET' && path === '/v1/gateway/overview') {
      const limit = toInt(parsed.searchParams.get('limit'), 20);
      const eventsPerObjective = toInt(parsed.searchParams.get('eventsPerObjective'), 8);
      sendJson(res, 200, this.buildGatewayOverview(limit, eventsPerObjective));
      return;
    }

    if (method === 'GET' && path === '/v1/agents') {
      sendJson(res, 200, { items: this.agentOS.listAgents() });
      return;
    }

    if (method === 'POST' && path === '/v1/agents') {
      const body = await readJsonBody(req);
      const name = asString(body['name']);
      if (!name) {
        sendJson(res, 400, { error: { code: 'invalid_request', message: 'name is required' } as ApiError });
        return;
      }
      const created = this.agentOS.createAgent({
        name,
        rolePrompt: asString(body['rolePrompt']) ?? undefined,
        autonomyMode: asAutonomyMode(body['autonomyMode']) ?? undefined,
      });
      sendJson(res, 201, created);
      return;
    }

    if (method === 'GET' && path === '/v1/objectives') {
      const limit = toInt(parsed.searchParams.get('limit'), 20);
      sendJson(res, 200, { items: this.agentOS.listObjectives(limit) });
      return;
    }

    if (method === 'POST' && path === '/v1/objectives') {
      const body = await readJsonBody(req);
      const title = asString(body['title']);
      const description = asString(body['description']);
      const requestedBy = asString(body['requestedBy']) ?? 'api-user';
      if (!title || !description) {
        sendJson(res, 400, { error: { code: 'invalid_request', message: 'title and description are required' } as ApiError });
        return;
      }

      const created = this.agentOS.createObjective({
        projectId: asString(body['projectId']) ?? undefined,
        ownerAgentId: asString(body['ownerAgentId']) ?? undefined,
        requestedBy,
        title,
        description,
        definitionOfDone: asRecord(body['definitionOfDone']) ?? undefined,
        priority: toInt(asString(body['priority']), 5),
      });
      sendJson(res, 201, created);
      return;
    }

    const objectiveIdMatch = path.match(/^\/v1\/objectives\/([^/]+)$/);
    if (method === 'GET' && objectiveIdMatch) {
      const objectiveId = decodeURIComponent(objectiveIdMatch[1]!);
      const objective = this.agentOS.getObjectiveById(objectiveId);
      if (!objective) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'Objective not found' } as ApiError });
        return;
      }
      const tasks = this.agentOS.getObjectiveTasks(objectiveId);
      const verification = this.agentOS.verifyObjectiveDefinitionOfDone(objectiveId);
      sendJson(res, 200, { objective, tasks, verification });
      return;
    }

    const objectiveTasksMatch = path.match(/^\/v1\/objectives\/([^/]+)\/tasks$/);
    if (method === 'GET' && objectiveTasksMatch) {
      const objectiveId = decodeURIComponent(objectiveTasksMatch[1]!);
      sendJson(res, 200, { items: this.agentOS.getObjectiveTasks(objectiveId) });
      return;
    }

    const objectiveEventsMatch = path.match(/^\/v1\/objectives\/([^/]+)\/events$/);
    if (method === 'GET' && objectiveEventsMatch) {
      const objectiveId = decodeURIComponent(objectiveEventsMatch[1]!);
      const after = toInt(parsed.searchParams.get('after'), 0);
      const limit = toInt(parsed.searchParams.get('limit'), 100);
      sendJson(res, 200, { items: this.agentOS.listObjectiveEvents(objectiveId, limit, after) });
      return;
    }

    const objectiveEventsStreamMatch = path.match(/^\/v1\/objectives\/([^/]+)\/events\/stream$/);
    if (method === 'GET' && objectiveEventsStreamMatch) {
      const objectiveId = decodeURIComponent(objectiveEventsStreamMatch[1]!);
      await this.handleEventStream(req, res, objectiveId, toInt(parsed.searchParams.get('after'), 0));
      return;
    }

    if (method === 'GET' && path === '/v1/delegations') {
      const status = asString(parsed.searchParams.get('status')) ?? 'active';
      sendJson(res, 200, { items: this.agentOS.listDelegations(status as 'active' | 'all', 50) });
      return;
    }

    const delegateTaskMatch = path.match(/^\/v1\/tasks\/([^/]+)\/delegate$/);
    if (method === 'POST' && delegateTaskMatch) {
      const taskId = decodeURIComponent(delegateTaskMatch[1]!);
      const body = await readJsonBody(req);
      const toAgent = asString(body['toAgent']) ?? asString(body['toAgentNameOrId']);
      const question = asString(body['question']);
      if (!toAgent || !question) {
        sendJson(res, 400, { error: { code: 'invalid_request', message: 'toAgent and question are required' } as ApiError });
        return;
      }
      const delegation = this.agentOS.createDelegation({
        taskId,
        toAgentNameOrId: toAgent,
        question,
        deadline: asString(body['deadline']) ?? null,
      });
      sendJson(res, 201, delegation);
      return;
    }

    if (method === 'GET' && path === '/v1/approvals') {
      const status = asString(parsed.searchParams.get('status')) ?? 'pending';
      sendJson(res, 200, { items: this.agentOS.listApprovals(status as 'pending' | 'approved' | 'rejected' | 'expired' | 'all', 50) });
      return;
    }

    const approvalDecisionMatch = path.match(/^\/v1\/approvals\/([^/]+)\/decision$/);
    if (method === 'POST' && approvalDecisionMatch) {
      const approvalId = decodeURIComponent(approvalDecisionMatch[1]!);
      const body = await readJsonBody(req);
      const decision = asString(body['decision']);
      if (decision !== 'approved' && decision !== 'rejected') {
        sendJson(res, 400, { error: { code: 'invalid_request', message: 'decision must be approved or rejected' } as ApiError });
        return;
      }
      const updated = this.agentOS.decideApproval(approvalId, decision, asString(body['note']) ?? undefined);
      if (!updated) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'Approval not found or not pending' } as ApiError });
        return;
      }
      sendJson(res, 200, updated);
      return;
    }

    sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } as ApiError });
  }

  private buildGatewayOverview(limit: number, eventsPerObjective: number): GatewayOverview {
    const objectives = this.agentOS.listObjectives(Math.max(1, Math.min(limit, 100)));
    const objectiveTitleById = new Map<string, string>();
    for (const objective of objectives) {
      objectiveTitleById.set(objective.id, objective.title);
    }

    const requestedTasks: GatewayTaskItem[] = [];
    const activeTasks: GatewayTaskItem[] = [];
    const recentEvents: GatewayEventItem[] = [];

    for (const objective of objectives) {
      const tasks = this.agentOS.getObjectiveTasks(objective.id);
      for (const task of tasks) {
        const item: GatewayTaskItem = {
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          objectiveId: task.objectiveId,
          objectiveTitle: objective.title,
          assignedAgentId: task.assignedAgentId,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          updatedAt: task.updatedAt,
          completedAt: task.completedAt,
          elapsedSeconds: computeElapsedSeconds(task.startedAt, task.completedAt),
          blockReason: task.blockReason,
          lastError: task.lastError,
        };
        requestedTasks.push(item);
        if (task.status === 'queued' || task.status === 'running' || task.status === 'blocked') {
          activeTasks.push(item);
        }
      }

      const events = this.agentOS.listObjectiveEvents(objective.id, Math.max(1, Math.min(eventsPerObjective, 50)), 0);
      for (const event of events) {
        recentEvents.push({
          id: event.id,
          objectiveId: event.objectiveId,
          objectiveTitle: objective.title,
          eventType: event.eventType,
          message: event.message,
          createdAt: event.createdAt,
        });
      }
    }

    requestedTasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    activeTasks.sort((a, b) => {
      const rank = (status: string): number => (
        status === 'running' ? 0 :
        status === 'blocked' ? 1 :
        status === 'queued' ? 2 : 3
      );
      const statusDiff = rank(a.status) - rank(b.status);
      if (statusDiff !== 0) return statusDiff;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    recentEvents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return {
      generatedAt: new Date().toISOString(),
      counts: {
        objectives: objectives.length,
        requestedTasks: requestedTasks.length,
        activeTasks: activeTasks.length,
        events: recentEvents.length,
      },
      objectives: objectives.map((objective) => ({
        id: objective.id,
        title: objective.title,
        status: objective.status,
        requestedBy: objective.requestedBy,
        ownerAgentId: objective.ownerAgentId,
        createdAt: objective.createdAt,
        startedAt: objective.startedAt,
        updatedAt: objective.updatedAt,
        taskTotal: objective.taskTotal,
        taskDone: objective.taskDone,
        taskFailed: objective.taskFailed,
        taskQueued: objective.taskQueued,
        taskRunning: objective.taskRunning,
      })),
      requestedTasks: requestedTasks.slice(0, 200),
      activeTasks: activeTasks.slice(0, 100),
      recentEvents: recentEvents
        .map((event) => ({
          ...event,
          objectiveTitle: event.objectiveTitle || objectiveTitleById.get(event.objectiveId) || event.objectiveId,
        }))
        .slice(0, 200),
    };
  }

  private async handleEventStream(
    req: IncomingMessage,
    res: ServerResponse,
    objectiveId: string,
    afterId: number,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let cursor = afterId;
    const push = () => {
      const events = this.agentOS.listObjectiveEvents(objectiveId, 100, cursor);
      for (const event of events) {
        cursor = event.id;
        res.write(`id: ${event.id}\n`);
        res.write(`event: ${event.eventType}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write(`event: ping\ndata: {}\n\n`);
    };

    push();
    const timer = setInterval(push, 2000);
    req.on('close', () => clearInterval(timer));
  }
}

function isAuthorized(req: IncomingMessage, parsed: URL, expectedToken: string): boolean {
  const auth = req.headers['authorization'];
  if (auth && auth === `Bearer ${expectedToken}`) return true;

  const queryToken = parsed.searchParams.get('access_token') ?? parsed.searchParams.get('token');
  return queryToken === expectedToken;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(html));
  res.end(html);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asAutonomyMode(value: unknown): 'manual' | 'supervised' | 'autonomous' | null {
  if (value === 'manual' || value === 'supervised' || value === 'autonomous') return value;
  return null;
}

function toInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function computeElapsedSeconds(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(end)) return null;
  const seconds = Math.floor((end - start) / 1000);
  return seconds >= 0 ? seconds : 0;
}

function buildGatewayHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mother Brain Gateway</title>
  <style>
    :root {
      --bg: #f4f8f2;
      --panel: #ffffff;
      --ink: #1f2a1f;
      --muted: #5f6f62;
      --line: #d8e3d6;
      --accent: #2f7d4f;
      --warn: #b7791f;
      --danger: #b91c1c;
      --radius: 14px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at 20% -10%, #dcedd9 0%, var(--bg) 50%);
    }
    .shell {
      max-width: 1200px;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      gap: 14px;
    }
    .topbar {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    h1 {
      margin: 0;
      font-size: 1.25rem;
      letter-spacing: 0.02em;
    }
    .meta {
      color: var(--muted);
      font-size: 0.9rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 12px;
    }
    .k {
      color: var(--muted);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .v {
      font-size: 1.2rem;
      font-weight: 650;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .panel h2 {
      margin: 0;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      font-size: 1rem;
      background: #f8fcf7;
    }
    .table-wrap { overflow: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      text-align: left;
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      white-space: nowrap;
    }
    td.title {
      max-width: 560px;
      white-space: normal;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      text-transform: capitalize;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #94a3b8;
      display: inline-block;
    }
    .running .dot { background: var(--accent); }
    .blocked .dot { background: var(--warn); }
    .failed .dot { background: var(--danger); }
    .done .dot { background: var(--accent); }
    .queued .dot { background: #64748b; }
    .events {
      padding: 10px 14px 14px;
      display: grid;
      gap: 8px;
    }
    .event {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      background: #fbfdfb;
    }
    .event-meta {
      color: var(--muted);
      font-size: 0.82rem;
      margin-bottom: 3px;
    }
    .empty {
      color: var(--muted);
      padding: 14px;
      font-style: italic;
    }
    @media (max-width: 960px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="topbar">
      <h1>Mother Brain Daemon Gateway</h1>
      <div class="meta" id="stamp">Loading...</div>
    </div>
    <div class="grid">
      <div class="card"><div class="k">Objectives</div><div class="v" id="cObjectives">0</div></div>
      <div class="card"><div class="k">Requested Tasks</div><div class="v" id="cRequested">0</div></div>
      <div class="card"><div class="k">Active Tasks</div><div class="v" id="cActive">0</div></div>
      <div class="card"><div class="k">Recent Events</div><div class="v" id="cEvents">0</div></div>
    </div>

    <section class="panel">
      <h2>In Progress</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Task</th>
              <th>Objective</th>
              <th>Elapsed</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody id="activeBody"></tbody>
        </table>
      </div>
      <div class="empty" id="activeEmpty" hidden>No active tasks.</div>
    </section>

    <section class="panel">
      <h2>Requested Tasks</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Task</th>
              <th>Objective</th>
              <th>Priority</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="requestedBody"></tbody>
        </table>
      </div>
      <div class="empty" id="requestedEmpty" hidden>No tasks yet.</div>
    </section>

    <section class="panel">
      <h2>Recent Events</h2>
      <div class="events" id="eventsList"></div>
      <div class="empty" id="eventsEmpty" hidden>No recent events.</div>
    </section>
  </div>

  <script>
    const state = { overview: null };

    function esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function fmtDate(iso) {
      if (!iso) return '-';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return date.toLocaleString();
    }

    function fmtDuration(totalSeconds) {
      if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '-';
      const seconds = Math.max(0, Math.floor(totalSeconds));
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }

    function statusCell(status) {
      const s = String(status || 'unknown').toLowerCase();
      return '<span class="status ' + esc(s) + '"><span class="dot"></span>' + esc(s) + '</span>';
    }

    function taskElapsed(task) {
      if (!task || !task.startedAt) return null;
      const start = Date.parse(task.startedAt);
      if (!Number.isFinite(start)) return null;
      const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
      if (!Number.isFinite(end)) return null;
      return Math.max(0, Math.floor((end - start) / 1000));
    }

    async function loadOverview() {
      const params = new URLSearchParams(location.search);
      const token = params.get('access_token') || params.get('token');
      const query = new URLSearchParams({ limit: '30', eventsPerObjective: '12' });
      if (token) query.set('access_token', token);
      const response = await fetch('/v1/gateway/overview?' + query.toString(), { cache: 'no-store' });
      if (!response.ok) {
        const text = await response.text();
        throw new Error('Failed to load overview: ' + response.status + ' ' + text.slice(0, 160));
      }
      state.overview = await response.json();
      render();
    }

    function render() {
      const overview = state.overview;
      if (!overview) return;

      document.getElementById('stamp').textContent = 'Updated ' + fmtDate(overview.generatedAt);
      document.getElementById('cObjectives').textContent = String(overview.counts.objectives || 0);
      document.getElementById('cRequested').textContent = String(overview.counts.requestedTasks || 0);
      document.getElementById('cActive').textContent = String(overview.counts.activeTasks || 0);
      document.getElementById('cEvents').textContent = String(overview.counts.events || 0);

      const active = Array.isArray(overview.activeTasks) ? overview.activeTasks : [];
      const activeBody = document.getElementById('activeBody');
      const activeEmpty = document.getElementById('activeEmpty');
      if (active.length === 0) {
        activeBody.innerHTML = '';
        activeEmpty.hidden = false;
      } else {
        activeEmpty.hidden = true;
        activeBody.innerHTML = active.map((task) => (
          '<tr>' +
          '<td>' + statusCell(task.status) + '</td>' +
          '<td class="title">' + esc(task.title) + '</td>' +
          '<td><code>' + esc(task.objectiveId || '-') + '</code></td>' +
          '<td data-elapsed-task="' + esc(task.id) + '">' + esc(fmtDuration(taskElapsed(task))) + '</td>' +
          '<td>' + esc(fmtDate(task.updatedAt)) + '</td>' +
          '</tr>'
        )).join('');
      }

      const requested = Array.isArray(overview.requestedTasks) ? overview.requestedTasks : [];
      const requestedBody = document.getElementById('requestedBody');
      const requestedEmpty = document.getElementById('requestedEmpty');
      if (requested.length === 0) {
        requestedBody.innerHTML = '';
        requestedEmpty.hidden = false;
      } else {
        requestedEmpty.hidden = true;
        requestedBody.innerHTML = requested.map((task) => (
          '<tr>' +
          '<td>' + statusCell(task.status) + '</td>' +
          '<td class="title">' + esc(task.title) + '</td>' +
          '<td><code>' + esc(task.objectiveId || '-') + '</code></td>' +
          '<td>' + esc(task.priority) + '</td>' +
          '<td>' + esc(fmtDate(task.createdAt)) + '</td>' +
          '</tr>'
        )).join('');
      }

      const events = Array.isArray(overview.recentEvents) ? overview.recentEvents : [];
      const eventsList = document.getElementById('eventsList');
      const eventsEmpty = document.getElementById('eventsEmpty');
      if (events.length === 0) {
        eventsList.innerHTML = '';
        eventsEmpty.hidden = false;
      } else {
        eventsEmpty.hidden = true;
        eventsList.innerHTML = events.map((event) => (
          '<div class="event">' +
          '<div class="event-meta">' + esc(fmtDate(event.createdAt)) + ' - ' + esc(event.eventType) + ' - <code>' + esc(event.objectiveId) + '</code></div>' +
          '<div>' + esc(event.message) + '</div>' +
          '</div>'
        )).join('');
      }
    }

    function tickElapsed() {
      if (!state.overview || !Array.isArray(state.overview.activeTasks)) return;
      for (const task of state.overview.activeTasks) {
        const cell = document.querySelector('[data-elapsed-task="' + CSS.escape(task.id) + '"]');
        if (!cell) continue;
        cell.textContent = fmtDuration(taskElapsed(task));
      }
    }

    async function boot() {
      try {
        await loadOverview();
      } catch (error) {
        document.getElementById('stamp').textContent = String(error && error.message ? error.message : error);
      }
      setInterval(async () => {
        try {
          await loadOverview();
        } catch (_) {
          // keep previous data visible on transient failures
        }
      }, 10000);
      setInterval(tickElapsed, 1000);
    }

    boot();
  </script>
</body>
</html>`;
}
