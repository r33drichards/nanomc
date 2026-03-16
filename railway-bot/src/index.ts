/**
 * NanoClaw Railway Bot — Main Orchestrator
 *
 * Combines NanoClaw's message loop, task scheduler, and IPC watcher
 * with an IRC channel for communication. Uses direct Node.js subprocess
 * execution instead of Docker containers.
 */
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { Client } from 'irc-framework';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  ContainerOutput,
  runDirectAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './direct-runner.js';
import {
  clearAllActiveTasks,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher, AvailableGroup } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// --- State ---
let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

// --- IRC Config ---
const IRC_SERVER = process.env.IRC_SERVER || 'docker.railway.internal';
const IRC_PORT = parseInt(process.env.IRC_PORT || '6667');
const IRC_NICK = process.env.IRC_NICK || 'nanomc';
const IRC_CHANNEL = process.env.IRC_CHANNEL || '#minecraft';
const IRC_PASS = process.env.IRC_PASS || '';
const IRC_JID = `irc:${IRC_CHANNEL}`; // Virtual JID for the IRC channel

// --- State persistence ---
function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

// --- Message processing ---
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing process stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback',
      );
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runDirectAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        queue.registerProcess(chatJid, proc, processName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// --- Message loop ---
async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        lastTimestamp = newTimestamp;
        saveState();

        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active process',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
          } else {
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

// --- IRC Channel ---
function createIrcChannel(): Channel {
  const client = new Client();
  let connected = false;

  return {
    name: 'irc',

    async connect(): Promise<void> {
      return new Promise((resolve) => {
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
          logger.info(`Connected to IRC as ${IRC_NICK}`);
          client.join(IRC_CHANNEL);
          connected = true;
          resolve();
        });

        client.on('message', (event: { target: string; nick: string; message: string }) => {
          if (event.target !== IRC_CHANNEL) return;
          if (event.nick === IRC_NICK) return;

          const now = new Date().toISOString();
          const msgId = `irc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

          // Store chat metadata
          storeChatMetadata(IRC_JID, now, IRC_CHANNEL, 'irc', true);

          // Store message in SQLite
          const msg: NewMessage = {
            id: msgId,
            chat_jid: IRC_JID,
            sender: event.nick,
            sender_name: event.nick,
            content: event.message,
            timestamp: now,
            is_from_me: false,
            is_bot_message: false,
          };
          storeMessage(msg);
        });

        client.on('error', (err: Error) => {
          logger.error({ err }, 'IRC error');
        });

        client.on('close', () => {
          connected = false;
          logger.info('IRC connection closed, will auto-reconnect...');
        });

        // Resolve after timeout if registered event hasn't fired
        setTimeout(() => {
          if (!connected) {
            logger.warn('IRC connection timeout, continuing startup');
            resolve();
          }
        }, 15000);
      });
    },

    async sendMessage(_jid: string, text: string): Promise<void> {
      if (!connected) {
        logger.warn('IRC not connected, dropping message');
        return;
      }
      // Split long messages for IRC line limits
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          // Further split if line exceeds IRC limit
          const chunks: string[] = [];
          if (line.length <= 400) {
            chunks.push(line);
          } else {
            for (let i = 0; i < line.length; i += 400) {
              chunks.push(line.slice(i, i + 400));
            }
          }
          for (const chunk of chunks) {
            client.say(IRC_CHANNEL, chunk);
          }
        }
      }

      // Also store bot messages in the DB
      const now = new Date().toISOString();
      storeMessage({
        id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        chat_jid: IRC_JID,
        sender: IRC_NICK,
        sender_name: IRC_NICK,
        content: text,
        timestamp: now,
        is_from_me: true,
        is_bot_message: true,
      });
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(jid: string): boolean {
      return jid === IRC_JID;
    },

    async disconnect(): Promise<void> {
      client.quit('NanoClaw shutting down');
      connected = false;
    },
  };
}

// --- Startup ---
async function main(): Promise<void> {
  // Ensure data directories exist
  fs.mkdirSync(DATA_DIR, { recursive: true });

  initDatabase();
  logger.info('Database initialized');

  // Clear stale scheduled tasks from previous sessions to prevent blocking
  const staleCount = clearAllActiveTasks();
  if (staleCount > 0) {
    logger.info({ count: staleCount }, 'Cleared stale scheduled tasks from previous session');
  }

  loadState();

  // Reset message cursors to current time so we don't reprocess old messages on restart
  const now = new Date().toISOString();
  lastTimestamp = now;
  for (const jid of Object.keys(registeredGroups)) {
    lastAgentTimestamp[jid] = now;
  }
  saveState();
  logger.info('Reset message cursors to current time (fresh start)');

  // Auto-register the IRC channel as the main group if not already registered
  if (!registeredGroups[IRC_JID]) {
    registerGroup(IRC_JID, {
      name: IRC_CHANNEL,
      folder: 'main',
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: true,
    });
    logger.info({ jid: IRC_JID }, 'Auto-registered IRC channel as main group');
  }

  // Create and connect IRC channel
  const ircChannel = createIrcChannel();
  channels.push(ircChannel);
  await ircChannel.connect();

  if (channels.length === 0 || !channels.some((c) => c.isConnected())) {
    logger.warn('No channels connected yet, message loop will wait for reconnection');
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, processName, groupFolder) =>
      queue.registerProcess(groupJid, proc, processName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
  });

  queue.setProcessMessagesFn(processGroupMessages);
  // Skip recoverPendingMessages — we reset cursors to now on startup
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
