// Browser API polyfills for Three.js in Node.js environment
// Must be set before importing Three.js
(global as any).requestAnimationFrame = (callback: FrameRequestCallback): number => {
  return setTimeout(callback, 16) as unknown as number;
};
(global as any).cancelAnimationFrame = (id: number): void => {
  clearTimeout(id);
};

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import http from "http";
import { z } from "zod";
import mineflayer, { Bot } from "mineflayer";
import mineflayerPathfinder from "mineflayer-pathfinder";
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
const { pathfinder, Movements, goals } = mineflayerPathfinder;

// Screenshot dependencies (optional — loaded dynamically)
import { Worker } from "worker_threads";
(global as any).Worker = Worker;

let Viewer: any, WorldView: any, getBufferFromStream: any;
let createCanvas: any;
let THREE: any;
let mineflayerViewer: any;
let screenshotAvailable = false;

try {
  // Use string variables to prevent TypeScript from resolving these at compile time
  const pvViewerPath = "prismarine-viewer/viewer/index.js";
  const canvasPath = "node-canvas-webgl/lib/index.js";
  const threePath = "three";
  const pvPath = "prismarine-viewer";
  const prismarineViewerMod = await import(/* @vite-ignore */ pvViewerPath);
  ({ Viewer, WorldView, getBufferFromStream } = prismarineViewerMod.default || prismarineViewerMod);
  const canvasMod = await import(/* @vite-ignore */ canvasPath);
  createCanvas = canvasMod.createCanvas;
  THREE = await import(/* @vite-ignore */ threePath);
  const viewerMod = await import(/* @vite-ignore */ pvPath);
  mineflayerViewer = viewerMod.mineflayer;
  screenshotAvailable = true;
} catch {
  // Screenshot deps not available — screenshot tool will return an error
}

// Configuration from environment
const MC_HOST = process.env.MC_HOST || "localhost";
const MC_PORT = parseInt(process.env.MC_PORT || "25565");
const MC_USERNAME = process.env.MC_USERNAME || "mcp-bot";
const MC_PASSWORD = process.env.MC_PASSWORD;
const MC_AUTH = process.env.MC_AUTH || "microsoft"; // "offline" for cracked servers
const VIEWER_PORT = parseInt(process.env.VIEWER_PORT || "3000");

// Bot state
let bot: Bot | null = null;
let botReady = false;
let mcData: ReturnType<typeof minecraftData> | null = null;
let autoReconnect = true;
let lastConnectOpts: { host: string; port: number; username: string; auth: string } | null = null;
let reconnecting = false;

function setupAutoReconnect() {
  if (!bot) return;
  bot.on("end", (reason) => {
    console.error(`[mineflayer-mcp] Bot disconnected: ${reason}`);
    botReady = false;
    if (autoReconnect && lastConnectOpts && !reconnecting) {
      reconnecting = true;
      console.error("[mineflayer-mcp] Auto-reconnecting in 5 seconds...");
      setTimeout(() => {
        reconnecting = false;
        if (!botReady && lastConnectOpts) {
          console.error("[mineflayer-mcp] Reconnecting...");
          doConnect(lastConnectOpts.host, lastConnectOpts.port, lastConnectOpts.username, lastConnectOpts.auth);
        }
      }, 5000);
    }
  });
}

function doConnect(host: string, port: number, username: string, auth: string): Promise<string> {
  return new Promise((resolve) => {
    bot = mineflayer.createBot({
      host, port, username,
      password: MC_PASSWORD,
      auth: auth as "offline" | "microsoft",
    });
    lastConnectOpts = { host, port, username, auth };

    bot.on("spawn", async () => {
      try {
        console.error("[mineflayer-mcp] Bot spawned, loading pathfinder...");
        bot!.loadPlugin(pathfinder);
        const defaultMovements = new Movements(bot!);
        bot!.pathfinder.setMovements(defaultMovements);
        mcData = minecraftData(bot!.version);
        console.error(`[mineflayer-mcp] Loaded minecraft-data for version ${bot!.version}`);
        await bot!.waitForChunksToLoad();
        console.error("[mineflayer-mcp] Chunks loaded, bot ready");

        if (mineflayerViewer) {
          try {
            mineflayerViewer(bot!, { port: VIEWER_PORT, firstPerson: false });
          } catch (viewerErr: any) {
            console.error("[mineflayer-mcp] Web viewer failed:", viewerErr.message);
          }
        }

        botReady = true;
        setupAutoReconnect();
        resolve(`Connected to ${host}:${port} as ${username}. Bot is ready.`);
      } catch (err: any) {
        console.error("[mineflayer-mcp] Spawn error:", err);
        setupAutoReconnect();
        resolve(`Spawn error: ${err.message}`);
      }
    });

    bot.on("error", (err) => {
      botReady = false;
      setupAutoReconnect();
      resolve(`Connection error: ${err.message}`);
    });

    bot.on("kicked", (reason) => {
      botReady = false;
      console.error(`[mineflayer-mcp] Kicked: ${reason}`);
      setupAutoReconnect();
      resolve(`Kicked: ${reason}`);
    });

    setTimeout(() => {
      if (!botReady) {
        setupAutoReconnect();
        resolve("Connection timeout after 30 seconds");
      }
    }, 30000);
  });
}

