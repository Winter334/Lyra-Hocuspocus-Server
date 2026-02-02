/**
 * Redis 客户端封装
 * 提供 Redis 连接管理和常用操作
 */

import { Redis } from "ioredis";
import { getConfig } from "../config.js";

// Redis 客户端单例
let redisClient: Redis | null = null;

// 内存缓存（Redis 降级时使用）
const memoryCache = new Map<string, { value: string; expiresAt: number }>();

/**
 * 获取 Redis 客户端实例
 */
export function getRedisClient(): Redis | null {
  const config = getConfig();

  if (!config.redisEnabled) {
    return null;
  }

  if (!redisClient) {
    const client = new Redis({
      host: config.redisHost,
      port: config.redisPort,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.error("[Redis] Max retry attempts reached");
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    client.on("connect", () => {
      console.log("[Redis] Connected");
    });

    client.on("error", (err: Error) => {
      console.error("[Redis] Error:", err.message);
    });

    client.on("close", () => {
      console.log("[Redis] Connection closed");
    });

    redisClient = client;
  }

  return redisClient;
}

/**
 * 连接 Redis
 */
export async function connectRedis(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) {
    console.log("[Redis] Redis is disabled, using memory cache");
    return false;
  }

  try {
    await client.connect();
    return true;
  } catch (error) {
    console.error("[Redis] Failed to connect:", error);
    return false;
  }
}

/**
 * 关闭 Redis 连接
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * 检查 Redis 连接状态
 */
export async function isRedisConnected(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

// ============================================
// 通用操作封装（自动降级到内存缓存）
// ============================================

/**
 * 清理过期的内存缓存
 */
function cleanupMemoryCache(): void {
  const now = Date.now();
  for (const [key, data] of memoryCache.entries()) {
    if (data.expiresAt > 0 && data.expiresAt < now) {
      memoryCache.delete(key);
    }
  }
}

/**
 * 设置值（带过期时间）
 */
export async function setValue(
  key: string,
  value: string,
  ttlSeconds?: number
): Promise<void> {
  const client = getRedisClient();

  if (client && client.status === "ready") {
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, value);
    } else {
      await client.set(key, value);
    }
  } else {
    // 降级到内存缓存
    memoryCache.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
  }
}

/**
 * 获取值
 */
export async function getValue(key: string): Promise<string | null> {
  const client = getRedisClient();

  if (client && client.status === "ready") {
    return client.get(key);
  } else {
    // 降级到内存缓存
    cleanupMemoryCache();
    const data = memoryCache.get(key);
    if (!data) return null;
    if (data.expiresAt > 0 && data.expiresAt < Date.now()) {
      memoryCache.delete(key);
      return null;
    }
    return data.value;
  }
}

/**
 * 删除键
 */
export async function deleteKey(key: string): Promise<void> {
  const client = getRedisClient();

  if (client && client.status === "ready") {
    await client.del(key);
  } else {
    memoryCache.delete(key);
  }
}

/**
 * 检查键是否存在
 */
export async function keyExists(key: string): Promise<boolean> {
  const client = getRedisClient();

  if (client && client.status === "ready") {
    const result = await client.exists(key);
    return result === 1;
  } else {
    cleanupMemoryCache();
    return memoryCache.has(key);
  }
}

/**
 * 获取并递增计数器（用于限流）
 */
