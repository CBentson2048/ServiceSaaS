type LogMetadata = Record<string, unknown>;

export const logger = {
  info(message: string, metadata?: LogMetadata): void {
    console.info(`[sheer-lab] ${message}`, metadata ?? {});
  },
  warn(message: string, metadata?: LogMetadata): void {
    console.warn(`[sheer-lab] ${message}`, metadata ?? {});
  },
  error(message: string, metadata?: LogMetadata): void {
    console.error(`[sheer-lab] ${message}`, metadata ?? {});
  },
};
