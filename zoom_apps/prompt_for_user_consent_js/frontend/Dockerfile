# Build the Zoom App React UI, then serve only static production assets.
FROM node:20-bookworm-slim AS build
ENV NODE_ENV=production
WORKDIR /app
COPY zoom_apps/prompt_for_user_consent_js/frontend/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --include=dev || (rm -f package-lock.json && npm install --include=dev); else npm install --include=dev; fi
COPY zoom_apps/prompt_for_user_consent_js/frontend ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY zoom_apps/prompt_for_user_consent_js/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 8080
