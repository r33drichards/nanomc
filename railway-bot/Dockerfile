FROM node:22-slim

# Install build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install host dependencies
COPY package*.json ./
RUN npm install --ignore-scripts
# Rebuild native modules (better-sqlite3)
RUN npm rebuild better-sqlite3

# Install agent-runner dependencies
COPY agent-runner/package*.json ./agent-runner/
RUN cd agent-runner && npm install

# Copy and build host app
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Copy and build agent-runner
COPY agent-runner/tsconfig.json ./agent-runner/
COPY agent-runner/src/ ./agent-runner/src/
RUN cd agent-runner && npx tsc

# Install Minecraft MCP server (as subprocess, no native deps)
COPY minecraft-mcp/ /app/minecraft-mcp/
RUN cd /app/minecraft-mcp && npm install --ignore-scripts --omit=optional && npm run build

# Create data directory
RUN mkdir -p /app/data/store /app/data/groups /app/data/ipc /app/data/sessions

CMD ["node", "dist/index.js"]
