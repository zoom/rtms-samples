# LLM Router Server

Internal MCP service that sends transcript batches to Claude and exposes only the explicitly allowed tools discovered from MCP servers declared in `MCP_SERVERS_JSON`.

Each server entry names its token environment variable and tool allowlist. Tools are namespaced as `<server-id>__<tool-name>`. See the project-level `README.md` for OAuth, security, configuration, and Docker instructions. This service defaults to port `3100` and requires bearer authentication on `/mcp`.
