# OMP / ompweb 集成核对

## 核对的版本

- OMP：`@oh-my-pi/pi-coding-agent@19.0.0`。
- ompweb：`@kahme247/ompweb@0.7.3`。
- ompweb 当前 agent 使用其自带的 `ompweb-omp` 二进制；不能用全局 OMP 源码版本推断该二进制的内部 RPC 能力。

## 已有机制

- 插件 manifest 位于 `package.json#omp`，扩展通过 `omp.extensions` 注册。
- `PluginManager` 与 `omp plugin config list/get/set/delete/validate` 已提供配置存储入口。
- `getPluginSettings()` 每次读取全局锁文件与项目 override；本插件因此能在每次调用开始取得新快照，纯配置变化无需重载扩展。
- manifest 设置仅支持 `string`、`number`、`boolean`、`enum`；数组在本插件中使用 JSON 字符串表达，并由插件严格解析。
- `apiKey` 的 `secret` 是掩码标记；锁文件权限为 `0600`，但原始管理器/CLI JSON 读取并不构成脱敏 API。

## 初始缺口

- ompweb 设置页未读取插件 settings schema，也没有通用插件配置或测试 action RPC。
- ompweb v0.7.3 的插件面板导航被归一化到 MCP，原路径不可达。
- OMP 没有通用插件测试 action RPC。
- `PluginManager` 缓存并整文件覆盖配置；原子 rename 不等于跨进程读合并。
- OMP 19 的 `plugin config set/delete --local` 未实际传递 project 写语义。
- 视频附件没有公共 `attachment id -> bytes` API；OMP 当前以会话分支中的隐藏 `video-attachment` 来源记录保存 `[Video #N]` 与原始路径。本插件只从当前分支解析，拒绝任意 blob hash。

## 本仓库集成补丁

- `integration/omp-19.0.0-plugin-config.patch`：全局配置与 project overrides 的跨进程锁、三向合并、损坏配置防覆盖、`--local` 写入，以及 marketplace 写路径迁移。
- `integration/ompweb-0.7.3-plugin-config.patch`：通用 schema 表单、secret 只写/显式清除、受认证配置路由、manifest 声明 action 调度和插件页导航。

WebUI 不直接读写 OMP 锁文件，不包含 vLLM 请求、视频解码、data URL 或语义判定。动作由插件包的 `omp.actions` 声明并在服务端受控加载；浏览器只能选择 action id，不能提供模块、export 或命令行。

## 生效与运维边界

- baseUrl、model、key、limits、来源配置：新调用读取新快照，运行中调用不变。
- 安装、升级、启停、manifest 或代码变化：新建/reload agent session；OMP 的普通插件状态刷新不会卸载旧扩展模块。
- 保存配置不应自动重启 ompweb 或 OMP。
- 部署 WebUI 路由/前端代码需要重建并重启 ompweb；这属于运行时操作，必须在静态套件通过后由远端运维执行并保留回滚。

## Secret 约束

- Web `GET` 对 secret 仅返回 `{ configured, redacted: true }`。
- 空 secret 保存表示保留；只有 `clearSecrets` 或 OMP `config delete` 才清除。
- 插件工具、action 结果和普通日志不得包含 API key、Authorization、完整后端响应或 data URL。
