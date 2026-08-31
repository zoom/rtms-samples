# LLM Router Server

Internal MCP service that sends transcript batches to Claude and exposes only the explicitly allowed tools discovered from Zoom's official hosted MCP server.

See the project-level `README.md` for OAuth, security, configuration, and Docker instructions. This service defaults to port `3100` and requires bearer authentication on `/mcp`.
