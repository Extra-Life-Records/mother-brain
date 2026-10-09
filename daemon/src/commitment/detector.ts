import type OpenAI from 'openai';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Two-Stage Commitment Detector
// ---------------------------------------------------------------------------
// Stage 1: Cheap regex candidate filter ($0) — permissive, high recall
// Stage 2: LLM classification (~$0.001) — precise, structured output
// ---------------------------------------------------------------------------

export type CommitmentType = 'one_time' | 'recurring';

export interface DetectedCommitment {
  type: CommitmentType;
  promiseText: string;       // The matched phrase from LLM output
  actionDescription: string; // What needs to happen
  schedule?: string;         // Cron pattern for recurring (e.g., "0 7 * * *")
  executeAt?: string;        // ISO timestamp for one-time (or "now")
}

/** LLM client interface for Stage 2 classification. */
export interface CommitmentLLMClient {
  client: OpenAI;
  model: string;
}

// ---------------------------------------------------------------------------
// Text Normalization
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")   // curly single quotes → straight
    .replace(/[\u201C\u201D]/g, '"')   // curly double quotes → straight
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Recurring Patterns (regex only — very specific, reliable)
// ---------------------------------------------------------------------------

const RECURRING_PATTERNS: Array<{
  regex: RegExp;
  extractSchedule: (match: RegExpMatchArray) => string;
}> = [
  {
    regex: /(?:every\s+day|daily)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    extractSchedule: (m) => {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (m[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
      return `${minute} ${hour} * * *`;
    },
  },
  { regex: /every\s+morning/i, extractSchedule: () => '0 7 * * *' },
  { regex: /every\s+evening/i, extractSchedule: () => '0 18 * * *' },
  { regex: /every\s+hour/i, extractSchedule: () => '0 * * * *' },
  { regex: /every\s+(\d+)\s+hours?/i, extractSchedule: (m) => `0 */${m[1]} * * *` },
  { regex: /every\s+(\d+)\s+minutes?/i, extractSchedule: (m) => `*/${m[1]} * * * *` },
  { regex: /(?:every\s+week|weekly)/i, extractSchedule: () => '0 9 * * 1' },
];

const RECURRING_COMMITMENT_CUE = /\b(i(?:'ll| will| can| am going to|\'m going to)|we(?:'ll| will)|scheduled|set to run|will run|running)\b/i;
const RECURRING_NON_COMMITMENT_CUE = /\?|(?:\bfor example\b|\be\.g\.\b|\bsuch as\b|\bhow often\b|\bfrequency\b|\bif you\b|\bwould you\b|\bcould you\b|\bshould i\b|\bor is it enough\b)/i;

// ---------------------------------------------------------------------------
// Time Patterns (for converting time expressions to timestamps)
// ---------------------------------------------------------------------------

const TIME_PATTERNS: Array<{
  regex: RegExp;
  toTimestamp: (match: RegExpMatchArray) => string;
}> = [
  {
    regex: /at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
    toTimestamp: (m) => {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      if (m[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (m[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
      const now = new Date();
      now.setHours(hour, minute, 0, 0);
      if (now.getTime() < Date.now()) now.setDate(now.getDate() + 1);
      return now.toISOString();
    },
  },
  {
    regex: /at\s+(\d{1,2}):(\d{2})(?!\s*(?:am|pm))/i,
    toTimestamp: (m) => {
      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const now = new Date();
      now.setHours(hour, minute, 0, 0);
      if (now.getTime() < Date.now()) now.setDate(now.getDate() + 1);
      return now.toISOString();
    },
  },
  {
    regex: /in\s+(\d+)\s+minutes?/i,
    toTimestamp: (m) => new Date(Date.now() + parseInt(m[1], 10) * 60_000).toISOString(),
  },
  {
    regex: /in\s+(\d+)\s+hours?/i,
    toTimestamp: (m) => new Date(Date.now() + parseInt(m[1], 10) * 3_600_000).toISOString(),
  },
  {
    regex: /tomorrow/i,
    toTimestamp: () => {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(9, 0, 0, 0);
      return t.toISOString();
    },
  },
  {
    regex: /(?:right now|right away|immediately|straightaway|shortly)/i,
    toTimestamp: () => 'now',
  },
  {
    regex: /\btoday\b/i,
    toTimestamp: () => new Date(Date.now() + 5 * 60_000).toISOString(),
  },
];

// ---------------------------------------------------------------------------
// Stage 1: Cheap Candidate Filter ($0 — pure regex)
// ---------------------------------------------------------------------------
// Detects "maybe commitment" sentences using commitment frames.
// Permissive (high recall). Stage 2 filters false positives.

// First-person future/intent markers
const COMMITMENT_FRAMES = [
  /\bI'll\s+(\w+)/i,
  /\bI will\s+(\w+)/i,
  /\bLet me\s+(\w+)/i,
  /\bI'm going to\s+(\w+)/i,
  /\bI can\s+(\w+)/i,
  /\bI'll go ahead and\s+(\w+)/i,
  /\bHappy to\s+(\w+)/i,
];

// Chatter/conversational verbs — NOT real commitments
const CHATTER_VERBS = new Set([
  'think', 'guess', 'say', 'assume', 'consider', 'suggest', 'mention',
  'note', 'clarify', 'explain', 'add', 'point', 'acknowledge', 'reiterate',
  'repeat', 'emphasize', 'highlight', 'know', 'understand', 'see', 'imagine',
  'be', 'keep', 'make', 'have', 'need', 'take', 'leave', 'stay', 'wait',
]);

// Conditional prefixes that weaken commitment signal
const CONDITIONAL_PREFIX = /(?:if you (?:want|like|prefer|need)|would you like me to|should i|shall i)/i;

export function detectCandidates(llmOutput: string, logger: Logger): string[] {
  const normalized = normalizeText(llmOutput);
  const candidates: string[] = [];

  // Split into sentences
  const sentences = normalized.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);

  for (const sentence of sentences) {
    if (CONDITIONAL_PREFIX.test(sentence)) continue;

    let matched = false;
    for (const frame of COMMITMENT_FRAMES) {
      const match = sentence.match(frame);
      if (match) {
        const verb = match[1].toLowerCase();
        if (!CHATTER_VERBS.has(verb)) {
          matched = true;
        }
        break;
      }
    }

    if (matched) candidates.push(sentence);
  }

  if (candidates.length > 0) {
    logger.debug({ count: candidates.length, candidates }, 'Stage 1: commitment candidates detected');
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Stage 2: LLM Classification (~$0.001 per candidate)
// ---------------------------------------------------------------------------

interface CommitmentClassification {
  isCommitment: boolean;
  task: string;
  deliverable: string | null;
  when: 'immediate' | 'scheduled' | 'recurring' | 'ambiguous' | 'none';
  timeExpression: string | null;
  confidence: number;
}

const CLASSIFICATION_PROMPT = `You are a commitment classifier. Analyze if the AI assistant's message contains a real, actionable commitment to do something IN THE FUTURE for the user.

Return ONLY valid JSON:
{"isCommitment":bool,"task":"concise description","deliverable":"what user receives or null","when":"immediate|scheduled|recurring|ambiguous|none","timeExpression":"extracted time or null","confidence":0.0-1.0}

Rules:
- isCommitment=true ONLY for FUTURE actions with a clear time component (remind at 3pm, every morning, tomorrow, etc.)
- isCommitment=false for things the assistant is doing RIGHT NOW in the conversation ("I'll fetch that", "Let me check", "I'll try an alternative")
- isCommitment=false for in-flight actions the assistant is currently performing
- isCommitment=false for conversational intent ("I'll keep that in mind", "I'll think about it")
- "when":"immediate" should ONLY be true if the user explicitly asked for a reminder or scheduled action
- confidence < 0.5 means probably not a real commitment`;

async function classifyCommitment(
  candidate: string,
  fullResponse: string,
  llm: CommitmentLLMClient,
  logger: Logger,
): Promise<CommitmentClassification | null> {
  try {
    const response = await llm.client.chat.completions.create({
      model: llm.model,
      max_completion_tokens: 150,
      temperature: 0,
      messages: [
        { role: 'system', content: CLASSIFICATION_PROMPT },
        { role: 'user', content: `AI said: "${candidate}"\n\nFull response: "${fullResponse.slice(0, 300)}"` },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ raw }, 'Stage 2: no JSON in classification response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as CommitmentClassification;
    logger.debug({ candidate, classification: parsed }, 'Stage 2: commitment classified');
    return parsed;
  } catch (error) {
    logger.warn({ error: String(error), candidate }, 'Stage 2: classification failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main Detection Pipeline
// ---------------------------------------------------------------------------

/**
 * Two-stage commitment detection.
 *
 * Stage 1: Regex candidate filter ($0, ~0ms)
 * Stage 2: LLM classification (~$0.001, only when Stage 1 triggers)
 *
 * @param llmOutput - The LLM's response text
 * @param logger - Pino logger
 * @param llm - Optional LLM client for Stage 2. If omitted, Stage 1 only.
 */
export async function detectCommitments(
  llmOutput: string,
  logger: Logger,
  llm?: CommitmentLLMClient,
): Promise<DetectedCommitment[]> {
  const commitments: DetectedCommitment[] = [];
  const normalized = normalizeText(llmOutput);

  // 1. Check for recurring commitments (regex only — very specific patterns)
  for (const pattern of RECURRING_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (match) {
      const promiseContext = extractPromiseContext(normalized, match.index ?? 0) || match[0];
      if (RECURRING_NON_COMMITMENT_CUE.test(promiseContext)) {
        logger.debug({ match: match[0], promiseContext }, 'Ignoring recurring pattern in non-commitment context');
        continue;
      }
      if (!RECURRING_COMMITMENT_CUE.test(promiseContext)) {
        logger.debug({ match: match[0], promiseContext }, 'Ignoring recurring pattern without commitment cue');
        continue;
      }

      const schedule = pattern.extractSchedule(match);
      commitments.push({
        type: 'recurring',
        promiseText: match[0],
        actionDescription: promiseContext || match[0],
        schedule,
      });
      logger.debug({ type: 'recurring', schedule, match: match[0] }, 'Detected recurring commitment');
    }
  }

  if (commitments.length > 0) return commitments;

  // 2. Two-stage detection for one-time commitments
  const candidates = detectCandidates(llmOutput, logger);
  if (candidates.length === 0) return commitments;

  if (llm) {
    // Stage 2: LLM classification (max 2 candidates to limit cost)
    for (const candidate of candidates.slice(0, 2)) {
      const classification = await classifyCommitment(candidate, llmOutput, llm, logger);

      if (classification?.isCommitment && classification.confidence >= 0.6) {
        // Resolve time expression
        let executeAt = 'now';
        const timeSource = classification.timeExpression ?? llmOutput;
        for (const timePat of TIME_PATTERNS) {
          const timeMatch = timeSource.match(timePat.regex) ?? llmOutput.match(timePat.regex);
          if (timeMatch) {
            executeAt = timePat.toTimestamp(timeMatch);
            break;
          }
        }

        commitments.push({
          type: classification.when === 'recurring' ? 'recurring' : 'one_time',
          promiseText: candidate,
          actionDescription: classification.task,
          executeAt: classification.when !== 'recurring' ? executeAt : undefined,
        });

        logger.info(
          { task: classification.task, when: classification.when, confidence: classification.confidence },
          'Commitment confirmed by Stage 2',
        );
        break; // One confirmed commitment per response
      }
    }
  } else {
    // Fallback: no LLM client — use Stage 1 candidate as-is
    const candidate = candidates[0];
    let executeAt = 'now';
    for (const timePat of TIME_PATTERNS) {
      const timeMatch = llmOutput.match(timePat.regex);
      if (timeMatch) {
        executeAt = timePat.toTimestamp(timeMatch);
        break;
      }
    }
    commitments.push({
      type: 'one_time',
      promiseText: candidate,
      actionDescription: candidate,
      executeAt,
    });
  }

  return commitments;
}

/** Extract surrounding sentence context for a match position. */
function extractPromiseContext(text: string, matchIndex: number): string {
  const before = text.lastIndexOf('.', matchIndex);
  const after = text.indexOf('.', matchIndex);
  const start = before >= 0 ? before + 1 : 0;
  const end = after >= 0 ? after : text.length;
  return text.slice(start, end).trim();
}
