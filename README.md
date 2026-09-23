# CascadeImg

垂直 cascade 网页直链箱：往页面里粘一张截图 / 文件（Ctrl+V / 拖拽 / 选择文件），立刻生成
**直链 + 可自定义格式的引用文本**（如 `[image:http://…]`），一键复制喂给大模型。

- 零依赖 Node.js（无需 npm install），单容器交付
- **支持类型**：图片 png/jpeg/gif/webp/bmp、文本 txt/md/json/csv/yaml/各类代码、
  音频 mp3/flac/wav/m4a/aac/ogg、视频 mp4/webm/mov/mkv/avi/ogv、文档 pdf、压缩包 zip/7z/rar/gz/bz2
  （全部经魔数嗅探；纯文本粘贴会存为 `.txt`；SVG 与 html/xml 按 text/plain 下发防 XSS）
- 音视频支持 HTTP Range（可拖动进度条）；文本卡片带内容预览
- 反代基础域名、保留时长/自动清理、访问续期、简易访问密码均可在设置里改
- 直链**公开免密**（LLM 要能直接取图/取文件），防遍历靠 128-bit 随机 ID；密码只保护管理界面和上传

## 快速开始

### Docker（推荐）

```bash
docker compose up -d --build
# 打开 http://<主机IP>:3080
```

数据持久化在 `./data`（图片 `data/images/`、元数据 `data/meta.json`、配置 `data/config.json`）。

### 直接运行（Node ≥ 18）

```bash
DATA_DIR=./data node src/server.js
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `BASE_URL` | 空 | 反代基础域名，如 `https://img.example.com`。留空则按访问地址（支持 X-Forwarded-*）自动推导 |
| `PASSWORD` | 空 | 访问密码；留空 = 开放模式。**设置了环境变量后以环境变量为准**（每次启动覆盖设置页的修改） |
| `RETENTION` | `7d` | 保留时长：`10m`/`1h`/`6h`/`1d`/`7d`/`30d`/`never` |
| `CLEAN_INTERVAL` | `5m` | 清理扫描间隔 |
| `MAX_IMAGE_MB` / `MAX_TEXT_MB` / `MAX_AUDIO_MB` / `MAX_VIDEO_MB` / `MAX_DOC_MB` | 20 / 2 / 50 / 100 / 30 | 分类型上传大小上限（MB）；`MAX_UPLOAD_MB` 一次性设全部（兼容旧配置） |
| `SLIDING_EXPIRY` | `false` | `true` 时每次直链被访问都重新计时 |
| `KEEP_FILENAME` | `true` | `false` 时下载/另存使用随机文件名（id.ext），否则保留原文件名 |
| `RATE_LIMIT_PER_MIN` | `30` | 每 IP 每分钟上传上限（0 = 不限） |
| `PORT` / `HOST` | `3080` / `0.0.0.0` | 监听端口/地址 |
| `DATA_DIR` | `./data`（镜像内 `/data`） | 数据目录 |

> 设置页的修改持久化在 `data/config.json`；不想被环境变量覆盖就留空对应变量。

## 格式模板

占位符：`{url}` `{id}` `{filename}` `{ext}` `{size}` `{w}` `{h}` `{time}`（非图片的宽高为 0）

内置模板：`[image:{url}]`、`![{filename}]({url})`、`<image>{url}</image>`、`<img src="{url}">`、`{url}`。
可在「设置 → 格式模板」增删改，并设默认模板；每张卡片上也能临时切换。

## 访问密码逻辑

- 在「设置 → 访问密码」填 新密码 + 确认新密码，点 **「✓ 设置 / 修改密码」** 按钮立即生效；
  清除密码必须输入当前密码并点 **「清除密码」**（双重确认）。
- 密码保护的是：查看历史、上传、删除、改设置（页面刷新后弹登录门禁）。
- **直链 `/i/<id>.<ext>` 永远公开**——大模型取文件不能带密码；靠 128-bit 随机 ID 防枚举。
- 登录 Cookie 为会话级（关浏览器后需重新登录）；脚本可用 `/api/login` 返回的 token 走 `Authorization: Bearer`。
- 设置密码后，当前浏览器自动保持登录；验证门禁请用无痕窗口或点右上角「退出」。

## API

```bash
# 上传（原始 body，脚本友好）
curl -X POST http://HOST:3080/api/upload \
  -H 'Content-Type: image/png' -H 'X-Filename: shot.png' \
  --data-binary @shot.png

# 上传（multipart，curl -F 自然写法）
curl -X POST http://HOST:3080/api/upload -F file=@shot.png

# 返回示例
# {"id":"...","url":"http://HOST:3080/i/xxx.png",
#  "formats":{"llm":"[image:http://HOST:3080/i/xxx.png]", "markdown":"![shot.png](...)", ...}}

# 登录（设置了 PASSWORD 时，管理接口需登录；也可用返回的 token 走 Bearer）
curl -X POST http://HOST:3080/api/login -d '{"password":"..."}' -H 'Content-Type: application/json'

# 列表 / 删除 / 清空 / 手动清理
curl http://HOST:3080/api/images
curl -X DELETE http://HOST:3080/api/images/<id>
curl -X POST http://HOST:3080/api/purge
curl -X POST http://HOST:3080/api/sweep
```

直链：`GET /i/<id>.<ext>` —— **永远公开**，供大模型直接取图。

## 反代示例

在设置里（或 `BASE_URL`）填好外部域名后，直链会用该域名生成。

**Caddy**

```caddyfile
img.example.com {
    request_body { max_size 25MB }
    reverse_proxy 127.0.0.1:3080
}
```

**Nginx**

```nginx
server {
    listen 443 ssl;
    server_name img.example.com;
    client_max_body_size 25m;    # 别忘了调大，否则大图 413
    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Cloudflare Tunnel / Tailscale Funnel 同理：指到 3080 端口，把公网域名填进 `BASE_URL` 即可。

## 安全说明

- 直链免密是**有意设计**（LLM 无法带 Cookie）；ID 为 128-bit 随机数，不可枚举。
- 不想让内容公开可见时，把直链放在鉴权反代之后，并接受"大模型需要能访问"这一前提。
- 上传文件经魔数校验；**SVG 不支持**，html/xml 文本强制按 `text/plain` 下发（防存储型 XSS）；原始文件名只存元数据、不进路径。
- 支持：上传限流、分类型大小上限（图片/文本/音频/视频/其他）、`nosniff`、UI 页面 CSP、Cookie HttpOnly。
