FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY rtms_mcp_client/zoom-rtms-mcp-client/mcp_client/package*.json ./
RUN npm ci
COPY rtms_mcp_client/zoom-rtms-mcp-client/mcp_client/tsconfig.json ./
COPY rtms_mcp_client/zoom-rtms-mcp-client/mcp_client/src ./src
RUN npm test && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
