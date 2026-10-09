# Mother Brain Daemon

An autonomous development agent that runs on a Raspberry Pi, executes [Mother Brain](https://github.com/super-state/mother-brain) roadmap outcomes overnight while you sleep, and reports via Telegram.

## What It Does

- 🌙 **Overnight Worker** — Assign work before bed, wake up to completed outcomes
- 📱 **Telegram Interface** — Monitor, command, and receive reports from your phone
- 💰 **Token Efficient** — $0 when idle, minimal context per task, budget caps enforced
- 🔒 **Self-Hosted** — Runs on your Raspberry Pi. Your machine, your data
- ✅ **Verified Output** — Multi-layer verification gates ensure quality

## Architecture

```
┌─────────────────────────────────────────────┐
│  Mother Brain Daemon (Raspberry Pi)         │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Scheduler │→ │ Runtime  │→ │ Verifier  │ │
│  │ (croner)  │  │ (LLM)   │  │ (gates)   │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│       ↑              ↑             ↓        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │ Roadmap  │  │ Budget   │  │ Workspace │ │
│  │ (files)  │  │ (SQLite) │  │ (git)     │ │
│  └──────────┘  └──────────┘  └───────────┘ │
│                      ↓                      │
│              ┌──────────────┐               │
│              │   Reporter   │               │
│              │  (Telegram)  │               │
│              └──────────────┘               │
└─────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install
npm install -g mother-brain-daemon

# Configure
mother-brain-daemon init

# Start
mother-brain-daemon start
```

## Deploy + Runtime Verification

On your runtime host (Pi/server), run:

```bash
npm run deploy:smoke
```

Then in Telegram, send:

```text
/version
```

You should see the active runtime version + commit so you can confirm the bot is running the latest deployment.

## Agent OS Telegram Commands

The daemon now supports persistent autonomous agents and objective queues.

```text
/addagent <name> [role prompt]
/agents

/objective <description>
/objective <agent> :: <description>
/objectives
/objective_tasks <objective-id>

/delegate <task-id> <agent-name> :: <question>
/delegations

/approvals
/approve <approval-id> [note]
/reject <approval-id> [reason]
```

Direct chat shortcuts also work:

```text
@agentName: do this objective
agent agentName do this objective
```

These create queued objectives assigned to agents. The scheduler executes objective tasks continuously and reports progress back in Telegram.

## Agent OS HTTP API

Optional control-plane API:

- Config file: set `api.enabled`, `api.host`, `api.port`, optional `api.bearerToken`
- Or env vars: `AGENT_OS_API_PORT`, optional `AGENT_OS_API_HOST`, `AGENT_OS_API_TOKEN`

Core endpoints:

- `GET /health`
- `GET/POST /v1/agents`
- `GET/POST /v1/objectives`
- `GET /v1/objectives/:id`
- `GET /v1/objectives/:id/tasks`
- `GET /v1/objectives/:id/events`
- `GET /v1/objectives/:id/events/stream` (SSE)
- `GET /v1/delegations`
- `POST /v1/tasks/:taskId/delegate`
- `GET /v1/approvals`
- `POST /v1/approvals/:approvalId/decision`

## Autonomous Hosting

When a verified task looks like a website deliverable (for example HTML output),
the daemon now attempts external deployment automatically and returns the live URL.

Auto-publish control:

- `MB_HOSTING_MODE=auto` (default) enables autonomous publish attempts
- `MB_HOSTING_MODE=off` disables autonomous publishing
- `MB_HOSTING_DEFAULT_PROVIDER=vercel|netlify|cloudflare_pages` sets provider priority

Provider setup (any one):

- Vercel:
  - `VERCEL_TOKEN`
  - `vercel` CLI installed
- Netlify:
  - `NETLIFY_AUTH_TOKEN`
  - `NETLIFY_SITE_ID`
  - `netlify` CLI installed
- Cloudflare Pages:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_PAGES_PROJECT` (or `CLOUDFLARE_PAGES_PROJECT_NAME`)
  - `wrangler` CLI installed

## Mission Autonomy + Memory

- Long-horizon asks in Telegram are automatically routed to objective mode (multi-step mission queue) instead of one-shot tasks.
- The planner now loads relevant successful completed tasks as memory context before generating a new plan.
- This gives agents persistent execution memory and better autonomous follow-through across sessions.

## Web-User Operator (1-8)

The daemon now includes an operator lane for authenticated web execution:

1. Persistent browser sessions (`browser_operator` open/list/close)
2. Human-like browser actions (`goto`, `click`, `type`, `press`, `wait_for`)
3. Page extraction and screenshots (`extract_text`, `screenshot`)
4. Session state export (`storage_state`)
5. OTP retrieval adapters (`inbox_otp_wait` with env/file/command)
6. Login orchestration (`web_auth_flow` with optional OTP)
7. Sensitive-flow policy gate (`allowSensitive` required for financial domains)
8. Mission routing + memory-backed planning for long-horizon execution

### Operator env setup

- OTP env source: set `MB_OTP_CODE` (or custom var via tool params)
- OTP file source: write incoming codes to `~/.mother-brain-daemon/otp-inbox.txt`
- OTP command source: set `MB_INBOX_FETCH_CMD` to a command that prints inbox content

### New tools

- `browser_operator`
- `inbox_otp_wait`
- `web_auth_flow`

## Part of Mother Brain

This is a runtime for the [Mother Brain framework](https://github.com/super-state/mother-brain). The CLI is for interactive sessions. The daemon is for autonomous execution. Same brain, different mode.

## Status

🚧 Under active development — not yet released.
