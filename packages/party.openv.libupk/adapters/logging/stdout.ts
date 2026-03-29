import type { LoggingAdapter } from "../../types/adapters.js";

export class StdoutLogger implements LoggingAdapter {
  debug(message: string, ...args: any[]): void {
    this.write("DEBUG", message, args);
  }

  info(message: string, ...args: any[]): void {
    this.write("INFO", message, args);
  }

  warn(message: string, ...args: any[]): void {
    this.write("WARN", message, args);
  }

  error(message: string, ...args: any[]): void {
    this.write("ERROR", message, args);
  }

  private write(level: string, message: string, args: any[]): void {
    const formatted = args.length > 0 
      ? `[UPK ${level}] ${message} ${JSON.stringify(args)}`
      : `[UPK ${level}] ${message}`;
    
    if (typeof process !== "undefined" && process.stdout) {
      process.stdout.write(formatted + "\n");
    } else {
      console.log(formatted);
    }
  }
}
