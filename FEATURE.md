# SSH/SFTP Remote Explorer - 右键修改连接信息

## 实现概览

在 SSH 资源管理器（`sshExplorer` 视图）的连接项上，右键菜单新增**编辑连接**和**删除连接**功能。

- **编辑连接**：以 Webview 表单 UI 展示所有字段，预填当前值，一键保存
- **删除连接**：弹窗确认后删除，自动断开连接并刷新视图
- 同时支持**手动配置**（VS Code 设置 `ssh.connections`）和 **SSH 配置文件**（`~/.ssh/config`）两种来源的连接

## 编辑连接表单 (Webview UI)

右键连接 → `SSH: 编辑连接` 打开一个 Webview 面板，包含以下字段：

| 字段 | 说明 |
|---|---|
| 连接名称 * | 预填当前值 |
| 服务器地址 * | 预填当前值 |
| 端口 | 预填当前值，默认 22 |
| 用户名 * | 预填当前值 |
| 认证方式 | 下拉选择：SSH 密钥 / 密码 / SSH Agent，自动展开对应配置项 |
| 私钥路径 | 认证为 SSH 密钥时显示 |
| 密码 | 认证为密码时显示，已设置则提示留空保持原密码 |
| 远程根路径 | 可选 |
| 传输协议 | SFTP / SCP |
| 来源标签 | 显示 "SSH 配置文件" 或 "手动配置" 徽章 |

操作按钮：**保存**（验证必填项非空后写入配置）/ **取消**（关闭面板）

### 保存行为

- **手动连接**：更新 VS Code 设置 `ssh.connections` 数组中的对应条目
- **SSH 配置文件连接**：解析 `~/.ssh/config`，定位目标 `Host` 块，更新/新增/删除相应指令（`HostName`、`Port`、`User`、`IdentityFile`、`IdentityAgent`、`RemotePath`），写回文件
- 保存后自动调用 `connectionManager.reload()` 刷新连接列表

## 删除连接

右键连接 → `SSH: 删除连接`，弹窗模态确认后：

- **手动连接**：从 `ssh.connections` 设置数组中移除
- **SSH 配置文件连接**：解析配置文件，移除对应 `Host` 块，写回文件
- 自动断开该连接（如已连接）并刷新状态栏和资源管理器

## contextValue 分级

`RemoteConnectionItem` 的 `contextValue` 附带连接来源后缀：

| 状态 | 来源 | contextValue |
|---|---|---|
| 已连接 | 手动 | `connection-connected-manual` |
| 已断开 | 手动 | `connection-disconnected-manual` |
| 已连接 | 配置文件 | `connection-connected-config` |
| 已断开 | 配置文件 | `connection-disconnected-config` |

右键菜单的 `when` 条件使用正则 `/^connection/` 匹配所有连接类型。

## 修改文件

| 文件 | 修改内容 |
|---|---|
| `package.json` | 新增 `ssh.editConnection`、`ssh.deleteConnection` 命令及其 `view/item/context` 菜单项；更新 `when` 条件为 `/^connection-connected/` 正则 |
| `package.nls.json` | 新增 `command.editConnection`、`command.deleteConnection` 中文本地化字符串 |
| `src/commands/connectionCommands.ts` | Webview 表单编辑器；编辑/删除的手动连接和 SSH 配置文件连接处理逻辑 |
| `src/providers/treeItems.ts` | `contextValue` 添加 `-manual`/`-config` 后缀 |
