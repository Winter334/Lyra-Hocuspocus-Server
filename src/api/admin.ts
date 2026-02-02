/**
 * 管理控制台 API
 * Phase 5: 提供基本的运维管理能力
 *
 * 所有 /admin/api/* 路由需要 ADMIN_PASSWORD 认证
 */

import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getConfig } from "../config.js";
import { getRateLimitStats } from "../middleware/rate-limit.js";
import { adminLogger } from "../utils/logger.js";
import {
  deleteRoomData,
  getAllRooms,
  isRedisConnected,
  type RoomMetadata,
} from "../utils/redis.js";
import { getActiveConnections, getRedisStatus } from "./health.js";

// 服务器启动时间（从 health.ts 复用逻辑）
const startTime = Date.now();

// Hocuspocus 服务器实例引用（用于关闭房间）
let hocuspocusInstance: HocuspocusInstance | null = null;

/**
 * Hocuspocus 服务器实例接口
 */
interface HocuspocusInstance {
  getConnectionsCount(): number;
  closeConnection(documentName: string): void;
  getDocuments(): Map<string, unknown>;
}

/**
 * 设置 Hocuspocus 实例引用
 */
export function setHocuspocusInstance(instance: HocuspocusInstance): void {
  hocuspocusInstance = instance;
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
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * 管理员认证中间件
 */
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfig();
  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== `Bearer ${config.adminPassword}`) {
    adminLogger.warn("Unauthorized admin access attempt", {
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

/**
 * 获取每个房间的活跃连接数
 */
function getConnectionsByRoom(): Record<string, number> {
  const connectionsByRoom: Record<string, number> = {};

  if (hocuspocusInstance) {
    const documents = hocuspocusInstance.getDocuments();
    for (const [docName] of documents) {
      // 从文档名提取房间 ID
      const match = docName.match(/^room:([^:]+):/);
      if (match) {
        const roomId = match[1];
        connectionsByRoom[roomId] = (connectionsByRoom[roomId] || 0) + 1;
      }
    }
  }

  return connectionsByRoom;
}

/**
 * 创建管理 API 路由
 */
export function createAdminRouter(): Router {
  const router = createRouter();

  // 所有管理 API 需要认证
  router.use(adminAuth);

  // ============================================
  // GET /admin/api/metrics - 实时指标
  // ============================================
  router.get("/metrics", async (_req: Request, res: Response) => {
    try {
      const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      const memory = process.memoryUsage();
      const rateLimitStats = getRateLimitStats();
      const connectionsByRoom = getConnectionsByRoom();

      const metrics = {
        timestamp: Date.now(),
        connections: {
          total: getActiveConnections(),
          byRoom: connectionsByRoom,
        },
        resources: {
          uptime: formatUptime(uptimeSeconds),
          uptimeSeconds,
          memoryUsage: `${formatBytes(memory.heapUsed)} / ${formatBytes(
            memory.heapTotal
          )}`,
          memory: {
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            rss: memory.rss,
            external: memory.external,
          },
        },
        redis: {
          status: getRedisStatus(),
          connected: await isRedisConnected(),
        },
        rateLimiting: {
          uniqueIps: rateLimitStats.uniqueIps,
          totalIpConnections: rateLimitStats.ipConnections,
        },
      };

      adminLogger.debug("Metrics requested", {
        connections: metrics.connections.total,
      });
      res.json(metrics);
    } catch (error) {
      adminLogger.error(
        "Failed to get metrics",
        {},
        error instanceof Error ? error : undefined
      );
      res.status(500).json({ error: "Failed to get metrics" });
    }
  });

  // ============================================
  // GET /admin/api/rooms - 房间列表
  // ============================================
  router.get("/rooms", async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = (page - 1) * limit;

      // 获取所有房间
      const allRooms = await getAllRooms();
      const total = allRooms.length;

      // 分页
      const rooms = allRooms.slice(offset, offset + limit);

      // 获取每个房间的活跃连接数
      const connectionsByRoom = getConnectionsByRoom();

      // 构建响应
      const roomsWithConnections = rooms.map((room: RoomMetadata) => ({
        roomId: room.roomId,
        hostUserId: room.hostUserId,
        members: room.members,
        activeConnections: connectionsByRoom[room.roomId] || 0,
        createdAt: room.createdAt,
      }));

      adminLogger.debug("Rooms list requested", { page, limit, total });
      res.json({
        total,
        page,
        limit,
        rooms: roomsWithConnections,
      });
    } catch (error) {
      adminLogger.error(
        "Failed to get rooms",
        {},
        error instanceof Error ? error : undefined
      );
      res.status(500).json({ error: "Failed to get rooms" });
    }
  });

  // ============================================
  // POST /admin/api/rooms/:roomId/close - 关闭房间
  // ============================================
  router.post("/rooms/:roomId/close", async (req: Request, res: Response) => {
    try {
      const roomId = req.params.roomId as string;
      const { reason, notifyUsers } = req.body as {
        reason?: string;
        notifyUsers?: boolean;
      };

      adminLogger.info("Closing room", {
        roomId,
        reason: reason || "N/A",
        notifyUsers: notifyUsers ?? false,
      });

      // 统计断开的连接数
      let disconnectedUsers = 0;

      // 关闭所有与该房间相关的连接
      if (hocuspocusInstance) {
        const documents = hocuspocusInstance.getDocuments();
        for (const [docName] of documents) {
          if (docName.startsWith(`room:${roomId}:`)) {
            try {
              hocuspocusInstance.closeConnection(docName);
              disconnectedUsers++;
            } catch (e) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              adminLogger.warn("Failed to close connection", {
                docName,
                error: errorMsg,
              });
            }
          }
        }
      }

      // 删除 Redis 中的房间数据
      await deleteRoomData(roomId);

      adminLogger.info("Room closed", { roomId, disconnectedUsers });
      res.json({
        success: true,
        disconnectedUsers,
      });
    } catch (error) {
      const roomId = req.params.roomId as string;
      adminLogger.error(
        "Failed to close room",
        { roomId },
        error instanceof Error ? error : undefined
      );
      res.status(500).json({ error: "Failed to close room" });
    }
  });

  // ============================================
  // GET /admin/api/stats - 统计信息
  // ============================================
  router.get("/stats", async (_req: Request, res: Response) => {
    try {
      const allRooms = await getAllRooms();
      const connectionsByRoom = getConnectionsByRoom();

      // 计算统计信息
      const totalRooms = allRooms.length;
      const activeRooms = Object.keys(connectionsByRoom).length;
      const totalMembers = allRooms.reduce(
        (sum: number, room: RoomMetadata) => sum + room.members.length,
        0
      );
      const totalConnections = getActiveConnections();

      // 房间年龄分布
      const now = Date.now();
      const roomAges = allRooms.map(
        (room: RoomMetadata) => now - room.createdAt
      );
      const avgRoomAge =
        roomAges.length > 0
          ? roomAges.reduce((a: number, b: number) => a + b, 0) /
            roomAges.length
          : 0;

      res.json({
        timestamp: Date.now(),
        rooms: {
          total: totalRooms,
          active: activeRooms,
          avgAgeMs: Math.round(avgRoomAge),
          avgAgeFormatted: formatUptime(Math.round(avgRoomAge / 1000)),
        },
        users: {
          totalMembers,
          activeConnections: totalConnections,
        },
      });
    } catch (error) {
      adminLogger.error(
        "Failed to get stats",
        {},
        error instanceof Error ? error : undefined
      );
      res.status(500).json({ error: "Failed to get stats" });
    }
  });

  return router;
}
