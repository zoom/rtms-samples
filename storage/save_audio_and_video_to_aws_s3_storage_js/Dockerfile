# rtms-sample
FROM node:22-bookworm-slim AS dependencies
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples
COPY library/javascript /workspace/rtms-samples/library/javascript
COPY library/javascript /workspace/library/javascript
COPY storage/save_audio_and_video_to_aws_s3_storage_js /workspace/rtms-samples/storage/save_audio_and_video_to_aws_s3_storage_js
WORKDIR /workspace/rtms-samples/storage/save_audio_and_video_to_aws_s3_storage_js
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/rtms-samples/storage/save_audio_and_video_to_aws_s3_storage_js
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg=7:5.1.9-0+deb12u1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies --chown=node:node /workspace /workspace
RUN mkdir -p recordings && chown node:node recordings
USER node
EXPOSE 3000
VOLUME ["/workspace/rtms-samples/storage/save_audio_and_video_to_aws_s3_storage_js/recordings"]
CMD ["node", "index.js"]
