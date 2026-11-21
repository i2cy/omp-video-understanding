# OMP Native Video Understanding Plugin — 设计与实施计划

## 1. 项目定位

开发一个独立的 OMP 插件，通过注册 `video_understand` 工具，把本地文件、附件或受控远程 URL 中的视频发送到支持 `video_url` 的原生视频理解后端，并把文本分析结果返回当前 agent。

同时，在当前 omphub WebUI 设置页中提供通用、可持久化、可脱敏的配置界面。

核心边界：

> **omphub/WebUI 负责配置控制面；OMP 插件负责媒体获取、校验和调用；vLLM 负责原生视频解码与推理；OMP 现有 `read` 继续负责本地抽帧预览。**

第一版不修改 OMP 主聊天消息协议，不给当前会话模型增加 `video` 模态，不把原生视频请求静默降级成图片抽帧。

## 2. 已有事实与开发假设

### 已验证事实

- 当前 GX10 后端提供 OpenAI-compatible `POST /v1/chat/completions`。
- 当前 Qwen3.8 Flash Next b12x 服务已实测接受：
  - `text`
  - `image_url`
  - `video_url`
- 原生视频请求可通过 `data:video/mp4;base64,...` 成功返回语义答案。
- 当前 OMP `read` 的视频能力是 ffmpeg/ffprobe 元数据、contact sheet 和按帧/时间戳读取，不等同于原生视频输入。
- OMP 支持插件注册自定义工具、manifest 声明和持久化插件设置。
- OMP 插件锁文件可保存标记为 `secret` 的设置，文件权限为 `0600`。
- 插件锁文件没有完整的跨进程写合并机制，WebUI 与 CLI 并发写必须由配置服务串行化。

### 开发前置核对

实现开始前，在 omphub 源码中确认：

1. 设置页当前读取的是 core settings registry、plugin manifest，还是自定义配置接口。
2. 当前是否已有插件配置列表、读写、校验和 secret 脱敏 RPC。
3. 当前是否已有插件测试动作 RPC；若没有，按本计划增加通用动作，不在前端硬编码视频逻辑。
4. 配置变更后，当前运行中的 agent 如何重新读取插件设置，以及哪些变化要求 reload/restart。

不得绕过这些现有机制直接操作 OMP 锁文件。

## 3. 目标与非目标

### 目标

1. 提供一个模型可调用、参数稳定、结果可溯源的 `video_understand` 工具。
2. 首个后端完整支持 vLLM 的 `video_url` Chat Completions 扩展。
3. 支持本地文件和 OMP attachment；远程 URL 默认关闭，可显式配置。
4. 原生模式失败时明确报错，不隐式抽帧、转码或裁剪。
5. WebUI 可配置后端、密钥、媒体来源和资源限制。
6. WebUI 可分别验证“服务可达”和“原生视频已验证”。
7. 视频与密钥不进入当前 LLM 上下文、WebUI 普通响应或普通日志。
8. CLI、headless、RPC 和 WebUI 使用同一份插件配置与工具实现。
9. 取消、超时、并发和媒体大小均有确定性边界。

### 非目标

本插件不负责：

- 给 OMP 主聊天新增 `VideoContent`。
- 修改 RPC prompt 的消息结构。
- 给所有 provider 增加 `video_url` 透传。
- 新增 `modelRoles.video`。
- 自动替换现有 `read video` 的行为。
- 在工具端抽帧后仍声称是原生视频理解。
- 实现通用视频编辑、转码、剪辑或文件管理服务。
- 代理任意 OpenAI 请求、任意 HTTP header 或任意后端参数。

主聊天原生视频消息属于后续独立项目：`VideoContent → provider adapter → vLLM video_url`。

## 4. 总体架构

### 控制面

```text
omphub WebUI
    │ schema / read / validate / write / test
    ▼
OMP 插件配置服务
    │
    ├── 使用现有插件 manifest 和配置接口
    ├── 对同一 profile/scope 的写入串行化
    └── secret 只写不回显
```

### 数据面

```text
当前 LLM
    │ video_understand(source, question)
    ▼
OMP 插件工具
    │
    ├── 解析 file / attachment / URL
    ├── 检查路径、域名、大小、时长和并发
    ├── 获取媒体字节并计算 SHA-256
    ├── 构造 data URL（不经过当前 LLM）
    ▼
vLLM /chat/completions
    │ 原生 video_url 解码和模型推理
    ▼
OMP 插件工具
    │
    └── 文本答案 + 结构化 provenance + usage
```

