# LLM Router Server

This service routes model requests between the RTMS MCP components.

## Docker

Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server/Dockerfile -t rtms-zoom-rtms-mcp-client-llm-router-server .
docker run --rm --env-file rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server/.env -p 3000:3000 rtms-zoom-rtms-mcp-client-llm-router-server
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
