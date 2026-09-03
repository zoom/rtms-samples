export type AiProviderName = 'anthropic' | 'openai' | 'openrouter';

export type AiConfig = {
  provider: AiProviderName;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
  taskPrompt?: string;
  openRouterBaseUrl: string;
  openRouterHttpReferer?: string;
  openRouterAppName?: string;
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const value = Number(environment[name] || fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} has an invalid value`);
  return value;
}

export function loadAiConfig(environment: NodeJS.ProcessEnv = process.env): AiConfig {
  const provider = required(environment, 'AI_PROVIDER').toLowerCase();
  if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openrouter') {
    throw new Error('AI_PROVIDER must be anthropic, openai, or openrouter');
  }

  const keyVariable = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY'
  }[provider];
  const modelVariable = {
    anthropic: 'ANTHROPIC_MODEL',
    openai: 'OPENAI_MODEL',
    openrouter: 'OPENROUTER_MODEL'
  }[provider];
  const model = environment.AI_MODEL?.trim() || environment[modelVariable]?.trim();
  if (!model) throw new Error(`AI_MODEL or ${modelVariable} is required`);

  return {
    provider,
    apiKey: required(environment, keyVariable),
    model,
    maxOutputTokens: integer(environment, 'AI_MAX_OUTPUT_TOKENS', 1000, 1),
    timeoutMs: integer(environment, 'AI_TIMEOUT_MS', 30000, 1000),
    maxRetries: integer(environment, 'AI_MAX_RETRIES', 2, 0),
    taskPrompt: environment.AI_TASK_PROMPT,
    openRouterBaseUrl: environment.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1',
    openRouterHttpReferer: environment.OPENROUTER_HTTP_REFERER?.trim() || undefined,
    openRouterAppName: environment.OPENROUTER_APP_NAME?.trim() || undefined
  };
}