// Task tracking for background eval
interface Task {
  id: string;
  code: string;
  status: "running" | "completed" | "error" | "cancelled";
  result?: string;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  abortController?: AbortController;
}

const tasks = new Map<string, Task>();
let taskIdCounter = 0;

function generateTaskId(): string {
  return `task_${++taskIdCounter}_${Date.now()}`;
}

// Create the MCP server
const server = new McpServer({
  name: "mineflayer-mcp",
  version: "1.0.0",
});

// Tool: Connect to Minecraft server
server.tool(
  "connect",
  "Connect the bot to a Minecraft server",
  {
    host: z.string().optional().describe("Minecraft server host (default: localhost)"),
    port: z.number().optional().describe("Minecraft server port (default: 25565)"),
    username: z.string().optional().describe("Bot username (default: mcp-bot)"),
    auth: z.enum(["offline", "microsoft"]).optional().describe("Auth mode: 'offline' for cracked servers, 'microsoft' for premium (default: microsoft)"),
  },
  async ({ host, port, username, auth }) => {
    if (bot && botReady) {
      return {
        content: [{ type: "text", text: "Bot is already connected. Use disconnect first." }],
      };
    }

    const result = await doConnect(
      host || MC_HOST,
      port || MC_PORT,
      username || MC_USERNAME,
      auth || MC_AUTH,
    );
    return { content: [{ type: "text", text: result }] };
  }
);

// Tool: Check bot status
server.tool(
  "status",
  "Check if the bot is connected and get its current state (position, health, food). Use this before running commands to verify connection.",
  {},
  async () => {
    if (!bot || !botReady) {
      return {
        content: [{ type: "text", text: `Bot is NOT connected. Auto-reconnect: ${autoReconnect}. Last server: ${lastConnectOpts ? `${lastConnectOpts.host}:${lastConnectOpts.port}` : 'none'}` }],
      };
    }
    const pos = bot.entity?.position;
    return {
      content: [{ type: "text", text: `Bot CONNECTED as ${bot.username} at (${pos?.x?.toFixed(1)}, ${pos?.y?.toFixed(1)}, ${pos?.z?.toFixed(1)}). Health: ${bot.health}/20, Food: ${bot.food}/20. Auto-reconnect: ${autoReconnect}` }],
    };
  }
);

// Tool: Disconnect from server
server.tool(
  "disconnect",
  "Disconnect the bot from the Minecraft server. Set auto_reconnect=false to prevent auto-reconnect.",
  { auto_reconnect: z.boolean().optional().describe("If false, disables auto-reconnect (default: keeps current setting)") },
  async ({ auto_reconnect }) => {
    if (auto_reconnect !== undefined) autoReconnect = auto_reconnect;
    if (!bot) {
      return {
        content: [{ type: "text", text: "Bot is not connected." }],
      };
    }

    autoReconnect = false; // Don't auto-reconnect on manual disconnect
    bot.end();
    bot = null;
    botReady = false;

    return {
      content: [{ type: "text", text: "Disconnected from server." }],
    };
  }
);

// Helper to stringify results
function stringifyResult(result: unknown): string {
  if (result === undefined) {
    return "undefined";
  } else if (result === null) {
    return "null";
  } else if (typeof result === "object") {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  } else {
    return String(result);
  }
}

