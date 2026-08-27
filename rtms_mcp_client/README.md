# Send Zoom Meeting Transcripts to MCP Servers

This directory contains the `zoom-rtms-mcp-client` sample. It receives live meeting transcripts through Zoom RTMS and routes bounded transcript batches through Claude to authorized tools discovered from Zoom's official hosted MCP server.

## Current Architecture

The sample has two local services:

| Service | Default port | Purpose |
|---|---:|---|
| `zoom-rtms-mcp-client/mcp_client` | `3000` | Authenticates Zoom webhooks, connects to RTMS transcript media, and batches transcript text per stream. |
| `zoom-rtms-mcp-client/llm-router-server` | `3100` | Calls Claude and an allowlisted subset of tools discovered from Zoom's hosted MCP server. |

The router connects directly to the official Zoom Meeting MCP Streamable HTTP endpoint. No additional local tool server is required.

```text
Zoom webhook
    -> RTMS transcript WebSocket
    -> mcp_client
    -> authenticated private MCP request
    -> llm-router-server
    -> Claude
    -> official Zoom hosted MCP server
```

## Setup

The complete setup, OAuth, security, configuration, Docker, and testing instructions are in the project guide:

- [zoom-rtms-mcp-client/README.md](zoom-rtms-mcp-client/README.md)

Create environment files from the examples in each service. Both services must use the same `LLM_ROUTER_AUTH_TOKEN` and `ZOOM_ACCOUNT_ID`.

Start the private router first:

```bash
cd zoom-rtms-mcp-client/llm-router-server
npm ci
npm run build
npm start
```

Then start the RTMS client:

```bash
cd zoom-rtms-mcp-client/mcp_client
npm ci
npm run build
npm start
```

Only the RTMS client's webhook route should be publicly exposed. Keep the LLM router on a private network.
