import { contextBridge, ipcRenderer } from 'electron';

const kefu = {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  removeAccount: (id: string) => ipcRenderer.invoke('accounts:remove', id),
  login: (autoFill?: { username: string; password: string }) => ipcRenderer.invoke('accounts:login', autoFill),
  /** 应用内账号密码登录：返回 { ok:true, account } 或 { ok:false, needCaptcha:true } */
  loginByPassword: (p: { username: string; password: string; code?: string }) =>
    ipcRenderer.invoke('accounts:loginByPassword', p),
  /** 企微客服中心：账号密码登录（调对方 /api/auth/login） */
  qywxLogin: (p: { serverUrl: string; username: string; password: string }) =>
    ipcRenderer.invoke('accounts:qywxLogin', p),

  // 企微客服中心：会话 / 消息 / 发送 / 管理
  qywxConversations: (id: string) => ipcRenderer.invoke('qywx:conversations', id),
  qywxMessages: (id: string, p: { robotId: number | string; contactUserId: string; beforeId?: number | string }) =>
    ipcRenderer.invoke('qywx:messages', id, p),
  qywxReply: (
    id: string,
    p: {
      robotId: number | string;
      contactUserId: string;
      msgType: number;
      content?: string;
      imagePath?: string;
      videoPath?: string;
      traceId?: string;
    },
  ) => ipcRenderer.invoke('qywx:reply', id, p),
  qywxUpload: (id: string, p: { kind: 'image' | 'video'; name: string; type: string; base64: string }) =>
    ipcRenderer.invoke('qywx:upload', id, p),
  qywxRead: (id: string, p: { robotId: number | string; contactUserId: string }) => ipcRenderer.invoke('qywx:read', id, p),
  qywxSetUnread: (id: string, p: { robotId: number | string; contactUserId: string }) =>
    ipcRenderer.invoke('qywx:setUnread', id, p),
  qywxPin: (id: string, p: { robotId: number | string; contactUserId: string; pinned: boolean }) =>
    ipcRenderer.invoke('qywx:pin', id, p),
  qywxRemoveConversation: (id: string, p: { robotId: number | string; contactUserId: string }) =>
    ipcRenderer.invoke('qywx:removeConversation', id, p),
  qywxTranscribe: (id: string, p: { id: number | string }) => ipcRenderer.invoke('qywx:transcribe', id, p),
  qywxQuickReplies: (id: string, p: { robotId: number | string }) => ipcRenderer.invoke('qywx:quickReplies', id, p),
  qywxQuickReplyAdd: (id: string, p: { robotId: number | string; content: string }) =>
    ipcRenderer.invoke('qywx:quickReplyAdd', id, p),
  qywxQuickReplyUpdate: (id: string, p: { robotId: number | string; id: number | string; content: string }) =>
    ipcRenderer.invoke('qywx:quickReplyUpdate', id, p),
  qywxQuickReplyDelete: (id: string, p: { robotId: number | string; id: number | string }) =>
    ipcRenderer.invoke('qywx:quickReplyDelete', id, p),
  /** 企微会话实时事件：{ accountId, type, data }，type 见 main/qywx.ts */
  onQywxEvent: (cb: (p: { accountId: string; type: string; data: any }) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('qywx:event', handler);
    return () => ipcRenderer.removeListener('qywx:event', handler);
  },
  /** 权限号（只读查询）登录：返回 { ok:true, account } 或 { ok:false, needCaptcha:true } */
  loginAuth: (p: { username: string; password: string; code?: string }) => ipcRenderer.invoke('accounts:loginAuth', p),
  /** 权限号登录窗口（落地页 /myGame） */
  loginAuthWindow: (autoFill?: { username: string; password: string }) =>
    ipcRenderer.invoke('accounts:loginAuthWindow', autoFill),
  gmScript: (kind?: 'kf996' | 'gmAuth') => ipcRenderer.invoke('accounts:gmScript', kind),
  /** 只导入「设备凭证」的脚本（在已登录过的浏览器执行，用于账号密码登录免验证码） */
  deviceScript: (account: string) => ipcRenderer.invoke('accounts:deviceScript', account),
  /** 只读：从本机浏览器（Edge/Firefox/QQ/夸克）的 localStorage 直接取该账号的 deviceid */
  browserDevice: (account: string) => ipcRenderer.invoke('accounts:browserDevice', account),

  /* ---- 权限号 GM 只读查询（主进程白名单，只能查不能改） ---- */
  /** 统一查询入口：fn 见 src/main/gmQuery.ts 的白名单 */
  gmCall: (accountId: string, gameId: string, fn: string, p?: any) =>
    ipcRenderer.invoke('gm:call', accountId, gameId, fn, p),
  /** 已保存的物品/装备对照表配置 */
  gmItemTables: (accountId: string) => ipcRenderer.invoke('gm:itemTables', accountId),
  gmItemTablePickFile: () => ipcRenderer.invoke('gm:itemTablePickFile'),
  gmItemTableSheets: (file: string) => ipcRenderer.invoke('gm:itemTableSheets', file),
  gmItemTablePreview: (p: { file: string; sheet: string; skipRows: number; limit?: number }) =>
    ipcRenderer.invoke('gm:itemTablePreview', p),
  gmItemTableSave: (p: {
    accountId: string;
    kind: 'item' | 'equip';
    file: string;
    sheet: string;
    idCol: number;
    nameCol: number;
    skipRows: number;
  }) => ipcRenderer.invoke('gm:itemTableSave', p),
  gmItemTableRemove: (p: { accountId: string; kind: 'item' | 'equip' }) =>
    ipcRenderer.invoke('gm:itemTableRemove', p),
  /** 按名字或 ID 查对照表 */
  gmItemLookup: (p: { accountId: string; kind: 'item' | 'equip'; id?: string; name?: string; limit?: number }) =>
    ipcRenderer.invoke('gm:itemLookup', p),
  refreshLogin: (id: string) => ipcRenderer.invoke('accounts:refresh', id),
  onAccountsChanged: (cb: (p: any) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('accounts:changed', handler);
    return () => ipcRenderer.removeListener('accounts:changed', handler);
  },

  sessions: (id: string) => ipcRenderer.invoke('api:sessions', id),
  messages: (id: string, p: any) => ipcRenderer.invoke('api:messages', id, p),
  send: (id: string, p: any) => ipcRenderer.invoke('api:send', id, p),
  allRead: (id: string, p: any) => ipcRenderer.invoke('api:allRead', id, p),
  recall: (id: string, p: any) => ipcRenderer.invoke('api:recall', id, p),
  read: (id: string, p: any) => ipcRenderer.invoke('api:read', id, p),
  status: (id: string) => ipcRenderer.invoke('api:status', id),
  setStatus: (id: string, status: number) => ipcRenderer.invoke('api:setStatus', id, status),
  visitor: (id: string, p: any) => ipcRenderer.invoke('api:visitor', id, p),
  records: (id: string, p: any) => ipcRenderer.invoke('api:records', id, p),
  messageRecord: (id: string, p: any) => ipcRenderer.invoke('api:messageRecord', id, p),
  sendLeaveMessage: (id: string, p: any) => ipcRenderer.invoke('api:sendLeaveMessage', id, p),
  serviceRecord: (id: string, p: any) => ipcRenderer.invoke('api:serviceRecord', id, p),
  upload: (id: string, p: any) => ipcRenderer.invoke('api:upload', id, p),
  /** 把图片复制到系统剪贴板（右键菜单用） */
  copyImage: (url: string) => ipcRenderer.invoke('img:copy', url),

  openLog: () => ipcRenderer.invoke('log:open'),
  logPath: () => ipcRenderer.invoke('log:path'),
  /** 当前程序版本 */
  appVersion: () => ipcRenderer.invoke('app:version'),

  // 设置
  settings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: any) => ipcRenderer.invoke('settings:save', patch),
  pickDir: (defaultPath?: string) => ipcRenderer.invoke('settings:pickDir', defaultPath),
  /** 保存某客服号的自定义头像 / 昵称 */
  setProfile: (accountId: string, patch: { name?: string; avatar?: string }) =>
    ipcRenderer.invoke('settings:setProfile', { accountId, patch }),
  /** 选择头像图片（主进程读成 data URL 返回，取消返回空串） */
  pickAvatar: () => ipcRenderer.invoke('settings:pickAvatar'),

  // AI 客服
  aiModels: (cfg?: any) => ipcRenderer.invoke('ai:models', cfg),
  aiTest: (cfg: any, model?: string) => ipcRenderer.invoke('ai:test', { cfg, model }),
  aiReply: (p: { accountId: string; messages: { role: string; content: string }[]; visitorName?: string }) =>
    ipcRenderer.invoke('ai:reply', p),

  // 每日自动学习
  learnNow: () => ipcRenderer.invoke('learn:run'),
  onLearnDone: (cb: (p: any) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('learn:done', handler);
    return () => ipcRenderer.removeListener('learn:done', handler);
  },

  notifyNewSession: (p: {
    accountId: string;
    sessionId: string;
    messageSessionId?: string;
    visitorName?: string;
    content?: string;
    title?: string;
  }) => ipcRenderer.invoke('win:notify', p),
  /** 关闭「新消息」提醒弹窗 */
  closeNotify: () => ipcRenderer.invoke('win:closeNotify'),
  /** 主进程复用提醒弹窗时，推新的会话过来（不重新加载页面） */
  onNotifySwitch: (cb: (p: { accountId: string; sessionId: string; messageSessionId?: string }) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('notify:switch', handler);
    return () => ipcRenderer.removeListener('notify:switch', handler);
  },
  wsStatus: (id: string) => ipcRenderer.invoke('ws:status', id),
  wsReconnect: (id: string) => ipcRenderer.invoke('ws:reconnect', id),

  // 局域网客服管理
  lanStatus: () => ipcRenderer.invoke('lan:status'),
  lanSave: (patch: any) => ipcRenderer.invoke('lan:save', patch),
  lanAddPeer: (p: { addr: string; name?: string }) => ipcRenderer.invoke('lan:addPeer', p),
  lanRemovePeer: (addr: string) => ipcRenderer.invoke('lan:removePeer', addr),
  /** 从对方拉取快捷回复/关键词并合并到本机 */
  lanSyncFrom: (addr: string, kinds: string[]) => ipcRenderer.invoke('lan:syncFrom', { addr, kinds }),
  /** 把本机的快捷回复/关键词推给对方 */
  lanSyncTo: (addr: string, kinds: string[]) => ipcRenderer.invoke('lan:syncTo', { addr, kinds }),
  lanRemoteSessions: (addr: string, accountId: string) => ipcRenderer.invoke('lan:remoteSessions', { addr, accountId }),
  lanCopyAccount: (addr: string, accountId: string) => ipcRenderer.invoke('lan:copyAccount', { addr, accountId }),
  /** 把对方的客服号映射到本机（不复制凭据，操作走转发） */
  lanMapAccount: (addr: string, accountId: string) => ipcRenderer.invoke('lan:mapAccount', { addr, accountId }),
  /** 取消映射 */
  lanUnmapAccount: (addr: string, accountId: string) => ipcRenderer.invoke('lan:unmapAccount', { addr, accountId }),
  lanShareSession: (addr: string, accountId: string, session: any) =>
    ipcRenderer.invoke('lan:shareSession', { addr, accountId, session }),
  lanAddRemote: (p: { addr: string; accountId: string; accountName?: string; uid?: string; session: any }) =>
    ipcRenderer.invoke('lan:addRemote', p),
  lanRemoveRemote: (peerId: string, sessionId: string) => ipcRenderer.invoke('lan:removeRemote', { peerId, sessionId }),
  lanHistory: (p: { uid: string; messageSessionId: string; pageNum?: number; pageSize?: number }) =>
    ipcRenderer.invoke('lan:history', p),
  lanReply: (p: Record<string, unknown>) => ipcRenderer.invoke('lan:reply', p),
  onLanStatus: (cb: (p: any) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('lan:status', handler);
    return () => ipcRenderer.removeListener('lan:status', handler);
  },
  onLanEvent: (cb: (p: any) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('lan:event', handler);
    return () => ipcRenderer.removeListener('lan:event', handler);
  },
  /** 设置被外部改动（例如局域网同步数据）时刷新 */
  onSettingsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },

  /** token 巡检结果（每 5s 推一次）：ok=false 表示该客服号已掉线 */
  onAuthState: (cb: (p: { accountId: string; ok: boolean }) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('auth:state', handler);
    return () => ipcRenderer.removeListener('auth:state', handler);
  },
  onWsEvent: (cb: (payload: any) => void) => {
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on('ws:event', handler);
    return () => ipcRenderer.removeListener('ws:event', handler);
  },
};

contextBridge.exposeInMainWorld('kefu', kefu);

export type KefuApi = typeof kefu;
