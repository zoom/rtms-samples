import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { z, ZodRawShape } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const mcp_urls= process.env.MCP_URLS || ''
app.use(cors());
app.use(express.json());
app.use('/.well-known', express.static('./public/.well-known'));

type ToolDescriptor = {
  name: string;
  description: string;
  input_schema: any;
  client: Client;
};

type SimpleJSONSchema = {
  type: 'object';
  properties: Record<string, {
    type: 'string' | 'number' | 'integer' | 'object';
    description?: string;
    properties?: any;
    required?: string[];
  }>;
  required?: string[];
};

function convertToZodShape(schema: SimpleJSONSchema): ZodRawShape {
  const shape: ZodRawShape = {};
  console.log('🔄 Converting schema:', JSON.stringify(schema, null, 2));

  for (const key in schema.properties) {
    const value = schema.properties[key];
    console.log(`🔧 Field "${key}": type = "${value.type}"`);

    let zodType;
    switch (value.type) {
      case 'string': zodType = z.string(); break;
      case 'number': zodType = z.number(); break;
      case 'integer': zodType = z.number().int(); break;
      case 'object': zodType = z.record(z.any()); break;
      default: throw new Error(`Unsupported type: ${value.type}`);
    }
    shape[key] = schema.required?.includes(key) ? zodType : zodType.optional();
  }
  return shape;
}

async function registerToolsFromServer(server: McpServer, baseUrl: string): Promise<ToolDescriptor[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: `client-${baseUrl}`, version: '1.0.0' });
  await client.connect(transport);
  console.log(`🔌 Connected MCP client to ${baseUrl}`);

  const res = await fetch(`${baseUrl}/.well-known/mcp.json`);
  if (!res.ok) throw new Error(`Failed to fetch manifest from ${baseUrl}`);
  const manifest = (await res.json()) as { tools: any[] };

  const tools: ToolDescriptor[] = [];
  for (const tool of manifest.tools || []) {
    try {
      console.log(`🔧 Preparing to register tool: ${tool.name}`);
      const inputShape = convertToZodShape(tool.input_schema);

      server.tool(tool.name, inputShape, async (params: any) => {
        console.log(`🚀 Calling ${tool.name} via MCP client (${baseUrl}) with params:`, params);
        const result = await client.callTool({ name: tool.name, arguments: params });
        console.log(`✅ Tool result (${tool.name}):`, result);

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      });

      tools.push({
        name: tool.name,
        description: tool.description || tool.name,
        input_schema: tool.input_schema,
        client
      });

      console.log(`✅ Registered tool: ${tool.name}`);
    } catch (err: any) {
      console.warn(`⚠️ Could not register tool "${tool.name}": ${err.message}`);
    }
  }
  return tools;
}

const server = new McpServer({ name: 'llm-router', version: '1.0.0' });
const mcpUrls = (mcp_urls)
  .split(',')
  .map(url => url.trim())
  .filter(Boolean); // removes empty strings

const tools: ToolDescriptor[] = [];

for (const url of mcpUrls) {
  try {
    const newTools = await registerToolsFromServer(server, url);
    tools.push(...newTools);
  } catch (err: any) {
    console.error(`❌ Failed to connect to ${url}:`, err.message);
  }
}

console.log(`🧰 Total tools registered: ${tools.length}`);

server.tool('ask-llm', { message: z.string() }, async ({ message }) => {
  console.log(`📝 Received message: "${message}"`);

  if (tools.length === 0) {
    console.warn('⚠️ No tools registered — skipping processing');
    return { content: [{ type: 'text', text: '❌ No tools available to route.' }], isError: true };
  }

  const toolList: Tool[] = tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema
  }));

const systemPrompt = `
You are a helpful assistant with access to real, executable Zoom API tools.

Use the tools provided to take action.
If required input is missing, ask the user for it.
Do not explain manual steps unless the user explicitly asks for them.
`.trim();
  const messages: MessageParam[] = [{ role: 'user', content: message }];
  const finalText: string[] = [];

  try {
    // const response = await anthropic.messages.create({
    //   model: 'claude-3-5-sonnet-20241022',
    //   messages,
    //   tools: toolList,
    //   tool_choice: { type: 'auto' },
    //   system: systemPrompt,
    //   max_tokens: 1000
    // });
        const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      messages,
      tools: toolList,
      tool_choice: { type: 'auto' },
      max_tokens: 1000
    });

    for (const content of response.content) {
      if (content.type === 'text') {
        messages.push({ role: 'assistant', content: content.text });
        finalText.push(content.text);
      } else if (content.type === 'tool_use') {
        const tool = tools.find(t => t.name === content.name);
        if (!tool) {
          finalText.push(`❌ Tool ${content.name} not found.`);
          continue;
        }
        const result = await tool.client.callTool({ name: content.name,arguments: content.input as { [key: string]: unknown }
 });
        const toolOutput = JSON.stringify(result.content, null, 2);
        messages.push({ role: 'user', content: toolOutput });

        const followUp = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          messages,
          max_tokens: 1000
        });
        const followUpText = followUp.content.find(c => c.type === 'text')?.text;
        if (followUpText) finalText.push(followUpText);
      }
    }

    return {
      content: finalText.map(text => ({ type: 'text', text }))
    };
  } catch (err: any) {
    console.error(`❌ ask-llm tool failed:`, err);
    return {
      content: [{ type: 'text', text: `❌ Error: ${err.message || String(err)}` }],
      isError: true
    };
  }
});

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
});
await server.connect(transport);

app.post('/mcp', (req, res) => {
  transport.handleRequest(req, res, req.body);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    tools: tools.length,
    toolNames: tools.map(t => t.name)
  });
});

app.listen(PORT, () => {
  console.log(`✅ LLM Router running at http://localhost:${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
