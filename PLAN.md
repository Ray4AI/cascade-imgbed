# CascadeImg（暂名）— 面向 LLM 的粘贴图床 · 项目计划

> 一句话：一个垂直 cascade 页面，粘一张图 → 生成直链 + 可自定义格式的引用文本（如 `[image:http://…]`），
> 一键复制喂给大模型；带反代域名设置、自动清理、简易访问密码。单容器 Docker 交付。

> **状态：已实现并通过验证**（M1–M7 全部完成）。实现决策：零依赖 Node（无 npm install，Docker 构建极简）；
> 元数据用 `data/meta.json`（文件系统为准，可重建）；新图在 cascade 顶部；端口 3080。
> 运行：`docker compose up -d --build` 或 `DATA_DIR=./data node src/server.js`。

---

## 1. 定位与借鉴

- **不是通用图床**（Lsky/EasyImage/Picsur 太重：相册、多存储策略、用户系统都用不上）。
- 借鉴点：
  - `imgpush`：极简 API 上传返回路径的思路 → 我们的 `/i/:id` 直链。
  - `EasyImage`（无数据库）→ 我们用 SQLite 但只存元数据，文件系统为准。
  - `lstc` 的"对外只发本站 /i/ 短链"思路 → 反代基础域名可配置。
- 核心差异：**输出格式模板** + **垂直 cascade 工作流界面** + **为 LLM 设计的免密直链**。

## 2. 核心功能

### 2.1 主界面：垂直 Cascade
- 单页应用，主体是从上到下堆叠的**图片卡片流**（新图追加在顶部，可切换）。
- 粘贴（Ctrl+V，支持一次多张）、拖拽、点击选择文件，三种方式均可上传。
- 每张卡片包含：
  - 缩略图 + 元信息（尺寸、大小、上传时间、剩余存活倒计时）
  - 直链 URL（只读框 + 复制按钮）
  - **格式化输出框**（按当前模板实时渲染，如 `[image:https://img.example.com/i/aB3x.png]`）+ 复制按钮
  - 卡片级格式切换（Markdown / `[image:{url}]` / `<image>{url}</image>` / 纯 URL / 自定义）
  - 单独删除按钮
- 顶部工具条：当前格式模板选择器、"复制全部"（把整个 cascade 按模板拼成一段）、设置入口、登录状态。
- 刷新页面后从 `/api/images` 恢复历史 cascade（未过期的）。

### 2.2 格式模板系统
- 占位符：`{url}` `{id}` `{filename}` `{ext}` `{size}` `{w}x{h}` `{time}`。
- 内置预设：`markdown`、`[image:{url}]`、`<image>{url}</image>`、`<img src="{url}">`、`plain: {url}`。
- 设置页可增删改自定义模板，设一个"全局默认模板"。
- 上传 API 返回时把**所有模板渲染结果**一并返回（`formats: {...}`），方便脚本调用。

### 2.3 设置（设置抽屉/页）
| 设置项 | 说明 |
|---|---|
| 反代基础域名 `base_url` | 生成直链用的外部域名，如 `https://img.example.com`；留空则按请求 Host 自动推导。页面同时显示"当前实际生效值"提示 |
| 保留时长 `retention` | 10min / 1h / 6h / 1d / 7d / 30d / 永久 |
| 清理扫描间隔 `clean_interval` | 默认 5min，启动时也跑一次 |
| 访问续期 `sliding_expiry` | 开关：图片每次被访问（GET 直链）则刷新过期时间 |
| 访问密码 | 见 2.4 |
| 上传限制 | 单文件大小上限（默认 20MB）、允许的图片类型 |
| 危险操作 | 清空全部图片 |

### 2.4 简易访问密码
- 环境变量 `PASSWORD` 作为初始密码；设置页可修改（bcrypt 存 DB）。
- 登录后签发 **HMAC-SHA256 签名 token**（含过期时间），存 HttpOnly Cookie；API 也接受 `Authorization: Bearer <token>`（方便 curl 脚本上传）。
- **关键设计：`/i/*` 直链免密**——LLM 拿到 URL 必须能直接取图，不能带 Cookie。
  - 防护靠 **128-bit 随机 ID**（nanoid 21 位）不可枚举，而非鉴权。
  - 密码只保护：网页 UI、上传接口、管理接口（列表/删除/设置）。
- 未设 `PASSWORD` 且 DB 无密码 = 完全开放模式（局域网自用方便）。

### 2.5 自动清理
- 定时任务扫描 `expire_at < now` 的记录 → 删文件 + 删记录。
- 开启"访问续期"时，GET 直链会把 `expire_at` 顺延。
- 删除后直链返回 404（可选返回一张占位图，设置里开关）。

## 3. 技术选型

- **后端**：Node.js 20 + Fastify（依赖极少：fastify、@fastify/multipart、@fastify/cookie、better-sqlite3、nanoid）。
- **元数据**：SQLite（单文件 `/data/db.sqlite`，仅存 id/文件名/mime/尺寸/大小/时间/过期/访问数），**文件系统为准**，DB 挂了可重建。
- **文件存储**：`/data/images/<id>.<ext>`，挂载 volume 持久化。
- **前端**：单页 vanilla JS + CSS，**无构建步骤**（三个静态文件），粘贴/拖拽用原生 API。
- **图片类型校验**：魔数嗅探（png/jpeg/gif/webp/bmp），不信 Content-Type；SVG 默认禁用（XSS 风险）。

