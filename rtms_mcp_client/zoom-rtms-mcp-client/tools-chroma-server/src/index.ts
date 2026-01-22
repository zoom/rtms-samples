import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ChromaClient } from 'chromadb';
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use('/.well-known', express.static('./public/.well-known'));

const chroma = new ChromaClient({ path: 'http://localhost:8000' });

const server = new McpServer({
  name: 'chroma-database-tools',
  version: '1.0.0',
});






// ✅ Tool: chroma-database-add
server.tool(
  'chroma-database-add',
  {
    id: z.string(),
    text: z.string(),
  },
  async ({ id, text }) => {
    console.log(`📥 Tool invoked: chroma-database-add`);
    console.log(`📝 Received: { id: "${id}", text: "${text}" }`);
    try {
      const collection = await chroma.getOrCreateCollection({
        name: 'my_collection',
        embeddingFunction: new DefaultEmbeddingFunction(),
      });

      console.log('📤 Adding document...');
      await collection.add({ ids: [id], documents: [text] });

      console.log('✅ Successfully added to ChromaDB');
      return {
        content: [{ type: 'text', text: '✅ Added to ChromaDB' }],
      };
    } catch (err) {
      console.error('❌ Failed to add document:', err);
      return {
        content: [{ type: 'text', text: '❌ Failed to add document.' }],
        isError: true,
      };
    }
  }
);

// ✅ Tool: chroma-database-query
server.tool(
  'chroma-database-query',
  {
    query: z.string(),
    n: z.number().optional(),
  },
  async ({ query, n = 5 }) => {
    console.log(`📥 Tool invoked: chroma-database-query`);
    console.log(`🔎 Query: "${query}", top ${n}`);
    try {
      const collection = await chroma.getOrCreateCollection({
        name: 'my_collection',
        embeddingFunction: new DefaultEmbeddingFunction(),
      });

      const results = await collection.query({ queryTexts: [query], nResults: n });
      console.log('📈 Query results:', JSON.stringify(results, null, 2));

      return {
        content: [
          {
            type: 'text',
            text: '```json\n' + JSON.stringify(results, null, 2) + '\n```',
          },
        ],
      };
    } catch (err) {
      console.error('❌ Failed to query ChromaDB:', err);
      return {
        content: [{ type: 'text', text: '❌ Failed to query ChromaDB.' }],
        isError: true,
      };
    }
  }
);

// ✅ Transport setup
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

app.listen(PORT, () => {
  console.log(`✅ Chroma tools MCP server running at http://localhost:${PORT}`);
  console.log(`🌐 Manifest available at: http://localhost:${PORT}/.well-known/mcp.json`);
  console.log(`📮 Accepting POST requests at: http://localhost:${PORT}/mcp`);
});