数据面约束：

- 视频字节不经过 omphub。
- 视频字节不经过当前聊天模型 provider。
- WebUI 不参与实时视频推理。
- 插件不继承或发送当前 OMP 会话历史、系统提示词或工具目录。

## 5. 组件划分

### 5.1 插件包

职责：

- manifest 与配置 schema。
- 注册 `video_understand`。
- 解析和校验工具参数。
- 解析受信配置，禁止调用参数覆盖后端。
- 获取和校验媒体。
- 调用 vLLM。
- 取消、超时、并发、错误映射和审计元数据。
- 提供 WebUI/CLI 共用的连接测试和原生视频测试。

### 5.2 omphub 配置适配层

职责：

- 将插件 manifest 配置 schema 转换为现有设置页表单项。
- 调用 OMP 插件配置接口，不直接写锁文件。
- 串行化同一 profile/scope 的写操作。
- secret 字段只显示 configured/redacted。
- 展示插件返回的测试状态与脱敏错误。
- 不实现 vLLM 客户端、视频读取或测试视频解码。

### 5.3 vLLM 适配器

首个实现只支持一种明确协议：

```text
vllm-openai-compatible/video_url
```

不提前建设通用 backend 插件系统。代码上保持一个窄接口以便测试和未来扩展，但仓库只交付一个后端实现。

### 5.4 现有 `read`

保持行为不变：

- 本地视频预览仍是抽帧路径。
- 不自动上传本地视频。
- 不因为安装了插件就改变隐私和延迟特征。
- 用户/agent 需要原生理解时显式调用 `video_understand`。

## 6. 工具公共契约

### 6.1 输入

```ts
type VideoUnderstandInput = {
  source:
    | { kind: "file"; path: string }
    | { kind: "attachment"; id: string }
    | { kind: "url"; url: string };
  question: string;
  maxOutputTokens?: number;
};
```

规则：

1. `source` 必须且只能有一种。
2. `question` 必须非空，并设合理字符上限。
3. `maxOutputTokens` 只能小于或等于配置上限。
4. 不允许每次调用覆盖 `baseUrl`、API key、model、HTTP header 或 backend type。
5. 不接受 base64 字符串参数，避免媒体进入模型上下文。
6. 不暴露任意后端 extra body、chat history、tools 或系统提示词参数。
7. 默认不暴露 per-call `mode`；该工具始终表示原生模式。

### 6.2 输出

```ts
type VideoUnderstandResult = {
  schemaVersion: 1;
  answer: string;
  provenance: {
    mode: "native-video-url";
    backend: "vllm-openai-compatible";
    model: string;
    mediaSha256: string;
  };
  media: {
    sizeBytes: number;
    durationMs?: number;
    width?: number;
    height?: number;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  finishReason?: string;
  warnings: string[];
};
```

映射到 OMP 工具结果时：

- `content` 中只放答案文本和必要摘要。
- `details` 放结构化结果，供 renderer、审计和测试使用。
- 不返回 base64、视频字节、完整后端响应或 Authorization。
- 后端文本视为不可信数据，不自动转换为后续工具执行指令。

### 6.3 部分进度

`onUpdate` 只报告稳定阶段：

```text
resolving_source
validating_media
dispatching
waiting_for_backend
completed
```

如实现答案流式输出，最终工具结果仍必须由完整响应重建，不能以部分文本代替完成状态。

## 7. 后端请求契约

请求：

```text
POST {baseUrl}/chat/completions
Content-Type: application/json
Authorization: Bearer <configured-key>  # 仅配置非空时
```

消息只包含：

1. 用户问题；
2. 一个 `video_url` content part；
3. 输出 token 上限和已配置的确定性采样参数。

示意：

```json
{
  "model": "qwen3.8-flash-next",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "描述物体的运动方向"},
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,..."}}
      ]
    }
  ],
  "max_tokens": 512,
  "temperature": 0
}
```

禁止发送：

- 当前 OMP 会话历史；
- 当前 agent 的系统提示词；
- OMP 工具定义；
- 其他项目文件；
- 调用者自定义 header；
- 模型在工具参数中提供的后端地址。

请求一经 dispatch 不自动重试，避免重复计费和重复推理。连接、读取和总时限均由配置的 deadline 与 AbortSignal 控制。

## 8. 媒体来源与获取边界

### 8.1 本地文件

