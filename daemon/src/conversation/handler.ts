import OpenAI from 'openai';
import type { Logger } from 'pino';
import type { DaemonConfig } from '../core/config.js';
import type { ConversationMemory } from './memory.js';
import type { PersonaConfig } from './persona.js';
import type { BudgetTracker } from '../budget/tracker.js';
import type { ProjectManager } from '../db/projects.js';
import { detectCommitments } from '../commitment/detector.js';
import type { DetectedCommitment, CommitmentLLMClient } from '../commitment/detector.js';
import type { ToolRegistry } from '../tools/index.js';
import type { TaskLedger } from '../tasks/index.js';
import { runPipeline } from '../tasks/index.js';
import type { PipelineResult, HeartbeatCallback, AutoPublishCallback } from '../tasks/index.js';
import type { BlockerMemory } from '../tasks/index.js';
import { ChatGPTCodexClient } from '../llm/chatgpt-codex.js';
import type { ResponsesInput, ResponsesTool } from '../llm/chatgpt-codex.js';
import {
  BrainStateManager,
  getPhasePrompt,
  buildDiscoveryContext,
  detectTransition,
} from './brain-runtime.js';
import type { ConversationPhase, DiscoveryData } from './brain-runtime.js';

// ---------------------------------------------------------------------------
// Intent Classification (lightweight, $0 — no LLM call)
// ---------------------------------------------------------------------------

export type MessageIntent =
  | 'project_description'  // User describing a project or repo
  | 'vision_statement'     // User expressing goals/direction
  | 'help_request'         // User asking for help with something
  | 'status_query'         // User asking about daemon/project status
  | 'casual_chat'          // General conversation
  | 'command';             // Explicit command (fallback to bot commands)

