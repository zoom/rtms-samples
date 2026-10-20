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

Deploy the router before the client:

1. Create a private service named `zoom-rtms-mcp-router` from the repository
   root. Apply
   `rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server/railway.json`,
   configure the model and MCP server variables, and deploy it without a public
   domain. Wait for its `/health` endpoint to report the discovered MCP tools.
2. Create the public `zoom-rtms-mcp-client` service from the repository root.
   Apply `rtms_mcp_client/zoom-rtms-mcp-client/railway.json`, configure the
   Zoom variables, and generate its public domain.

Create `LLM_ROUTER_AUTH_TOKEN` as a project shared secret and set this
reference on both services:

```text
LLM_ROUTER_AUTH_TOKEN=${{ shared.LLM_ROUTER_AUTH_TOKEN }}
```

Set the client router URL through Railway's private service reference:

```text
LLM_MCP_SERVER_URL=http://${{zoom-rtms-mcp-router.RAILWAY_PRIVATE_DOMAIN}}:3100/mcp
ALLOW_INSECURE_ROUTER_HTTP=true
```

The router-domain reference makes the client depend on the router during
template deployments and staged multi-service changes. Railway waits for the
router deployment before starting the client. GitHub-triggered service deploys
remain independent, so keep the health checks and restart policies enabled.

Create and publish a two-service Railway template after testing private
networking, startup ordering, and the shared token in the Zoom-owned Railway
workspace.