// Helper to execute code with bot context
async function executeCode(code: string, currentBot: Bot, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw new Error("Task was cancelled before execution");
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    "bot", "goals", "Movements", "signal", "mcData", "Vec3",
    `return (async () => { ${code} })()`
  );
  const result = await fn(currentBot, goals, Movements, signal, mcData, Vec3);
  return stringifyResult(result);
}

// Tool: Eval - execute JavaScript code with bot context
server.tool(
  "eval",
  "Execute JavaScript code with access to the bot object (like a REPL). Use background=true for long-running tasks. Available: bot, goals (GoalFollow, GoalNear, GoalBlock, GoalXZ, GoalY, GoalGetToBlock), Movements, mcData (minecraft-data), Vec3.",
  {
    code: z.string().describe("JavaScript code to execute. Available: bot, goals, Movements, mcData (for items/blocks/recipes), Vec3."),
    background: z.boolean().optional().describe("Run in background and return task ID (default: false)"),
  },
  async ({ code, background }) => {
    if (!bot || !botReady) {
      return {
        content: [{ type: "text", text: "Bot is not connected. Use connect tool first." }],
        isError: true,
      };
    }

    // Background execution
    if (background) {
      const taskId = generateTaskId();
      const abortController = new AbortController();
      const task: Task = {
        id: taskId,
        code,
        status: "running",
        startedAt: new Date(),
        abortController,
      };
      tasks.set(taskId, task);

      // Run in background (don't await)
      const currentBot = bot; // Capture reference
      executeCode(code, currentBot, abortController.signal)
        .then((result) => {
          if (task.status === "running") {
            task.status = "completed";
            task.result = result;
            task.completedAt = new Date();
          }
        })
        .catch((err: Error) => {
          if (task.status === "running") {
            task.status = "error";
            task.error = `${err.message}\n${err.stack}`;
            task.completedAt = new Date();
          }
        });

      return {
        content: [{ type: "text", text: `Task started in background.\nTask ID: ${taskId}\nUse get_task to check status.` }],
      };
    }

    // Synchronous execution with 30s timeout
    const EVAL_TIMEOUT_MS = 30000;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Eval timed out after ${EVAL_TIMEOUT_MS / 1000}s. Use background=true for long-running tasks.`)), EVAL_TIMEOUT_MS);
      });
      const result = await Promise.race([executeCode(code, bot), timeoutPromise]);
      return {
        content: [{ type: "text", text: `Result:\n${result}` }],
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: [{ type: "text", text: `Eval error: ${error.message}\n${error.stack}` }],
        isError: true,
      };
    }
  }
);

// Tool: Get task status and output
server.tool(
  "get_task",
  "Get the status and output of a background task",
  {
    task_id: z.string().describe("The task ID returned from eval with background=true"),
  },
  async ({ task_id }) => {
    const task = tasks.get(task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task not found: ${task_id}` }],
        isError: true,
      };
    }

    const duration = task.completedAt
      ? `${(task.completedAt.getTime() - task.startedAt.getTime()) / 1000}s`
      : `${(Date.now() - task.startedAt.getTime()) / 1000}s (running)`;

    let output = `Task ID: ${task.id}\nStatus: ${task.status}\nDuration: ${duration}\nCode: ${task.code.slice(0, 100)}${task.code.length > 100 ? "..." : ""}\n`;

    if (task.status === "completed") {
      output += `\nResult:\n${task.result}`;
    } else if (task.status === "error") {
      output += `\nError:\n${task.error}`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
);

// Tool: List all tasks
server.tool(
  "list_tasks",
  "List all background tasks and their status",
  {
    status: z.enum(["all", "running", "completed", "error", "cancelled"]).optional().describe("Filter by status (default: all)"),
  },
  async ({ status }) => {
    const filterStatus = status || "all";
    const filteredTasks = Array.from(tasks.values()).filter(
      (task) => filterStatus === "all" || task.status === filterStatus
    );

    if (filteredTasks.length === 0) {
      return {
        content: [{ type: "text", text: `No tasks found${filterStatus !== "all" ? ` with status: ${filterStatus}` : ""}.` }],
      };
    }

    const taskList = filteredTasks
      .map((task) => {
        const duration = task.completedAt
          ? `${(task.completedAt.getTime() - task.startedAt.getTime()) / 1000}s`
          : `${(Date.now() - task.startedAt.getTime()) / 1000}s`;
        return `- ${task.id}: ${task.status} (${duration}) - ${task.code.slice(0, 50)}${task.code.length > 50 ? "..." : ""}`;
      })
      .join("\n");

    return {
      content: [{ type: "text", text: `Tasks (${filteredTasks.length}):\n${taskList}` }],
    };
  }
);

