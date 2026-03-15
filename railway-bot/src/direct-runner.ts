/**
 * Direct Runner for NanoClaw (Railway edition)
 * Spawns agent-runner as a Node.js child process instead of Docker container.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  PROCESS_MAX_OUTPUT_SIZE,
  PROCESS_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getAgentRunnerPath(): string {
  // Look for agent-runner dist relative to this file's dist location
  // dist/direct-runner.js -> ../agent-runner/dist/index.js
  const candidate = path.resolve(__dirname, '..', 'agent-runner', 'dist', 'index.js');
  if (fs.existsSync(candidate)) return candidate;

  // Fallback: look in the source tree (for dev mode with tsx)
  const devCandidate = path.resolve(__dirname, '..', 'agent-runner', 'dist', 'index.js');
  return devCandidate;
}

function ensureDirectories(group: RegisteredGroup): void {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Session directory
  const sessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(sessionsDir, { recursive: true });
}

export async function runDirectAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  ensureDirectories(group);

  const agentRunnerPath = getAgentRunnerPath();
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-${safeName}-${Date.now()}`;

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const sessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');

  logger.info(
    {
      group: group.name,
      processName,
      agentRunner: agentRunnerPath,
      isMain: input.isMain,
    },
    'Spawning direct agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Build environment for the child process
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Paths for the agent-runner
    GROUP_DIR: groupDir,
    IPC_DIR: groupIpcDir,
    SESSIONS_DIR: sessionsDir,
    TZ: TIMEZONE,
    // Bedrock config
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK || '1',
  };

  // Pass through AWS credentials
  if (process.env.AWS_REGION) childEnv.AWS_REGION = process.env.AWS_REGION;
  if (process.env.AWS_DEFAULT_REGION) childEnv.AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION;
  if (process.env.AWS_ACCESS_KEY_ID) childEnv.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
  if (process.env.AWS_SECRET_ACCESS_KEY) childEnv.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
  if (process.env.AWS_SESSION_TOKEN) childEnv.AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;
  if (process.env.BEDROCK_MODEL) childEnv.BEDROCK_MODEL = process.env.BEDROCK_MODEL;

  // Minecraft MCP config
  if (process.env.MC_MCP_ENABLED) childEnv.MC_MCP_ENABLED = process.env.MC_MCP_ENABLED;
  if (process.env.MC_HOST) childEnv.MC_HOST = process.env.MC_HOST;
  if (process.env.MC_PORT) childEnv.MC_PORT = process.env.MC_PORT;
  if (process.env.MC_USERNAME) childEnv.MC_USERNAME = process.env.MC_USERNAME;
  if (process.env.MC_AUTH) childEnv.MC_AUTH = process.env.MC_AUTH;

  return new Promise((resolve) => {
    const proc = spawn('node', [agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    onProcess(proc, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdin!.write(JSON.stringify(input));
    proc.stdin!.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;

    proc.stdout!.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = PROCESS_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Process stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    proc.stderr!.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ process: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = PROCESS_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || PROCESS_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Process timeout, killing',
      );
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Process timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Process timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
      ];

      if (isVerbose || code !== 0) {
        logLines.push(
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: stderr.slice(-500),
            logFile,
          },
          'Agent process exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Non-streaming: parse last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        resolve(output);
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
