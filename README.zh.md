# dsh-cua-driver

[English](README.md) | 中文

独立维护的 [DeepSeek Harness](https://github.com/stevessr/deepseek-harness) 插件，用于管理本机 [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) 并提供 computer use 能力。

- 探测 PATH、官方用户安装目录或显式指定的可执行文件。
- 可选自动安装、启动前更新，默认均关闭。
- 复用 Harness MCP 客户端的发现、重连、结果处理和截图附件能力。
- 在原生 MCP tools 与**仅 CUA 的 TypeScript functions** 间实时切换；模型通过 `run_code` 调用函数，不影响其他工具，也不重启驱动。
- 等待启动任务及 MCP 子进程清理完毕后，才释放独占的 computer-use 注册。

## 兼容性与安装

基线为 **Harness `0.2.0-rc.2`**、Cordis `4.0.4`，Node `^22.19.0 || >=24`。

原版 Harness 支持 `tools` 模式，但缺少“只将某个 MCP 服务器设为程序调用”的能力。因此 `typescript` 模式需要本仓库提供的[独立兼容补丁](integration/README.md)，以及 `dsh-ptc-runtime-node`。缺少支持会明确报错，不会静默暴露原生工具。

**补丁必须应用到 Host 实际使用的 `dsh-tools` 和 `dsh-mcp-client`，不能只修改插件目录下的另一份依赖。** 插件不通过 monkey patch 修改 Host，也不更改全局 PTC 配置。本仓库不会推送 Harness 分支。

暂未发布 npm 包。构建本地安装包：

```sh
pnpm install
pnpm build
pnpm pack
```

把生成的 `stevessr-dsh-cua-driver-0.1.0.tgz` 安装到负责解析 Harness profile 的包目录。不要同时加载其他 computer-use provider。

## 配置

以下条目用于已经提供 `dsh-tools`、`dsh-system-prompt` 的 profile。截图还需要附件存储和支持图片输入的模型。应用通过具名 `dsh` profile 启动。

```yaml
- name: '@deepseek-ai/dsh-computer-use'
- id: cua-driver
  name: '@stevessr/dsh-cua-driver'
  config:
    mode: tools
    command: cua-driver
    autoInstall: false
    autoUpdate: false
```

`mode` 是实时 Cordis 设置，可由通用 Settings 页面编辑。其余字段是部署配置：在 profile 或插件管理器中修改后重新加载条目。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `mode` | `tools` | `tools` 或 `typescript`，切换不重连 |
| `command` | `cua-driver` | PATH 命令名或**绝对路径**；显式路径不存在时不回退 |
| `binDir` | 官方用户 bin 目录 | 额外探测位置、安装目标，必须为绝对路径 |
| `args` | 驱动 manifest | MCP 参数，如 `[mcp, --direct]`；显式 `[]` 与省略不同 |
| `autoInstall` | `false` | 未找到指定程序时执行官方安装器 |
| `autoUpdate` | `false` | 每次激活前设置通道并运行 `update --apply --json` |
| `updateChannel` | `stable` | `stable` 或 `nightly`；切回 stable 也会显式执行 |
| `setupTimeoutMs` | `300000` | 探测、安装、更新、manifest 读取的总超时 |
| `toolCallTimeoutMs` | `60000` | MCP 请求超时 |
| `maxInstallerBytes` | `1048576` | 安装脚本下载字节上限 |
| `maxOutputBytes` | `131072` | 每个命令输出流保留的字节上限 |
| `terminationGraceMs` | `1000` | 本地启动任务终止宽限时间 |
| `reconnect` | Harness MCP 默认值 | `enabled`、`initialDelayMs`、`maxDelayMs`、`maxAttempts` |

依次探测 PATH、配置或默认 wrapper 目录、`~/.cua-driver/packages/current`。Windows 默认目录为 `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`；POSIX 为 `~/.local/bin`。自动安装不支持任意自定义命令名；显式绝对安装路径必须以 `cua-driver` 结尾，Windows 为 `cua-driver.exe`。

省略 `args` 时需要有效的 `manifest --json`：`mcp_invocation.command` 必须为绝对路径，`args` 必须是字符串数组。旧版本或损坏的 manifest 会报错；旧驱动可显式配置参数。安装或更新失败不会静默选择另一份程序。

## TypeScript-only 模式

安装兼容补丁和 TypeScript PTC 运行时后，设置 `mode: typescript`。模型只获得 `run_code` 和生成的 SDK 声明，不获得原生 `mcp__cua-driver__*` schema；执行器也拒绝直接调用这些工具。其他原生工具保持原样，除非 profile 另行启用了全局 PTC。

假设驱动提供 `check_permissions`，模型可向 `run_code` 传入：

```typescript
const result = await tools["mcp__cua-driver__check_permissions"]({ prompt: false });
return result.structuredContent;
```

工具名和参数来自实际安装的驱动。成功调用产生的截图会在程序结束后附加到上下文。只返回需要的数据：完整返回 MCP 结果可能将内联图片字节打印到会话。共享的 MCP 资源发现/读取工具仍由 Harness 资源插件管理。

## 安全与生命周期

安装和更新**默认关闭**：启用后会执行上游代码，可能改变用户已有的驱动安装或 daemon。插件仅从官方 `install.sh` / `install.ps1` 地址下载脚本，限制大小，写入私有临时目录，执行后删除。启动命令始终在本机运行，并清理凭据类环境变量；不会因 Host 使用远程 subprocess provider 而在远程机器安装。

POSIX 安装器接收 `--no-modify-path`；Windows 接收 `-NoPathUpdate -NoAutoStart`。上游脚本可能进一步下载发布文件并执行完整性校验；插件不替代这些校验，不授予桌面权限，不绕过审批，不安装 perception 扩展。启用前请审阅上游安装器。

插件只拥有 MCP 子进程，**不拥有已运行的 Cua daemon 或安装文件**。卸载插件不是卸载软件：它取消并等待启动工作，关闭 MCP、撤销工具，最后释放 `computerUse`。重连期间仍保留注册。不同 Session 或不同 Harness 进程共享桌面，需要外部协调。

## 开发验证

```sh
pnpm typecheck
pnpm test
DSH_HARNESS_ROOT=/path/to/patched/harness pnpm test:integration
```

[集成环境说明](integration/README.md)列出了准备步骤。集成测试通过真正的 Loader 加载 `cordis.yml`，启动 MCP fixture 子进程，运行真实 Agent 与 Node PTC，验证截图持久化、实时模式切换以及进程退出。Fixture 不操作真实桌面，也不真实安装或更新软件。

只读的已安装驱动测试：

```sh
DSH_HARNESS_ROOT=/path/to/patched/harness \
DSH_COMPUTER_USE_MCP_EXECUTABLE=/absolute/path/to/cua-driver \
DSH_COMPUTER_USE_MCP_ARGS='["mcp","--direct"]' \
pnpm test:live
```

它只检查发现与 `check_permissions({ prompt: false })`，不证明所有桌面动作都可用。真实安装/更新及 macOS、Windows 运行时仍需各平台验证。独立测试套件暂不包含完整 shipped-profile recorded-session 重放。

原生模式增加工具 schema 和普通结果上下文；TypeScript 模式使用 SDK 声明、筛选后的程序输出和持久截图。模式切换或驱动升级可能使提示前缀缓存失效。程序中间值只有被返回或打印时才进入模型上下文。

## 许可证

MIT，见 [LICENSE](LICENSE)。Cua Driver 及单独安装的扩展仍遵循各自许可证。
