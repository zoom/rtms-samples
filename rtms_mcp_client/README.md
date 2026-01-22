# 🧠 RTMS LLM Router with ChromaDB Tools (MCP Architecture)

This repo contains **three distinct typescript projects**, each representing a component in an **MCP (Model Context Protocol)** based system for tool-augmented LLM interaction.

---

## 🧱 Overview

| Project | Description |
|---------|-------------|
| `mcp-client` | Zoom RTMS transcript sends requests to `llm-router-server`'s `ask-llm` and interprets responses. This serves as the entry point |
| `llm-router-server` | Central router server that receives LLM requests, calls Anthropic’s Claude model, and routes tool calls if needed. It connects to the remotedly hosted tools listed below |
| `tools-chroma-server` | Exposes ChromaDB-based semantic storage/querying tools via MCP localhost:5000. This project assumes you already setup your own chromaDB + data on docker (port 8000) |
| `tools-zoom-openapi-server` | Expose 4 hardcoded sample interfaces to demonstrate API via MCP locahosthost:5001. in this case Zoom Open API |


---

## 🗂 Project Breakdown

### 1. `mcp-client`

🧪 **Client/Consumer App**

- Sends RTMS transcript as queries to the `llm-router-server` via  `Client` + `StreamableHTTPClientTransport` provided by `'@modelcontextprotocol/sdk/...`
- Can be used by:
  - Web frontends
  - Bots
  - CLI tools
- Receives either Claude’s answer or tool(s) output routed via the MCP chain.

➡️ Acts as the **entry point** for users or client apps.

### 2. `llm-router-server`

🔁 **LLM Router & Orchestrator**

- Hosts an MCP server (`ask-llm`) which:
  - Accepts user queries. In this sample, transcripts from RTMS are the queries.
  - Sends them to **Claude** via the [Anthropic API].
  - Allows Claude to **invoke external tools** (like `chroma-database-query` and `chroma-database-add`) as needed.
  - If the query tool is used, performs a **RAG-like flow** (i.e. calls Claude again with results).
- Connects to external tools (such as tools-chroma-server, tools-zoom-openapi-server) via manifest (`/.well-known/mcp.json`) using HTTP POST (`/mcp`).
- Keep the list of tools connected in-memory on startup, and passes the details of all tools available to LLM when prompting with tool-use.
- Supports tool chaining logic, conditional execution, and fallback responses.

➡️ Acts as the **core brain and controller**.

---

### 3. `tools-chroma-server`

📚 **ChromaDB-backed Tool Server**

- Hosts tools via MCP to:
  - `chroma-database-add`: Store documents into ChromaDB.
  - `chroma-database-query`: Perform semantic searches using natural language.
- Uses `chromadb` and `@chroma-core/default-embed` to generate embeddings and run queries.
- Exposes a standard MCP manifest endpoint.
- You will need to run a docker instance of chromaDB on port 8000, and populate it with data to use this MCP server.

➡️ Acts as the **tool backend** (semantic memory system hosted on other internal node/systems).

---

### 4. `tools-zoom-openapi-server`

📚 **Zoom Open API Mock Server**

This is a mock server which does not make actual calls to Zoom OpenAPI. The intention is to demonstrate the use of mcp.json to describe API's purpose to LLM for routing decisions.

- Hosts tools (mock) via MCP to:
  - `zoom-create-meeting`
  - `zoom-create-user`
  - `zoom-list-meetings`
  - `zoom-get-meeting=details`
- Returns a hardcoded mock response when it is successfully invoked by LLM
- Exposes a standard MCP manifest endpoint.

➡️ Acts as the **tool backend** (API calls to external systems).

---



## 🧠 High-Level Flow

```mermaid
sequenceDiagram

    User->>LLM Router: "What is Meeting SDK?"
    LLM Router->>Claude: Prompt + tool manifest
    Claude->>LLM Router: Tool use → chroma-database-query
    LLM Router->>ChromaDB Tool Server: { query: "Meeting SDK" }
    ChromaDB Tool Server->>LLM Router: Matching 5x docs
    LLM Router->>Claude: Second call with retrieved context
    Claude->>LLM Router: Final answer
    LLM Router->>User: Full LLM answer with tool result


    User->>LLM Router: "Create a meeting"
    LLM Router->>Claude: Prompt + tool manifest
    Claude->>LLM Router: Tool use → "missing data" for zoom-create-meeting
    LLM->> User: Prompt user for requires fields as stated in mcp.json  ("user_id", "topic", "start_time", "duration")
    User->> LLM Router->>Claude : Prompt + Additional User Provided entities + tool manifest
    Claude->>LLM Router: Tool use → zoom-create-meeting
    LLM Router->>Zoom OpenAPI Tool Server: { zoom-create-meeting }
    Zoom OpenAPI Tool Server->>LLM Router: Mock response meeting created successful
    LLM Router->>User:  Meeting created successful
```

---

## 🚀 How to Run (Quickstart)

```bash
# Start ChromaDB locally (you must install chromadb separately)
docker run -p 8000:8000 ghcr.io/chroma-core/chroma

# Start Chroma tool server (start this first)
# If you do not want to use this tool server, you do not need to start it. Remember to remove the URL localhost:5000 from llm-router-server 
cd tools-chroma-server
npm start

# Start ZoomOpenAPI tool server (start this second)
# If you do not want to use this tool server, you do not need to start it. Remember to remove the URL localhost:5001 from llm-router-server 
cd tools-zoom-openapi--server
npm start

# Start LLM Router (start this third)
cd llm-router-server
npm start

# Start client (start this last)
cd mcp-client
npm start
```
---

Q: Why is there a sequence of which service to start first? 
A: The server object need to be initiatlized, before the client can successfully establish a  transport connection

## 📦 MCP Tool Schema

Sample tool implementation for Chroma DB. Ensure that your name and description of the are verbose enough for LLM to understand its use. This is crucial for accurate tool routing for LLM.

```json
{
  "type": "server.tool",
  "name": "chroma-database-tools",
  "version": "1.0.0",
  "description": "Tools for searching and storing documents in ChromaDB (chroma database).",
  "tools": [
    {
      "name": "chroma-database-add",
      "description": "Store a document in ChromaDB (chroma database) for future semantic search.",
      "input_schema": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "text": { "type": "string" }
        },
        "required": ["id", "text"]
      }
    },
    {
      "name": "chroma-database-query",
      "description": "Use this tool to search relevant documents in ChromaDB (chroma database) by keyword or question. Always use this for factual or technical answers.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "n": { "type": "number" }
        },
        "required": ["query"]
      }
    }
  ]
}

```

---

