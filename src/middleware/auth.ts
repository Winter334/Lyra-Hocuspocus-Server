/**
 * JWT 认证中间件
 * 验证客户端 Token，确保只有授权用户可访问房间
 */

import jwt from "jsonwebtoken";
import { getConfig } from "../config.js";

/**
 * JWT Payload 类型
 */
export interface JwtPayload {
  userId: string;
  roomId: string;
  role: "host" | "guest";
  exp: number;
}

/**
 * 认证结果
 */
export interface AuthResult {
  success: boolean;
  userId?: string;
  roomId?: string;
  role?: "host" | "guest";
  error?: string;
}

/**
 * 从文档名中提取房间 ID
 * 文档命名规范：room:{roomId}:main | room:{roomId}:turn:{n} | room:{roomId}:history
 */
export function extractRoomIdFromDocumentName(
  documentName: string
): string | null {
  const match = documentName.match(/^room:([^:]+):/);
  return match ? match[1] : null;
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token: string): AuthResult {
  const config = getConfig();

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;

    // 检查必需字段
    if (!decoded.userId || !decoded.roomId || !decoded.role) {
      return { success: false, error: "Invalid token payload" };
    }

    // 检查过期时间
    if (decoded.exp && decoded.exp < Date.now()) {
      return { success: false, error: "Token expired" };
    }

    return {
      success: true,
      userId: decoded.userId,
      roomId: decoded.roomId,
      role: decoded.role,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: "Token expired" };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: "Invalid token" };
    }
    return { success: false, error: "Authentication failed" };
  }
}

/**
 * 生成 JWT Token
 */
export function generateToken(
  userId: string,
  roomId: string,
  role: "host" | "guest"
): { token: string; expiresAt: number } {
  const config = getConfig();

  // 7 天过期
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

  const payload: JwtPayload = {
    userId,
    roomId,
    role,
    exp: expiresAt,
  };

  const token = jwt.sign(payload, config.jwtSecret);

  return { token, expiresAt };
}

/**
 * 验证用户是否有权限访问指定文档
 * @param token JWT Token
 * @param documentName 文档名称
 * @returns 认证结果
 */
export function authenticateForDocument(
  token: string | undefined,
  documentName: string
): AuthResult {
  // 1. 检查 token 是否存在
  if (!token) {
    return { success: false, error: "Missing authentication token" };
  }

  // 2. 验证 token
  const authResult = verifyToken(token);
  if (!authResult.success) {
    return authResult;
  }

  // 3. 从文档名提取房间 ID
  const documentRoomId = extractRoomIdFromDocumentName(documentName);
  if (!documentRoomId) {
    return { success: false, error: "Invalid document name format" };
  }

  // 4. 验证房间 ID 匹配
  if (authResult.roomId !== documentRoomId) {
    return { success: false, error: "Room ID mismatch" };
  }

  return authResult;
}

/**
 * Hocuspocus onAuthenticate 钩子
 * 用于 WebSocket 连接认证
 */
export async function onAuthenticate({
  token,
  documentName,
}: {
  token: string;
  documentName: string;
}): Promise<{ userId: string; role: "host" | "guest" }> {
  const result = authenticateForDocument(token, documentName);

  if (!result.success) {
    throw new Error(result.error || "Authentication failed");
  }

  return {
    userId: result.userId!,
    role: result.role!,
  };
}
