# Send Zoom Meeting Transcripts to MCP Servers

This sample streams Zoom meeting transcripts through RTMS, sends bounded transcript batches to Claude, and lets Claude use an explicitly authorized subset of tools discovered from Zoom's official hosted Meeting MCP server.

## Architecture

The project contains two services:

- `mcp_client`: public webhook receiver and RTMS transcript WebSocket client, port `3000`
- `llm-router-server`: private MCP router for Claude and Zoom's hosted MCP server, port `3100`

The old Chroma and mock Zoom OpenAPI MCP services were removed. The router now calls `tools/list` against the configured official Zoom MCP endpoint and rejects every discovered tool not present in `ZOOM_MCP_ALLOWED_TOOLS`.

## Security Model

- Zoom webhook signatures are verified against the exact raw body with a replay window.
- `ZOOM_ACCOUNT_ID` restricts the sample to one Zoom account. Run separate isolated deployments and OAuth tokens for multiple tenants.
- `LLM_ROUTER_AUTH_TOKEN` authenticates every RTMS-client request to the private router.
- TLS certificate validation remains enabled for all RTMS and Zoom MCP connections.
- Plain HTTP to the router is accepted only on loopback unless explicitly enabled for a trusted private network.
- CORS is not enabled because neither service is a browser API.
- Zoom MCP tools are denied unless they are allowlisted. The default list is read-only.
- Audit logs contain request IDs, tool names, outcomes, durations, and error codes. They do not contain transcript text, tool arguments, tool results, meeting IDs, stream IDs, account IDs, or credentials.
- Transcript text is untrusted model input. The system prompt instructs Claude not to treat transcript text or tool results as policy-changing instructions.

The router's `/health` endpoint is intentionally metadata-only. Place both services behind normal network controls; expose only the RTMS webhook route publicly.

Forward the JSON audit output to durable centralized logging in production and apply your organization's access and retention controls there.

## Prerequisites

- Node.js 22 or Docker
- A Zoom app with RTMS enabled and the `meeting.rtms_started` and `meeting.rtms_stopped` webhook events
- Zoom app Client ID, Client Secret, webhook Secret Token, and Account ID
- An Anthropic API key
- A Zoom user OAuth access token authorized for the official MCP server and its requested granular scopes

Zoom's hosted MCP servers use OAuth 2.1. The default endpoint is the official Meeting Streamable HTTP server:

```text
https://zoom.us/mcp/meeting/streamable
```

Access tokens expire. A production deployment should obtain and refresh user OAuth tokens securely rather than treating a copied access token as permanent configuration. Review Zoom's current [MCP server documentation](https://developers.zoom.us/docs/mcp/servers/) and use `tools/list` as the authority for the tools available to the authorized user.

## Configuration

Create each service's local environment file:

```bash
cp llm-router-server/.env.example llm-router-server/.env
cp mcp_client/.env.example mcp_client/.env
```

Use the same random `LLM_ROUTER_AUTH_TOKEN` and `ZOOM_ACCOUNT_ID` in both files. Generate the internal token with:

```bash
openssl rand -hex 32
```

The default `ZOOM_MCP_ALLOWED_TOOLS` contains only read-oriented tools. Compare it with the router's discovered tool count and update it only after reviewing each tool's scopes and side effects. Do not add document creation or other write tools merely because discovery returns them.

`ANTHROPIC_MODEL` is required and is passed directly to the Anthropic Messages API. The example currently uses `claude-sonnet-5`; verify model availability for your account against [Anthropic's model documentation](https://platform.claude.com/docs/en/about-claude/models/overview).

## Run Locally

Start the router first:

```bash
cd llm-router-server
npm ci
npm run build
npm start
```

Then start the RTMS client:

```bash
cd mcp_client
npm ci
npm run build
npm start
```

Configure the Zoom webhook URL as `https://YOUR_DOMAIN/webhook` and route it to port `3000`. Do not route the router's port `3100` to the public internet.

## Docker

Build from the `rtms-samples` repository root:

```bash
docker build \
  -f rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server/Dockerfile \
  -t zoom-rtms-llm-router .

docker build \
  -f rtms_mcp_client/zoom-rtms-mcp-client/mcp_client/Dockerfile \
  -t zoom-rtms-mcp-client .
```

Run the router only on a private network. If the RTMS client uses plain HTTP over that private Docker network, set `ALLOW_INSECURE_ROUTER_HTTP=true`; keep bearer authentication enabled and do not publish port `3100`.

## Tests

Run in each service:

```bash
npm test
npm run build
npm audit --omit=dev
```

Tests cover internal bearer authentication, tenant matching, sanitized errors, Zoom webhook signature/replay verification, and per-stream transcript isolation.