- 默认仅允许显式配置的 `localRoots`。
- 对路径做 canonicalize，并检查 symlink 解析后的真实路径仍在允许根目录内。
- 禁止任意 `/etc`、SSH 目录、其他用户目录和未授权项目文件上传。
- 不把本地路径转换为 `file://` 发给 vLLM；OMP 与 vLLM 容器文件系统不同，并避免服务端文件读取。

### 8.2 Attachment

- 通过 OMP 附件/blob 机制解析，不由模型提供底层存储路径。
- 继承附件已有的会话归属与权限边界。
- 读取后执行与本地文件相同的大小、格式和时长检查。

### 8.3 远程 URL

默认关闭。开启后：

- 只允许 HTTPS 和 `allowedRemoteDomains`。
- 工具负责下载，后端仍只接收 data URL；首版不允许把任意外部 URL 直接交给 vLLM 抓取。
- 禁止重定向；如未来支持，必须重新校验每一跳。
- 限制下载字节数、总时长和 DNS/IP 目标，阻止云 metadata 与内网管理面 SSRF。
- 下载使用临时文件和流式 hash，避免无界内存增长。
- 临时文件在成功、失败、取消和进程清理路径均删除。

### 8.4 格式与时长

- 校验文件签名和可识别的视频容器，不仅信任扩展名。
- 可用 ffprobe 获取元数据与时长；它只用于校验，不用于语义抽帧。
- 不以“工具无法解码”替代后端能力判断；后端拒绝时返回 `backend_rejected_video`。
- 不在原生工具中转码、裁剪、缩短或抽帧。

## 9. 配置模型与生命周期

以下是逻辑配置模型，不新增一份平行配置系统：

```yaml
enabled: false

backend:
  type: vllm-video-url
  baseUrl: http://192.168.11.104:18300/v1
  model: qwen3.8-flash-next
  apiKey: ""

limits:
  timeoutSeconds: 180
  maxMediaBytes: 67108864
  maxDurationSeconds: 600
  maxOutputTokens: 1024
  concurrency: 1

sources:
  allowLocalFiles: true
  localRoots: []
  allowRemoteUrls: false
  allowedRemoteDomains: []
```

`baseUrl` 中的 GX10 地址是开发环境示例，不是安装包的强制默认值。

### 配置字段分组

1. **启用与后端**：enabled、type、baseUrl、model、apiKey。
2. **资源限制**：媒体大小、时长、超时、输出 token、并发。
3. **媒体来源**：本地根目录、远程 URL 开关和域名白名单。
4. **状态与测试**：reachable、nativeVideoVerified、lastError、lastCheckedAt。

### 配置版本

- 配置包含 `schemaVersion: 1`。
- 缺省配置必须安全：工具 disabled、远程 URL disabled、localRoots 为空。
- 未知字段不静默当成有效配置。
- 配置升级保留已有设置；迁移失败时使用最后一份有效配置并报告错误。

### 生效规则

- 每次工具调用开始时取得不可变配置快照。
- 配置变更只影响新调用，运行中的调用继续使用原快照。
- enabled 变更不得中断正在运行的请求，除非操作员显式取消。
- CLI、RPC、headless 与 WebUI 使用同一配置来源。
- WebUI 不是工具运行依赖。

### 写入与 secret

- WebUI 使用 OMP 插件配置接口，禁止直接修改 `omp-plugins.lock.json`。
- 对同一 profile/scope 的写操作串行化，避免 WebUI 和 CLI 并发覆盖。
- `apiKey` 在 manifest 中标记为 `secret`。
- WebUI/API 读取只返回：

  ```json
  {"configured": true, "redacted": true}
  ```

- 编辑时留空表示保留原值；只有明确清除操作才删除。
- secret 不进入 URL query、浏览器日志、错误文本或测试结果。

## 10. WebUI 设置页边界

设置页包含：

### 后端配置

- enabled 开关。
- backend type（首版固定为 `vllm-video-url`）。
- baseUrl、model。
- API key 的只写输入和清除按钮。

### 来源与限制

- localRoots 编辑器。
- remote URL 开关与域名白名单。
- 大小、时长、超时、maxOutputTokens、concurrency。

### 状态与动作

- `Save / Validate`。
- `Test connection`。
- `Verify native video`。
- 状态标签：disabled、not configured、reachable、nativeVideoVerified、failed。
- 最近一次脱敏错误和检查时间。

前端不得包含：

