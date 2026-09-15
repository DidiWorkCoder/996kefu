/// <reference types="vite/client" />

interface Window {
  kefu: {
    listAccounts: () => Promise<any[]>;
    removeAccount: (id: string) => Promise<any[]>;
    login: (autoFill?: { username: string; password: string }) => Promise<any>;
    /** 应用内账号密码登录：要么直接成功，要么提示需要验证码 */
    loginByPassword: (p: {
      username: string;
      password: string;
      code?: string;
    }) => Promise<{ ok: true; account: any } | { ok: false; needCaptcha: true }>;
    /** 企微客服中心：账号密码登录（中心地址 + 用户名 + 密码） */
    qywxLogin: (p: {
      serverUrl: string;
      username: string;
      password: string;
    }) => Promise<import('./types').Account>;

    // 企微客服中心：会话 / 消息 / 发送 / 管理
    qywxConversations: (id: string) => Promise<import('./types').QywxConversationRaw[]>;
    qywxMessages: (id: string, p: {
      robotId: number | string;
      contactUserId: string;
      beforeId?: number | string;
    }) => Promise<import('./types').QywxMessage[]>;
    qywxReply: (id: string, p: {
      robotId: number | string;
      contactUserId: string;
      msgType: number;
      content?: string;
      imagePath?: string;
      videoPath?: string;
      traceId?: string;
    }) => Promise<import('./types').QywxMessage | null>;
    qywxUpload: (id: string, p: {
      kind: 'image' | 'video';
      name: string;
      type: string;
      base64: string;
    }) => Promise<{ url: string; filename: string }>;
    qywxRead: (id: string, p: { robotId: number | string; contactUserId: string }) => Promise<any>;
    qywxSetUnread: (id: string, p: { robotId: number | string; contactUserId: string }) => Promise<any>;
    qywxPin: (id: string, p: { robotId: number | string; contactUserId: string; pinned: boolean }) => Promise<any>;
    qywxRemoveConversation: (id: string, p: { robotId: number | string; contactUserId: string }) => Promise<any>;
    qywxTranscribe: (id: string, p: { id: number | string }) => Promise<{ text?: string }>;
    qywxQuickReplies: (id: string, p: { robotId: number | string }) => Promise<import('./types').QywxQuickReply[]>;
    qywxQuickReplyAdd: (id: string, p: { robotId: number | string; content: string }) => Promise<any>;
    qywxQuickReplyUpdate: (id: string, p: {
      robotId: number | string;
      id: number | string;
      content: string;
    }) => Promise<any>;
    qywxQuickReplyDelete: (id: string, p: { robotId: number | string; id: number | string }) => Promise<any>;
    /** 企微会话实时事件 */
    onQywxEvent: (cb: (p: { accountId: string; type: string; data: any }) => void) => () => void;
    /** 权限号（只读查询）登录：要么直接成功，要么提示需要验证码 */
    loginAuth: (p: {
      username: string;
      password: string;
      code?: string;
    }) => Promise<{ ok: true; account: import('./types').Account } | { ok: false; needCaptcha: true }>;
    /** 权限号登录窗口（落地页 /myGame） */
    loginAuthWindow: (autoFill?: { username: string; password: string }) => Promise<import('./types').Account | null>;
    gmScript: (kind?: 'kf996' | 'gmAuth') => Promise<string>;
    /** 只导入「设备凭证」的脚本 */
    deviceScript: (account: string) => Promise<string>;
    /** 只读：从本机浏览器（Edge/Firefox/QQ/夸克）的 localStorage 直接取该账号的 deviceid */
    browserDevice: (account: string) => Promise<
      | { ok: true; account: string; deviceId: string; browser: string; path: string; storage: Record<string, string> }
      | { ok: false; reason: string }
    >;

    /* ---- 权限号 GM 只读查询（主进程白名单，只能查不能改） ---- */
    gmCall: (accountId: string, gameId: string, fn: string, p?: any) => Promise<any>;
    gmItemTables: (accountId: string) => Promise<import('./types').GmItemTables>;
    gmItemTablePickFile: () => Promise<string>;
    gmItemTableSheets: (file: string) => Promise<string[]>;
    gmItemTablePreview: (p: { file: string; sheet: string; skipRows: number; limit?: number }) => Promise<string[][]>;
    gmItemTableSave: (p: {
      accountId: string;
      kind: 'item' | 'equip';
      file: string;
      sheet: string;
      idCol: number;
      nameCol: number;
      skipRows: number;
    }) => Promise<{ count: number }>;
    gmItemTableRemove: (p: { accountId: string; kind: 'item' | 'equip' }) => Promise<import('./types').GmItemTables>;
    gmItemLookup: (p: {
      accountId: string;
      kind: 'item' | 'equip';
      id?: string;
      name?: string;
      limit?: number;
      /** ID 完全相等才返回（结果表反查用；下拉搜索不要传） */
      exact?: boolean;
    }) => Promise<{ id: string; name: string }[]>;

    refreshLogin: (id: string) => Promise<any>;
    onAccountsChanged: (cb: (p: any) => void) => () => void;
    sessions: (id: string) => Promise<any>;
    messages: (id: string, p: any) => Promise<any>;
    send: (id: string, p: any) => Promise<any>;
    allRead: (id: string, p: any) => Promise<any>;
    recall: (id: string, p: any) => Promise<any>;
    read: (id: string, p: any) => Promise<any>;
    status: (id: string) => Promise<any>;
    setStatus: (id: string, status: number) => Promise<any>;
    visitor: (id: string, p: any) => Promise<any>;
    records: (id: string, p: any) => Promise<any>;
    messageRecord: (id: string, p: any) => Promise<any>;
    sendLeaveMessage: (id: string, p: { id: string | number; content: string; handlerName: string; type?: number }) => Promise<boolean>;
    serviceRecord: (id: string, p: any) => Promise<any>;
    upload: (id: string, p: { name: string; type: string; base64: string }) => Promise<string>;
    copyImage: (url: string) => Promise<boolean>;
    openLog: () => Promise<string>;
    logPath: () => Promise<string>;
    /** 当前程序版本 */
    appVersion: () => Promise<string>;
    settings: () => Promise<any>;
    saveSettings: (patch: any) => Promise<any>;
    pickDir: (defaultPath?: string) => Promise<string>;
    /** 保存某客服号的自定义头像 / 昵称 */
    setProfile: (
      accountId: string,
      patch: import('./types').AccountProfile,
    ) => Promise<import('./types').Settings>;
    /** 选择头像图片（取消返回空串） */
    pickAvatar: () => Promise<string>;
    aiModels: (cfg?: any) => Promise<string[]>;
    aiTest: (cfg: any, model?: string) => Promise<{ ok: boolean; message: string }>;
    aiReply: (p: {
      accountId: string;
      messages: { role: string; content: string }[];
      visitorName?: string;
    }) => Promise<{ content: string; hasKnowledge: boolean }>;
    learnNow: () => Promise<
      { accountId: string; account: string; sessions: number; ok: boolean; message: string }[]
    >;
    onLearnDone: (
      cb: (p: {
        trigger: 'auto' | 'manual';
        results: { accountId: string; account: string; sessions: number; ok: boolean; message: string }[];
      }) => void,
    ) => () => void;
    notifyNewSession: (p: {
      accountId: string;
      sessionId: string;
      messageSessionId?: string;
      visitorName?: string;
      content?: string;
      title?: string;
    }) => Promise<boolean>;
    /** 关闭「新消息」提醒弹窗 */
    closeNotify: () => Promise<boolean>;
    /** 主进程复用提醒弹窗时推来的新会话（不重新加载页面） */
    onNotifySwitch: (
      cb: (p: { accountId: string; sessionId: string; messageSessionId?: string }) => void,
    ) => () => void;
    wsStatus: (id: string) => Promise<boolean>;
    wsReconnect: (id: string) => Promise<boolean>;
    onAuthState: (cb: (p: { accountId: string; ok: boolean }) => void) => () => void;
    onWsEvent: (cb: (payload: any) => void) => () => void;

    // 局域网客服管理
    lanStatus: () => Promise<import('./types').LanStatus>;
    lanSave: (patch: Partial<import('./types').LanConfig>) => Promise<import('./types').LanStatus>;
    lanAddPeer: (p: { addr: string; name?: string }) => Promise<import('./types').LanStatus>;
    lanRemovePeer: (addr: string) => Promise<import('./types').LanStatus>;
    lanSyncFrom: (
      addr: string,
      kinds: string[],
    ) => Promise<{ settings: import('./types').Settings; quickReplyAccounts: number; keywords: number }>;
    lanSyncTo: (addr: string, kinds: string[]) => Promise<boolean>;
    lanRemoteSessions: (addr: string, accountId: string) => Promise<{
      onlineSessionList: import('./types').Session[];
      endSessionList: import('./types').Session[];
      queueSessionList: import('./types').Session[];
    }>;
    lanCopyAccount: (
      addr: string,
      accountId: string,
    ) => Promise<{ account: import('./types').Account; pendingCount: number }>;
    /** 把对方的客服号映射到本机（不复制凭据，操作走转发） */
    lanMapAccount: (addr: string, accountId: string) => Promise<import('./types').LanAccount[]>;
    /** 取消映射 */
    lanUnmapAccount: (addr: string, accountId: string) => Promise<import('./types').Settings>;
    lanShareSession: (addr: string, accountId: string, session: import('./types').Session) => Promise<boolean>;
    lanAddRemote: (p: {
      addr: string;
      accountId: string;
      accountName?: string;
      uid?: string;
      session: import('./types').Session;
    }) => Promise<import('./types').LanSession[]>;
    lanRemoveRemote: (peerId: string, sessionId: string) => Promise<import('./types').LanSession[]>;
    lanHistory: (p: {
      uid: string;
      messageSessionId: string;
      pageNum?: number;
      pageSize?: number;
    }) => Promise<{ records: import('./types').ChatMessage[] }>;
    lanReply: (p: Record<string, unknown>) => Promise<boolean>;
    onLanStatus: (cb: (p: import('./types').LanStatus) => void) => () => void;
    onLanEvent: (cb: (p: { type: string; data?: any }) => void) => () => void;
    onSettingsChanged: (cb: () => void) => () => void;
  };
}
