# llm-router-server
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --include=dev || (rm -f package-lock.json && npm install --include=dev); else npm install --include=dev; fi
COPY rtms_mcp_client/zoom-rtms-mcp-client/llm-router-server ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
