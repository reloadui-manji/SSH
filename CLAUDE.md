# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension for SSH/SFTP remote file browsing, editing, sync, and terminal integration. Packaged as `.vsix`.

## Key Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Production build (webpack) |
| `npm run build:dev` | Development build |
| `npm run watch` | Incremental dev build |
| `npm run package` | Package as `.vsix` |
| `npm run test` | Run tests via vscode-test |
| `npm run test:unit` | Run unit tests only (mocha) |
| `npm run lint` | ESLint check |

Build output: `dist/extension.js` (entry point per `package.json` `main`).

## Architecture

### Dual-Backend Design

The extension supports two SSH backends, selected automatically via [selectConnectionBackend](src/core/backendSelector.ts):

- **ssh2** (default) — Pure Node.js SSH/SFTP via `ssh2` + `ssh2-sftp-client`
- **openssh** — Spawns system `ssh`/`scp` commands; used for SSH certificate-based auth

Backend is chosen per-profile based on `profile.backend` setting or auto-detected via certificate presence.

### Core Layers

```
src/extension.ts              — Activation, wiring, lifecycle
src/core/
  protocol.ts                 — Types: ConnectionProfile, AuthConfig, ConnectionStatus, ConnectionBackend
  remoteConnection.ts         — RemoteConnection interface (unified API for both backends)
  connection.ts               — ssh2 backend (SshConnection)
  openSshConnection.ts        — openssh backend (spawns ssh/scp)
  openSshArgs.ts              — SSH CLI argument builder for openssh backend
  openSshPty.ts               — PTY allocation for openssh backend
  connectionManager.ts        — Profile loading from settings, connect/disconnect lifecycle
  backendSelector.ts          — Auto-detect backend (certificate detection)
  passphraseStore.ts          — Encrypted key passphrase persistence (globalState)
src/providers/
  remoteExplorer.ts           — TreeDataProvider for sidebar view
  remoteFileSystem.ts         — FileSystemProvider for ssh:// URIs
  treeItems.ts                — TreeView item types
src/commands/
  connectionCommands.ts       — connect/disconnect/addConnection
  fileCommands.ts             — upload/download/delete/rename/chmod
  syncCommands.ts             — syncUp/syncDown/syncDiff
src/sync/
  syncEngine.ts               — Sync engine + auto-upload on save
  syncConfig.ts               — .ssh-sync.json workspace config parser
  fileWatcher.ts              — chokidar-based file watcher
src/terminal/
  sshTerminal.ts              — SSH terminal integration
src/statusbar/
  statusBarManager.ts         — VS Code status bar updates
src/utils/
  logger.ts, path.ts, uri.ts, i18n.ts
```

### Connection Data Source

All connection profiles come from VS Code settings (`ssh.connections` array in `settings.json`). No `~/.ssh/config` parsing.

Profiles are loaded in [ConnectionManager.loadFromSettings](src/core/connectionManager.ts#L94) and watched for changes via `onDidChangeConfiguration`.

### Key Interfaces

- **`ConnectionProfile`** ([protocol.ts](src/core/protocol.ts)): id, name, host, port, username, protocol, auth, backend, remotePath
- **`RemoteConnection`** ([remoteConnection.ts](src/core/remoteConnection.ts)): Unified interface for file operations, stat, read/write, upload/download, rename, delete
- **`AuthConfig`**: type (`password`|`privateKey`|`agent`|`keyboard-interactive`), with variant fields

### Activation

Extension activates on: view `sshExplorer`, file system `ssh`, commands `ssh.*`, or `workspaceContains:**/.ssh-sync.json`.

### 规范

所有的功能修改都要先确认是否在文档中，如果是新增需求需要先确认后在添加
详细设计中每个功能都需要和代码关联上。修改代码时不能修改了与功能无关的代码。