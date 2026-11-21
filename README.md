# omp-video-understanding

OMP 原生视频理解插件。注册 `video_understand`，将获授权的视频编码为 `data:video/...;base64,...`，仅发送给操作员配置的 vLLM OpenAI-compatible 后端。现有 OMP `read` 的视频抽帧预览路径不变。

## 能力边界

- 后端协议：`vllm-openai-compatible/video_url`。
- 来源：显式 `localRoots` 内的本地文件、当前会话中的 `[Video #N]` 附件、默认关闭的 HTTPS URL 白名单。
- 不做隐式抽帧、转码、裁剪或重试；后端拒绝原生视频时直接报错。
- 视频字节不进入当前聊天模型上下文；工具结果仅包含文本答案、结构化 provenance、媒体元数据和 usage。
- API key 只来自插件配置或 `OMP_VIDEO_API_KEY`，工具参数不能覆盖后端地址、模型、密钥、header 或请求体。

## 安装与配置

开发链接：

```bash
omp plugin link /absolute/path/to/omp-video-understanding
```

使用 OMP 的插件配置接口设置值；不要直接编辑 `omp-plugins.lock.json`：

```bash
omp plugin config set omp-video-understanding enabled true
omp plugin config set omp-video-understanding baseUrl http://192.168.11.104:18300/v1
omp plugin config set omp-video-understanding model qwen3.8-flash-next
omp plugin config set omp-video-understanding localRoots '["/absolute/authorized/video-directory"]'
omp plugin config validate
```

无密钥服务无需设置 `apiKey`。有密钥服务优先使用 WebUI 的只写字段，或通过环境变量注入（存储配置中不要另设空字符串）：

```bash
read -rsp 'OMP video API key: ' OMP_VIDEO_API_KEY; export OMP_VIDEO_API_KEY; echo
```

安全缺省：`enabled=false`、`localRoots=[]`、`allowRemoteUrls=false`。`localRoots` 和 `allowedRemoteDomains` 在现有扁平 manifest 中分别使用 JSON 字符串数组；例如：

```bash
omp plugin config set omp-video-understanding allowedRemoteDomains '["media.example.com"]'
omp plugin config set omp-video-understanding allowRemoteUrls true
```

纯配置变更由每次工具调用重新读取，只影响新调用，不中断已派发请求。安装、升级、启停或代码变更需要新建 agent session；普通设置保存不会重载扩展模块。

## 工具输入

```json
{
  "source": { "kind": "file", "path": "/authorized/video.mp4" },
  "question": "描述物体的运动方向与颜色变化顺序",
  "maxOutputTokens": 256
}
```

也支持：

```json
{ "source": { "kind": "attachment", "id": "1" }, "question": "描述视频" }
```

`id=1` 对应当前会话的 `[Video #1]`；不能用它读取其他会话或任意 blob。远程来源为 `{ "kind": "url", "url": "https://media.example.com/video.mp4" }`，并要求显式启用白名单。

成功结果的 `details.schemaVersion=1`，`details.provenance.mode=native-video-url`。工具 `content` 只放答案文本；失败结果为 `isError=true`，并提供稳定错误码。

## 两级能力验证

连接测试只证明 `/models` 可达、认证接受且模型 ID 存在，不证明支持视频：

```bash
bun run test:connection
```

原生验证使用仓库内 `fixtures/native-motion.mp4`。该素材先让黑方块从左向右运动，再显示红色方块；只有答案同时覆盖方向和黑→红顺序才通过：

```bash
bun run verify:native
```

`fixtures/static-red.mp4` 仅用于兼容性辅助验证，不能作为时序能力证明。

## 资源与安全

- `timeoutSeconds` 是获取、校验和推理共用的总体 deadline；取消会关闭媒体流和 HTTP 请求。
- `maxMediaBytes` 同时约束原始文件与实际下载字节；base64/JSON 膨胀另有派生上限。
- `maxDurationSeconds` 通过 ffprobe 校验；ffprobe 不用于语义抽帧。
- `concurrency` 使用固定容量、非排队策略；超限立即返回 `concurrency_limit`。
- 本地路径和允许根目录都经过 `realpath`，拒绝 symlink 与路径穿越逃逸。
- 远程 URL 禁止重定向、非公网 IP 和 DNS 重绑定；下载到权限为 `0600` 的临时文件，所有退出路径均清理。
- 日志不记录问题文本、原始未授权路径、API key、Authorization、data URL、视频字节或完整后端响应。

## 错误码

`not_configured`、`disabled`、`permission_denied`、`invalid_media`、`media_too_large`、`media_too_large_after_encoding`、`media_too_long`、`unsupported_backend`、`backend_unreachable`、`backend_authentication_failed`、`backend_rejected_video`、`backend_protocol_error`、`timeout`、`cancelled`、`concurrency_limit`。

## 静态检查

```bash
bun install
bun run check
```

真实后端验收必须在静态检查通过后单独执行。以下命令使用一次性 `XDG_DATA_HOME`，不会改写用户的 OMP 插件配置；`OMP_VIDEO_API_KEY` 仅在需要认证时设置：

```bash
OMP_VIDEO_BASE_URL=http://192.168.11.104:18300/v1 \
OMP_VIDEO_MODEL=qwen3.8-flash-next \
bun run verify:backend
```

验收输出不包含完整 data URL 或密钥。

## 卸载

```bash
omp plugin uninstall omp-video-understanding
```

卸载插件不会保留后台任务。远程下载临时文件位于系统临时目录的插件专用目录，成功、失败、超时和取消路径都会删除。
