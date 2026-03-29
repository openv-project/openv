import type { LoggingAdapter } from "../../types/adapters.js";

export class ConsoleLogger implements LoggingAdapter {
  debug(message: string, ...args: any[]): void {
    console.debug(`[UPK DEBUG] ${message}`, ...args);
  }

  info(message: string, ...args: any[]): void {
    console.info(`[UPK INFO] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[UPK WARN] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[UPK ERROR] ${message}`, ...args);
  }
}
