# Send Zoom Meeting Transcripts to MCP Servers

This sample streams Zoom meeting transcripts through RTMS, sends bounded transcript batches to a configured Anthropic, OpenAI, or OpenRouter model, and lets that model use explicitly authorized tools discovered from MCP servers configured through the environment.

## Architecture

The project contains two services:

| Service | Default port | Purpose |
|---|---:|---|
| `mcp_client` | `3000` | Authenticates Zoom webhooks, connects to RTMS transcript media, and batches transcript text per stream. |
| `llm-router-server` | `3100` | Calls the selected AI provider and allowlisted tools discovered from the configured MCP servers. |

The router reads `MCP_SERVERS_JSON`, connects to every configured server, and calls `tools/list` at startup. It rejects every discovered tool not present in that server's `allowedTools` list. Tools are exposed to the model as `<server-id>__<tool-name>` so two servers can publish the same upstream tool name safely.

```text
Zoom webhook
    -> RTMS transcript WebSocket
    -> mcp_client
    -> authenticated private MCP request
    -> llm-router-server
    -> configured AI provider
    -> configured MCP server
```

## Security Model

- Zoom webhook signatures are verified against the exact raw body with a replay window.
- `LLM_ROUTER_AUTH_TOKEN` authenticates every RTMS-client request to the private router.
- TLS certificate validation remains enabled for all RTMS and MCP connections.
- Plain HTTP to the router is accepted only on loopback unless explicitly enabled for a trusted private network.
- CORS is not enabled because neither service is a browser API.
- MCP tools are denied unless they are allowlisted for their configured server. The included Zoom Meeting server list is read-only.
- Audit logs omit transcript and model-response content by default. Set `LOG_CONTENT=true` in both services only during local debugging to log received transcript segments, routed transcript batches, and model responses. Meeting IDs, stream IDs, credentials, tool arguments, and tool results remain excluded.
- Transcript text is untrusted model input. The system prompt instructs the selected model not to treat transcript text or tool results as policy-changing instructions.

The router's `/health` endpoint is intentionally metadata-only. Place both services behind normal network controls; expose only the RTMS webhook route publicly.

Forward the JSON audit output to durable centralized logging in production and apply your organization's access and retention controls there.

## Prerequisites

- Node.js 22 or Docker
- A Zoom app with RTMS enabled and the `meeting.rtms_started` and `meeting.rtms_stopped` webhook events
- Zoom app Client ID, Client Secret, webhook Secret Token, and Account ID
- An API key for Anthropic, OpenAI, or OpenRouter
- An access token for each configured MCP server, including a Zoom user OAuth access token for the included Zoom Meeting server

Import [`manifest.json`](manifest.json) to create the user-managed Zoom General App and declare the RTMS plus default read-only Zoom MCP scopes. Replace the development and production domain placeholders first. The sample does not yet implement OAuth authorization-code and refresh flows; it expects each configured token environment variable to be supplied securely.

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

Use the same random `LLM_ROUTER_AUTH_TOKEN` in both files. Generate the internal token with:

```bash
openssl rand -hex 32
```

To inspect the end-to-end transcript flow locally, set `LOG_CONTENT=true` in both `.env` files. This writes meeting transcript and model response text to standard output; keep it disabled where logs are retained or shared.

`MCP_SERVERS_JSON` is a JSON array. Each entry declares a stable server ID, an HTTPS Streamable HTTP endpoint, its authentication configuration, and an explicit tool allowlist. Bearer authentication is the default; keep credentials outside the JSON value:

```dotenv
MCP_SERVERS_JSON='[{"id":"zoom_meeting","url":"https://zoom.us/mcp/meeting/streamable","bearerTokenEnv":"ZOOM_MEETING_MCP_ACCESS_TOKEN","allowedTools":["search_meetings","get_meeting_assets","get_recording_resource","get_file_content","recordings_list"]}]'
ZOOM_MEETING_MCP_ACCESS_TOKEN="YOUR_ZOOM_USER_OAUTH_ACCESS_TOKEN_HERE"
```

Add another object to the array and its token as a separate environment variable to connect another server. The router rejects duplicate IDs, non-HTTPS URLs, missing tokens, empty allowlists, and invalid tool names. It loads the configuration and discovers tools at startup, so restart the service after changing the server list.

For a trusted public server that requires no credentials, set `authType` to `none` and omit `bearerTokenEnv`:

```dotenv
MCP_SERVERS_JSON='[{"id":"example_server","url":"https://YOUR_MCP_SERVER_HOST_HERE/mcp","authType":"none","allowedTools":["YOUR_TOOL_NAME_HERE"]}]'
```

Unauthenticated MCP servers are third-party trust boundaries. Keep their allowlists read-only and minimal, and do not send confidential transcript content to them.

The included Zoom Meeting allowlist contains only read-oriented tools. Compare every server's allowlist with its discovered tools and add a tool only after reviewing its permissions and side effects. Do not add write tools merely because discovery returns them.

Choose the provider and model independently:

```dotenv
AI_PROVIDER="anthropic" # anthropic, openai, or openrouter
ANTHROPIC_MODEL="claude-sonnet-5"
OPENAI_MODEL="gpt-5.6"
OPENROUTER_MODEL="anthropic/claude-sonnet-5"
```

Only the selected provider's key and corresponding model are used: `ANTHROPIC_API_KEY` plus `ANTHROPIC_MODEL`, `OPENAI_API_KEY` plus `OPENAI_MODEL`, or `OPENROUTER_API_KEY` plus `OPENROUTER_MODEL`. Set `AI_MODEL` only when you want one explicit override. OpenRouter model identifiers include a provider prefix; verify that the selected model supports tool calling. For example, `anthropic/claude-sonnet-5` and `openai/gpt-5.6-sol` currently advertise tool support.

The shared `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS`, and `AI_MAX_RETRIES` controls apply to all three providers. `OPENROUTER_BASE_URL` defaults to `https://openrouter.ai/api/v1`; the optional `OPENROUTER_HTTP_REFERER` and `OPENROUTER_APP_NAME` values provide application attribution.

Set the optional `AI_TASK_PROMPT` to describe the purpose of the deployment:

```dotenv
AI_TASK_PROMPT="Find relevant past meetings and return concise answers with source details."
```

The router appends this value to fixed security rules that treat transcripts and tool output as untrusted, restrict the model to the filtered MCP tools, and prohibit credential disclosure. The task prompt is limited to 4,000 characters and cannot expand the router's tool allowlists or call limits.

## Run Locally

Select Node.js 22 before installing or starting either service. Current MCP and AI SDK releases use Web APIs that are unavailable in Node.js 18:

```bash
source ~/.nvm/nvm.sh
nvm use 22
node --version
```

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

Tests cover MCP server configuration, tool namespacing, prompt composition, internal bearer authentication, sanitized errors, Zoom webhook signature/replay verification, and per-stream transcript isolation.
