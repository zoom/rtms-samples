import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { installGracefulShutdown } from './gracefulShutdown.js';
import { loadMcpServerConfigs, routedToolName } from './mcpServers.js';
import { buildSystemPrompt } from './prompt.js';
import { audit, isBearerAuthorized, safeErrorCode, safeTenantMatch } from './security.js';

dotenv.config({ quiet: true });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} has an invalid value`);
  return value;
}

const config = {
  port: integer('PORT', 3100, 1),
  serviceToken: required('LLM_ROUTER_AUTH_TOKEN'),
  tenantId: required('ZOOM_ACCOUNT_ID'),
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: required('ANTHROPIC_MODEL'),
  anthropicMaxTokens: integer('ANTHROPIC_MAX_OUTPUT_TOKENS', 1000, 1),
  anthropicTimeoutMs: integer('ANTHROPIC_TIMEOUT_MS', 30000, 1000),
  anthropicMaxRetries: integer('ANTHROPIC_MAX_RETRIES', 2, 0),
  anthropicTaskPrompt: process.env.ANTHROPIC_TASK_PROMPT,
  maxToolCalls: integer('MAX_TOOL_CALLS_PER_REQUEST', 3, 0),
  maxInputCharacters: integer('MAX_INPUT_CHARACTERS', 12000, 1),
  maxToolResultCharacters: integer('MAX_TOOL_RESULT_CHARACTERS', 50000, 1),
  mcpServers: loadMcpServerConfigs(process.env.MCP_SERVERS_JSON)
};

const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
  timeout: config.anthropicTimeoutMs,
  maxRetries: config.anthropicMaxRetries
});

const connectedServers = await Promise.all(config.mcpServers.map(async (server) => {
  const transport = new StreamableHTTPClientTransport(server.url, {
    requestInit: { headers: { Authorization: `Bearer ${server.accessToken}` } }
  });
  const client = new Client({ name: `zoom-rtms-router-${server.id}`, version: '2.0.0' });
  await client.connect(transport);
  const discovered = await client.listTools();
  const tools = discovered.tools.filter((tool) => server.allowedTools.has(tool.name));
  if (tools.length === 0) throw new Error(`No allowed tools were discovered from MCP server ${server.id}`);
  return { server, client, tools };
}));

const routedTools = connectedServers.flatMap(({ server, client, tools }) => tools.map((tool) => ({
  name: routedToolName(server.id, tool.name),
  upstreamName: tool.name,
  serverId: server.id,
  client,
  description: tool.description || tool.name,
  inputSchema: tool.inputSchema
})));
const anthropicTools: Tool[] = routedTools.map((tool) => ({
  name: tool.name,
  description: `[${tool.serverId}] ${tool.description}`,
  input_schema: tool.inputSchema as Tool['input_schema']
}));
const toolsByName = new Map(routedTools.map((tool) => [tool.name, tool]));

const systemPrompt = buildSystemPrompt(config.anthropicTaskPrompt);

async function routeTranscript(message: string, requestId: string): Promise<string> {
  const messages: MessageParam[] = [{ role: 'user', content: message }];
  const output: string[] = [];
  let toolCalls = 0;

  while (true) {
    const toolUseEnabled = toolCalls < config.maxToolCalls;
    const response = await anthropic.messages.create({
      model: config.anthropicModel,
      system: systemPrompt,
      messages,
      ...(toolUseEnabled ? { tools: anthropicTools, tool_choice: { type: 'auto' as const } } : {}),
      max_tokens: config.anthropicMaxTokens
    });

    messages.push({ role: 'assistant', content: response.content });
    for (const block of response.content) {
      if (block.type === 'text' && block.text) output.push(block.text);
    }

    const requestedTools = response.content.filter((block) => block.type === 'tool_use');
    if (requestedTools.length === 0) break;

    const toolResults: ToolResultBlockParam[] = [];
    for (const request of requestedTools) {
      toolCalls += 1;
      const startedAt = Date.now();
      const routedTool = toolsByName.get(request.name);
      if (toolCalls > config.maxToolCalls || !routedTool) {
        audit('tool_denied', { requestId, tool: request.name, outcome: 'denied' });
        toolResults.push({ type: 'tool_result', tool_use_id: request.id, is_error: true, content: 'Tool call denied by router policy.' });
        continue;
      }

      try {
        const result = await routedTool.client.callTool({
          name: routedTool.upstreamName,
          arguments: request.input as Record<string, unknown>
        });
        const serialized = (JSON.stringify(result.content) || '[]').slice(0, config.maxToolResultCharacters);
        toolResults.push({ type: 'tool_result', tool_use_id: request.id, content: serialized });
        audit('tool_call', { requestId, server: routedTool.serverId, tool: routedTool.upstreamName, outcome: 'success', durationMs: Date.now() - startedAt });
      } catch (error) {
        audit('tool_call', {
          requestId,
          server: routedTool.serverId,
          tool: routedTool.upstreamName,
          outcome: 'error',
          errorCode: safeErrorCode(error),
          durationMs: Date.now() - startedAt
        });
        toolResults.push({ type: 'tool_result', tool_use_id: request.id, is_error: true, content: 'MCP tool execution failed.' });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return output.join('\n').trim() || 'No response generated.';
}

const mcpServer = new McpServer({ name: 'zoom-rtms-llm-router', version: '2.0.0' });
mcpServer.tool(
  'ask-llm',
  'Route meeting transcript text through Claude and the authorized MCP tools.',
  { message: z.string().min(1).max(config.maxInputCharacters), tenantId: z.string().min(1) },
  async ({ message, tenantId }) => {
    const requestId = crypto.randomUUID();
    if (!safeTenantMatch(tenantId, config.tenantId)) {
      audit('route_request', { requestId, outcome: 'tenant_denied' });
      return { content: [{ type: 'text', text: 'Tenant is not authorized.' }], isError: true };
    }

    audit('route_request', { requestId, outcome: 'started', inputCharacters: message.length });
    try {
      const response = await routeTranscript(message, requestId);
      audit('route_request', { requestId, outcome: 'success' });
      return { content: [{ type: 'text', text: response }] };
    } catch (error) {
      audit('route_request', { requestId, outcome: 'error', errorCode: safeErrorCode(error) });
      return { content: [{ type: 'text', text: 'The routing request failed.' }], isError: true };
    }
  }
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
await mcpServer.connect(transport);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.post('/mcp', (req: Request, res: Response) => {
  if (!isBearerAuthorized(req.headers.authorization, config.serviceToken)) {
    audit('service_auth', { outcome: 'denied' });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  void transport.handleRequest(req, res, req.body).catch((error) => {
    audit('mcp_request', { outcome: 'error', errorCode: safeErrorCode(error) });
    if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
  });
});
app.get('/health', (_req, res) => res.json({ status: 'ok', mcpServerCount: connectedServers.length, allowedToolCount: routedTools.length }));

const httpServer = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[LLMRouter] Listening on port ${config.port}; ${connectedServers.length} MCP server(s) and ${routedTools.length} tool(s) authorized`);
});

installGracefulShutdown('llm-router-server', httpServer, async () => {
  await transport.close();
  await Promise.allSettled(connectedServers.map(({ client }) => client.close()));
});
