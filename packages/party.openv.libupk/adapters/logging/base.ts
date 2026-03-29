import type { LoggingAdapter } from "../../types/adapters.js";

export class BaseLogger implements LoggingAdapter {
  debug(message: string, ..._args: any[]): void {
    this.log("DEBUG", message);
  }

  info(message: string, ..._args: any[]): void {
    this.log("INFO", message);
  }

  warn(message: string, ..._args: any[]): void {
    this.log("WARN", message);
  }

  error(message: string, ..._args: any[]): void {
    this.log("ERROR", message);
  }

  protected log(_level: string, _message: string): void {
    // Override in subclasses
  }
}

export class NoOpLogger implements LoggingAdapter {
  debug(_message: string, ..._args: any[]): void {}
  info(_message: string, ..._args: any[]): void {}
  warn(_message: string, ..._args: any[]): void {}
  error(_message: string, ..._args: any[]): void {}
}
