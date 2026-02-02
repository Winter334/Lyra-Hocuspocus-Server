# Lyra Hocuspocus Server

Lyra Next 多人协作 WebSocket 服务器，基于 [Hocuspocus](https://tiptap.dev/hocuspocus) 构建。

## 功能特性

- 🔌 **WebSocket 实时同步** - 基于 Yjs CRDT 的实时协作
- 🔐 **JWT 认证** - 安全的房间访问控制
- 🏠 **房间管理** - 房间码创建、加入、成员管理
- ⚡ **限流保护** - 防止滥用的多层限流机制
- 📊 **管理控制台** - 实时监控和房间管理
- 🐳 **Docker 部署** - 一键容器化部署

## 快速开始

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

服务启动后：
- HTTP API: <http://localhost:3000>
- WebSocket: ws://localhost:1234
- 管理控制台: <http://localhost:3000/admin>

### Docker 部署

```bash
cd docker

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f hocuspocus

# 停止服务
docker compose down
```

## API 文档

### 健康检查

```bash
GET /health

# 响应示例
{
  "status": "ok",
  "uptime": "5m 30s",
  "activeConnections": 12,
  "redis": "connected",
  "memory": { "heapUsed": "15.6MB", "heapTotal": "18.1MB" }
}
```

### 房间管理 API

```bash
# 注册房间
POST /api/room/register
Content-Type: application/json
{
  "roomId": "room-uuid",
  "code": "ABC123",
  "hostUserId": "user-id"
}

# 查询房间
GET /api/room/join?code=ABC123

# 添加成员
POST /api/room/add-member
Content-Type: application/json
{
  "roomId": "room-uuid",
  "userId": "user-id",
  "displayName": "Player 2"
}

# 获取 Token
POST /api/room/get-token
Content-Type: application/json
{
  "userId": "user-id",
  "roomId": "room-uuid",
  "role": "host" | "guest"
}
```

### 管理控制台 API

需要 `Authorization: Bearer {ADMIN_PASSWORD}` 认证。

```bash
# 获取实时指标
GET /admin/api/metrics

# 获取房间列表
GET /admin/api/rooms?page=1&limit=20

# 获取统计信息
GET /admin/api/stats

# 关闭房间
POST /admin/api/rooms/{roomId}/close
Content-Type: application/json
{
  "reason": "管理员操作"
}
```

### WebSocket 连接

```bash
# 使用 wscat 测试
wscat -c "ws://localhost:1234?token=YOUR_JWT_TOKEN"
```

## 环境变量

| 变量名                           | 默认值      | 说明                               |
| -------------------------------- | ----------- | ---------------------------------- |
| `NODE_ENV`                       | development | 运行环境                           |
| `WS_PORT`                        | 1234        | WebSocket 端口                     |
| `WS_HOST`                        | 0.0.0.0     | WebSocket 监听地址                 |
| `HTTP_PORT`                      | 3000        | HTTP API 端口                      |
| `REDIS_ENABLED`                  | false       | 是否启用 Redis                     |
| `REDIS_HOST`                     | localhost   | Redis 主机                         |
| `REDIS_PORT`                     | 6379        | Redis 端口                         |
| `JWT_SECRET`                     | (开发密钥)  | JWT 签名密钥（生产环境必须修改）   |
| `ADMIN_PASSWORD`                 | admin       | 管理控制台密码（生产环境必须修改） |
| `RATE_LIMIT_MESSAGES_PER_MINUTE` | 300         | 单连接消息速率限制                 |
| `RATE_LIMIT_CONNECTIONS_PER_IP`  | 100         | 单 IP 连接数限制                   |
| `LOG_LEVEL`                      | info        | 日志级别 (debug/info/warn/error)   |

查看 [.env.example](.env.example) 了解完整配置。

## 项目结构

```
hocuspocus-server/
├── src/
│   ├── index.ts              # 服务器入口
│   ├── config.ts             # 配置管理
│   ├── api/
│   │   ├── health.ts         # 健康检查 API
│   │   ├── room.ts           # 房间管理 API
│   │   └── admin.ts          # 管理控制台 API
│   ├── middleware/
│   │   ├── auth.ts           # JWT 认证
│   │   ├── rate-limit.ts     # 限流中间件
│   │   └── room-isolation.ts # 房间隔离
│   ├── utils/
│   │   ├── redis.ts          # Redis 客户端
│   │   └── logger.ts         # 日志工具
│   └── admin-ui/
│       └── index.html        # 管理控制台前端
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── .env.example
├── package.json
└── tsconfig.json
```

## 开发命令

```bash
npm run dev        # 启动开发服务器（热重载）
npm run build      # 构建生产版本
npm run start      # 运行生产版本
npm run typecheck  # TypeScript 类型检查
```

## License

本项目采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 协议开源。

- ✅ 允许：个人使用、学习研究、非商业分享
- ✅ 要求：署名、相同方式共享
- ❌ 禁止：商业用途

详见 [LICENSE](../LICENSE) 文件。
