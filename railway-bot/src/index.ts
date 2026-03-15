/**
 * NanoMC IRC Bot
 * Vercel AI SDK v5 + Amazon Bedrock + MCP tools (Minecraft via mineflayer)
 * Runs as a single Node.js process — MCP server spawned as subprocess.
 */
import { Client } from 'irc-framework';
import { generateText, tool, stepCountIs } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const IRC_SERVER = process.env.IRC_SERVER || 'docker.railway.internal';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6667');
const IRC_NICK = process.env.IRC_NICK || 'nanomc';
const IRC_CHANNEL = process.env.IRC_CHANNEL || '#minecraft';
const IRC_PASS = process.env.IRC_PASS || '';

const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT_NUM = process.env.MC_PORT || '25565';
const MC_USERNAME = process.env.MC_USERNAME || 'nanomc-bot';
const MC_AUTH = process.env.MC_AUTH || 'offline';

const MODEL_ID = process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are NanoMC, an AI assistant in an IRC channel with Minecraft bot control.
You have access to Minecraft MCP tools: connect, disconnect, eval, eval_file, screenshot, get_task, list_tasks, cancel_task.
When asked to do Minecraft things, use these tools. First connect if not connected.
The eval tool lets you run JavaScript with the mineflayer bot object.
Keep responses concise — IRC has ~400 char line limits. Use plain text, NO markdown.`;

// Conversation history per channel
const history = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>();

function getHistory(channel: string) {
  if (!history.has(channel)) history.set(channel, []);
  return history.get(channel)!;
}

function splitMessage(text: string, maxLen = 400): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= maxLen) {
      lines.push(line);
    } else {
      for (let i = 0; i < line.length; i += maxLen) {
        lines.push(line.slice(i, i + maxLen));
      }
    }
  }
  return lines;
}

let mcpClient: Awaited<ReturnType<typeof createMCPClient>> | null = null;
let mcpTools: Record<string, any> = {};

async function initMCP(): Promise<void> {
  try {
    console.log('Initializing Minecraft MCP server...');
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['/app/minecraft-mcp/dist/index.js'],
      env: {
        ...process.env as Record<string, string>,
        MC_HOST,
        MC_PORT: MC_PORT_NUM,
        MC_USERNAME,
        MC_AUTH,
      },
    });
    mcpClient = await createMCPClient({ transport: transport as any });
    mcpTools = await mcpClient.tools();
    console.log(`MCP tools loaded: ${Object.keys(mcpTools).join(', ')}`);
  } catch (err) {
    console.error('Failed to init MCP:', err);
  }
}

async function handleMessage(client: any, channel: string, nick: string, message: string): Promise<void> {
  console.log(`[${channel}] <${nick}> ${message}`);

  const conv = getHistory(channel);
  conv.push({ role: 'user', content: `${nick}: ${message}` });
  while (conv.length > 20) conv.shift();

  try {
    client.say(channel, `${nick}: thinking...`);

    const { text } = await generateText({
      model: bedrock(MODEL_ID),
      system: SYSTEM_PROMPT,
      messages: conv.map(m => ({ role: m.role, content: m.content })),
      tools: mcpTools,
      stopWhen: stepCountIs(10),
    });

    const response = text || '(completed tool actions, no text response)';
    conv.push({ role: 'assistant', content: response });

    const lines = splitMessage(response);
    const toSend = lines.slice(0, 10);
    for (const line of toSend) {
      if (line.trim()) client.say(channel, line);
    }
    if (lines.length > 10) {
      client.say(channel, `... (${lines.length - 10} more lines truncated)`);
    }
  } catch (err: any) {
    console.error('Agent error:', err?.message || err);
    client.say(channel, `${nick}: error — ${(err?.message || String(err)).slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  console.log('NanoMC IRC Bot starting...');
  console.log(`IRC: ${IRC_SERVER}:${IRC_PORT} as ${IRC_NICK} -> ${IRC_CHANNEL}`);
  console.log(`Model: ${MODEL_ID} (Bedrock)`);
  console.log(`MC: ${MC_HOST}:${MC_PORT_NUM} as ${MC_USERNAME}`);

  await initMCP();

  const client = new Client();

  client.connect({
    host: IRC_SERVER,
    port: IRC_PORT,
    nick: IRC_NICK,
    password: IRC_PASS || undefined,
    tls: false,
    auto_reconnect: true,
    auto_reconnect_wait: 5000,
    auto_reconnect_max_retries: 0,
  });

  client.on('registered', () => {
    console.log(`Connected to IRC as ${IRC_NICK}`);
    client.join(IRC_CHANNEL);
    console.log(`Joined ${IRC_CHANNEL}`);
  });

  client.on('message', (event: { target: string; nick: string; message: string }) => {
    if (event.target !== IRC_CHANNEL) return;
    if (event.nick === IRC_NICK) return;
    handleMessage(client, event.target, event.nick, event.message);
  });

  client.on('error', (err: Error) => {
    console.error('IRC error:', err);
  });

  client.on('close', () => {
    console.log('IRC connection closed, will auto-reconnect...');
  });

  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    if (mcpClient) await mcpClient.close();
    client.quit('NanoMC shutting down');
    process.exit(0);
  });
}

main();
