# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mineflayer MCP Server - An MCP (Model Context Protocol) server that provides tools for controlling a Minecraft bot using mineflayer. The server exposes tools via stdio transport for integration with Claude Desktop or other MCP clients.

## Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Run in development mode (uses tsx for hot reload)
npm run dev

# Run production build
npm start

# Test with MCP inspector
npx @modelcontextprotocol/inspector node dist/index.js
npx @modelcontextprotocol/inspector npm run dev
```

## Architecture

Single-file MCP server (`src/index.ts`) that:

1. **Bot State Management**: Global `bot` and `botReady` variables track the mineflayer Bot instance and connection state
2. **Task System**: Background task execution with `tasks` Map storing Task objects (id, code, status, result/error, AbortController)
3. **MCP Tools**: Each tool is registered via `server.tool()` with Zod schemas for parameter validation

### MCP Tools Exposed

- `connect` - Creates mineflayer bot, loads pathfinder plugin, waits for chunks
- `disconnect` - Ends bot session
- `eval` - Executes arbitrary JS with bot context (sync or background mode)
- `eval_file` - Same as eval but loads code from file
- `get_task` / `list_tasks` / `cancel_task` - Background task management

### Eval Context

Code executed via `eval` has access to:
- `bot` - mineflayer Bot instance
- `goals` - pathfinder goals (GoalFollow, GoalNear, GoalBlock, GoalXZ, GoalY, GoalGetToBlock)
- `Movements` - pathfinder Movements class
- `mcData` - minecraft-data for the connected server version
- `Vec3` - vec3 class for vector operations
- `signal` - AbortSignal for background tasks

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_HOST` | localhost | Minecraft server host |
| `MC_PORT` | 25565 | Minecraft server port |
| `MC_USERNAME` | mcp-bot | Bot username |
| `MC_PASSWORD` | - | For online-mode servers |
| `MC_AUTH` | microsoft | Auth mode: offline or microsoft |
