/**
 * 日志工具
 * 提供结构化日志功能，支持不同日志级别
 */

import { getConfig } from "../config.js";

// 日志级别优先级
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

// 日志颜色（ANSI 转义码）
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

/**
 * 日志元数据接口
 */
export interface LogMeta {
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * Logger 类
 */
class Logger {
  private module: string;

  constructor(module: string) {
    this.module = module;
  }

  /**
   * 检查是否应该输出此级别的日志
   */
  private shouldLog(level: LogLevel): boolean {
    const config = getConfig();
    const configLevel = config.logLevel as LogLevel;
    return LOG_LEVELS[level] >= LOG_LEVELS[configLevel];
  }

  /**
   * 格式化时间戳
   */
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * 格式化元数据
   */
  private formatMeta(meta?: LogMeta): string {
    if (!meta || Object.keys(meta).length === 0) {
      return "";
    }

    const parts = Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`);

    return parts.length > 0 ? ` | ${parts.join(", ")}` : "";
  }

  /**
   * 输出日志
   */
  private log(
    level: LogLevel,
    message: string,
    meta?: LogMeta,
    error?: Error
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const timestamp = this.formatTimestamp();
    const metaStr = this.formatMeta(meta);
    const levelUpper = level.toUpperCase().padEnd(5);

    // 选择颜色
    let color: string = COLORS.reset;
    switch (level) {
      case "debug":
        color = COLORS.dim;
        break;
      case "info":
        color = COLORS.green;
        break;
      case "warn":
        color = COLORS.yellow;
        break;
      case "error":
        color = COLORS.red;
        break;
    }

    const logLine = `${COLORS.dim}${timestamp}${COLORS.reset} ${color}${levelUpper}${COLORS.reset} [${COLORS.cyan}${this.module}${COLORS.reset}] ${message}${metaStr}`;

    if (level === "error") {
      console.error(logLine);
      if (error) {
        console.error(`${COLORS.dim}  Stack:${COLORS.reset}`, error.stack);
      }
    } else if (level === "warn") {
      console.warn(logLine);
    } else {
      console.log(logLine);
    }
  }

  /**
   * Debug 级别日志
   */
  debug(message: string, meta?: LogMeta): void {
    this.log("debug", message, meta);
  }

  /**
   * Info 级别日志
   */
  info(message: string, meta?: LogMeta): void {
    this.log("info", message, meta);
  }

  /**
   * Warn 级别日志
   */
  warn(message: string, meta?: LogMeta): void {
    this.log("warn", message, meta);
  }

  /**
   * Error 级别日志
   */
  error(message: string, meta?: LogMeta, error?: Error): void {
    this.log("error", message, meta, error);
  }
}

/**
 * 创建模块 Logger
 */
export function createLogger(module: string): Logger {
  return new Logger(module);
}

// 预定义的 Logger 实例
export const serverLogger = createLogger("Server");
export const redisLogger = createLogger("Redis");
export const authLogger = createLogger("Auth");
export const roomLogger = createLogger("Room");
export const rateLimitLogger = createLogger("RateLimit");
export const httpLogger = createLogger("HTTP");
export const wsLogger = createLogger("WS");
export const adminLogger = createLogger("Admin");
