# tools-zoom-openapi-server
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /app
COPY rtms_mcp_client/zoom-rtms-mcp-client/tools-zoom-openapi-server/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --include=dev || (rm -f package-lock.json && npm install --include=dev); else npm install --include=dev; fi
COPY rtms_mcp_client/zoom-rtms-mcp-client/tools-zoom-openapi-server ./

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app /app
USER node
EXPOSE 5001
CMD ["npm", "start"]
