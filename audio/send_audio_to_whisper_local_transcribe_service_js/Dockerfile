# RTMS sample using local OpenAI Whisper model for real-time transcription
FROM node:20-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples
COPY library/javascript /workspace/rtms-samples/library/javascript
COPY library/javascript /workspace/library/javascript
COPY audio/send_audio_to_whisper_local_transcribe_service_js /workspace/rtms-samples/audio/send_audio_to_whisper_local_transcribe_service_js
WORKDIR /workspace/rtms-samples/audio/send_audio_to_whisper_local_transcribe_service_js
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || (rm -f package-lock.json && npm install --omit=dev); else npm install --omit=dev; fi

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples/audio/send_audio_to_whisper_local_transcribe_service_js
COPY --from=dependencies --chown=node:node /workspace /workspace
USER node
EXPOSE 3000
CMD ["node", "index.js"]