- vLLM 请求构造代码；
- data URL 或视频字节；
- ffprobe/ffmpeg 调用；
- 原生视频测试的语义判定逻辑；
- 对锁文件的直接读写。

若当前 omphub 没有通用插件测试动作，增加一个受认证的插件 RPC/action，由插件执行测试并返回结构化结果；不要把测试实现写进 React 组件。

## 11. 两级能力验证

### 11.1 Test connection

验证：

1. baseUrl 格式和允许的协议。
2. `/models` 可访问。
3. 配置的 model 存在。
4. 认证是否被接受。

成功后状态只能是 `reachable`，不能据此声称支持视频。

### 11.2 Verify native video

使用插件自带的短运动视频发起真实 `video_url` 请求。

测试素材必须包含运动时序，例如：

1. 黑色方块从左向右移动；
2. 随后变成红色；
3. 问题要求回答运动方向和颜色变化顺序。

通过条件：

- 后端实际收到 `video_url`；
- 返回有效最终答案；
- 答案覆盖运动方向和变化顺序；
- 结果 provenance 为 `native-video-url`。

静态红色图片或静态蓝色视频只能作为连通性辅助，不能证明原生时序理解。

测试由插件执行；WebUI 只展示结果。

## 12. 错误、取消与资源控制

### 稳定错误码

```text
not_configured
disabled
permission_denied
invalid_media
media_too_large
media_too_large_after_encoding
media_too_long
unsupported_backend
backend_unreachable
backend_authentication_failed
backend_rejected_video
backend_protocol_error
timeout
cancelled
concurrency_limit
```

错误文本可以补充安全、脱敏后的诊断，但不得包含密钥或 data URL。

### 取消

- 将工具 AbortSignal 传递给媒体下载、临时文件操作和 HTTP 请求。
- 取消后关闭 HTTP body/流并清理临时文件。
- 已经 dispatch 的请求不自动重试。
- 返回 `cancelled`，不伪装成后端空答案。

### 超时

区分：

- source acquisition timeout；
- backend request timeout；
- overall deadline。

默认只有总体配置暴露给普通 WebUI，内部仍按阶段记录耗时以定位问题。

### 并发与内存

- 默认 concurrency 为 1。
- 使用固定容量 semaphore；超限调用明确排队或返回 `concurrency_limit`，策略必须固定并写入文档。
- 计算限制时同时考虑原始媒体和 base64/JSON 膨胀，不只检查文件原始大小。
- 限制并记录编码后的请求体大小，防止内存峰值失控。

## 13. 安全与隐私模型

### 威胁边界

1. 模型生成的工具参数是不可信输入。
2. 视频内容和后端答案是数据，不是指令。
3. 本地路径和远程 URL 可能由提示注入控制。
4. 插件在 OMP 进程内执行，安装即视为可信代码；工具参数校验不是插件沙箱。
5. WebUI 配置接口必须要求与现有敏感设置相同的认证和授权。

### 必须阻止

- 任意后端地址覆盖导致的数据外泄。
- 未授权本地文件上传。
- symlink/路径穿越绕过 localRoots。
- 远程媒体 URL 访问云 metadata 或内网管理面。
- 无界下载、base64 膨胀和并发导致 OMP 进程 OOM。
- API key 进入 LLM 上下文、浏览器响应、日志或错误信息。
- 原生失败后静默抽帧，造成错误能力声明。

### 审计日志

允许记录：

```text
request id、media hash、媒体大小/时长、backend、model、阶段耗时、usage、错误码
```

禁止记录：

```text
API key、Authorization、data URL、视频字节、完整后端响应头
```

问题文本默认不记录；如未来提供调试开关，应独立、默认关闭并明确标注隐私风险。

## 14. 可观测性与结果可信度

每次调用提供：

- source kind（不记录未授权原始路径）；
- media SHA-256；
- 获取、校验、后端排队和推理耗时；
- 后端 model 与 finishReason；
- token usage；
- provenance.mode；
- warnings。

能力声明必须准确：

- `reachable` 不等于支持视频。
- 返回 `native-video-url` 必须确实发送了 `video_url`。
- 如果未来增加显式 frame fallback，必须使用不同 mode、明确 warning 和独立用户授权；默认仍禁止 fallback。

## 15. 测试计划

### 15.1 工具契约测试

使用可控的 HTTP fake server，验证：

