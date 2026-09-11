# Deploy transcripts to MCP servers

Deploy this project as two long-running services:

- `mcp_client`: public webhook service on port 3000
- `llm-router-server`: private model and MCP router on port 3100

Both services use the same generated `LLM_ROUTER_AUTH_TOKEN`. Only the RTMS
client receives a public domain.

## Render

Create a Render Blueprint from `zoom/rtms-samples` and set the Blueprint path
to `rtms_mcp_client/zoom-rtms-mcp-client/render.yaml`. The Blueprint creates
both Docker services, connects them over Render's private network, and creates
their shared internal token.

Provide the Zoom credentials, the selected model-provider key, the
`MCP_SERVERS_JSON` registry, and any bearer-token variables named by that
registry. Set the Zoom webhook to `https://YOUR_RENDER_HOST/webhook`.

## Railway

Create two services from the repository root. Apply:

- `rtms_mcp_client/zoom-rtms-mcp-client/railway.json` to the public client
- `rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server/railway.json` to the
  private router

Set `LLM_MCP_SERVER_URL` on the client to the router's Railway private URL plus
`/mcp`. Set `ALLOW_INSECURE_ROUTER_HTTP=true` only for that trusted private
connection. Generate one internal token and set it on both services.

Railway's legacy JSON files configure each service independently. Create and
publish a two-service Railway template after testing private networking and
the shared token in the Zoom-owned Railway workspace.
