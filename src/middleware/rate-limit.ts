/**
 * 限流中间件
 * 防止客户端滥用，限制消息发送速率和连接数
 */

import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../config.js";
import { rateLimitLogger } from "../utils/logger.js";
import { getValue, incrementCounter, setValue } from "../utils/redis.js";

/**
 * 限流配置
 */
interface RateLimitConfig {
  messagesPerMinute: number; // 单连接每分钟消息数限制
  connectionsPerIp: number; // 单 IP 最大连接数
  roomMessagesPerMinute: number; // 单房间每分钟消息数限制
}

/**
 * 限流结果
 */
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number; // 秒
}

/**
 * IP 连接计数器（内存）
 */
const ipConnectionCounts = new Map<string, number>();

/**
 * 获取限流配置
 */
function getRateLimitConfig(): RateLimitConfig {
  const config = getConfig();
  return {
    messagesPerMinute: config.rateLimitMessagesPerMinute,
    connectionsPerIp: config.rateLimitConnectionsPerIp,
    roomMessagesPerMinute: config.rateLimitRoomMessagesPerMinute,
  };
}

/**
 * 获取当前分钟标识
 */
function getCurrentMinute(): number {
  return Math.floor(Date.now() / 60000);
}

// ============================================
// WebSocket 限流（用于 Hocuspocus 消息）
// ============================================

/**
 * 检查单连接消息速率
 * @param socketId WebSocket 连接 ID
 * @returns 限流结果
 */
export async function checkConnectionRateLimit(
  socketId: string
): Promise<RateLimitResult> {
  const config = getRateLimitConfig();
  const currentMinute = getCurrentMinute();
  const key = `ratelimit:conn:${socketId}:${currentMinute}`;

  const count = await incrementCounter(key, 60);
  const allowed = count <= config.messagesPerMinute;
  const remaining = Math.max(0, config.messagesPerMinute - count);

  if (!allowed) {
    rateLimitLogger.warn("Connection rate limit exceeded", {
      socketId,
      count,
      limit: config.messagesPerMinute,
    });
  }

  return {
    allowed,
    remaining,
    resetIn: 60 - (Math.floor(Date.now() / 1000) % 60),
  };
}

/**
 * 检查单房间消息速率
 * @param roomId 房间 ID
 * @returns 限流结果
 */
export async function checkRoomRateLimit(
  roomId: string
): Promise<RateLimitResult> {
  const config = getRateLimitConfig();
  const currentMinute = getCurrentMinute();
  const key = `ratelimit:room:${roomId}:${currentMinute}`;

  const count = await incrementCounter(key, 60);
  const allowed = count <= config.roomMessagesPerMinute;
  const remaining = Math.max(0, config.roomMessagesPerMinute - count);

  if (!allowed) {
    rateLimitLogger.warn("Room rate limit exceeded", {
      roomId,
      count,
      limit: config.roomMessagesPerMinute,
    });
  }

  return {
    allowed,
    remaining,
    resetIn: 60 - (Math.floor(Date.now() / 1000) % 60),
  };
}

// ============================================
// IP 连接数限制
// ============================================

/**
 * 记录 IP 连接
 * @param clientIp 客户端 IP
 * @returns 是否允许连接
 */
export async function trackIpConnection(clientIp: string): Promise<boolean> {
  const config = getRateLimitConfig();
  const key = `connections:${clientIp}`;

  // 尝试从 Redis 获取
  const countStr = await getValue(key);
  const currentCount = countStr ? parseInt(countStr, 10) : 0;

  if (currentCount >= config.connectionsPerIp) {
    rateLimitLogger.warn("IP connection limit exceeded", {
      clientIp,
      count: currentCount,
      limit: config.connectionsPerIp,
    });
    return false;
  }

  // 增加计数
  await setValue(key, (currentCount + 1).toString(), 3600); // 1 小时过期

  // 同时更新内存计数
  ipConnectionCounts.set(clientIp, currentCount + 1);

  rateLimitLogger.debug("IP connection tracked", {
    clientIp,
    count: currentCount + 1,
  });

  return true;
}