- 请求确实包含一个 `video_url`。
- 不包含 OMP 历史、系统提示词或工具定义。
- model、baseUrl 和 key 只能来自受信配置。
- maxOutputTokens 被正确钳制。
- 结果 provenance、usage 和错误映射正确。
- 非 2xx、无效 JSON、空答案、截断响应均有确定行为。

这些测试必须断言消费者可见的请求/结果，不断言源码文本或内部调用次数。

### 15.2 媒体安全测试

覆盖：

- localRoots 内允许、根目录外拒绝。
- `..`、绝对路径、symlink 逃逸。
- attachment 会话归属。
- HTTP、非白名单域名、重定向、私网/metadata URL。
- 超限下载、超限 base64、无效容器和超时。
- 所有成功/失败/取消路径的临时文件清理。

### 15.3 原生能力测试

使用运动测试视频验证：

- 运动方向；
- 事件先后；
- 颜色变化顺序；
- 与单帧理解可区分的问题。

另测静态颜色视频作为基本兼容性用例，但不把它当时序证明。

### 15.4 取消与并发测试

- 下载阶段取消。
- 已 dispatch 后取消。
- 后端慢响应超时。
- 并发上限和排队策略。
- 重复调用不泄漏 socket、临时文件或后台任务。

### 15.5 WebUI 测试

- schema 正确渲染全部字段。
- 保存、刷新、重启后配置保持。
- secret 只显示 configured/redacted。
- 留空保存不清除 secret，显式清除才删除。
- CLI 与 WebUI 串行写入不丢失配置。
- Test connection 只标记 reachable。
- Verify native video 调用插件测试动作并展示结果。
- 未认证/低权限调用不能读 secret、改配置或运行测试。

### 15.6 GX10 实际集成验收

在当前 Orca b12x 服务上执行：

1. 连接测试。
2. 原生运动视频测试。
3. 本地文件、attachment 各一次。
4. 文本回答与 usage/provenance 校验。
5. 取消、超时和后端不可用路径。
6. 确认当前 `read` 视频抽帧行为不变。

测试记录不得包含完整 data URL 或密钥。

## 16. 交付拆分与退出条件

### 阶段 A：集成契约与项目骨架

交付：

- 插件 manifest、配置 schema、错误类型和公共工具类型。
- omphub 配置/secret/RPC 现状核对结果。
- vLLM 适配器接口与 fake server 测试骨架。

退出条件：插件可被 OMP 发现并注册工具，缺省为 disabled，WebUI 可读取 schema。

### 阶段 B：原生 vLLM 主路径

交付：

- file/attachment 获取、大小校验、data URL 请求。
- 完整结果 provenance。
- 超时、取消、错误映射。
- 连接测试与真实原生视频测试。

退出条件：GX10 上本地文件和 attachment 原生视频理解成功，fake server 证明请求使用 `video_url`。

### 阶段 C：来源策略与资源边界

交付：

- localRoots、symlink 防护、远程 URL 白名单与 SSRF 防护。
- 时长/编码后大小限制、并发控制和临时文件清理。

退出条件：全部安全与资源测试通过，无隐式 fallback。

### 阶段 D：omphub 设置页

交付：

- 通用插件设置表单项。
- secret 脱敏与串行写入。
- 两级测试动作和状态展示。
- 配置 reload/restart 行为说明。

退出条件：WebUI 端到端配置、保存、重启和原生验证通过；CLI/headless 使用同一配置。

### 阶段 E：发布与运维

交付：

- 安装、配置、权限、故障排查和卸载说明。
- 可重复的真实后端验收命令。
- 审计字段与隐私说明。
- 插件版本、配置 schema 版本和升级策略。

退出条件：干净环境可安装并完成原生视频验证，卸载后无残留后台任务或临时媒体文件。

## 17. 完成定义

只有同时满足以下条件才算完成：

1. fake server 证明请求使用真正的 `video_url`。
2. 真实 GX10 运动视频回答正确，结果标记 `native-video-url`。
3. 不支持视频的后端明确报错，无隐式抽帧。
4. WebUI 配置持久化、secret 脱敏、写入串行化均通过。
5. 本地路径、SSRF、大小、时长、取消和并发限制通过。
6. 视频和密钥不进入当前 LLM 上下文、WebUI 普通响应或日志。
7. CLI、headless、RPC、WebUI 使用同一插件实现。
8. 现有 `read` 行为保持不变。
9. 项目文档明确区分原生视频理解与抽帧视觉分析。
