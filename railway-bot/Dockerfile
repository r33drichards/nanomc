FROM node:22-slim

WORKDIR /app

# Install bot dependencies
COPY package*.json ./
RUN npm install

# Copy and build bot
COPY . .
RUN npm run build

# Install Minecraft MCP server (as subprocess, no native deps)
COPY minecraft-mcp/ /app/minecraft-mcp/
RUN cd /app/minecraft-mcp && npm install --ignore-scripts --omit=optional && npm run build

CMD ["node", "dist/index.js"]
