# ===== 构建阶段 =====
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖文件
COPY package*.json ./
COPY tsconfig.json ./

# 安装依赖（包含开发依赖，用于构建）
RUN npm ci

# 复制源码
COPY src ./src

# 构建 TypeScript
RUN npm run build

# ===== 生产镜像 =====
FROM node:20-alpine

WORKDIR /app

# 只安装生产依赖
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# 从 builder 复制构建产物
COPY --from=builder /app/dist ./dist

# 健康检查工具
RUN apk add --no-cache curl

# 非 root 用户运行
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3000 1234

CMD ["node", "dist/index.js"]