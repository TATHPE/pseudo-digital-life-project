# 鲸鲸 · 容器镜像（19 §7.1）
#
# 两个架构：`docker buildx build --platform linux/amd64,linux/arm64 .`
#   amd64 → 这台 PC；arm64 → 树莓派（99 §3，同一套镜像）
#
# 设计取舍：
#  - **不带 Ollama**。模型服务放宿主或另一个容器（compose 里可选），镜像只管鲸鲸本体，
#    否则镜像从 ~200 MB 变成 2 GB+，换模型要重建镜像。
#  - **不带 Python**：markitdown 走 MCP 子进程，装进来会把镜像撑到 1 GB。
#    需要 markitdown 时用 compose 的 profile（见 compose.yaml 注释）。
#  - 数据**全在卷里**：`/app/data` 必须挂出来，容器可删。
FROM node:24-alpine

# 时区：记忆的时间轴要按本地时间说话（01 §3）。不设就是 UTC，"今天"会错 8 小时。
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
ENV TZ=Asia/Shanghai

WORKDIR /app

# 依赖先装：只拷 package*.json，改代码不用重装依赖
COPY package.json package-lock.json ./
# sqlite-vec / casbin 都是纯 JS 或预编译二进制，没有编译步骤
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY persona ./persona
COPY tools ./tools

# 数据目录：无卷时也能起来（第一次启动会自动建库）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 只监听回环以外是**不行**的：面板默认只绑 127.0.0.1，容器里要绑 0.0.0.0 才能被宿主访问，
# 但 compose 里只映射到宿主回环（127.0.0.1:7700），所以外部仍然进不来。
ENV JJ_HOME=/app/data
# 容器内绑 0.0.0.0（compose 只把它映射到宿主回环，对外仍不可达）
ENV JJ_BIND=0.0.0.0
ENV NODE_ENV=production

EXPOSE 7700

# 注意：不是 `node --test`，也不做初始化——startup() 在 serve 里跑（断电检测 + 补算衰减）
CMD ["node", "src/cli/jingjing.ts", "serve", "7700"]
