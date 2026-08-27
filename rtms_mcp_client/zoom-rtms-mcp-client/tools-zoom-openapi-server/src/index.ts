import express from 'express';
import { installGracefulShutdown } from './gracefulShutdown.js';
import cors from 'cors';
import dotenv from 'dotenv';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());
app.use('/.well-known', express.static('./public/.well-known'));

// ✅ Create MCP server
const server = new McpServer({
  name: 'zoom-openapi-tools',
  version: '1.0.1',
});

// ✅ Tool: zoom-create-meeting
server.tool(
  'zoom-create-meeting',
  {
    user_id: z.string().describe('User ID or email to associate with the meeting'),
    topic: z.string().describe('Topic or title of the Zoom meeting'),
    start_time: z.string().describe('Meeting start time in ISO 8601 format (e.g. 2025-07-09T15:00:00Z)'),
    duration: z.number().describe('Length of the meeting in minutes'),
    timezone: z.string().describe('Time zone for the meeting (e.g. America/Los_Angeles)').optional(),
    type: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(8)])
      .describe('Meeting type: 1 = instant, 2 = scheduled, 3 = recurring (no fixed time), 8 = recurring (fixed time)')
      .optional(),
  },
  async ({ user_id, topic, start_time, duration, timezone, type = 2 }) => {
    console.log(`📥 Tool invoked: zoom-create-meeting`);
    console.log(`📝 Params:`, { user_id, topic, start_time, duration, timezone, type });

    return {
      content: [
        {
          type: 'text',
          text: `✅ Simulated: Created meeting "${topic}" for user "${user_id}" at ${start_time}.`,
        },
      ],
    };
  }
);

// ✅ Tool: zoom-create-user
server.tool(
  'zoom-create-user',
  {
    action: z.literal('create').describe('Action type — must be "create" to create a user'),
    user_info: z.object({
      email: z.string().describe('Email address of the new Zoom user'),
      type: z
        .union([z.literal(1), z.literal(2), z.literal(3)])
        .describe('User type: 1 = Basic, 2 = Licensed, 3 = On-prem'),
      first_name: z.string().describe('First name of the user').optional(),
      last_name: z.string().describe('Last name of the user').optional(),
    }),
  },
  async ({ action, user_info }) => {
    console.log(`📥 Tool invoked: zoom-create-user`);
    console.log(`🧑 User Info:`, user_info);

    return {
      content: [
        {
          type: 'text',
          text: `✅ Simulated: Created user ${user_info.email} (type ${user_info.type})`,
        },
      ],
    };
  }
);

// ✅ Tool: zoom-list-meetings
server.tool(
  'zoom-list-meetings',
  {
    user_id: z.string().describe('User ID or email address whose meetings you want to list'),
    type: z.enum(['scheduled', 'live', 'upcoming']).describe('Meeting type to list: scheduled, live, or upcoming').optional(),
    page_size: z.number().describe('Number of records to return (max 300)').optional(),
    next_page_token: z.string().describe('Token for paginated results').optional(),
  },
  async ({ user_id, type = 'scheduled', page_size = 30 }) => {
    console.log(`📥 Tool invoked: zoom-list-meetings`);
    console.log(`📋 Params:`, { user_id, type, page_size });

    return {
      content: [
        {
          type: 'text',
          text: `📄 Simulated: Listed ${page_size} ${type} meetings for user "${user_id}".`,
        },
      ],
    };
  }
);

// ✅ Tool: zoom-get-meeting-details
server.tool(
  'zoom-get-meeting-details',
  {
    meeting_id: z.string().describe('The Zoom meeting ID you want details for'),
  },
  async ({ meeting_id }) => {
    console.log(`📥 Tool invoked: zoom-get-meeting-details`);
    console.log(`🔍 Meeting ID: ${meeting_id}`);

    return {
      content: [
        {
          type: 'text',
          text: `ℹ️ Simulated: Retrieved details for meeting "${meeting_id}".`,
        },
      ],
    };
  }
);

// ✅ Transport
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});

await server.connect(transport);
console.log('✅ MCP Server connected to transport');

// ✅ Route
app.post('/mcp', (req, res) => {
  console.log('\n📨 --- Incoming MCP Request ---');
  console.log('🧾 Headers:', req.headers);
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));
  transport.handleRequest(req, res, req.body);
});

const httpServer = app.listen(PORT, () => {
  console.log(`✅ Zoom MCP server running at http://localhost:${PORT}`);
  console.log(`🌐 Manifest available at: http://localhost:${PORT}/.well-known/mcp.json`);
  console.log(`📮 POST requests accepted at: http://localhost:${PORT}/mcp`);
});

installGracefulShutdown('tools-zoom-openapi-server', httpServer, async () => transport.close());
