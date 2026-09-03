import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions';
import type { AiConfig } from './aiConfig.js';

export type AiTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type InvokeTool = (name: string, input: Record<string, unknown>) => Promise<ToolResult>;

export type AiProvider = {
  route(message: string, systemPrompt: string, tools: AiTool[], maxToolCalls: number, invokeTool: InvokeTool): Promise<string>;
};

function parseToolInput(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function finalOutput(parts: string[]): string {
  return parts.join('\n').trim() || 'No response generated.';
}

function createAnthropicProvider(config: AiConfig): AiProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries
  });

  return {
    async route(message, systemPrompt, tools, maxToolCalls, invokeTool) {
      const messages: MessageParam[] = [{ role: 'user', content: message }];
      const output: string[] = [];
      const providerTools: Tool[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Tool['input_schema']
      }));
      let toolCalls = 0;

      while (true) {
        const response = await client.messages.create({
          model: config.model,
          system: systemPrompt,
          messages,
          ...(toolCalls < maxToolCalls && providerTools.length > 0
            ? { tools: providerTools, tool_choice: { type: 'auto' as const } }
            : {}),
          max_tokens: config.maxOutputTokens
        });

        messages.push({ role: 'assistant', content: response.content });
        for (const block of response.content) {
          if (block.type === 'text' && block.text) output.push(block.text);
        }

        const requests = response.content.filter((block) => block.type === 'tool_use');
        if (requests.length === 0) break;

        const results: ToolResultBlockParam[] = [];
        for (const request of requests) {
          toolCalls += 1;
          const result = toolCalls > maxToolCalls
            ? { content: 'Tool call denied by router policy.', isError: true }
            : await invokeTool(request.name, request.input as Record<string, unknown>);
          results.push({
            type: 'tool_result',
            tool_use_id: request.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {})
          });
        }
        messages.push({ role: 'user', content: results });
      }

      return finalOutput(output);
    }
  };
}

function createOpenAiCompatibleProvider(config: AiConfig): AiProvider {
  const defaultHeaders: Record<string, string> = {};
  if (config.provider === 'openrouter') {
    if (config.openRouterHttpReferer) defaultHeaders['HTTP-Referer'] = config.openRouterHttpReferer;
    if (config.openRouterAppName) defaultHeaders['X-OpenRouter-Title'] = config.openRouterAppName;
  }
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.provider === 'openrouter' ? config.openRouterBaseUrl : undefined,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    defaultHeaders
  });

  return {
    async route(message, systemPrompt, tools, maxToolCalls, invokeTool) {
      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ];
      const output: string[] = [];
      const providerTools: ChatCompletionTool[] = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }));
      let toolCalls = 0;

      while (true) {
        const toolsEnabled = toolCalls < maxToolCalls && providerTools.length > 0;
        const completion = await client.chat.completions.create({
          model: config.model,
          messages,
          ...(toolsEnabled ? { tools: providerTools, tool_choice: 'auto' as const } : {}),
          ...(config.provider === 'openai' && toolsEnabled ? { reasoning_effort: 'none' as const } : {}),
          ...(config.provider === 'openai'
            ? { max_completion_tokens: config.maxOutputTokens }
            : { max_tokens: config.maxOutputTokens })
        });
        const response = completion.choices[0]?.message;
        if (!response) throw new Error('AI provider returned no completion choice');

        messages.push(response as ChatCompletionAssistantMessageParam);
        if (response.content) output.push(response.content);
        const requests = response.tool_calls || [];
        if (requests.length === 0) break;

        for (const request of requests) {
          toolCalls += 1;
          let result: ToolResult;
          try {
            result = request.type !== 'function'
              ? { content: 'Unsupported tool-call type.', isError: true }
              : toolCalls > maxToolCalls
              ? { content: 'Tool call denied by router policy.', isError: true }
              : await invokeTool(request.function.name, parseToolInput(request.function.arguments));
          } catch {
            result = { content: 'Tool call rejected because its arguments were invalid.', isError: true };
          }
          messages.push({ role: 'tool', tool_call_id: request.id, content: result.content });
        }
      }

      return finalOutput(output);
    }
  };
}

export function createAiProvider(config: AiConfig): AiProvider {
  return config.provider === 'anthropic'
    ? createAnthropicProvider(config)
    : createOpenAiCompatibleProvider(config);
}
