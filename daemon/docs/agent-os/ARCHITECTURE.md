# Agent OS Architecture

## Purpose

Build an always-on multi-agent platform where you can:

- Create independent agents.
- Assign objectives from mobile or desktop.
- Let agents execute end-to-end work with machine control.
- Allow delegation between agents.
- Receive progress, blockers, and completion updates.

This design turns the current daemon into an Agent OS control plane plus worker plane.

## Product Definition

### Core User Promise

Given a high-level objective, the system plans, executes, delegates, verifies, and reports until done or blocked.

### Example Objective

`"Make me money by writing an ebook"` becomes:

- Research market demand.
- Generate book outline and manuscript.
- Create cover and product assets.
- Publish to selected channels.
- Run marketing tasks.
- Report revenue and next actions.

## System Architecture

## Layer 1: Interface Layer

- Mobile chat interface (Telegram first, native app later).
- Web dashboard for deep control.
- API clients for automation.

Responsibilities:

- Send commands.
- Receive status streams.
- Handle approval prompts.
- View artifacts and outcomes.

## Layer 2: Control Plane

Services:

- Objective Service: lifecycle and prioritization.
- Agent Manager: agent creation, policy, capability assignment.
- Planner Service: converts objective to task graph.
- Delegation Router: agent-to-agent assignment and response handling.
- Approval Service: human-in-the-loop checkpoints.
- Policy Service: permissions and risk controls.
- Billing Service: token and cost tracking per objective.
- Notification Service: mobile updates and escalations.

## Layer 3: Worker Plane

Each running agent is an isolated runtime called an Agent Pod.

Agent Pod components:

- Executor loop.
- Tool runtime (shell, browser, file, API).
- Skill runtime (load/create/update skills).
- Memory client (short and long-term memory).
- Event emitter (step-level telemetry).

## Layer 4: Infrastructure

- Database (SQLite now, Postgres optional later).
- Event stream (DB-backed queue now, Redis/NATS optional later).
- Artifact storage (local FS now, object storage optional later).
- Secrets store (env now, Vault-like later).
- Host registry for multi-machine placement.

## Runtime Model

## Entity Relationships

- One user owns many projects.
- One project has many objectives.
- One objective has many tasks.
- Tasks are assigned to agents.
- Agents run on hosts.
- Agents may delegate tasks to other agents.

## Objective Lifecycle

- `draft`
- `queued`
- `planning`
- `running`
- `waiting_approval`
- `blocked`
- `completed`
- `failed`
- `canceled`

## Task Lifecycle

- `queued`
- `running`
- `retrying`
- `delegated`
- `waiting_input`
- `blocked`
- `done`
- `failed`
- `canceled`

## Agent Lifecycle

- `provisioning`
- `idle`
- `running`
- `paused`
- `offline`
- `error`

## Delegation Protocol

Delegation is explicit and auditable.

Delegation request fields:

- `delegation_id`
- `from_agent_id`
- `to_agent_id`
- `objective_id`
- `task_id`
- `question`
- `context_payload`
- `definition_of_done`
- `deadline`

Delegation states:

- `requested`
- `accepted`
- `running`
- `answered`
- `rejected`
- `expired`

Rules:

- Delegated tasks inherit parent objective policy.
- Capability checks run before acceptance.
- Answer artifacts are linked back to parent task.

## Definitions of Done

Every objective must bind to a DoD template before execution.

DoD template includes:

- Outcome criteria list.
- Required artifact types.
- Verification steps.
- Stop conditions.
- Escalation conditions.

Example for ebook objective:

- Manuscript length threshold met.
- Plagiarism and quality checks pass.
- Publishing completed on selected platform.
- Marketing campaign launched with tracked links.
- Revenue report generated.

## Mobile-First Operations

Required mobile commands:

- Create objective.
- Pause/resume/cancel objective.
- Reply to clarification requests.
- Approve gated actions.
- Inspect status timeline.
- Retrieve artifacts.

Notification classes:

- `info`: progress update.
- `action_required`: approval/input needed.
- `blocker`: agent cannot proceed.
- `completion`: objective done.

## Capability and Access Model

Agents can have broad machine access, but must be policy-scoped.

Policy dimensions:

- Tool allowlist per agent.
- Filesystem scope per host path.
- Network/domain allowlist.
- Spend limits.
- Risky action approvals.

Approval examples:

- Publishing content to external platforms.
- Spending above configured threshold.
- Credential rotation.
- Destructive filesystem operations.

## Observability and Audit

Everything is evented:

- Objective events.
- Task events.
- Tool execution events.
- Delegation events.
- Approval events.
- Cost events.

Every event includes:

- `event_id`
- `timestamp`
- `entity_type`
- `entity_id`
- `event_type`
- `payload`

This powers replay, debugging, and trust.

## Security Model

- Secrets never stored in plain text in task logs.
- Tool output redaction before user-visible messages.
- Signed mobile sessions with short TTL.
- Mandatory audit record for external side effects.
- Policy evaluation before every tool execution.

## Mapping From Current Daemon

Current modules map to new architecture as follows:

- `ConversationHandler` -> Interface Orchestrator.
- `TaskLedger` -> Task Store (subset of new Task model).
- `runPipeline` -> Worker Executor core loop.
- `ToolRegistry` -> Tool Runtime.
- `ProjectManager` -> Project Service.
- `CommitmentScheduler` -> Objective scheduler seed.

Gaps to close:

- No first-class objective model.
- No agent identity and lifecycle model.
- No delegation protocol.
- No approval workflow contract.
- No machine-host capability model.
- No unified event stream contract.

## Rollout Plan

## Milestone 1: Control Plane MVP

- Add agents/objectives/tasks/delegations schema.
- Add objective and agent APIs.
- Add mobile command endpoints.
- Add event stream endpoint (SSE).

## Milestone 2: Worker Pod Runtime

- Introduce per-agent runtime loop.
- Bind policies and capabilities per agent.
- Execute objective task graphs.

## Milestone 3: Delegation and Approval

- Enable task delegation APIs and runtime flow.
- Add approval prompts and decision capture.
- Add objective-level DoD verification service.

## Milestone 4: Self-Improving Agent Ecosystem

- Skill generation pipeline by agent.
- Shared knowledge retrieval and memory scoring.
- Multi-host scheduling and host affinity.

## Build Contracts

The following files define implementation contracts:

- Schema: `daemon/docs/agent-os/schema.sql`
- API: `daemon/docs/agent-os/openapi.yaml`

