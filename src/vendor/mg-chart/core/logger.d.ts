export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';
declare class Logger {
    private level;
    private customHandler;
    /** Set minimum log level. Messages below this level are suppressed. */
    setLevel(level: LogLevel): void;
    /** Get current log level */
    getLevel(): LogLevel;
    /**
     * Set a custom log handler. Replaces console output.
     * Useful for sending logs to external services (Sentry, DataDog, etc.)
     */
    setHandler(handler: ((level: LogLevel, message: string, ...args: any[]) => void) | null): void;
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
}
/** Singleton logger instance for the library */
export declare const logger: Logger;
export {};
