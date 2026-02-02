/**
 * 配置管理模块
 * 从环境变量加载配置，提供默认值
 */

export interface Config {
  // 运行环境
  nodeEnv: "development" | "production" | "test";

  // WebSocket 配置
  wsPort: number;
  wsHost: string;

  // HTTP API 配置
  httpPort: number;

  // Redis 配置 (Phase 2)
  redisEnabled: boolean;
  redisHost: string;
  redisPort: number;

  // JWT 配置 (Phase 2)
  jwtSecret: string;

  // 限流配置 (Phase 3)
  rateLimitMessagesPerMinute: number;
  rateLimitConnectionsPerIp: number;
  rateLimitRoomMessagesPerMinute: number;
  rateLimitHttpRequestsPerMinute: number;

  // 管理控制台 (Phase 5)
  adminPassword: string;

  // 日志级别
  logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * 配置验证错误
 */
export class ConfigValidationError extends Error {
  constructor(message: string, public readonly missingVars: string[]) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
}

export function loadConfig(): Config {
  return {
    nodeEnv: getEnv("NODE_ENV", "development") as Config["nodeEnv"],

    wsPort: getEnvInt("WS_PORT", 1234),
    wsHost: getEnv("WS_HOST", "0.0.0.0"),

    httpPort: getEnvInt("HTTP_PORT", 3000),

    redisEnabled: getEnvBool("REDIS_ENABLED", false),
    redisHost: getEnv("REDIS_HOST", "localhost"),
    redisPort: getEnvInt("REDIS_PORT", 6379),

    jwtSecret: getEnv("JWT_SECRET", "dev-secret-please-change-in-production"),

    rateLimitMessagesPerMinute: getEnvInt(
      "RATE_LIMIT_MESSAGES_PER_MINUTE",
      300
    ),
    rateLimitConnectionsPerIp: getEnvInt("RATE_LIMIT_CONNECTIONS_PER_IP", 100),
    rateLimitRoomMessagesPerMinute: getEnvInt(
      "RATE_LIMIT_ROOM_MESSAGES_PER_MINUTE",
      1000
    ),
    rateLimitHttpRequestsPerMinute: getEnvInt(
      "RATE_LIMIT_HTTP_REQUESTS_PER_MINUTE",
      60
    ),

    adminPassword: getEnv("ADMIN_PASSWORD", "admin"),

    logLevel: getEnv("LOG_LEVEL", "info") as Config["logLevel"],
  };
}

/**
 * 验证生产环境必需的配置
 * 在生产环境启动时调用，确保关键配置已设置
 */
export function validateConfig(config: Config): void {
  const missingVars: string[] = [];
  const warnings: string[] = [];

  // 生产环境必须配置
  if (config.nodeEnv === "production") {
    // JWT_SECRET 必须修改
    if (
      config.jwtSecret === "dev-secret-please-change-in-production" ||
      config.jwtSecret.length < 32
    ) {
      missingVars.push("JWT_SECRET (must be at least 32 characters)");
    }

    // ADMIN_PASSWORD 必须修改
    if (config.adminPassword === "admin" || config.adminPassword.length < 8) {
      missingVars.push("ADMIN_PASSWORD (must be at least 8 characters)");
    }

    // Redis 建议启用
    if (!config.redisEnabled) {
      warnings.push(
        "REDIS_ENABLED is false - rate limiting will use memory (not recommended for production)"
      );
    }
  }

  // 开发环境警告
  if (config.nodeEnv === "development") {
    if (config.jwtSecret === "dev-secret-please-change-in-production") {
      warnings.push(
        "Using default JWT_SECRET - this is insecure for production"
      );
    }
    if (config.adminPassword === "admin") {
      warnings.push(
        "Using default ADMIN_PASSWORD - this is insecure for production"
      );
    }
  }

  // 输出警告
  if (warnings.length > 0) {
    console.warn("\n⚠️  Configuration Warnings:");
    warnings.forEach((w) => console.warn(`   - ${w}`));
    console.warn("");
  }

  // 生产环境缺少必需配置时抛出错误
  if (missingVars.length > 0) {
    const message = `Missing or invalid required configuration:\n${missingVars
      .map((v) => `  - ${v}`)
      .join("\n")}`;
    throw new ConfigValidationError(message, missingVars);
  }
}

// 单例配置
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

// 开发时可以打印配置（隐藏敏感信息）
export function printConfig(config: Config): void {
  console.log("\n=== Server Configuration ===");
  console.log(`  NODE_ENV: ${config.nodeEnv}`);
  console.log(`  WS: ${config.wsHost}:${config.wsPort}`);
  console.log(`  HTTP: ${config.httpPort}`);
  console.log(
    `  Redis: ${
      config.redisEnabled
        ? `${config.redisHost}:${config.redisPort}`
        : "disabled"
    }`
  );
  console.log(`  JWT_SECRET: ${config.jwtSecret.substring(0, 8)}...`);
  console.log(`  Rate Limits:`);
  console.log(`    - Messages/min: ${config.rateLimitMessagesPerMinute}`);
  console.log(`    - Connections/IP: ${config.rateLimitConnectionsPerIp}`);
  console.log(`    - Room msgs/min: ${config.rateLimitRoomMessagesPerMinute}`);
  console.log(`    - HTTP req/min: ${config.rateLimitHttpRequestsPerMinute}`);
  console.log(`  Log Level: ${config.logLevel}`);
  console.log("============================\n");
}
