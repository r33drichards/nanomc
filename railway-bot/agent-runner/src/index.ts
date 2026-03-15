/**
 * NanoClaw Agent Runner (Railway edition)
 * Runs as a direct Node.js child process (no Docker).
 * Uses Vercel AI SDK with Amazon Bedrock instead of Claude Agent SDK.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON
 *   IPC:   Follow-up messages as JSON files in IPC_DIR/input/
 *          Sentinel: IPC_DIR/input/_close signals session end
 *
 * Stdout protocol:
 *   Each result wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateText, stepCountIs } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// Paths from environment (set by direct-runner.ts)
const IPC_DIR = process.env.IPC_DIR || '/app/data/ipc/main';
const GROUP_DIR = process.env.GROUP_DIR || '/app/data/groups/main';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const MODEL_ID = process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Initialize MCP clients
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // NanoClaw IPC MCP server (for send_message, schedule_task, etc.)
  let nanoclawTools: Record<string, any> = {};
  let nanoclawClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;

  try {
    log('Initializing NanoClaw MCP server...');
    const nanoclawTransport = new StdioClientTransport({
      command: 'node',
      args: [mcpServerPath],
      env: {
        ...process.env as Record<string, string>,
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        IPC_DIR: IPC_DIR,
      },
    });
    nanoclawClient = await createMCPClient({ transport: nanoclawTransport as any });
    nanoclawTools = await nanoclawClient.tools();
    log(`NanoClaw MCP tools loaded: ${Object.keys(nanoclawTools).join(', ')}`);
  } catch (err) {
    log(`Failed to init NanoClaw MCP: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Minecraft MCP server (optional)
  let mcTools: Record<string, any> = {};
  let mcClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;

  if (process.env.MC_MCP_ENABLED === '1') {
    try {
      log('Initializing Minecraft MCP server...');
      const mcTransport = new StdioClientTransport({
        command: 'node',
        args: ['/app/minecraft-mcp/dist/index.js'],
        env: {
          ...process.env as Record<string, string>,
          MC_HOST: process.env.MC_HOST || 'localhost',
          MC_PORT: process.env.MC_PORT || '25565',
          MC_USERNAME: process.env.MC_USERNAME || 'nanomc-bot',
          MC_AUTH: process.env.MC_AUTH || 'offline',
        },
      });
      mcClient = await createMCPClient({ transport: mcTransport as any });
      mcTools = await mcClient.tools();
      log(`Minecraft MCP tools loaded: ${Object.keys(mcTools).join(', ')}`);
    } catch (err) {
      log(`Failed to init Minecraft MCP: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const allTools = { ...nanoclawTools, ...mcTools };

  // Build system prompt
  const assistantName = containerInput.assistantName || 'NanoMC';
  const systemPrompt = buildSystemPrompt(assistantName, containerInput);

  // Conversation history for multi-turn
  const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop
  try {
    let currentPrompt = prompt;

    while (true) {
      log(`Starting query (conversation turns: ${conversation.length})...`);

      conversation.push({ role: 'user', content: currentPrompt });

      // Keep conversation bounded
      while (conversation.length > 40) conversation.shift();

      // Poll for IPC messages during generation (in background)
      let closedDuringQuery = false;
      let ipcPolling = true;
      const pollIpc = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          closedDuringQuery = true;
          ipcPolling = false;
          return;
        }
        // We don't pipe mid-query messages in the Vercel AI SDK approach
        // since generateText is not streaming-input-capable.
        // They'll be picked up in the next iteration.
        setTimeout(pollIpc, IPC_POLL_MS);
      };
      setTimeout(pollIpc, IPC_POLL_MS);

      const { text } = await generateText({
        model: bedrock(MODEL_ID),
        system: systemPrompt,
        messages: conversation.map(m => ({ role: m.role, content: m.content })),
        tools: allTools,
        stopWhen: stepCountIs(15),
      });

      ipcPolling = false;

      const response = text || null;
      if (response) {
        conversation.push({ role: 'assistant', content: response });
      }

      log(`Query done. Result: ${response ? response.slice(0, 200) : '(no text)'}`);

      writeOutput({
        status: 'success',
        result: response,
      });

      if (closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Wait for next IPC message or close
      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      currentPrompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    // Cleanup MCP clients
    if (nanoclawClient) await nanoclawClient.close().catch(() => {});
    if (mcClient) await mcClient.close().catch(() => {});
    process.exit(1);
  }

  // Cleanup MCP clients
  if (nanoclawClient) await nanoclawClient.close().catch(() => {});
  if (mcClient) await mcClient.close().catch(() => {});
}

function buildSystemPrompt(assistantName: string, input: ContainerInput): string {
  const parts: string[] = [];

  parts.push(`You are ${assistantName}, an AI assistant running in the NanoClaw orchestrator.`);
  parts.push('You have access to MCP tools for messaging (send_message, schedule_task, list_tasks, etc.) and Minecraft bot control.');
  parts.push('');
  parts.push('IMPORTANT: The Minecraft bot has AUTO-RECONNECT. If disconnected, it reconnects automatically in 5 seconds. Use the "status" tool to check if the bot is connected before assuming it is disconnected.');
  parts.push('When asked to do Minecraft things, use the Minecraft MCP tools. First call "status" to check, then "connect" only if not connected.');
  parts.push('The eval tool lets you run JavaScript with the mineflayer bot object (bot, goals, Movements, mcData, Vec3).');
  parts.push('');
  parts.push('Use send_message to send progress updates or multiple messages while working.');
  parts.push('Use schedule_task to create recurring or one-time tasks.');
  parts.push('');
  parts.push('Keep responses concise. Use plain text, NO markdown formatting.');

  if (input.isMain) {
    parts.push('');
    parts.push('You are running in the MAIN group with elevated privileges.');
    parts.push('You can schedule tasks for any group and register new groups.');
  }

  // Load group CLAUDE.md if it exists
  const groupDir = process.env.GROUP_DIR || `/app/data/groups/${input.groupFolder}`;
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    try {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      parts.push('');
      parts.push('--- Group Instructions (CLAUDE.md) ---');
      parts.push(claudeMd);
    } catch {
      // ignore
    }
  }

  return parts.join('\n');
}

main();
