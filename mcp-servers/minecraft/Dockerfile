FROM node:18-bullseye

# Install X11 dependencies for headless WebGL rendering, canvas, and build tools
RUN apt-get update -y && \
    apt-get install -y \
    xserver-xorg-dev \
    libxi-dev \
    libxext-dev \
    xvfb \
    build-essential \
    python3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package files first for better caching
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Build TypeScript
RUN npm run build

# Create screenshots directory for output
RUN mkdir -p /usr/src/app/screenshots

# Environment variables (can be overridden at runtime)
ENV MC_HOST=localhost
ENV MC_PORT=25565
ENV MC_USERNAME=mcp-bot
ENV MC_AUTH=offline
ENV VIEWER_PORT=3000

# Expose the web viewer port
EXPOSE 3000

# Run the MCP server with xvfb for headless WebGL
# Start Xvfb in background, then run node (avoids xvfb-run stdout buffering)
CMD ["sh", "-c", "Xvfb :99 -ac -screen 0 1280x1024x24 & export DISPLAY=:99 && exec node dist/index.js"]
