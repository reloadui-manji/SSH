import * as vscode from 'vscode';

const messages: Record<string, Record<string, string>> = {
  'en': {
    'permission.title': 'Permissions: {0}',
    'permission.placeholder': 'Toggle Read/Write/Execute for each role',
    'permission.owner': 'Owner (user)',
    'permission.group': 'Group',
    'permission.other': 'Other',
    'permission.read': 'Read',
    'permission.write': 'Write',
    'permission.execute': 'Execute',
    'permission.noConnections': 'No SSH connections configured',
    'permission.failedToConnect': 'Failed to connect',
    'permission.uploadedItems': 'Uploaded {0} item(s) to {1}',
    'permission.uploadFailed': 'Upload failed: {0}',
    'permission.uploadedFiles': 'Uploaded {0} file(s)',
    'permission.uploadedFolders': 'Uploaded {0} folder(s)',
    'permission.downloadedTo': 'Downloaded to {0}',
    'permission.downloadFailed': 'Download failed: {0}',
    'permission.openFileFailed': 'Failed to open file: {0}',
    'permission.deleteConfirm': 'Are you sure you want to delete "{0}"?',
    'permission.deleteBtn': 'Delete',
    'permission.renamed': 'Renamed',
    'permission.renameFailed': 'Rename failed: {0}',
    'permission.renamePrompt': 'Enter new name',
    'permission.folderCreated': 'Created folder',
    'permission.folderFailed': 'Create folder failed: {0}',
    'permission.folderPrompt': 'Enter folder name',
    'permission.permissionSet': 'Permission set to {0}',
    'permission.permissionFailed': 'Change permission failed: {0}',
    'permission.selectConnection': 'Select a connection',
    'permission.invalidPermission': 'Invalid permission: {0}',
    'permission.syncFailed': 'Sync failed: {0}',
    'permission.noSyncConfig': 'No sync config found (.ssh-sync.json)',
    'permission.syncUpSuccess': 'Synced {0} file(s) to {1}',
    'permission.syncDownSuccess': 'Synced {0} file(s) to local',
  },
  'zh-cn': {
    'permission.title': '权限: {0}',
    'permission.placeholder': '切换每个角色的读/写/执行',
    'permission.owner': '所有者 (用户)',
    'permission.group': '用户组',
    'permission.other': '其他',
    'permission.read': '读',
    'permission.write': '写',
    'permission.execute': '执行',
    'permission.noConnections': '没有配置 SSH 连接',
    'permission.failedToConnect': '连接失败',
    'permission.uploadedItems': '已上传 {0} 个项目到 {1}',
    'permission.uploadFailed': '上传失败: {0}',
    'permission.uploadedFiles': '已上传 {0} 个文件',
    'permission.uploadedFolders': '已上传 {0} 个文件夹',
    'permission.downloadedTo': '已下载到 {0}',
    'permission.downloadFailed': '下载失败: {0}',
    'permission.openFileFailed': '打开文件失败: {0}',
    'permission.deleteConfirm': '确定要删除 "{0}" 吗？',
    'permission.deleteBtn': '删除',
    'permission.renamed': '已重命名',
    'permission.renameFailed': '重命名失败: {0}',
    'permission.renamePrompt': '输入新名称',
    'permission.folderCreated': '已创建文件夹',
    'permission.folderFailed': '创建文件夹失败: {0}',
    'permission.folderPrompt': '输入文件夹名称',
    'permission.permissionSet': '权限已设置为 {0}',
    'permission.permissionFailed': '修改权限失败: {0}',
    'permission.selectConnection': '选择连接',
    'permission.invalidPermission': '无效权限: {0}',
    'permission.syncFailed': '同步失败: {0}',
    'permission.noSyncConfig': '未配置同步 (.ssh-sync.json)',
    'permission.syncUpSuccess': '已同步 {0} 个文件到 {1}',
    'permission.syncDownSuccess': '已同步 {0} 个文件到本地',
  },
};

export function t(key: string, ...args: (string | number)[]): string {
  const locale = vscode.env.language.toLowerCase();
  const msg = messages[locale]?.[key] ?? messages['en']?.[key] ?? key;

  let result = msg;
  args.forEach((arg, i) => {
    result = result.replace(`{${i}}`, String(arg));
  });
  return result;
}
