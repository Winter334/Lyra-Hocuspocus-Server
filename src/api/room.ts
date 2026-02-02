/**
 * 房间码 API
 * 提供房间创建、加入、成员管理等功能
 */

import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getConfig } from "../config.js";
import { generateToken } from "../middleware/auth.js";
import { invalidateRoomCache } from "../middleware/room-isolation.js";
import {
  addRoomMember,
  getRoomCodeMapping,
  getRoomMetadata,
  roomCodeExists,
  saveRoomCode,
  saveRoomMetadata,
} from "../utils/redis.js";

/**
 * 创建房间 API 路由
 */
export function createRoomRouter(): Router {
  const router = createRouter();

  // ============================================
  // POST /api/room/register - 注册房间
  // ============================================
  router.post("/register", async (req: Request, res: Response) => {
    try {
      const { roomId, code, hostUserId } = req.body;

      // 验证参数
      if (!roomId || !code || !hostUserId) {
        res.status(400).json({
          error: "Missing required fields: roomId, code, hostUserId",
        });
        return;
      }

      // 检查房间码是否已被占用
      const exists = await roomCodeExists(code);
      if (exists) {
        res.status(409).json({
          error: "Room code already in use",
        });
        return;
      }

      // 保存房间码映射
      await saveRoomCode(code, {
        roomId,
        hostUserId,
      });

      // 初始化房间元数据（members 包含 hostUserId）
      await saveRoomMetadata({
        roomId,
        hostUserId,
        members: [hostUserId],
        createdAt: Date.now(),
      });

      console.log(
        `[Room] Registered: ${roomId} with code ${code} by ${hostUserId}`
      );

      res.json({
        success: true,
        roomId,
        code,
      });
    } catch (error) {
      console.error("[Room] Register error:", error);
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // ============================================
  // GET /api/room/join - 查询房间
  // ============================================
  router.get("/join", async (req: Request, res: Response) => {
    try {
      const code = req.query.code as string;

      // 验证参数
      if (!code) {
        res.status(400).json({
          error: "Missing required query parameter: code",
        });
        return;
      }

      // 查询房间码映射
      const mapping = await getRoomCodeMapping(code);
      if (!mapping) {
        res.status(404).json({
          error: "Room not found or expired",
        });
        return;
      }

      // 获取 WebSocket URL
      const config = getConfig();
      const wsUrl =
        config.nodeEnv === "production"
          ? "wss://your-domain.com/ws" // 生产环境需要配置
          : `ws://localhost:${config.wsPort}`;

      res.json({
        success: true,
        roomId: mapping.roomId,
        wsUrl,
      });
    } catch (error) {
      console.error("[Room] Join query error:", error);
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // ============================================
  // POST /api/room/add-member - 添加成员
  // ============================================
  router.post("/add-member", async (req: Request, res: Response) => {
    try {
      const { roomId, userId, displayName } = req.body;

      // 验证参数
      if (!roomId || !userId) {
        res.status(400).json({
          error: "Missing required fields: roomId, userId",
        });
        return;
      }

      // 检查房间是否存在
      const metadata = await getRoomMetadata(roomId);
      if (!metadata) {
        res.status(404).json({
          error: "Room not found or expired",
        });
        return;
      }

      // 添加成员
      const success = await addRoomMember(roomId, userId);
      if (!success) {
        res.status(500).json({
          error: "Failed to add member",
        });
        return;
      }

      // 使房间缓存失效
      invalidateRoomCache(roomId);

      console.log(
        `[Room] Member added: ${userId} (${
          displayName || "unknown"
        }) to ${roomId}`
      );

      res.json({
        success: true,
      });
    } catch (error) {
      console.error("[Room] Add member error:", error);
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // ============================================
  // POST /api/room/get-token - 获取 Token
  // ============================================
  router.post("/get-token", async (req: Request, res: Response) => {
    try {
      const { userId, roomId, role } = req.body;

      // 验证参数
      if (!userId || !roomId || !role) {
        res.status(400).json({
          error: "Missing required fields: userId, roomId, role",
        });
        return;
      }

      // 验证 role
      if (role !== "host" && role !== "guest") {
        res.status(400).json({
          error: 'Invalid role. Must be "host" or "guest"',
        });
        return;
      }

      // 检查房间是否存在
      const metadata = await getRoomMetadata(roomId);
      if (!metadata) {
        res.status(404).json({
          error: "Room not found or expired",
        });
        return;
      }

      // 检查用户是否是房间成员
      if (!metadata.members.includes(userId)) {
        res.status(403).json({
          error: "User is not a member of this room",
        });
        return;
      }

      // 验证 host 角色
      if (role === "host" && metadata.hostUserId !== userId) {
        res.status(403).json({
          error: "Only the room creator can have host role",
        });
        return;
      }

      // 生成 token
      const { token, expiresAt } = generateToken(userId, roomId, role);

      console.log(
        `[Room] Token generated for ${userId} in ${roomId} as ${role}`
      );

      res.json({
        token,
        expiresAt,
      });
    } catch (error) {
      console.error("[Room] Get token error:", error);
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  // ============================================
  // GET /api/room/:roomId - 获取房间信息
  // ============================================
  router.get("/:roomId", async (req: Request, res: Response) => {
    try {
      const roomId = req.params.roomId as string;

      const metadata = await getRoomMetadata(roomId);
      if (!metadata) {
        res.status(404).json({
          error: "Room not found or expired",
        });
        return;
      }

      res.json({
        success: true,
        room: {
          roomId: metadata.roomId,
          hostUserId: metadata.hostUserId,
          memberCount: metadata.members.length,
          createdAt: metadata.createdAt,
        },
      });
    } catch (error) {
      console.error("[Room] Get room error:", error);
      res.status(500).json({
        error: "Internal server error",
      });
    }
  });

  return router;
}
