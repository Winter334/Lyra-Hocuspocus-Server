/**
 * 房间隔离中间件
 * 确保不同房间的数据完全隔离，用户只能访问其所属房间
 */

import { getRoomMetadata } from "../utils/redis.js";
import { extractRoomIdFromDocumentName } from "./auth.js";

/**
 * 房间隔离验证结果
 */
export interface RoomIsolationResult {
  success: boolean;
  roomId?: string;
  error?: string;
}

/**
 * 内存缓存：房间元数据（1 分钟有效期）
 */
const roomMetadataCache = new Map<
  string,
  { members: string[]; expiresAt: number }
>();

/**
 * 从缓存获取房间成员列表
 */
async function getCachedRoomMembers(roomId: string): Promise<string[] | null> {
  // 检查缓存
  const cached = roomMetadataCache.get(roomId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.members;
  }

  // 从 Redis 获取
  const metadata = await getRoomMetadata(roomId);
  if (!metadata) {
    return null;
  }

  // 缓存 1 分钟
  roomMetadataCache.set(roomId, {
    members: metadata.members,
    expiresAt: Date.now() + 60 * 1000,
  });

  return metadata.members;
}

/**
 * 清理过期的缓存
 */
function cleanupCache(): void {
  const now = Date.now();
  for (const [key, data] of roomMetadataCache.entries()) {
    if (data.expiresAt < now) {
      roomMetadataCache.delete(key);
    }
  }
}

// 每 5 分钟清理一次缓存
setInterval(cleanupCache, 5 * 60 * 1000);

/**
 * 验证用户是否有权限访问房间
 * @param userId 用户 ID
 * @param documentName 文档名称
 */
export async function validateRoomAccess(
  userId: string,
  documentName: string
): Promise<RoomIsolationResult> {
  // 1. 从文档名提取房间 ID
  const roomId = extractRoomIdFromDocumentName(documentName);
  if (!roomId) {
    return {
      success: false,
      error: "Invalid document name format",
    };
  }

  // 2. 获取房间成员列表
  const members = await getCachedRoomMembers(roomId);
  if (!members) {
    return {
      success: false,
      roomId,
      error: "Room not found or expired",
    };
  }

  // 3. 检查用户是否在成员列表中
  if (!members.includes(userId)) {
    return {
      success: false,
      roomId,
      error: "User is not a member of this room",
    };
  }

  return {
    success: true,
    roomId,
  };
}

/**
 * 使房间缓存失效（当成员列表变化时调用）
 */
export function invalidateRoomCache(roomId: string): void {
  roomMetadataCache.delete(roomId);
}

/**
 * 记录连接事件（用于监控）
 */
export function logConnectionEvent(
  eventType: "connect" | "disconnect",
  roomId: string,
  userId: string,
  socketId: string
): void {
  const timestamp = new Date().toISOString();
  console.log(
    `[Room] ${timestamp} ${eventType.toUpperCase()} - Room: ${roomId}, User: ${userId}, Socket: ${socketId}`
  );
}

/**
 * Hocuspocus onConnect 钩子增强
 * 在认证之后验证房间成员
 */
export async function validateRoomMembership({
  userId,
  documentName,
  socketId,
}: {
  userId: string;
  documentName: string;
  socketId: string;
}): Promise<void> {
  const result = await validateRoomAccess(userId, documentName);

  if (!result.success) {
    console.log(
      `[Room] Access denied - User: ${userId}, Document: ${documentName}, Error: ${result.error}`
    );
    throw new Error(result.error || "Access denied");
  }

  // 记录成功连接
  logConnectionEvent("connect", result.roomId!, userId, socketId);
}
