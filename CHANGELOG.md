# Changelog

本项目记录对用户可见的变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用语义化版本。

## [0.1.0] - 2026-11-22

首个可用版本：OMP 原生视频工具、vLLM 后端、ompweb 控制面，以及生产部署与真实后端验收。

### Added

- 注册 `video_understand`，支持授权本地文件、当前会话 `[Video #N]` 附件和默认关闭的 HTTPS URL 来源。
- 实现 `vllm-openai-compatible/video_url`：通过 `data:video/...;base64,...` 发送一个视频 content part，不发送 OMP 历史、系统提示词或工具目录。
- 返回文本答案、SHA-256、媒体元数据、usage、finishReason 和 `native-video-url` provenance。
- 提供严格配置快照、稳定错误码、总体 deadline、AbortSignal、固定容量并发限制和完整临时文件清理。
- 提供 `test-connection` 与 `verify-native-video` 两级动作，以及运动方向和黑→红时序验证素材。
- 提供隔离真实后端验收命令：`OMP_VIDEO_BASE_URL=... OMP_VIDEO_MODEL=... bun run verify:backend`。
- 增加 ompweb 通用插件配置表单、secret 只写/显式清除、manifest action 和插件导航。
- 增加 OMP global/project 配置跨进程锁、三向合并、损坏配置防覆盖和 `--local` 写入支持。
- 增加 `OMP_WEB_PLUGIN_OMP_BIN`，允许插件配置 CLI 使用独立 OMP，保留 ompweb 聊天 runner 与 RPC 协议。

### Changed

- 原生自检使用不包含预期答案的中性问题，避免后端仅复述提示文本而产生假阳性。
- 原生自检接受常见的 rightward、to-the-right 和 moves-right 英文表述，同时检查颜色变化顺序。
- 文档建议当前 Qwen 推理模型使用 `maxOutputTokens=2048`，避免 1024 预算被 reasoning 全部消耗。
- 文档明确 64 MiB 原始媒体限制、base64 体积膨胀及该服务端大文件上限尚未实测的边界。

### Fixed

- `finish_reason=length` 优先报告为截断，即使后端同时返回空 content，不再误报为普通空答案协议错误。
- 本地路径同时校验目标与允许根目录的 canonical path，阻止 `..`、前缀兄弟目录和 symlink 逃逸。
- 远程下载禁止重定向、非公网地址和 DNS rebinding，并限制声明/实际下载字节。
- 配置保存保留不同 key/plugin 的并发更新，project/global 删除与新增不会互相复活或覆盖。
- ompweb action 返回 `{status:"failed"}` 时显示错误而非绿色成功。
- ompweb 插件配置 CLI 可独立指向全局 OMP，无需替换或降级聊天 runner。

### Security

- API key 在 Web 响应中只显示 configured/redacted；空输入保留，显式操作才清除。
- 工具参数不能覆盖 backend、baseUrl、model、API key、header 或任意请求体。
- 不返回或记录视频字节、data URL、Authorization、完整后端响应或问题文本。
- 视频附件仅从当前会话分支解析，不接受任意 blob hash 作为授权依据。
- 原生失败不隐式抽帧、转码、裁剪或重试。

### Verified

- 插件 TypeScript 与 66 项测试通过。
- OMP 配置锁 6 项测试通过；OMP 5090 文件类型检查通过。
- ompweb 相关 55 项测试、typecheck、lint 和生产构建通过。
- GX10 `qwen3.8-flash-next` 实测 reachable 与 nativeVideoVerified；本地文件和附件均返回原生 provenance 与 usage。
- 生产 ompweb 页面、配置保存/刷新持久化、secret 脱敏和两级动作均完成实际验收。
- 保留完整回滚备份；详细环境与上游测试限制见 `docs/VALIDATION.md`。

[0.1.0]: https://github.com/i2cy/omp-video-understanding
