# Codex DSH Workspace

[English](README.en.md)

一个本地插件，把 **Codex 规划、DeepSeek Harness 执行、项目归组、聊天导入导出**放在一起。

```text
Codex：任务 → 计划 → 六工具 MCP → DSH：改代码、运行测试
                       ↑               ↓
                  验收与修正 ← 摘要和执行证据

同一个项目目录 → DSH 对应工作区 → 相关任务继续同一个 DSH 会话
```

## 默认分工与明确覆盖

Codex 负责规划、架构、设计、拆解和有重点的验收；DSH 负责具体实现、调试和主要测试，把执行阶段的大部分模型工作交给 DSH。用户明确说“这件事 Codex 自己完成”时，Codex 必须直接执行，不调用 DSH。这一指令优先于默认分工。

## 能做什么

- **执行委派**：Codex 发出边界明确的任务，DSH 使用自己配置的模型执行；Codex 检查真实修改和测试结果。
- **项目归组**：按会话真实工作目录关联 DSH 项目；可导入项目名称清单，保留已有自定义分组名称。
- **聊天可移植**：按项目选择 Codex 聊天导入 DSH；可把 DSH 对话导出为新的 Codex 对话副本。
- **控制上下文**：Codex 只看到 6 个工具；优先长等待和持续会话；大结果保存本地文件，按需读取。
- **一个安装包**：不再分别安装执行桥和同步桥。MCP 镜像默认关闭，防止回调递归和重复上下文。

聊天导入导出创建或更新目标侧副本，**不提供同时写入同一聊天的实时双向合并**。侧边栏项目匹配以绝对路径为准；同名但目录不同的项目不会被视为同一个。Git worktree 也按其实际目录区分。

## 要求

- Node.js **24 或更高版本**；可使用 DSH 桌面版自带的 Node，无需升级系统 Node。
- 已安装并配置模型的 DeepSeek Harness。
- 支持本地 MCP 配置的 Codex 客户端。
- 当前适配目标：DSH **0.2.1-rc.5**。其他版本需要先验证宿主服务契约。

## 安装

```sh
git clone https://github.com/TomPrestonWernerp/codex-dsh-workspace.git
cd codex-dsh-workspace
npm ci --ignore-scripts
node bin/cli.mjs install --profile desktop
```

如果 `dsh` 不在 PATH，指定实际启动器；如果需要，指定 DSH 自带 Node：

```powershell
node bin/cli.mjs install --profile desktop `
  --dsh-command 'D:\Apps\DSH\resources\runtime\cli\bin\dsh.cmd' `
  --node 'D:\Apps\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
```

先检查拟修改的文件而不安装：

```sh
node bin/cli.mjs install --profile desktop --dry-run
```

安装会备份并保留原有 Codex 配置，在 DSH profile 中安装本地包，并注册 `dsh_delegate`。DSH 需要重启一次加载新客户端界面；Codex 需要新开聊天以加载工具。

已有旧版 `dsh_delegate` 时，安装器会拒绝覆盖未托管配置。先备份并移除旧桥自己的配置段，保留其他 MCP、模型和认证设置，再安装合并版。不要同时加载原执行桥、原同步桥和合并版。

## 在同一项目中使用

在 Codex 中打开实际项目目录，然后下发：

> 先规划，再交给 DSH 实现并运行相关测试。完成后检查真实 diff 和执行证据；相关修正继续原来的 DSH 会话。

`cwd` 必须是项目目录，不能是磁盘根目录、用户根目录或 Codex 控制目录。DSH 的工作区会使用这个目录，自动归组。不要让不同工作副本或 worktree 同时修改同一文件。

自定义项目名称可以通过清单导入：

```json
{
  "schemaVersion": 1,
  "projects": [
    { "title": "My application", "path": "/absolute/path/to/application" }
  ]
}
```

```sh
node bin/cli.mjs install --profile desktop --projects projects.json
```

清单只登记项目元数据，不复制项目文件，也不自动读取或上传聊天。

## 自动执行步骤与等待恢复（0.2.0）

Codex 应在规划后主动调用 `dsh_run_prompt`，把步骤写入 `steps`，无需用户逐步发消息。示例工具参数：

```json
{
  "cwd": "/absolute/project/path",
  "prompt": "按约定设计实现，修改范围限当前项目；每步实际验证。",
  "steps": [
    {"id":"implement","prompt":"实现已设计的功能并检查基本行为。"},
    {"id":"verify","prompt":"运行相关测试；在本项目范围修复问题并验证。"}
  ],
  "timeoutMs": 480000
}
```

