import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { loadAiConfig } from './aiConfig.js';
import { createAiProvider, type AiTool } from './aiProvider.js';
import { installGracefulShutdown } from './gracefulShutdown.js';
import { loadMcpServerConfigs, routedToolName } from './mcpServers.js';
import { buildSystemPrompt } from './prompt.js';
import { audit, isBearerAuthorized, safeErrorCode } from './security.js';

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

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

const config = {
  port: integer('PORT', 3100, 1),
  serviceToken: required('LLM_ROUTER_AUTH_TOKEN'),
  logContent: boolean('LOG_CONTENT', false),
  ai: loadAiConfig(),
  maxToolCalls: integer('MAX_TOOL_CALLS_PER_REQUEST', 3, 0),
  maxInputCharacters: integer('MAX_INPUT_CHARACTERS', 12000, 1),
  maxToolResultCharacters: integer('MAX_TOOL_RESULT_CHARACTERS', 50000, 1),
  mcpServers: loadMcpServerConfigs(process.env.MCP_SERVERS_JSON)
};

const aiProvider = createAiProvider(config.ai);

const connectedServers = await Promise.all(config.mcpServers.map(async (server) => {
  const transport = new StreamableHTTPClientTransport(
    server.url,
    server.authType === 'bearer'
      ? { requestInit: { headers: { Authorization: `Bearer ${server.accessToken}` } } }
      : undefined
  );
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
const aiTools: AiTool[] = routedTools.map((tool) => ({
  name: tool.name,
  description: `[${tool.serverId}] ${tool.description}`,
  inputSchema: tool.inputSchema as Record<string, unknown>
}));
const toolsByName = new Map(routedTools.map((tool) => [tool.name, tool]));

const systemPrompt = buildSystemPrompt(config.ai.taskPrompt);

async function routeTranscript(message: string, requestId: string): Promise<string> {
  return aiProvider.route(message, systemPrompt, aiTools, config.maxToolCalls, async (name, input) => {
    const startedAt = Date.now();
    const routedTool = toolsByName.get(name);
    if (!routedTool) {
      audit('tool_denied', { requestId, tool: name, outcome: 'denied' });
      return { content: 'Tool call denied by router policy.', isError: true };
    }

    try {
      const result = await routedTool.client.callTool({
        name: routedTool.upstreamName,
        arguments: input
      });
      const serialized = (JSON.stringify(result.content) || '[]').slice(0, config.maxToolResultCharacters);
      audit('tool_call', { requestId, server: routedTool.serverId, tool: routedTool.upstreamName, outcome: 'success', durationMs: Date.now() - startedAt });
      return { content: serialized };
    } catch (error) {
      audit('tool_call', {
        requestId,
        server: routedTool.serverId,
        tool: routedTool.upstreamName,
        outcome: 'error',
        errorCode: safeErrorCode(error),
        durationMs: Date.now() - startedAt
      });
      return { content: 'MCP tool execution failed.', isError: true };
    }
  });
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'zoom-rtms-llm-router', version: '2.0.0' });
  server.tool(
    'ask-llm',
    'Route meeting transcript text through the configured AI provider and authorized MCP tools.',
    { message: z.string().min(1).max(config.maxInputCharacters) },
    async ({ message }) => {
      const requestId = crypto.randomUUID();
      if (config.logContent) audit('llm_request', { requestId, transcript: message });
      audit('route_request', { requestId, outcome: 'started', inputCharacters: message.length });
      try {
        const response = await routeTranscript(message, requestId);
        if (config.logContent) audit('llm_response', { requestId, response });
        audit('route_request', { requestId, outcome: 'success' });
        return { content: [{ type: 'text', text: response }] };
      } catch (error) {
        audit('route_request', { requestId, outcome: 'error', errorCode: safeErrorCode(error) });
        const response = 'The routing request failed.';
        if (config.logContent) audit('llm_response', { requestId, response });
        return { content: [{ type: 'text', text: response }], isError: true };
      }
    }
  );
  return server;
}

type McpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const mcpSessions = new Map<string, McpSession>();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

function authorizeRouterRequest(req: Request, res: Response): boolean {
  if (!isBearerAuthorized(req.headers.authorization, config.serviceToken)) {
    audit('service_auth', { outcome: 'denied' });
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  if (!authorizeRouterRequest(req, res)) return;

  const sessionIdHeader = req.headers['mcp-session-id'];
  const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
  let session = sessionId ? mcpSessions.get(sessionId) : undefined;

  if (!session && req.method === 'POST' && !sessionId && isInitializeRequest(req.body)) {
    const server = createMcpServer();
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: id => {
        mcpSessions.set(id, { server, transport });
        audit('mcp_session', { outcome: 'initialized' });
      }
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) mcpSessions.delete(id);
    };
    session = { server, transport };
    await server.connect(transport);
  }

  if (!session) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid MCP session ID provided' },
      id: null
    });
    return;
  }

  await session.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
}

app.all('/mcp', (req: Request, res: Response) => {
  void handleMcpRequest(req, res).catch((error) => {
    audit('mcp_request', { outcome: 'error', errorCode: safeErrorCode(error) });
    if (!res.headersSent) res.status(500).json({ error: 'mcp_request_failed' });
  });
});
app.get('/health', (_req, res) => res.json({ status: 'ok', aiProvider: config.ai.provider, mcpServerCount: connectedServers.length, allowedToolCount: routedTools.length }));

const httpServer = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[LLMRouter] Listening on port ${config.port}; provider=${config.ai.provider} model=${config.ai.model}; ${connectedServers.length} MCP server(s) and ${routedTools.length} tool(s) authorized`);
});

installGracefulShutdown('llm-router-server', httpServer, async () => {
  await Promise.allSettled([...mcpSessions.values()].map(({ transport }) => transport.close()));
  mcpSessions.clear();
  await Promise.allSettled(connectedServers.map(({ client }) => client.close()));
});
