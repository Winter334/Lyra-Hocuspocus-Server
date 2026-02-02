# Lyra Hocuspocus Server 部署指南

本文档介绍如何在 Ubuntu 服务器（1panel）上部署 Lyra Hocuspocus Server。

## 前置要求

- Ubuntu 服务器（已安装 1panel）
- Docker 和 Docker Compose（1panel 自带）
- 域名（可选，用于 HTTPS）

## 部署步骤

### 1. 上传代码到服务器

```bash
# 方式一：使用 Git
cd /opt
git clone <your-repo-url> lyra-hocuspocus
cd lyra-hocuspocus/hocuspocus-server

# 方式二：使用 scp 上传
scp -r hocuspocus-server/ user@your-server:/opt/lyra-hocuspocus/
```

### 2. 配置环境变量

```bash
cd /opt/lyra-hocuspocus/hocuspocus-server/docker

# 复制环境变量模板
cp ../.env.example .env

# 编辑环境变量（重要！）
nano .env
```

**必须修改的配置：**

```bash
# 生成安全的 JWT 密钥（至少 32 字符）
JWT_SECRET=$(openssl rand -base64 32)
echo "JWT_SECRET=$JWT_SECRET"

# 生成管理密码（至少 8 字符）
ADMIN_PASSWORD=$(openssl rand -base64 16)
echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"
```

完整的 `.env` 文件示例：

```bash
NODE_ENV=production

# JWT 密钥（必须修改！）
JWT_SECRET=your-super-secret-key-min-32-chars-please-change-this

# WebSocket 配置
WS_PORT=1234
WS_HOST=0.0.0.0

# HTTP API 配置
HTTP_PORT=3000

# Redis 配置
REDIS_ENABLED=true
REDIS_HOST=redis
REDIS_PORT=6379

# 限流配置
RATE_LIMIT_MESSAGES_PER_MINUTE=300
RATE_LIMIT_CONNECTIONS_PER_IP=100

# 管理控制台密码（必须修改！）
ADMIN_PASSWORD=your-admin-password-here

# 日志级别
LOG_LEVEL=info
```

### 3. 启动 Docker 服务

```bash
cd /opt/lyra-hocuspocus/hocuspocus-server/docker

# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f hocuspocus

# 检查服务状态
docker compose ps
```

### 4. 验证部署

```bash
# 健康检查
curl http://localhost:3000/health

# 应该返回类似：
# {"status":"ok","uptime":"10s","activeConnections":0,"redis":"connected",...}

# 测试管理 API（使用你设置的密码）
curl -H "Authorization: Bearer YOUR_ADMIN_PASSWORD" http://localhost:3000/admin/api/metrics
```

### 5. 配置 1panel 反向代理

在 1panel 中配置 OpenResty 反向代理：

#### 5.1 创建网站

1. 登录 1panel 面板
2. 进入 **网站** → **创建网站** → **反向代理**
3. 填写配置：
   - 主域名：`lyra-ws.your-domain.com`（或你的子域名）
   - 代理地址：`http://127.0.0.1:3000`

#### 5.2 修改 Nginx 配置

点击网站 → **配置** → **修改配置文件**，替换为以下内容：

```nginx
upstream hocuspocus_ws {
    server 127.0.0.1:1234;
    keepalive 32;
}

upstream hocuspocus_http {
    server 127.0.0.1:3000;
    keepalive 16;
}

server {
    listen 80;
    server_name lyra-ws.your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name lyra-ws.your-domain.com;

    # SSL 证书（1panel 自动管理）
    ssl_certificate /www/sites/lyra-ws.your-domain.com/ssl/fullchain.pem;
    ssl_certificate_key /www/sites/lyra-ws.your-domain.com/ssl/privkey.pem;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;

    # HTTP API
    location /api/ {
        proxy_pass http://hocuspocus_http;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # 管理控制台
    location /admin {
        proxy_pass http://hocuspocus_http;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket 连接
    location /ws {
        proxy_pass http://hocuspocus_ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # 长连接超时（24 小时）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    # 健康检查
    location /health {
        proxy_pass http://hocuspocus_http;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    location / {
        return 404;
    }
}
```

#### 5.3 申请 SSL 证书

1. 在 1panel 中选择网站 → **HTTPS**
2. 申请方式：**Let's Encrypt**
3. 验证方式：**DNS 验证** 或 **文件验证**
4. 开启 **自动续期**

### 6. 配置 DNS

在你的 DNS 服务商（如 Cloudflare）添加记录：

| 类型 | 名称    | 内容          | 代理状态       |
| ---- | ------- | ------------- | -------------- |
| A    | lyra-ws | 你的服务器 IP | 仅 DNS（灰云） |

> ⚠️ **重要**：使用灰云模式（仅 DNS），不要开启 Cloudflare 代理，否则 WebSocket 会有超时问题。

### 7. 防火墙配置

确保以下端口开放：

```bash
# 1panel 通常已配置，如需手动添加：
ufw allow 80/tcp
ufw allow 443/tcp

# 不需要开放 3000 和 1234 端口（通过反向代理访问）
```

## 验证部署

```bash
# HTTPS 健康检查
curl https://lyra-ws.your-domain.com/health

# WebSocket 连接测试（需要安装 wscat）
npm i -g wscat
wscat -c wss://lyra-ws.your-domain.com/ws
# 会因无 token 被拒绝，但 SSL 握手成功即可

# 访问管理控制台
# 浏览器打开 https://lyra-ws.your-domain.com/admin
```

## 常用运维命令

```bash
cd /opt/lyra-hocuspocus/hocuspocus-server/docker

# 查看日志
docker compose logs -f hocuspocus

# 重启服务
docker compose restart hocuspocus

# 停止服务
docker compose down

# 更新部署
git pull
docker compose up -d --build

# 查看 Redis 数据
docker compose exec redis redis-cli
> KEYS *
> GET roomCode:ABC123
```

## 故障排查

### 服务无法启动

```bash
# 检查日志
docker compose logs hocuspocus

# 常见问题：
# 1. 端口被占用 → 修改 docker-compose.yml 中的端口映射
# 2. 环境变量未配置 → 检查 .env 文件
```

### WebSocket 连接失败

```bash
# 检查 Nginx 配置
nginx -t

# 检查端口监听
netstat -tlnp | grep -E '1234|3000'

# 检查防火墙
ufw status
```

### Redis 连接失败

```bash
# 检查 Redis 容器
docker compose ps redis
docker compose logs redis

# 测试 Redis 连接
docker compose exec redis redis-cli ping
```

## 备份与恢复

```bash
# 备份 Redis 数据
docker compose exec redis redis-cli BGSAVE
docker cp lyra-redis:/data/dump.rdb ./backup/

# 恢复 Redis 数据
docker cp ./backup/dump.rdb lyra-redis:/data/
docker compose restart redis