// Tool: Cancel a running task
server.tool(
  "cancel_task",
  "Cancel a running background task. Aborts execution and stops any active pathfinder goals.",
  {
    task_id: z.string().describe("The task ID to cancel"),
  },
  async ({ task_id }) => {
    const task = tasks.get(task_id);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task not found: ${task_id}` }],
        isError: true,
      };
    }

    if (task.status !== "running") {
      return {
        content: [{ type: "text", text: `Task ${task_id} is not running (status: ${task.status})` }],
        isError: true,
      };
    }

    // Abort the task
    task.abortController?.abort();
    task.status = "cancelled";
    task.completedAt = new Date();

    // Stop any active pathfinder goals
    if (bot && botReady) {
      try {
        bot.pathfinder.stop();
      } catch {
        // Ignore if pathfinder not active
      }
    }

    const duration = `${(task.completedAt.getTime() - task.startedAt.getTime()) / 1000}s`;
    return {
      content: [{ type: "text", text: `Task ${task_id} cancelled after ${duration}.\nPathfinder goals stopped.` }],
    };
  }
);

// Tool: Load and execute a script from a file
server.tool(
  "eval_file",
  "Load and execute a JavaScript file with access to the bot object. Same as eval but loads code from a file.",
  {
    file_path: z.string().describe("Absolute path to the JavaScript file to execute"),
    background: z.boolean().optional().describe("Run in background and return task ID (default: false)"),
  },
  async ({ file_path, background }) => {
    if (!bot || !botReady) {
      return {
        content: [{ type: "text", text: "Bot is not connected. Use connect tool first." }],
        isError: true,
      };
    }

    // Read the file
    let code: string;
    try {
      code = await readFile(file_path, "utf-8");
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: [{ type: "text", text: `Failed to read file: ${error.message}` }],
        isError: true,
      };
    }

    // Background execution
    if (background) {
      const taskId = generateTaskId();
      const abortController = new AbortController();
      const task: Task = {
        id: taskId,
        code: `[file: ${file_path}]\n${code.slice(0, 200)}${code.length > 200 ? "..." : ""}`,
        status: "running",
        startedAt: new Date(),
        abortController,
      };
      tasks.set(taskId, task);

      const currentBot = bot;
      executeCode(code, currentBot, abortController.signal)
        .then((result) => {
          if (task.status === "running") {
            task.status = "completed";
            task.result = result;
            task.completedAt = new Date();
          }
        })
        .catch((err: Error) => {
          if (task.status === "running") {
            task.status = "error";
            task.error = `${err.message}\n${err.stack}`;
            task.completedAt = new Date();
          }
        });

      return {
        content: [{ type: "text", text: `Task started from file: ${file_path}\nTask ID: ${taskId}\nUse get_task to check status.` }],
      };
    }

    // Synchronous execution with 30s timeout
    const EVAL_TIMEOUT_MS = 30000;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Eval timed out after ${EVAL_TIMEOUT_MS / 1000}s. Use background=true for long-running tasks.`)), EVAL_TIMEOUT_MS);
      });
      const result = await Promise.race([executeCode(code, bot), timeoutPromise]);
      return {
        content: [{ type: "text", text: `File: ${file_path}\nResult:\n${result}` }],
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        content: [{ type: "text", text: `Eval error in ${file_path}: ${error.message}\n${error.stack}` }],
        isError: true,
      };
    }
  }
);