export async function incrementCounter(
  key: string,
  ttlSeconds: number
): Promise<number> {
  const client = getRedisClient();

  if (client && client.status === "ready") {
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, ttlSeconds);
    }
    return count;
  } else {
    // 降级到内存缓存
    cleanupMemoryCache();
    const data = memoryCache.get(key);
    let count = 1;

    if (data) {
      count = parseInt(data.value, 10) + 1;
      memoryCache.set(key, {
        value: count.toString(),
        expiresAt: data.expiresAt,
      });
    } else {
      memoryCache.set(key, {
        value: "1",
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }

    return count;
  }
}

// ============================================
// 房间相关操作
// ============================================

// Redis Key 前缀
const ROOM_CODE_PREFIX = "roomCode:";
const ROOM_METADATA_PREFIX = "room:";
const ROOM_TTL = 7 * 24 * 60 * 60; // 7天

/**
 * 房间元数据类型
 */
export interface RoomMetadata {
  roomId: string;
  hostUserId: string;
  members: string[];
  createdAt: number;
}

/**
 * 房间码映射类型
 */
export interface RoomCodeMapping {
  roomId: string;
  hostUserId: string;
}

/**
 * 保存房间码映射
 */
export async function saveRoomCode(
  code: string,
  mapping: RoomCodeMapping
): Promise<void> {
  const key = `${ROOM_CODE_PREFIX}${code}`;
  await setValue(key, JSON.stringify(mapping), ROOM_TTL);
}

/**
 * 获取房间码映射
 */
export async function getRoomCodeMapping(
  code: string
): Promise<RoomCodeMapping | null> {
  const key = `${ROOM_CODE_PREFIX}${code}`;
  const value = await getValue(key);
  if (!value) return null;

  try {
    return JSON.parse(value) as RoomCodeMapping;
  } catch {
    return null;
  }
}

/**
 * 检查房间码是否存在
 */
export async function roomCodeExists(code: string): Promise<boolean> {
  const key = `${ROOM_CODE_PREFIX}${code}`;
  return keyExists(key);
}

/**
 * 保存房间元数据
 */
export async function saveRoomMetadata(metadata: RoomMetadata): Promise<void> {
  const key = `${ROOM_METADATA_PREFIX}${metadata.roomId}:metadata`;
  await setValue(key, JSON.stringify(metadata), ROOM_TTL);
}

/**
 * 获取房间元数据
 */
export async function getRoomMetadata(
  roomId: string
): Promise<RoomMetadata | null> {
  const key = `${ROOM_METADATA_PREFIX}${roomId}:metadata`;
  const value = await getValue(key);
  if (!value) return null;

  try {
    return JSON.parse(value) as RoomMetadata;
  } catch {
    return null;
  }
}

/**
 * 添加房间成员
 */
export async function addRoomMember(
  roomId: string,
  userId: string
): Promise<boolean> {
  const metadata = await getRoomMetadata(roomId);
  if (!metadata) return false;

  if (!metadata.members.includes(userId)) {
    metadata.members.push(userId);
    await saveRoomMetadata(metadata);
  }

  return true;
}

/**
 * 检查用户是否是房间成员
 */
export async function isRoomMember(
  roomId: string,
  userId: string
): Promise<boolean> {
  const metadata = await getRoomMetadata(roomId);
  if (!metadata) return false;

  return metadata.members.includes(userId);
}

/**
 * 获取所有房间列表
 * 注意：这个操作在大量房间时可能较慢
 */
export async function getAllRooms(): Promise<RoomMetadata[]> {
  const client = getRedisClient();
  const rooms: RoomMetadata[] = [];

  if (client && client.status === "ready") {
    // 使用 SCAN 命令遍历所有房间元数据键
    const pattern = `${ROOM_METADATA_PREFIX}*:metadata`;
    let cursor = "0";

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = nextCursor;

      for (const key of keys) {
        const value = await client.get(key);
        if (value) {
          try {
            const metadata = JSON.parse(value) as RoomMetadata;
            rooms.push(metadata);
          } catch {
            // 忽略解析错误
          }
        }
      }
    } while (cursor !== "0");
  } else {
    // 降级到内存缓存
    cleanupMemoryCache();
    for (const [key, data] of memoryCache.entries()) {
      if (key.startsWith(ROOM_METADATA_PREFIX) && key.endsWith(":metadata")) {
        try {
          const metadata = JSON.parse(data.value) as RoomMetadata;
          rooms.push(metadata);
        } catch {
          // 忽略解析错误
        }
      }
    }
  }

  // 按创建时间排序（最新的在前）
  rooms.sort((a, b) => b.createdAt - a.createdAt);

  return rooms;
}

/**
 * 删除房间相关的所有数据
 */
export async function deleteRoomData(roomId: string): Promise<void> {
  const client = getRedisClient();

  // 检查房间是否存在
  const roomExists = await getRoomMetadata(roomId);
  if (!roomExists) {
    // 房间不存在，无需删除
    return;
  }

  if (client && client.status === "ready") {
    // 删除房间元数据
    await client.del(`${ROOM_METADATA_PREFIX}${roomId}:metadata`);

    // 如果有房间码，也需要删除房间码映射
    // 注意：我们需要遍历找到对应的房间码
    const pattern = `${ROOM_CODE_PREFIX}*`;
    let cursor = "0";

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = nextCursor;

      for (const key of keys) {
        const value = await client.get(key);
        if (value) {
          try {
            const mapping = JSON.parse(value) as RoomCodeMapping;
            if (mapping.roomId === roomId) {
              await client.del(key);
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } while (cursor !== "0");
  } else {
    // 降级到内存缓存
    memoryCache.delete(`${ROOM_METADATA_PREFIX}${roomId}:metadata`);

    // 删除房间码映射
    for (const [key, data] of memoryCache.entries()) {
      if (key.startsWith(ROOM_CODE_PREFIX)) {
        try {
          const mapping = JSON.parse(data.value) as RoomCodeMapping;
          if (mapping.roomId === roomId) {
            memoryCache.delete(key);
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
  }
}
