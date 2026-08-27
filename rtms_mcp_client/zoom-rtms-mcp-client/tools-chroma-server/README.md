# Chroma MCP Tools Server

This service exposes Chroma retrieval tools through MCP.

## Docker

Its multi-stage Dockerfile keeps build tooling out of the final runtime image and does not hard-code a CPU architecture.

Build and run it from the `rtms-samples` repository root:

```bash
docker build -f rtms_mcp_client/zoom-rtms-mcp-client/tools-chroma-server/Dockerfile -t rtms-zoom-rtms-mcp-client-tools-chroma-server .
docker run --rm --env-file rtms_mcp_client/zoom-rtms-mcp-client/tools-chroma-server/.env -p 5000:5000 rtms-zoom-rtms-mcp-client-tools-chroma-server
```

Run the build from the repository root because the Dockerfile uses repository-relative paths. Runtime secrets are supplied with `--env-file` and are excluded from the image build context.
