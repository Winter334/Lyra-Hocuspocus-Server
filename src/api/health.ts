/**
 * 健康检查 API
 * GET /health - 返回服务器状态
 */

import type { Router } from "express";
import { Router as createRouter } from "express";
import { getRateLimitStats } from "../middleware/rate-limit.js";

// 服务器启动时间
const startTime = Date.now();

// 活跃连接数（由 Hocuspocus 更新）
let activeConnections = 0;

// Redis 连接状态
let redisStatus: "connected" | "disconnected" | "disabled" = "disabled";

// 内存使用快照
interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  rss: number;
}

export function setActiveConnections(count: number): void {
  activeConnections = count;
}

export function getActiveConnections(): number {
  return activeConnections;
}

export function setRedisStatus(
  status: "connected" | "disconnected" | "disabled"
): void {
  redisStatus = status;
}

export function getRedisStatus(): "connected" | "disconnected" | "disabled" {
  return redisStatus;
}

/**
 * 格式化运行时间
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

/**
 * 格式化内存大小
 */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

/**
 * 获取内存使用信息
 */
function getMemoryUsage(): MemorySnapshot {
  const mem = process.memoryUsage();
  return {
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
  };
}

export function createHealthRouter(): Router {
  const router = createRouter();

  // 简单健康检查（用于负载均衡器）
  router.get("/health", (_req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const memory = getMemoryUsage();
    const rateLimitStats = getRateLimitStats();

    // 判断整体状态
    // Redis 禁用时也算健康，只有 Redis 启用但断开连接时才算不健康
    const isHealthy = redisStatus !== "disconnected";
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "ok" : "degraded",
      uptime: formatUptime(uptimeSeconds),
      uptimeSeconds,
      activeConnections,
      redis: redisStatus,
      memory: {
        heapUsed: formatBytes(memory.heapUsed),
        heapTotal: formatBytes(memory.heapTotal),
        rss: formatBytes(memory.rss),
      },
      rateLimiting: {
        uniqueIps: rateLimitStats.uniqueIps,
        totalIpConnections: rateLimitStats.ipConnections,
      },
      timestamp: Date.now(),
    });
  });

  // 详细健康检查（用于监控系统）
  router.get("/health/detailed", (_req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const memory = getMemoryUsage();
    const rateLimitStats = getRateLimitStats();

    res.json({
      status: "ok",
      version: process.env.npm_package_version || "1.0.0",
      nodeVersion: process.version,
      uptime: {
        formatted: formatUptime(uptimeSeconds),
        seconds: uptimeSeconds,
        startTime: new Date(startTime).toISOString(),
      },
      connections: {
        active: activeConnections,
        byIp: rateLimitStats.uniqueIps,
        totalFromIps: rateLimitStats.ipConnections,
      },
      redis: {
        status: redisStatus,
        enabled: redisStatus !== "disabled",
      },
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        heapUsedFormatted: formatBytes(memory.heapUsed),
        heapTotalFormatted: formatBytes(memory.heapTotal),
        rssFormatted: formatBytes(memory.rss),
      },
      timestamp: Date.now(),
    });
  });

  return router;
}
