// Structured logs: one JSON object per line on stderr, so they can be searched
// and filtered by field (callId, event, latencyMs, ...). LOG_LEVEL sets the
// minimum level: debug, info (the default), warn, error or silent.
//
// Logs never contain what the caller said or their name and number: those
// belong in the call log, not in operational logs.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export type Logger = {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  // A logger that adds these fields to every line, e.g. { callId }.
  child(fields: Fields): Logger;
};

const ORDER: Record<LogLevel | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LoggerOptions = {
  fields?: Fields;
  write?: (line: string) => void;
  // Read on every call, so the level can change at runtime (e.g. in tests).
  level?: () => string | undefined;
};

export function createLogger({
  fields = {},
  write = (line) => process.stderr.write(line),
  level = () => process.env.LOG_LEVEL,
}: LoggerOptions = {}): Logger {
  const log =
    (lineLevel: LogLevel) =>
    (event: string, extra: Fields = {}) => {
      const min = ORDER[(level()?.toLowerCase() ?? 'info') as LogLevel] ?? ORDER.info;
      if (ORDER[lineLevel] < min) {
        return;
      }
      const entry = { time: new Date().toISOString(), level: lineLevel, event, ...fields, ...extra };
      write(`${JSON.stringify(entry, serializeErrors)}\n`);
    };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (more) => createLogger({ fields: { ...fields, ...more }, write, level }),
  };
}

// Errors don't serialise to JSON by default; keep what's useful.
function serializeErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}
