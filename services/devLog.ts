// ============================================================
// devLog — in-app log buffer for production observability.
//
// Routes warn/error events through console.* AND into a ring buffer
// stored in AsyncStorage (key: devLog). A hidden viewer in
// SettingsModal can dump these entries for support/debugging on
// production builds where Metro/Logcat aren't available.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'devLog';
const MAX_ENTRIES = 300;

export type DevLogLevel = 'info' | 'warn' | 'error';

export interface DevLogEntry {
  ts: number;        // epoch ms
  level: DevLogLevel;
  tag: string;
  msg: string;       // JSON-stringified args (best-effort)
}

function safeStringify(args: unknown[]): string {
  try {
    return args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(' ');
  } catch {
    return '[unstringifiable args]';
  }
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * Log an event to console AND to the AsyncStorage ring buffer.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export function logEvent(level: DevLogLevel, tag: string, ...args: unknown[]): void {
  const msg = safeStringify(args);
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${tag}]`, ...args);

  const entry: DevLogEntry = { ts: Date.now(), level, tag, msg };
  // Serialize writes so concurrent logs don't race on read-modify-write.
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        const entries: DevLogEntry[] = raw ? JSON.parse(raw) : [];
        entries.push(entry);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      } catch {
        // Silent — logging failures must never cascade.
      }
    });
}

/** Read the current log buffer (most-recent last). */
export async function getDevLog(): Promise<DevLogEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DevLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** Wipe the log buffer. */
export async function clearDevLog(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Silent.
  }
}

/** Format the buffer as plain text for copy-to-clipboard. */
export function formatDevLog(entries: DevLogEntry[]): string {
  return entries
    .map((e) => {
      const t = new Date(e.ts).toISOString();
      return `[${t}] ${e.level.toUpperCase()} ${e.tag}: ${e.msg}`;
    })
    .join('\n');
}
