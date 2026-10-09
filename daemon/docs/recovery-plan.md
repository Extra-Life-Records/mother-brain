# Daemon Recovery Plan (Telegram-first Autonomous Agent)

## Product Goal

Make Telegram interaction feel like a reliable autonomous assistant:

1. Understand natural language requests and follow-ups without rigid phrasing.
2. Execute scheduled and immediate tasks reliably (exactly-once semantics).
3. Return meaningful results (not false "fulfilled" notifications).
4. Provide traceable runtime evidence (`/version`, status, task outcomes).

## Current Failure Themes

- Multiple runtime/process instances caused duplicate commitment execution.
- Planner model mismatch (`unknown_model`) caused silent fallback behavior.
- Regex-only front-door intent routing made conversational edits brittle.
- Commitment success notifications could be emitted without useful outputs.

## North-Star Acceptance Criteria

A request like:

> "Make me a round up of AI news that came out today and send it to me at 13:07"

must produce:

- one schedule confirmation,
- one execution,
- one results message with headlines/links,
- zero duplicate fulfillments,
- natural follow-up edit support ("change that to 13:09").

## Delivery Phases

### Phase 1 — Reliability Guard Rails (Immediate)

- [x] Single-instance lock (`daemon.lock`)
- [x] Atomic commitment claiming for due one-time runs
- [x] Planner fallback to default chat model when planning override fails
- [x] Command compatibility fallback in text path (`version`, status, run, etc.)
- [x] Reschedule intent support (`change that to 12:34`)
- [x] Deterministic news roundup path for news asks

### Phase 2 — Conversational Understanding Upgrade

- [ ] Add lightweight intent interpreter (LLM fallback) for ambiguous Telegram messages
- [ ] Track last actionable user intent context (for pronouns like "that/it")
- [ ] Add explicit intent classes: schedule_create, schedule_update, schedule_cancel, execute_now, ask_status

### Phase 3 — Execution Quality

- [ ] Expand deterministic handlers for common domains (news, reminders, summaries)
- [ ] Return structured result payloads (headline list, links, source count)
- [ ] Add fallback strategy matrix for blocked sources (web_fetch → browser_fetch)

### Phase 4 — Verification & Confidence

- [ ] Add integration tests for Telegram flows (schedule/create/update/execute)
- [ ] Add exactly-once assertion tests for commitments under process contention
- [ ] Add explicit execution trace IDs in user-facing notifications

### Phase 5 — Product UX Stabilization

- [ ] `/health` command: runtime + scheduler + DB lock + queue health
- [ ] Better user messages for intent-confirm and reschedule-confirm
- [ ] Optional "verbose mode" for power users

## Rollout Plan

1. Deploy Phase 1 fixes to active host.
2. Run smoke scenario suite (scheduled news, reschedule, cancel, immediate run).
3. Monitor logs for 24h (duplicate executions and planner fallback frequency).
4. If stable, begin Phase 2 implementation.

## Smoke Test Scenarios

1. Schedule news: "...send it to me at HH:MM"
2. Edit time: "change that to HH:MM"
3. Cancel latest: "cancel that"
4. Immediate task: "get latest AI headlines"
5. Verify `/version` and single runtime PID.

## Definition of Done (Project Recovery)

- No duplicate commitment execution in 100 consecutive scheduled runs.
- ≥ 95% of follow-up schedule edits interpreted correctly.
- Scheduled news requests always include at least 3 headlines or clear error reason.
- User can operate naturally through Telegram without command babysitting.
