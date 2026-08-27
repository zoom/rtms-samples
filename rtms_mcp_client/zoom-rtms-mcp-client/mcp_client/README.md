# RTMS MCP Client

This service runs the HTTP and WebSocket client for the RTMS MCP sample.

## Docker

Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f rtms_mcp_client/zoom-rtms-mcp-client/mcp_client/Dockerfile -t rtms-zoom-rtms-mcp-client-mcp_client .
docker run --rm --env-file rtms_mcp_client/zoom-rtms-mcp-client/mcp_client/.env -p 3000:3000 rtms-zoom-rtms-mcp-client-mcp_client
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