## 4. API 设计

```
POST /api/login          {password}          → Set-Cookie token
POST /api/logout
GET  /api/config         (需登录)            → 当前配置（密码打码）
PUT  /api/config         (需登录)            → 更新配置
POST /api/upload         multipart 或 raw body   → {id, url, formats:{...}, expireAt}
GET  /api/images?before=&limit= (需登录)      → cascade 历史分页
DELETE /api/images/:id   (需登录)
POST /api/purge          (需登录)            → 清空全部
GET  /i/:id.:ext         ★公开直链★           → 图片本体（ETag/HEAD 支持）
GET  /healthz                                → 容器健康检查
```

## 5. 目录结构

```
cascade-imgbed/
├── Dockerfile               # node:20-alpine，非 root，HEALTHCHECK
├── docker-compose.yml       # volume + 环境变量示例
├── .dockerignore
├── README.md                # 部署 + nginx/Caddy/Cloudflare Tunnel 反代示例
├── package.json
└── src/
    ├── server.js            # Fastify 入口、路由、静态托管
    ├── config.js            # env + DB 配置合并/校验
    ├── db.js                # SQLite schema + 迁移
    ├── auth.js              # bcrypt 校验 + HMAC token 签发/验签
    ├── cleanup.js           # 过期清理定时任务
    ├── sniff.js             # 图片魔数嗅探
    └── public/
        ├── index.html       # cascade UI + 设置抽屉
        ├── app.js
        └── style.css
```

## 6. 安全要点

- ID 随机 128-bit，防枚举遍历；存储路径不含原始文件名。
- 魔数校验 + 大小上限 + 上传频率限制（每 IP token bucket，默认 30 张/分钟）。
- `X-Content-Type-Options: nosniff`、UI 页面 CSP、Cookie HttpOnly + SameSite=Lax。
- 容器非 root 运行；原始文件名仅存 DB 用于 `{filename}` 占位符。
- 反代注意事项写进 README（nginx `client_max_body_size`、Caddy `request_body` 限制）。

## 7. Docker 交付

- `Dockerfile`：`node:20-alpine`，`VOLUME /data`，`EXPOSE 3080`，HEALTHCHECK 打 `/healthz`。
- `docker-compose.yml` 环境变量：

  ```yaml
  environment:
    BASE_URL: https://img.example.com   # 反代基础域名（可留空自动推导）
    PASSWORD: change-me                  # 访问密码（可留空=开放模式）
    RETENTION: 7d                        # 多久清理
    CLEAN_INTERVAL: 5m                   # 清理扫描间隔
    MAX_UPLOAD_MB: 20
    SLIDING_EXPIRY: "false"
  volumes:
    - ./data:/data
  ```

- 用 buildx 出 `linux/amd64 + linux/arm64` 双架构镜像（NAS 也能跑）。

## 8. 实施里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 项目骨架 + Dockerfile/compose + healthz | `docker compose up` 服务可起 |
| M2 | 上传 → 存储 → `/i/:id` 直链 → SQLite 元数据 | curl 上传拿到可访问直链 |
| M3 | 垂直 cascade UI：粘贴/拖拽/卡片流/复制按钮 | 粘贴即出图出链出格式文本 |
| M4 | 格式模板系统 + 设置页（base 域名、清理策略） | 改模板即时生效；改域名换链接前缀 |
| M5 | 密码登录 + 上传限流 + 安全头 | 未登录不能上传/看列表，直链仍公开 |
| M6 | 定时清理 + 访问续期 + 清空 | 过期图自动消失，直链 404 |
| M7 | README（反代示例）+ 多架构构建 | 按文档 5 分钟内部署成功 |

## 9. 待确认的问题（已定，可在使用中调整）

1. 技术栈：**零依赖 Node.js ≥ 18**（已定）
2. 直链**完全免密**（已定，靠 128-bit 随机 ID 防护）
3. cascade 新图放**顶部**（已定）
4. 名称 `cascade-imgbed`，端口 **3080**（已定）

## 10. 实现补充（与原计划的差异）

- 元数据从 SQLite 改为 `data/meta.json`（去 native 依赖；单进程规模足够）。
- 密码散列从 bcrypt 改为 Node 内置 `crypto.scrypt`；token 为 HMAC-SHA256 签名无状态令牌。
- 新增：修改保留时长会**重算**已有图片过期时间（`createdAt + retention`），立即生效。
- 新增：`POST /api/sweep` 手动清理；`GET /api/me` 登录状态探测。
- 新增：支持类型扩展为 通用文件直链箱——图片、文本（txt/md/json/代码，卡片带预览）、
  音频（mp3/flac/wav/m4a/aac/ogg）、视频（mp4/webm/mov/mkv/avi）、pdf/zip 等（魔数嗅探）；
  纯文本粘贴存为 .txt；音视频支持 HTTP Range；html/xml/svg 文本强制按 text/plain 下发。
- Docker 入口脚本 `entrypoint.sh`：修复 bind mount `/data` 属主后降权到 `node` 用户运行。
