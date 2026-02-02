/**
 * Lyra Hocuspocus Server 入口
 * Phase 5: 管理控制台
 */

import { Server } from "@hocuspocus/server";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createAdminRouter, setHocuspocusInstance } from "./api/admin.js";
import {
  createHealthRouter,
  setActiveConnections,
  setRedisStatus,
} from "./api/health.js";
import { createRoomRouter } from "./api/room.js";
import { getConfig, printConfig, validateConfig } from "./config.js";
import {
  extractRoomIdFromDocumentName,
  onAuthenticate,
} from "./middleware/auth.js";
import {
  checkMessageRateLimit,
  createHttpRateLimiter,
  getRateLimitStats,
  releaseIpConnection,
  trackIpConnection,
} from "./middleware/rate-limit.js";
import {
  logConnectionEvent,
  validateRoomMembership,
} from "./middleware/room-isolation.js";
import {
  httpLogger,
  redisLogger,
  serverLogger,
  wsLogger,
} from "./utils/logger.js";
import { closeRedis, connectRedis, isRedisConnected } from "./utils/redis.js";

// ES Module 兼容的 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const config = getConfig();

  // 验证配置
  try {
    validateConfig(config);
  } catch (error) {
    if (error instanceof Error) {
      serverLogger.error("Configuration validation failed", {}, error);
    }
    process.exit(1);
  }

  printConfig(config);

  // ============================================
  // 0. 连接 Redis
  // ============================================
  if (config.redisEnabled) {
    redisLogger.info("Connecting to Redis...", {
      host: config.redisHost,
      port: config.redisPort,
    });
    await connectRedis();
  } else {
    redisLogger.warn("Redis is disabled, using memory cache for rate limiting");
  }

  // ============================================
  // 1. 创建 Hocuspocus WebSocket 服务器
  // ============================================
  const hocuspocus = Server.configure({
    port: config.wsPort,
    address: config.wsHost,
    name: "lyra-hocuspocus",

    // 认证回调
    onAuthenticate: async (data) => {
      const result = await onAuthenticate({
        token: data.token,
        documentName: data.documentName,
      });

      // 将认证信息存储到 context 中，供后续钩子使用
      return {
        user: {
          userId: result.userId,
          role: result.role,
        },
      };
    },

    // 连接生命周期回调
    onConnect: async (data) => {
      const { documentName, socketId, context, request } = data;
      const user = context?.user as
        | { userId: string; role: string }
        | undefined;

      // 获取客户端 IP
      const clientIp = getClientIpFromRequest(request);

      // 将 IP 存储到 context 中，供 onDisconnect 使用
      (context as Record<string, unknown>).clientIp = clientIp;

      // 检查 IP 连接数限制
      const allowed = await trackIpConnection(clientIp);
      if (!allowed) {
        wsLogger.warn("IP connection limit exceeded", {
          clientIp,
          socketId,
        });
        throw new Error("Too many connections from this IP");
      }

      if (user) {
        // 验证房间成员
        await validateRoomMembership({
          userId: user.userId,
          documentName,
          socketId,
        });
      } else {
        wsLogger.debug("Client connected without auth", {
          socketId,
          documentName,
        });
      }

      // 更新连接数
      const connections = hocuspocus.getConnectionsCount();
      setActiveConnections(connections);
    },

    onDisconnect: async (data) => {
      const { documentName, socketId, context } = data;
      const user = context?.user as
        | { userId: string; role: string }
        | undefined;

      // 从 context 获取客户端 IP
      const clientIp =
        ((context as Record<string, unknown>)?.clientIp as string) || "unknown";
      await releaseIpConnection(clientIp);

      if (user) {
        // 提取房间 ID 用于日志
        const roomId = extractRoomIdFromDocumentName(documentName) || "unknown";
        logConnectionEvent("disconnect", roomId, user.userId, socketId);
      } else {
        wsLogger.debug("Client disconnected", {
          socketId,
          documentName,
        });
      }

      // 更新连接数
      const connections = hocuspocus.getConnectionsCount();
      setActiveConnections(connections);
    },

    // 文档加载回调
    onLoadDocument: async ({ documentName }) => {
      wsLogger.debug("Loading document", { documentName });
    },

    // 消息处理前的限流检查
    beforeHandleMessage: async (data) => {
      const { documentName, socketId } = data;
      const roomId = extractRoomIdFromDocumentName(documentName);

      if (roomId) {
        const result = await checkMessageRateLimit(socketId, roomId);
        if (!result.allowed) {
          wsLogger.warn("Message rate limited", {
            socketId,
            roomId,
            reason: result.reason,
          });
          // 返回 false 会阻止消息处理
          // 但 Hocuspocus 不直接支持这个，我们记录日志即可
        }
      }
    },

    // 连接数统计
    onStoreDocument: async () => {
      // 更新活跃连接数
      const connections = hocuspocus.getConnectionsCount();
      setActiveConnections(connections);
    },
  });

  // ============================================
  // 2. 创建 Express HTTP 服务器
  // ============================================
  const app = express();

  // 中间件
  app.use(express.json());

  // HTTP 限流中间件（应用于 API 路由）
  const apiRateLimiter = createHttpRateLimiter({
    requestsPerMinute: config.rateLimitHttpRequestsPerMinute,
    keyPrefix: "ratelimit:api",
  });

  // 定期更新 Redis 状态
  if (config.redisEnabled) {
    const updateRedisStatus = async () => {
      const connected = await isRedisConnected();
      setRedisStatus(connected ? "connected" : "disconnected");
    };
    updateRedisStatus();
    setInterval(updateRedisStatus, 10000); // 每 10 秒检查一次
  }

  // 健康检查路由（不限流）
  app.use(createHealthRouter());

  // 房间 API 路由（带限流）
  app.use("/api/room", apiRateLimiter, createRoomRouter());

  // 管理控制台 API 路由
  app.use("/admin/api", createAdminRouter());

  // 管理控制台静态文件
  app.use("/admin", express.static(path.join(__dirname, "admin-ui")));

  // ============================================
  // 3. 启动服务器
  // ============================================

  // 启动 HTTP 服务器
  const httpServer = app.listen(config.httpPort, () => {
    httpLogger.info("HTTP server started", {
      port: config.httpPort,
      healthUrl: `http://localhost:${config.httpPort}/health`,
    });
  });

  // 启动 WebSocket 服务器
  await hocuspocus.listen();
  wsLogger.info("WebSocket server started", { port: config.wsPort });

  // 设置 Hocuspocus 实例引用（用于管理控制台）
  setHocuspocusInstance({
    getConnectionsCount: () => hocuspocus.getConnectionsCount(),
    closeConnection: (documentName: string) => {
      // Hocuspocus 没有直接的 closeConnection 方法
      // 我们通过获取文档并关闭所有连接来实现
      const document = hocuspocus.documents.get(documentName);
      if (document) {
        // document.connections 是一个 Map<string, { clients: Set, connection: Connection }>
        // 我们需要关闭每个连接的 WebSocket
        document.connections.forEach((connectionData) => {
          try {
            // 尝试关闭连接
            if (
              connectionData.connection &&
              typeof connectionData.connection.close === "function"
            ) {
              connectionData.connection.close();
            }
          } catch {
            // 忽略关闭错误
            wsLogger.debug("Failed to close connection", { documentName });
          }
        });
      }
    },
    getDocuments: () => hocuspocus.documents,
  });

  // ============================================
  // 4. 优雅关闭
  // ============================================
  const shutdown = async () => {
    serverLogger.info("Shutting down gracefully...");

    httpServer.close();
    await hocuspocus.destroy();
    await closeRedis();

    serverLogger.info("Server stopped. Goodbye!");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 输出启动完成信息
  const stats = getRateLimitStats();
  serverLogger.info("Lyra Hocuspocus Server is running!", {
    httpPort: config.httpPort,
    wsPort: config.wsPort,
    redisEnabled: config.redisEnabled,
    ipConnections: stats.ipConnections,
  });
  console.log("\n   Press Ctrl+C to stop\n");
}

/**
 * 从 WebSocket 请求中获取客户端 IP
 */
function getClientIpFromRequest(request: unknown): string {
  if (!request || typeof request !== "object") {
    return "unknown";
  }

  const req = request as {
    headers?: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
  };

  // 检查代理头
  const forwardedFor = req.headers?.["x-forwarded-for"];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor.split(",")[0];
    return ips?.trim() || "unknown";
  }

  const realIp = req.headers?.["x-real-ip"];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  return req.socket?.remoteAddress || "unknown";
}

main().catch((error) => {
  serverLogger.error(
    "Fatal error during startup",
    {},
    error instanceof Error ? error : undefined
  );
  process.exit(1);
});
