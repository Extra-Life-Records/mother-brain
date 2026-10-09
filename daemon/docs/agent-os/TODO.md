# Agent OS Build Todo

## Goal

Deliver four capabilities end-to-end:

- Delegation runtime + mobile flow
- Approval gates + mobile decisions
- Definition-of-done verification
- HTTP control-plane API

## Implementation Checklist

- [x] Add persistent Agent OS entities (agents/objectives/delegations/events)
- [x] Add approval persistence and task linkage fields
- [x] Extend task ledger with `objectiveId` and `assignedAgentId`
- [x] Build `AgentOSManager` objective lifecycle and planning
- [x] Build delegation creation and completion reconciliation
- [x] Add risky-task approval gate in objective execution loop
- [x] Add DoD verification and remediation-task fallback
- [x] Add Telegram commands:
  - [x] `/agents`, `/addagent`
  - [x] `/objective`, `/objectives`, `/objective_tasks`
  - [x] `/delegate`, `/delegations`
  - [x] `/approvals`, `/approve`, `/reject`
- [x] Add API server module with auth + JSON endpoints
- [x] Add SSE objective event stream endpoint
- [x] Add tests for manager behavior (delegation, approvals, DoD)
- [x] Update daemon README with command/API docs

## Follow-Up (Next Iteration)

- [ ] Add API integration tests for route contracts
- [ ] Add multi-agent concurrency limits per objective
- [ ] Add approval expiration and auto-escalation notifications
- [ ] Add richer DoD evaluator with custom verifier hooks
- [ ] Add objective-level budgeting and profit tracking models

