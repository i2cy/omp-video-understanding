# 验证记录

## 插件

- `bun run check`：TypeScript strict 通过；66 个测试通过，0 失败。
- fake server 验证请求只含一个问题、一个 `video_url`、配置模型和 token/采样参数；无会话历史、系统提示词、工具目录或自动重试。
- 媒体测试覆盖 localRoots、`..`、symlink、附件会话归属、容器签名、大小/时长、URL 白名单、私网/metadata/DNS 固定、取消、超时、并发与临时文件清理。

## OMP 核心配置补丁

- 在隔离 OMP 19.0.0 源码树运行 `bun test src/extensibility/plugins/runtime-config.test.ts`：6 个测试通过，0 失败。
- 覆盖独立 manager 的不同 key/plugin 写、project/global 隔离、多轮竞争、删除合并、损坏 JSON 防覆盖与 `0600`。
- 使用 OMP 官方编译选项做依赖闭包检查时，修改文件没有诊断；临时检查仍报告原包其他模块的 23 个既存/工具链诊断，因此不声称 OMP 全仓 typecheck 通过。
- 补丁对原始安装源码执行 `git apply --check` 通过。

## ompweb 适配

- `npm run typecheck`：通过。
- `npm run lint`：0 error；7 个既有 React hook warning。
- 新增/相关测试 55 个通过，0 失败，覆盖 schema、secret、串行写、action、认证、导航和结构化失败状态。
- `npm run build`：通过，构建 104 个文件；CSS 构建有既有 `::highlight` warning。
- 上游全量 `npm test`：4691 通过、82 失败。失败包含当前服务容器不允许创建独立 systemd scope 的宿主更新用例；本次相关测试没有失败。不将该全量结果记为通过。
- 补丁对干净 ompweb v0.7.3 检出的 `git apply --check` 通过。

## 真实 GX10

使用隔离 `XDG_DATA_HOME`，不读写用户配置：

```bash
OMP_VIDEO_BASE_URL=http://192.168.11.104:18300/v1 \
OMP_VIDEO_MODEL=qwen3.8-flash-next \
bun run verify:backend
```

结果：`reachable`，随后 `nativeVideoVerified`。中性问题不包含预期方向或颜色；答案为“moves right, first black and later red”，`finishReason=stop`，provenance 为 `native-video-url`，媒体 2052 bytes / 2000 ms / 96x96，usage 同时含 prompt/completion tokens。

另分别验证：

- 本地 `native-motion.mp4`：回答向右、黑→红。
- 当前会话解析器授权的 `static-red.mp4`：回答 `Red`。该静态素材仅作兼容性辅助，不充当运动时序证明。

小 token 预算可能全部被 reasoning 消耗；适配器将其明确报告为截断，不把空 content 当答案。

## 实际 WebUI

在临时源码构建和独立端口中验证，主 ompweb 未修改或重启：

1. Settings → Extensions & Tools → Plugins 可达。
2. 选中 `omp-video-understanding` 后，全部字段与两个 action 可见。
3. baseUrl/model/localRoots 从 OMP 配置读取；secret 输入为空，浏览器只收到 redacted 状态。
4. 页面保存 `maxOutputTokens=1024`，浏览器刷新与临时服务重启后均保持。
5. `Test connection` 显示 reachable；`Verify native video` 显示 `nativeVideoVerified: true`、答案和 usage。
6. 一次真实后端调用达到 90 秒 deadline，页面正确显示红色 `timeout`，而不是成功；后续同一动作成功。
7. 验证结束后已关闭浏览器页并停止临时服务。

## 主运行时部署与生产验收

Cody 已从 pristine 源码构建产物完成正式部署，并保留同盘回滚备份：

- `pi-coding-agent.bak-3eb55dbb-20261122T140130`
- `ompweb.bak-3eb55dbb-20261122T140130`

OMP 与 ompweb 整树 SHA-256 复核通过。`ompweb.service` 使用 `OMP_WEB_PLUGIN_OMP_BIN=/home/icy/.npm-global/bin/omp`，仅插件配置 CLI 使用全局 v19；聊天 `ompweb-omp` runner 未替换，host 未重启。仅主 ompweb 完成重启，认证后的 `/api/plugins` 与 `/api/plugin-config` 均返回 200。

生产页面已验证：插件配置页可达、连接测试返回 reachable、Web 保存与刷新持久化正常。1024 token 的一次原生验证被 reasoning 耗尽并正确报告截断；通过页面保存 `maxOutputTokens=2048` 后，原生验证返回 `nativeVideoVerified: true`，答案覆盖向右与黑→红，usage 和 `finishReason=stop` 完整。全字段保存逐次启动 CLI，实测约 90 秒，保存探针应允许最多 120 秒。

临时登录 cookie 文件与浏览器 cookie 均已删除。两个回滚备份保留到下一版本。
