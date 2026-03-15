export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || 'NanoMC';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// All persistent data under /app/data/
export const DATA_DIR = process.env.DATA_DIR || '/app/data';
export const STORE_DIR = `${DATA_DIR}/store`;
export const GROUPS_DIR = `${DATA_DIR}/groups`;

export const PROCESS_TIMEOUT = parseInt(
  process.env.PROCESS_TIMEOUT || '1800000',
  10,
);
export const PROCESS_MAX_OUTPUT_SIZE = parseInt(
  process.env.PROCESS_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
