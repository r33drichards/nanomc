/**
 * CLI Channel for NanoClaw
 * Provides a local stdin/stdout interface for testing without messaging platforms.
 * Messages typed in the terminal are delivered to the main group.
 */
import readline from 'readline';
import crypto from 'crypto';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';

const CLI_JID = 'cli@local';

class CliChannel implements Channel {
  name = 'cli';
  private rl: readline.Interface | null = null;
  private connected = false;
  private onMessage: ChannelOpts['onMessage'];
  private onChatMetadata: ChannelOpts['onChatMetadata'];

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `You> `,
    });

    this.connected = true;
    this.onChatMetadata(CLI_JID, new Date().toISOString(), 'CLI', 'cli', false);

    logger.info('CLI channel connected — type messages below');
    console.log(`\n💬 CLI mode active. Messages are sent to ${ASSISTANT_NAME}. Press Ctrl+C to exit.\n`);
    this.rl.prompt();

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      const message: NewMessage = {
        id: crypto.randomUUID(),
        chat_jid: CLI_JID,
        sender: 'cli-user',
        sender_name: 'You',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      };

      this.onMessage(CLI_JID, message);
      // Don't re-prompt — the agent response will print first
    });

    this.rl.on('close', () => {
      this.connected = false;
    });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    console.log(`\n${ASSISTANT_NAME}> ${text}\n`);
    this.rl?.prompt();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid === CLI_JID;
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.connected = false;
  }
}

registerChannel('cli', (opts) => {
  // Only activate if CLI_CHANNEL=1 env var is set (to avoid conflicting with real channels)
  if (process.env.CLI_CHANNEL !== '1') return null;
  return new CliChannel(opts);
});
