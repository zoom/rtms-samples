# RTMS Server Dockerfile
# Use Debian-based image for better @zoom/rtms compatibility
FROM --platform=linux/amd64 node:18-slim

WORKDIR /app

# Install system dependencies needed by @zoom/rtms
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 3002

# Start server
CMD ["npm", "start"]
