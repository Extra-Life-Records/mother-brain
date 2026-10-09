import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function header(text: string): void {
  console.log(`\n${BOLD}${CYAN}${text}${RESET}`);
}

function step(num: number, text: string): void {
  console.log(`\n${BOLD}Step ${num}:${RESET} ${text}`);
}

function hint(text: string): void {
  console.log(`  ${DIM}${text}${RESET}`);
}

function success(text: string): void {
  console.log(`  ${GREEN}✓${RESET} ${text}`);
}

function warn(text: string): void {
  console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}

// ---------------------------------------------------------------------------
// Init Wizard
// ---------------------------------------------------------------------------

export async function runInitWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  header('🧠 Mother Brain Daemon — Setup Wizard');
  console.log('This will guide you through configuring the daemon.\n');

  const dataDir = join(homedir(), '.mother-brain-daemon');
  const configPath = join(dataDir, 'config.json');

  if (existsSync(configPath)) {
    const overwrite = await rl.question('Config already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      rl.close();
      return;
    }
  }

  // --- Step 1: GitHub PAT ---
  step(1, 'GitHub Personal Access Token');
  hint('Required for Copilot model access (no per-token cost).');
  hint('Create one at: https://github.com/settings/tokens');
  hint('Scope needed: models:read');
  console.log();
  const githubToken = await rl.question('  Paste your GitHub PAT: ');

  if (!githubToken.startsWith('ghp_') && !githubToken.startsWith('github_pat_')) {
    warn('Token doesn\'t look like a GitHub PAT. Continuing anyway...');
  } else {
    success('Token accepted');
  }

  // --- Step 2: Model selection (five-tier) ---
  step(2, 'LLM Model Tiers');
  hint('The daemon uses five model tiers, each optimized for its job:');
  hint('  🔧 Background — heartbeat, classification (local = $0)');
  hint('  💬 Chat       — understanding, conversing, organising');
  hint('  📋 Planning   — planning, breaking down approaches');
  hint('  🏗️  Coding     — implementation (premium)');
  hint('  🔍 Review     — code review');
  console.log();

  // Background tier
  header('  🔧 Background Tier (mindless tasks)');
  console.log('  1. Local Ollama with Copilot fallback (recommended — free when available)');
  console.log('  2. Copilot only (uses subscription)');
  console.log();
  const bgChoice = await rl.question('  Select (1-2): ');

  let backgroundTier: { provider: string; model: string; fallback?: { provider: string; model: string } };
  let localBaseUrl = 'http://localhost:11434';
  if (bgChoice.trim() === '2') {
    backgroundTier = { provider: 'copilot', model: 'openai/gpt-4.1-mini' };
    success(`Background: copilot/gpt-4.1-mini`);
  } else {
    const localModel = (await rl.question('  Ollama model name (default: qwen3): ')).trim() || 'qwen3';
    localBaseUrl = (await rl.question(`  Ollama URL (default: ${localBaseUrl}): `)).trim() || localBaseUrl;
    backgroundTier = {
      provider: 'local',
      model: localModel,
      fallback: { provider: 'copilot', model: 'openai/gpt-4.1-mini' },
    };
    success(`Background: local/${localModel} → fallback: copilot/gpt-4.1-mini`);
  }

  // Chat tier
  console.log();
  header('  💬 Chat Tier (understanding, conversing, organising)');
  console.log('  1. openai/gpt-5 (recommended)');
  console.log('  2. openai/gpt-4.1');
  console.log('  3. Custom');
  console.log();
  const chatChoice = await rl.question('  Select (1-3): ');

  let chatModel: string;
  switch (chatChoice.trim()) {
    case '1': chatModel = 'openai/gpt-5'; break;
    case '2': chatModel = 'openai/gpt-4.1'; break;
    case '3': chatModel = await rl.question('  Enter model ID: '); break;
    default: chatModel = 'openai/gpt-5';
  }
  success(`Chat: copilot/${chatModel}`);

  // Planning tier
  console.log();
  header('  📋 Planning Tier (planning, breaking down approaches)');
  console.log('  1. claude-opus-4.6 (recommended — best reasoning)');
  console.log('  2. openai/gpt-5');
  console.log('  3. Custom');
  console.log();
  const planChoice = await rl.question('  Select (1-3): ');

  let planningModel: string;
  switch (planChoice.trim()) {
    case '1': planningModel = 'claude-opus-4.6'; break;
    case '2': planningModel = 'openai/gpt-5'; break;
    case '3': planningModel = await rl.question('  Enter model ID: '); break;
    default: planningModel = 'claude-opus-4.6';
  }
  success(`Planning: copilot/${planningModel}`);

  // Coding tier
  console.log();
  header('  🏗️  Coding Tier (implementation — premium)');
  console.log('  1. openai/gpt-5 (recommended — best coder)');
  console.log('  2. openai/gpt-4.1');
  console.log('  3. Custom');
  console.log();
  const codeChoice = await rl.question('  Select (1-3): ');

  let codingModel: string;
  switch (codeChoice.trim()) {
    case '1': codingModel = 'openai/gpt-5'; break;
    case '2': codingModel = 'openai/gpt-4.1'; break;
    case '3': codingModel = await rl.question('  Enter model ID: '); break;
    default: codingModel = 'openai/gpt-5';
  }
  success(`Coding: copilot/${codingModel}`);

  // Review tier
  console.log();
  header('  🔍 Review Tier (code review)');
  console.log('  1. openai/gpt-5 (recommended)');
  console.log('  2. openai/gpt-4.1');
  console.log('  3. Custom');
  console.log();
  const revChoice = await rl.question('  Select (1-3): ');

  let reviewModel: string;
  switch (revChoice.trim()) {
    case '1': reviewModel = 'openai/gpt-5'; break;
    case '2': reviewModel = 'openai/gpt-4.1'; break;
    case '3': reviewModel = await rl.question('  Enter model ID: '); break;
    default: reviewModel = 'openai/gpt-5';
  }
  success(`Review: copilot/${reviewModel}`);

  // --- Step 3: Telegram ---
  step(3, 'Telegram Bot');
  hint('The daemon sends notifications and responds to commands via Telegram.');
  hint('1. Open Telegram → search @BotFather → send /newbot');
  hint('2. Follow the prompts to name your bot');
  hint('3. Copy the bot token BotFather gives you');
  console.log();
  const botToken = await rl.question('  Paste your bot token: ');

  if (!botToken.includes(':')) {
    warn('Token doesn\'t look like a Telegram bot token. Continuing anyway...');
  } else {
    success('Bot token accepted');
  }

  hint('Now send any message to your bot in Telegram, then...');
  hint('To get your Chat ID: Open https://api.telegram.org/bot<TOKEN>/getUpdates');
  hint('Or send /start to your bot and check the response.');
  console.log();
  const chatId = await rl.question('  Enter your Telegram chat ID: ');
  success(`Chat ID: ${chatId}`);

  // --- Step 4: Schedule ---
  step(4, 'Active Hours');
  hint('When should the daemon run? (24h format, e.g., 23 for 11pm)');
  console.log();
  const startHour = parseInt((await rl.question('  Start hour (default: 23): ')).trim() || '23', 10);
  const endHour = parseInt((await rl.question('  End hour (default: 7): ')).trim() || '7', 10);
  const timezoneDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = (await rl.question(`  Timezone (default: ${timezoneDefault}): `)).trim() || timezoneDefault;
  success(`Schedule: ${startHour}:00 — ${endHour}:00 ${timezone}`);

  // --- Step 5: Budget ---
  step(5, 'Budget');
  hint('Track and cap all token usage across the daemon.');
  const budgetStr = (await rl.question('  Max spend per session in USD (default: 5.00): ')).trim() || '5.00';
  const budget = parseFloat(budgetStr);
  success(`Session cap: $${budget.toFixed(2)}`);

  hint('Global lifetime cap prevents runaway costs across all sessions.');
  const globalCapStr = (await rl.question('  Global lifetime cap in USD (default: 100.00): ')).trim() || '100.00';
  const globalCap = parseFloat(globalCapStr);
  success(`Global cap: $${globalCap.toFixed(2)}`);

  // --- Write config ---
  header('Writing configuration...');

  const config: Record<string, unknown> = {
    activeHours: { start: startHour, end: endHour },
    timezone,
    budget: { perNight: budget, globalCap, currency: 'USD' },
    telegram: { botToken, chatId, wakeTime: `${endHour.toString().padStart(2, '0')}:00` },
    llm: {
      githubToken,
      ...(backgroundTier.provider === 'local' ? { local: { enabled: true, baseUrl: localBaseUrl, model: backgroundTier.model } } : {}),
      tiers: {
        background: backgroundTier,
        chat: { provider: 'copilot', model: chatModel },
        planning: { provider: 'copilot', model: planningModel },
        coding: { provider: 'copilot', model: codingModel },
        review: { provider: 'copilot', model: reviewModel },
      },
    },
    heartbeatMinutes: 15,
  };

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  success(`Config written to: ${configPath}`);

  // --- Test connection ---
  header('Testing connections...');

  // Test each unique model on GitHub Models API
  const modelsToTest = new Set<string>();
  if (backgroundTier.provider === 'copilot') modelsToTest.add(backgroundTier.model);
  if (backgroundTier.fallback) modelsToTest.add(backgroundTier.fallback.model);
  modelsToTest.add(chatModel);
  modelsToTest.add(planningModel);
  modelsToTest.add(codingModel);
  modelsToTest.add(reviewModel);

  for (const model of modelsToTest) {
    try {
      const res = await fetch(`https://models.github.ai/inference/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
          max_completion_tokens: 10,
        }),
      });
      if (res.ok) {
        success(`${model} — connected`);
      } else {
        const body = await res.text();
        warn(`${model} — ${res.status}: ${body.slice(0, 100)}`);
      }
    } catch (error) {
      warn(`${model} — failed: ${error}`);
    }
  }

  // Test Telegram bot
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🧠 Mother Brain Daemon connected! Setup complete.',
      }),
    });
    if (res.ok) {
      success('Telegram — message sent! Check your phone.');
    } else {
      const body = await res.text();
      warn(`Telegram — ${res.status}: ${body.slice(0, 100)}`);
    }
  } catch (error) {
    warn(`Telegram — failed: ${error}`);
  }

  // --- Done ---
  header('🎉 Setup Complete!');
  console.log();
  console.log(`  Config: ${configPath}`);
  console.log(`  🔧 Background: ${backgroundTier.provider}/${backgroundTier.model}${backgroundTier.fallback ? ` → fallback: ${backgroundTier.fallback.provider}/${backgroundTier.fallback.model}` : ''}`);
  console.log(`  💬 Chat:       copilot/${chatModel}`);
  console.log(`  📋 Planning:   copilot/${planningModel}`);
  console.log(`  🏗️  Coding:     copilot/${codingModel}`);
  console.log(`  🔍 Review:     copilot/${reviewModel}`);
  console.log(`  Hours:  ${startHour}:00 — ${endHour}:00 ${timezone}`);
  console.log();
  console.log(`  ${BOLD}Start the daemon:${RESET}`);
  console.log(`    cd daemon && npm run build && node dist/index.js start`);
  console.log();
  console.log(`  ${BOLD}Add projects via Telegram:${RESET}`);
  console.log(`    /addproject /path/to/your/repo`);
  console.log(`    /work project-name`);
  console.log(`    /projects`);
  console.log();
  console.log(`  ${BOLD}Or with pm2:${RESET}`);
  console.log(`    pm2 start dist/index.js --name mother-brain-daemon -- start`);
  console.log();

  rl.close();
}
