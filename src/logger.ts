import winston from "winston";
import type { Config } from "./config.js";

export function createLogger(config: Pick<Config, "log_level">): winston.Logger {
  return winston.createLogger({
    level: config.log_level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.printf(({ level, message, timestamp }) => {
        return `${timestamp} [${level.toUpperCase()}] ${message}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}
