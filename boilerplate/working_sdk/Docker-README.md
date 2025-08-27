# Docker Setup for RTMS Sample Project

This project includes two Docker configurations using different Node.js base images.

## Available Dockerfiles

1. **Dockerfile.slim** - Uses `node:20-slim` base image
2. **Dockerfile.alpine** - Uses `node:20-alpine` base image

## Key Features

- **External Environment Configuration**: Environment variables are provided externally via mounted `.env` file
- **Security**: Runs as non-root user
- **Health Checks**: Built-in health monitoring
- **Signal Handling**: Proper signal handling (especially in Alpine version with dumb-init)
- **Production Optimized**: Uses `npm ci --only=production` for faster, reliable builds

## Setup Instructions

### 1. Create your environment file

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your actual Zoom RTMS credentials:

```bash
# Required
ZM_RTMS_CLIENT=your_zoom_client_id
ZM_RTMS_SECRET=your_zoom_client_secret

# Optional
ZM_RTMS_PORT=5050
ZM_RTMS_LOG_LEVEL=info
```

### 2. Build and Run Options

#### Option A: Using Docker Compose (Recommended)

**Run with slim image:**
```bash
docker-compose --profile slim up --build
```

**Run with alpine image:**
```bash
docker-compose --profile alpine up --build
```

**Run both versions simultaneously:**
```bash
docker-compose --profile slim --profile alpine up --build
```

#### Option B: Using Docker directly

**Build and run slim version:**
```bash
# Build
docker build -f Dockerfile.slim -t rtms-app:slim .

# Run
docker run -d \
  --name rtms-app-slim \
  -p 5050:5050 \
  -v $(pwd)/.env:/app/.env:ro \
  -v $(pwd)/logs:/app/logs \
  rtms-app:slim
```

**Build and run alpine version:**
```bash
# Build
docker build -f Dockerfile.alpine -t rtms-app:alpine .

# Run
docker run -d \
  --name rtms-app-alpine \
  -p 5050:5050 \
  -v $(pwd)/.env:/app/.env:ro \
  -v $(pwd)/logs:/app/logs \
  rtms-app:alpine
```

### 3. Alternative: Environment Variables Instead of .env File

You can also pass environment variables directly without mounting a `.env` file:

```bash
docker run -d \
  --name rtms-app \
  -p 5050:5050 \
  -e ZM_RTMS_CLIENT=your_client_id \
  -e ZM_RTMS_SECRET=your_client_secret \
  -e ZM_RTMS_PORT=5050 \
  -v $(pwd)/logs:/app/logs \
  rtms-app:slim
```

## Image Comparison

| Feature | node:20-slim | node:20-alpine |
|---------|--------------|----------------|
| Base OS | Debian | Alpine Linux |
| Size | ~180MB | ~120MB |
| Security | Good | Excellent |
| Compatibility | High | High |
| Package Manager | apt | apk |
| Signal Handling | Basic | Enhanced (dumb-init) |

## Monitoring and Logs

### View container logs:
```bash
docker logs rtms-app-slim
# or
docker logs rtms-app-alpine
```

### Check health status:
```bash
docker inspect --format='{{.State.Health.Status}}' rtms-app-slim
```

### Access container shell:
```bash
# For slim version
docker exec -it rtms-app-slim /bin/bash

# For alpine version
docker exec -it rtms-app-alpine /bin/sh
```

## Troubleshooting

1. **Permission Issues**: Ensure the `.env` file is readable by the container
2. **Port Conflicts**: Change the host port if 5050/ 5051 is already in use
3. **Environment Variables**: Verify all required environment variables are set
4. **Network Issues**: Ensure the container can reach Zoom's RTMS endpoints
5. **Logs Permission**: Fixed - logs directory now has proper write permissions (755) for the appuser

## Security Notes

- Containers run as non-root user (`appuser`)
- Environment file is mounted read-only
- Only necessary ports are exposed
- Production dependencies only (no dev dependencies)
- Logs directory has secure write permissions (755) for the application user

## Package Manager Performance Note

While **bun** is faster than npm/yarn for package installation, these Dockerfiles use npm for maximum compatibility with the official Node.js images. If you want to use bun, you would need to install it separately in the Dockerfile.