/**
 * 释放 IP 连接
 * @param clientIp 客户端 IP
 */
export async function releaseIpConnection(clientIp: string): Promise<void> {
  const key = `connections:${clientIp}`;

  const countStr = await getValue(key);
  if (countStr) {
    const currentCount = parseInt(countStr, 10);
    if (currentCount > 0) {
      await setValue(key, (currentCount - 1).toString(), 3600);
      ipConnectionCounts.set(clientIp, currentCount - 1);
    }
  }

  rateLimitLogger.debug("IP connection released", { clientIp });
}

/**
 * 获取 IP 当前连接数
 */
export async function getIpConnectionCount(clientIp: string): Promise<number> {
  const key = `connections:${clientIp}`;
  const countStr = await getValue(key);
  return countStr ? parseInt(countStr, 10) : 0;
}

// ============================================
// Express HTTP 限流中间件
// ============================================

/**
 * HTTP API 限流中间件
 * 限制单 IP 的 API 请求速率
 */
export function createHttpRateLimiter(options?: {
  requestsPerMinute?: number;
  keyPrefix?: string;
}) {
  const requestsPerMinute = options?.requestsPerMinute ?? 60;
  const keyPrefix = options?.keyPrefix ?? "ratelimit:http";

  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIp = getClientIp(req);
    const currentMinute = getCurrentMinute();
    const key = `${keyPrefix}:${clientIp}:${currentMinute}`;

    try {
      const count = await incrementCounter(key, 60);

      // 设置限流响应头
      res.setHeader("X-RateLimit-Limit", requestsPerMinute.toString());
      res.setHeader(
        "X-RateLimit-Remaining",
        Math.max(0, requestsPerMinute - count).toString()
      );
      res.setHeader(
        "X-RateLimit-Reset",
        (60 - (Math.floor(Date.now() / 1000) % 60)).toString()
      );

      if (count > requestsPerMinute) {
        rateLimitLogger.warn("HTTP rate limit exceeded", {
          clientIp,
          path: req.path,
          count,
          limit: requestsPerMinute,
        });

        res.status(429).json({
          error: "Too Many Requests",
          message: "Rate limit exceeded. Please try again later.",
          retryAfter: 60 - (Math.floor(Date.now() / 1000) % 60),
        });
        return;
      }

      next();
    } catch (error) {
      // 限流检查失败时放行（降级策略）
      rateLimitLogger.error(
        "Rate limit check failed, allowing request",
        { clientIp, path: req.path },
        error instanceof Error ? error : undefined
      );
      next();
    }
  };
}

/**
 * 获取客户端真实 IP
 */
function getClientIp(req: Request): string {
  // 检查常见的代理头
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor.split(",")[0];
    return ips.trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

// ============================================
// Hocuspocus 消息限流钩子
// ============================================

/**
 * Hocuspocus onMessage 限流检查
 * 在消息处理前调用
 */
export async function checkMessageRateLimit(
  socketId: string,
  roomId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // 检查单连接速率
  const connResult = await checkConnectionRateLimit(socketId);
  if (!connResult.allowed) {
    return {
      allowed: false,
      reason: `Connection rate limit exceeded. Try again in ${connResult.resetIn}s`,
    };
  }

  // 检查房间速率
  const roomResult = await checkRoomRateLimit(roomId);
  if (!roomResult.allowed) {
    return {
      allowed: false,
      reason: `Room rate limit exceeded. Try again in ${roomResult.resetIn}s`,
    };
  }

  return { allowed: true };
}

// ============================================
// 统计信息
// ============================================

/**
 * 获取限流统计信息
 */
export function getRateLimitStats(): {
  ipConnections: number;
  uniqueIps: number;
} {
  let totalConnections = 0;
  for (const count of ipConnectionCounts.values()) {
    totalConnections += count;
  }

  return {
    ipConnections: totalConnections,
    uniqueIps: ipConnectionCounts.size,
  };
}
