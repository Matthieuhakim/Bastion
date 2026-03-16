type LogLevel = 'info' | 'warn' | 'error';
type LogMeta = Record<string, unknown> | Error | undefined;

function serializeMeta(meta: LogMeta): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }

  if (meta instanceof Error) {
    return {
      errorName: meta.name,
      errorMessage: meta.message,
      errorStack: meta.stack,
    };
  }

  return meta;
}

function writeLog(level: LogLevel, message: string, meta?: LogMeta): void {
  const timestamp = new Date().toISOString();
  const normalizedMeta = serializeMeta(meta);
  const writer = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;

  if (process.env['NODE_ENV'] === 'production') {
    writer(
      JSON.stringify({
        timestamp,
        level,
        message,
        ...(normalizedMeta ?? {}),
      }),
    );
    return;
  }

  const suffix = normalizedMeta ? ` ${JSON.stringify(normalizedMeta)}` : '';
  writer(`[${timestamp}] ${level.toUpperCase()} ${message}${suffix}`);
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    writeLog('info', message, meta);
  },

  warn(message: string, meta?: LogMeta): void {
    writeLog('warn', message, meta);
  },

  error(message: string, meta?: LogMeta): void {
    writeLog('error', message, meta);
  },
};