export function classifyIntent(text: string): MessageIntent {
  const lower = text.toLowerCase().trim();
  if (lower.startsWith('/')) return 'command';
  if ([/(?:working on|building|creating|developing|my project|my repo|my app)/,
       /(?:github\.com|gitlab\.com|bitbucket\.org)/,
       /(?:repo(?:sitory)?|codebase|workspace).*(?:at|in|is)/,
       /(?:c:|d:|\/home\/|\/users\/|~\/).*(?:\.git|src|package\.json)/i,
  ].some(p => p.test(lower))) return 'project_description';
  if ([/(?:i want|i need|i'd like|goal is|vision is|plan is|idea is)/,
       /(?:should be able to|needs to|must be able to)/,
       /(?:the end result|ultimately|the product should|the app should)/,
  ].some(p => p.test(lower))) return 'vision_statement';
  if ([/(?:help me|can you|how do i|how to|what's the best way)/,
       /(?:stuck on|struggling with|having trouble|can't figure)/,
  ].some(p => p.test(lower))) return 'help_request';
  if ([/(?:status|progress|how's it going|what are you doing|what did you do)/,
       /(?:update|report|results|anything new)/,
  ].some(p => p.test(lower))) return 'status_query';
  return 'casual_chat';
}

// ---------------------------------------------------------------------------
// Tool Output Truncation — prevent token overflow
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT_CHARS = 3000; // ~750 tokens — safe for 8k context

function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n\n[... truncated, ${output.length} total chars]`;
}

function normalizeModelErrorText(error: unknown): string {
  const err = error as {
    message?: string;
    code?: string;
    status?: number;
    error?: { message?: string };
  };
  const parts = [
    typeof err.status === 'number' ? `status ${err.status}` : '',
    typeof err.code === 'string' ? err.code : '',
    typeof err.message === 'string' ? err.message : '',
    typeof err.error?.message === 'string' ? err.error.message : '',
    error instanceof Error ? error.message : '',
  ];
  return parts.join(' ').toLowerCase();
}

function isFallbackWorthyModelError(error: unknown): boolean {
  const text = normalizeModelErrorText(error);
  return (
    text.includes('429') ||
    text.includes('too many requests') ||
    text.includes('rate limit') ||
    text.includes('unknown model') ||
    text.includes('model_not_found') ||
    text.includes('404')
  );
}

// ---------------------------------------------------------------------------
// Conversation Handler — routes through Brain Runtime
// ---------------------------------------------------------------------------

export interface ConversationResponse {
  text: string;
  intent: MessageIntent;
  phase: ConversationPhase;
  extractedProject?: { name: string; path: string };
  detectedCommitments?: DetectedCommitment[];
  inputTokens: number;
  outputTokens: number;
}

const GITHUB_MODELS_BASE_URL = 'https://models.github.ai/inference';

export class ConversationHandler {
  private client: OpenAI;
  private model: string;
  private brainState: BrainStateManager;
  private toolRegistry: ToolRegistry | null = null;
  private taskLedger: TaskLedger | null = null;
  private blockerMemory: BlockerMemory | null = null;
  private autoPublish: AutoPublishCallback | null = null;
  private plannerModel: string | undefined;
  private verifierModel: string | undefined;
  private chatFallbackModels: string[] = [];
  private plannerClient: OpenAI | undefined;
  private verifierClient: OpenAI | undefined;
  private codexClient: ChatGPTCodexClient | null = null;

  constructor(
    config: DaemonConfig,
    private _persona: PersonaConfig,
    private memory: ConversationMemory,
    private projectManager: ProjectManager,
    private logger: Logger,
    private budgetTracker?: BudgetTracker,
    private sessionId?: string,
  ) {
    const chatTier = config.llm.tiers?.chat;
    const githubToken = config.llm.githubToken ?? config.llm.copilot?.githubToken;
    const oauthCreds = config.llm.openaiOAuth;

    // ChatGPT subscription path: use Codex Responses API for chat
    if (chatTier && chatTier.provider === 'openai' && oauthCreds?.accessToken) {
      this.codexClient = new ChatGPTCodexClient(oauthCreds.accessToken, chatTier.model, logger);
      this.model = chatTier.model;
      // Still set up a fallback OpenAI client for auxiliary tasks (commitment detection)
      if (githubToken) {
        this.client = new OpenAI({ baseURL: GITHUB_MODELS_BASE_URL, apiKey: githubToken });
      } else {
        this.client = new OpenAI({ baseURL: 'https://api.openai.com/v1', apiKey: 'unused' });
      }
    } else if (chatTier && chatTier.provider === 'copilot' && githubToken) {
      this.client = new OpenAI({
        baseURL: GITHUB_MODELS_BASE_URL,
        apiKey: githubToken,
      });
      this.model = chatTier.model;
    } else if (githubToken) {
      this.client = new OpenAI({
        baseURL: GITHUB_MODELS_BASE_URL,
        apiKey: githubToken,
      });
      this.model = config.llm.copilot?.model ?? 'openai/gpt-4.1';
    } else {
      throw new Error('No LLM provider available for conversation.');
    }

    // Resolve planner/verifier — may use different provider than chat
    const planningTier = config.llm.tiers?.planning;
    const reviewTier = config.llm.tiers?.review;
    this.plannerModel = planningTier?.model;
    this.verifierModel = reviewTier?.model;

    // Create separate client for planning/verification if different provider
    if (planningTier && planningTier.provider === 'copilot' && githubToken) {
      this.plannerClient = new OpenAI({
        baseURL: GITHUB_MODELS_BASE_URL,
        apiKey: githubToken,
      });
    }

    if (reviewTier && reviewTier.provider === 'copilot' && githubToken) {
      this.verifierClient = new OpenAI({
        baseURL: GITHUB_MODELS_BASE_URL,
        apiKey: githubToken,
      });
    }

    const chatFallbackCandidates = [
      chatTier?.fallback?.model,
      'openai/gpt-4.1',
      'openai/gpt-4.1-mini',
    ];
    this.chatFallbackModels = Array.from(new Set(
      chatFallbackCandidates
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
        .filter((value) => value !== this.model),
    ));

    this.logger.info({
      chatModel: this.model,
      chatFallbackModels: this.chatFallbackModels,
      chatProvider: this.codexClient ? 'chatgpt-codex' : 'openai-sdk',
      plannerModel: this.plannerModel ?? '(same as chat)',
      verifierModel: this.verifierModel ?? '(same as chat)',
    }, 'LLM model routing configured');

    // Initialize brain state manager (uses same DB as conversation memory)
    this.brainState = new BrainStateManager(this.memory.getDb(), this.logger);

    // If there are existing projects, start in active phase
    const projects = this.projectManager.listProjects();
    if (projects.length > 0) {
      const state = this.brainState.getState();
      if (state.phase === 'greeting') {
        this.brainState.updateState('active', state.discoveryData);
      }
    }
  }

  /**
   * Handle an incoming user message through the Brain Runtime.
   * The runtime tracks which phase of Mother Brain's process we're in
   * and constrains the LLM to follow that phase's rules.
   */
  async handleMessage(userMessage: string): Promise<ConversationResponse> {
    const intent = classifyIntent(userMessage);
    this.memory.addMessage('user', userMessage, intent);

    // Get current brain state
    let state = this.brainState.getState();

    // Extract entities from user message and update discovery data
    const updatedData = this.extractEntities(userMessage, state.discoveryData);

    // Check for phase transition
    const newPhase = detectTransition(state.phase, userMessage, updatedData);
    if (newPhase) {
      this.logger.info({ from: state.phase, to: newPhase }, 'Phase transition');
      this.brainState.updateState(newPhase, updatedData);
      state = { phase: newPhase, discoveryData: updatedData, updatedAt: new Date().toISOString() };
    } else {
      // Update discovery data without phase change
      this.brainState.updateState(state.phase, updatedData);
    }

    // Increment questions counter
    this.brainState.incrementQuestions(state);

    // Build phase-specific system prompt
    const systemPrompt = this.buildPhasePrompt(state.phase, updatedData);

    // Get conversation context — enough history for continuity
    const messages = this.memory.buildLLMContext(systemPrompt, 12);

    this.logger.debug(
      { phase: state.phase, intent, messageCount: messages.length },
      'Processing message through brain runtime',
    );

    // Call LLM with constrained prompt — handle content filter errors
    // If tools are available, include them and handle tool-call responses.
    let reply: string;
    let inputTokens = 0;
    let outputTokens = 0;

    const openAITools = this.toolRegistry && this.toolRegistry.size > 0
      ? this.toolRegistry.toOpenAITools() as OpenAI.ChatCompletionTool[]
      : undefined;

    // Route through ChatGPT Codex Responses API when subscription auth is active
    if (this.codexClient) {
      try {
        const result = await this.handleMessageCodex(systemPrompt, messages, openAITools);
        reply = result.reply;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
      } catch (error: unknown) {
        this.logger.error({ error: String(error) }, 'Codex API error — sending graceful response');
        reply = "I had a brief connection issue. Could you say that again?";
      }
    } else {
    // Standard OpenAI SDK path (GitHub Models / direct API)
    try {
      let currentMessages = [...messages as OpenAI.ChatCompletionMessageParam[]];
      const MAX_TOOL_ROUNDS = 5;
      let toolRound = 0;
      reply = '';

      // Multi-turn tool-use loop: LLM can call tools multiple times
      while (toolRound <= MAX_TOOL_ROUNDS) {
        const response = await this.createChatCompletionWithFallback(
          currentMessages,
          openAITools,
          openAITools ? 1024 : 512,
        );

        inputTokens += response.usage?.prompt_tokens ?? 0;
        outputTokens += response.usage?.completion_tokens ?? 0;
        const choice = response.choices[0];

        // If the LLM wants to call tools, execute them and loop
        if (choice?.message?.tool_calls?.length && this.toolRegistry) {
          toolRound++;
          currentMessages.push(choice.message as OpenAI.ChatCompletionAssistantMessageParam);

          for (const toolCall of choice.message.tool_calls) {
            const toolName = toolCall.function.name;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(toolCall.function.arguments); } catch { /* empty args */ }

            this.logger.info({ tool: toolName, args, round: toolRound }, 'Executing tool call from LLM');
            const result = await this.toolRegistry.execute(toolName, args, this.logger);

            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result.success
                ? truncateToolOutput(JSON.stringify(result.output))
                : `Error: ${result.error ?? 'Unknown error'}`,
            });
          }
          // Continue loop — LLM will see tool results and either call more tools or respond
          continue;
        }

        // No tool calls — LLM is done, extract text response
        reply = choice?.message?.content ?? "Let me think about that...";
        break;
      }

      if (!reply) {
        reply = "I used several tools but ran out of rounds. Here's what I found so far — please ask again if you need more.";
      }
    } catch (error: unknown) {
      // Handle Azure content filter or other API errors gracefully
      const errorCode = (error as { code?: string })?.code;
      const errorMessage = (error as { error?: { message?: string } })?.error?.message ?? '';
      if (errorCode === 'content_filter') {
        this.logger.warn({ error: errorCode }, 'Content filter triggered — sending graceful response');
        reply = "I understand! Let me think about the best way to approach that. Could you tell me a bit more about what you'd like to focus on?";
      } else if (errorCode === 'tokens_limit_reached' || errorMessage.includes('too large')) {
        // Self-healing: aggressively reduce tool outputs and retry once
        this.logger.warn('Token limit reached — auto-reducing and retrying');
        try {
          // Find all tool messages and aggressively truncate
          const reducedMessages = messages.map(m => {
            if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 500) {
              return { ...m, content: m.content.slice(0, 500) + '\n[reduced due to size]' };
            }
            return m;
          }) as OpenAI.ChatCompletionMessageParam[];

          const retryResponse = await this.createChatCompletionWithFallback(reducedMessages, undefined, 512);
          reply = retryResponse.choices[0]?.message?.content ?? "I fetched data but it was too large. Try a more specific request.";
          inputTokens += retryResponse.usage?.prompt_tokens ?? 0;
          outputTokens += retryResponse.usage?.completion_tokens ?? 0;
        } catch {
          reply = "I fetched the data but it was too large to process. Try a more specific request.";
        }
      } else {
        throw error;
      }
    }
    } // end else (standard SDK path)

    this.memory.addMessage('assistant', reply, intent);

    // Two-stage commitment detection: regex filter → LLM classification
    const commitmentLLM: CommitmentLLMClient = { client: this.client, model: this.model };
    const detectedCommitments = await detectCommitments(reply, this.logger, commitmentLLM);

    // Record token usage
    if (this.budgetTracker && this.sessionId && (inputTokens > 0 || outputTokens > 0)) {
      const activeProject = this.projectManager.getActiveProject();
      const provider = this.codexClient ? 'chatgpt-codex' : 'copilot';
      this.budgetTracker.recordUsage(
        this.sessionId, provider, this.model, inputTokens, outputTokens,
        'chat', activeProject?.id,
      );
    }

    this.logger.info(
      { phase: state.phase, intent, inputTokens, outputTokens },
      'Brain runtime response generated',
    );

    return {
      text: reply,
      intent,
      phase: state.phase,
      detectedCommitments: detectedCommitments.length > 0 ? detectedCommitments : undefined,
      inputTokens,
      outputTokens,
    };
  }

  /** Check if the user is new (no conversation history). */
  isNewUser(): boolean {
    return this.memory.isNewUser();
  }

  /** Get the greeting message (no LLM call). */
  getGreeting(): string {
    return this._persona.greeting;
  }

  /** Get current phase for status reporting. */
  getCurrentPhase(): ConversationPhase {
    return this.brainState.getState().phase;
  }

  /** Reset conversation state to start fresh. */
  resetConversation(): void {
    this.brainState.reset();
    this.logger.info('Conversation state reset by user');
  }

  /** Attach a tool registry for function-calling in conversations. */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
    this.logger.info({ tools: registry.size }, 'Tool registry attached to conversation handler');
  }

  /** Attach a task ledger for pipeline execution. */
  setTaskLedger(ledger: TaskLedger): void {
    this.taskLedger = ledger;
  }

  /** Attach blocker memory for self-learning. */
  setBlockerMemory(memory: BlockerMemory): void {
    this.blockerMemory = memory;
  }

  /** Attach an auto-publisher to publish deployable outputs after verified tasks. */
  setAutoPublish(callback: AutoPublishCallback): void {
    this.autoPublish = callback;
  }

  /** Run a task through the full planner/executor/verifier pipeline. */
  async executeTask(taskId: string, onHeartbeat?: HeartbeatCallback): Promise<PipelineResult | null> {
    if (!this.toolRegistry || !this.taskLedger) {
      this.logger.error('Cannot run pipeline — tool registry or task ledger not set');
      return null;
    }
    return runPipeline(taskId, {
      client: this.client,
      model: this.model,
      plannerClient: this.plannerClient,
      plannerModel: this.plannerModel,
      verifierClient: this.verifierClient,
      verifierModel: this.verifierModel,
      toolRegistry: this.toolRegistry,
      taskLedger: this.taskLedger,
      logger: this.logger,
      blockerMemory: this.blockerMemory ?? undefined,
      onHeartbeat,
      autoPublish: this.autoPublish ?? undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Handle a message via the ChatGPT Codex Responses API.
   * Converts chat history to Responses API format and handles tool calls.
   */
  private async handleMessageCodex(
    systemPrompt: string,
    messages: Array<{ role: string; content?: string | null }>,
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<{ reply: string; inputTokens: number; outputTokens: number }> {
    // Convert chat history to Responses API input format
    const input: ResponsesInput[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') continue;
      if ((msg.role === 'user' || msg.role === 'assistant') && msg.content) {
        input.push({ role: msg.role, content: msg.content });
      }
    }

    // Convert OpenAI tool definitions to Responses API format
    const codexTools: ResponsesTool[] | undefined = tools?.map(t => ({
      type: 'function' as const,
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: (t.function.parameters ?? {}) as Record<string, unknown>,
    }));

    let reply = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const MAX_TOOL_ROUNDS = 5;
    let toolRound = 0;

    while (toolRound <= MAX_TOOL_ROUNDS) {
      const response = await this.codexClient!.chat(systemPrompt, input, codexTools);
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;

      // If the LLM wants to call tools, execute them and loop
      if (response.toolCalls.length > 0 && this.toolRegistry) {
        toolRound++;
        for (const tc of response.toolCalls) {
          input.push({
            type: 'function_call',
            name: tc.name,
            arguments: tc.arguments,
            call_id: tc.callId,
          });

          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.arguments); } catch { /* empty args */ }

          this.logger.info({ tool: tc.name, args, round: toolRound }, 'Executing tool call from Codex');
          const result = await this.toolRegistry.execute(tc.name, args, this.logger);

          input.push({
            type: 'function_call_output',
            call_id: tc.callId,
            output: result.success
              ? truncateToolOutput(JSON.stringify(result.output))
              : `Error: ${result.error ?? 'Unknown error'}`,
          });
        }
        continue;
      }

      // No tool calls — extract text response
      reply = response.text || "Let me think about that...";
      break;
    }

    if (!reply) {
      reply = "I used several tools but ran out of rounds. Please ask again if you need more.";
    }

    return { reply, inputTokens, outputTokens };
  }

  private async createChatCompletionWithFallback(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    maxCompletionTokens: number,
  ) {
    const models = [this.model, ...this.chatFallbackModels];
    let lastError: unknown = null;

    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      try {
        return await this.client.chat.completions.create({
          model,
          max_completion_tokens: maxCompletionTokens,
          messages,
          ...(tools ? { tools } : {}),
        });
      } catch (error) {
        lastError = error;
        const nextModel = models[i + 1];
        if (!nextModel || !isFallbackWorthyModelError(error)) {
          throw error;
        }

        this.logger.warn(
          {
            fromModel: model,
            toModel: nextModel,
            error: normalizeModelErrorText(error),
          },
          'Chat completion failed; retrying with fallback model',
        );
      }
    }

    throw (lastError instanceof Error ? lastError : new Error('Chat completion failed'));
  }

  /** Build phase-aware system prompt with project context. */
  private buildPhasePrompt(phase: ConversationPhase, data: DiscoveryData): string {
    let prompt = getPhasePrompt(phase);

    // Add discovery context
    prompt += buildDiscoveryContext(data);

    // Add project context for active phase
    if (phase === 'active') {
      const projects = this.projectManager.listProjects();
      if (projects.length > 0) {
        const projectList = projects
          .map(p => `- ${p.name}${p.active ? ' [ACTIVE]' : ''}: ${p.repoPath}`)
          .join('\n');
        prompt += `\n\nRegistered projects:\n${projectList}`;
      }

      // Append tool manifest so the LLM knows what tools are available
      if (this.toolRegistry && this.toolRegistry.size > 0) {
        prompt += `\n\nAVAILABLE TOOLS:\n${this.toolRegistry.generateManifest()}`;
        prompt += '\nYou may call these tools via function calling when the user asks you to perform actions.';
      }
    }

    return prompt;
  }

  /** Extract project entities from user message to build discovery data. */
  private extractEntities(message: string, current: DiscoveryData): DiscoveryData {
    const updated = { ...current, userNeeds: [...current.userNeeds], visionNotes: [...current.visionNotes] };

    // Extract project name (heuristic)
    const nameMatch = message.match(/(?:called|named|it's|project is)\s+"?([A-Za-z][\w-]*)"?/i)
      ?? message.match(/(?:working on|building)\s+"?([A-Za-z][\w-]*)"?/i);
    if (nameMatch && !updated.projectName) {
      updated.projectName = nameMatch[1];
    }

    // Extract paths
    const pathMatch = message.match(/((?:[A-Z]:\\|\/home\/|\/Users\/|~\/)\S+)/);
    if (pathMatch && !updated.projectPath) {
      updated.projectPath = pathMatch[1];
    }

    // Extract GitHub URLs
    const githubMatch = message.match(/(https?:\/\/github\.com\/\S+)/i);
    if (githubMatch && !updated.projectPath) {
      updated.projectPath = githubMatch[1];
    }

    // Extract user needs (vision-level statements)
    const needPatterns = [
      /(?:i want|i need|should be able to|must be able to|needs to)\s+(.{10,80})/i,
      /(?:ability to|able to)\s+(.{10,60})/i,
    ];
    for (const pattern of needPatterns) {
      const match = message.match(pattern);
      if (match && !updated.userNeeds.includes(match[1])) {
        updated.userNeeds.push(match[1].trim());
      }
    }

    return updated;
  }
}