插件在本地自动下发并等待各步，只有当前步给出明确通过的验收回执才进入下一步；中间结果存本地，无需每步唤醒 Codex 模型。工具连接保持时自动推进；等待预算用尽后，Codex 应主动以原 `sessionId` / `jobId` 调用 `dsh_wait_session`，无需用户触发。不提供关闭全部进程后的常驻调度服务。

`running`、断连、超时、空回复均不是允许 Codex 自行重做的依据。只有匹配本次提交游标的真实 `turn/end` 才能确定该次执行结束。任务在等待间隙完成时，结果可从 DSH 日志恢复；工具进程重启后，可用本地任务回执继续等。发送响应丢失导致是否接收不明确时，不自动重发。

同一目录有未结束任务时，重复提交会返回原任务。取消时会同时清理桥接器产生的待执行消息，保留人工排队消息；取消请求仍需随后确认任务结束。测试失败、缺少验收回执、等待人工信息或权限阻塞时暂停，不自动放宽权限或执行后续步骤。

插件可约束自己的下发与重试行为；Codex 是否调用其自身的其他工具，还受客户端指令遵循影响，并非插件对整台电脑的强制写入锁。

## 聊天导入导出

DSH 侧边栏的 Codex 同步入口提供项目和会话选择器：

- 从 Codex 导入：按项目选择聊天，导入后关联对应工作区。
- 导出到 Codex：生成新的对话副本；Codex 可能需要重启才能显示。
- 增量导入：只追加可验证的新内容；保留原始 Codex 对话。

自动导入默认关闭，避免启动时复制全部历史。Skill、指令、模型配置摘要和 MCP 镜像也默认关闭。两边使用各自的模型和认证。

**兼容性边界**：Codex 导出适配器依赖本地历史格式和索引结构，属于需要随 Codex 版本复核的功能。执行与项目归组不依赖导出操作。不要把本插件当作历史记录备份工具。

## 工具与检查

工具：`dsh_run_prompt`、`dsh_continue_session`、`dsh_wait_session`、`dsh_cancel_session`、`dsh_read_session`、`dsh_status`。

```sh
node bin/cli.mjs doctor
npm ci
npm run check
```

等待超时只结束等待，不表示 DSH 已停止。需要停止执行时使用取消工具；权限或提问阻塞必须报告，不应自动放宽权限。

## Windows 执行兼容

如果 DSH 继承了其他应用私有目录中的 `pwsh.exe`，可在安装时用 `--pwsh` 指定可用的 PowerShell 路径，例如：

```powershell
node bin/cli.mjs install --profile desktop --pwsh 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
```

这只配置 DSH 的 shell 可执行文件，不改变权限策略。若受限环境中的 Node 测试子进程报 `spawn EPERM`，Node 24 可用 `node --test --test-isolation=none <test-file>` 运行同一组测试。其他测试框架应根据自身文档配置；不能运行时报告阻塞，不自动改成完全权限。

Windows 某些目录的权限可能导致 DSH 沙箱初始化报 `SetNamedSecurityInfoW ... Win32 5`。应在用户有权限的项目目录中排查 ACL；插件不会自动修改项目 ACL。

## 卸载

```sh
node bin/cli.mjs uninstall --profile desktop
```

DSH 启动器不在 PATH 时同样传 `--dsh-command`。仅移除本插件及其标记的配置，保留聊天、项目元数据、执行证据和备份。安装备份位于 Codex 端状态目录的 `backups/`。

## 验证范围

见 [验证记录](docs/verification.md)。离线测试覆盖同步格式、执行接口、项目归组和快照完成回传；Windows 实际委派已验证文件修改、同会话追加修改、DSH 内 5 项测试及独立复验。真实聊天的桌面导出后显示仍需随 Codex 版本验证，不等同于已验证实时聊天合并。

## 数据与开源范围

- 配置、端点令牌、项目清单和结果文件存储在用户目录，**不在源码仓库中**。
- DSH 端状态：`~/.dsh/codex-dsh-workspace/`。
- Codex 端结果与备份：`~/.codex/codex-dsh-workspace/`。
- 仓库和 npm 打包清单排除聊天日志、数据库、备份与凭据。
- 本地索引或历史复制不产生模型 token；读取历史、规划、执行和审查仍消耗相应模型额度。本项目没有承诺固定节省比例。

## 来源与许可证

MIT。基于两个 MIT 项目整合并修改：

- [baitouwuya/dsh-mcp-server](https://github.com/baitouwuya/dsh-mcp-server)
- [Walvez/dsh-codex-sync](https://github.com/Walvez/dsh-codex-sync)

完整来源、修改范围及其上游归属见 [NOTICE](NOTICE) 和 [third_party/licenses](third_party/licenses)。这是独立社区项目，与 OpenAI、DeepSeek 均无官方隶属关系。