// Screenshot tool - takes a screenshot of the bot's view
server.tool(
  "screenshot",
  "Take a screenshot of the bot's view in Minecraft. Returns the image as base64 JPEG or saves to a file.",
  {
    output_path: z.string().optional().describe("Optional file path to save the screenshot (e.g., '/tmp/screenshot.jpg'). If not provided, returns base64 image data."),
    width: z.number().optional().describe("Image width in pixels (default: 512)"),
    height: z.number().optional().describe("Image height in pixels (default: 512)"),
    direction: z.object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    }).optional().describe("Direction to look (relative to bot position). Default: { x: 1, y: -0.2, z: 0 }"),
    view_distance: z.number().optional().describe("View distance in chunks (default: 4)"),
  },
  async ({ output_path, width, height, direction, view_distance }) => {
    if (!screenshotAvailable) {
      return {
        content: [{ type: "text", text: "Screenshot dependencies not available (prismarine-viewer, node-canvas-webgl, three). Install optional deps to enable screenshots." }],
        isError: true,
      };
    }
    if (!bot || !botReady) {
      return {
        content: [{ type: "text", text: "Bot is not connected. Use connect tool first." }],
        isError: true,
      };
    }

    const imgWidth = width || 512;
    const imgHeight = height || 512;
    const viewDist = view_distance || 4;
    const dir = direction || { x: 1, y: -0.2, z: 0 };

    try {
      console.error("[mineflayer-mcp] Taking screenshot...");

      // Create canvas and renderer
      const canvas = createCanvas(imgWidth, imgHeight);
      const renderer = new THREE.WebGLRenderer({ canvas });
      const viewer = new Viewer(renderer);

      // Get bot position
      const botPos = bot.entity.position;
      const center = new Vec3(botPos.x, botPos.y + 1.6, botPos.z); // Eye height

      // Set version and create world view
      viewer.setVersion(bot.version);
      const worldView = new WorldView(bot.world, viewDist, center);
      viewer.listen(worldView);

      // Position camera at bot's eye position
      viewer.camera.position.set(center.x, center.y, center.z);

      // Initialize world view
      await worldView.init(center);

      // Set camera direction
      const cameraPos = new Vec3(viewer.camera.position.x, viewer.camera.position.y, viewer.camera.position.z);
      const lookDir = new Vec3(dir.x, dir.y, dir.z);
      const point = cameraPos.add(lookDir);
      viewer.camera.lookAt(point.x, point.y, point.z);

      // Wait for world to load
      console.error("[mineflayer-mcp] Waiting for world chunks to render...");
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Render the scene
      renderer.render(viewer.scene, viewer.camera);

      // Create JPEG stream
      const imageStream = canvas.createJPEGStream({
        bufsize: 4096,
        quality: 95,
        progressive: false,
      });
      const buf = await getBufferFromStream(imageStream);

      // Cleanup - wrap in try-catch as Three.js dispose may have browser-specific code
      try {
        renderer.dispose();
      } catch (disposeErr) {
        console.error("[mineflayer-mcp] Renderer dispose warning:", disposeErr);
      }

      if (output_path) {
        // Save to file
        const dir = output_path.substring(0, output_path.lastIndexOf('/'));
        if (dir) {
          try {
            await stat(dir);
          } catch {
            await mkdir(dir, { recursive: true });
          }
        }
        await writeFile(output_path, buf);
        console.error(`[mineflayer-mcp] Screenshot saved to ${output_path}`);
        return {
          content: [{ type: "text", text: `Screenshot saved to ${output_path}` }],
        };
      } else {
        // Return as base64
        const base64 = buf.toString("base64");
        console.error("[mineflayer-mcp] Screenshot captured, returning as base64");
        return {
          content: [
            {
              type: "image",
              data: base64,
              mimeType: "image/jpeg",
            },
          ],
        };
      }
    } catch (err: unknown) {
      const error = err as Error;
      console.error("[mineflayer-mcp] Screenshot error:", error);
      return {
        content: [{ type: "text", text: `Screenshot error: ${error.message}\n${error.stack}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const httpPort = process.env.MC_MCP_HTTP_PORT;

  if (httpPort) {
    // HTTP/SSE mode — persistent server that multiple clients can connect to
    const port = parseInt(httpPort);
    let sseTransport: SSEServerTransport | null = null;

    const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        console.error(`[mineflayer-mcp] SSE client connected`);
        sseTransport = new SSEServerTransport('/messages', res);
        await server.connect(sseTransport);
      } else if (req.method === 'POST' && req.url === '/messages') {
        if (sseTransport) {
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(503);
          res.end('No SSE connection');
        }
      } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', botReady, autoReconnect }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`[mineflayer-mcp] HTTP/SSE server listening on port ${port}`);
    });
  } else {
    // Stdio mode (default)
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch(console.error);
