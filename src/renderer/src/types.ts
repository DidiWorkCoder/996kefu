export interface Account {
  id: string;
  /** 账号类型：kf996=996 客服（默认，老数据没有这个字段） qywx=企微客服 gmAuth=996 权限号 */
  kind?: 'kf996' | 'qywx' | 'gmAuth';
  name: string;
  account: string;
  uid: string;
  companyId: string;
  tokenExp: number;
  createdAt: number;
  /** GM 站点凭据是否已导入（用于「续期」） */
  juheToken?: string;
  gmUserId?: string;
  /** 企微客服中心地址（kind=qywx 时用） */
  serverUrl?: string;
  /** 企微客服登录 token（kind=qywx 时用） */
  qywxToken?: string;
  /** 企微客服登录返回的用户信息 */
  qywxUser?: Record<string, any>;
}

export interface Session {
  id: string;
  messageSessionId: string;
  visitorId: string;
  visitorName: string;
  headImg?: string;
  lastMessageContent?: string;
  messageTime?: string;
  unReadCount?: number;
  state?: number;
  messageSessionRecordId?: string;
  customerServiceName?: string;
  messageSessionRecord?: any;
}

export interface ChatMessage {
  id: string;
  messageFromId?: string;
  messageFromName?: string;
  messageToId?: string;
  messageToName?: string;
  content: string;
  messageTime: string;
  messageSessionId: string;
  messageSessionRecordId?: string;
  type?: number;
  isVisible?: number;
  messageSendSource?: number;
  msgSuccess?: number;
  /** 2=已读（配合 messageReadTime），1=未读 */
  status?: number;
  messageReadTime?: string | null;
  /** 1=该消息已被撤回 */
  recallMsg?: number | null;
  recallMsgDesc?: string;
}

export interface SessionBuckets {
  online: Session[];
  end: Session[];
  queue: Session[];
}

/* ---------------- 企微客服中心 ---------------- */

/** 企微消息里的媒体信息 */
export interface QywxMedia {
  url?: string;
  path?: string;
  local_url?: string;
  filename?: string;
  /** 语音转写结果（转写后写回） */
  voice_text?: string;
  [k: string]: any;
}

/** 企微一条消息 */
export interface QywxMessage {
  id: number | string;
  /** in=对方发来 out=自己发出 */
  direction?: 'in' | 'out';
  msg_type?: number;
  content?: string;
  media?: QywxMedia | null;
  source?: string;
  read_at?: string | null;
  read_by?: any;
  send_error?: string;
  created_at?: string;
  robot_id?: number | string;
  contact_user_id?: string;
}

/** 会话列表接口（GET /api/conversations）返回的原始会话 */
export interface QywxConversationRaw {
  robot_id: number | string;
  contact_user_id: string;
  contact_nick?: string;
  robot_name?: string;
  online?: boolean;
  pinned?: boolean;
  unread_count?: number;
  manual_unread?: boolean;
  avatar?: number | string;
  /** 最后一条消息摘要（会话列表接口直接返回，不含完整 message 列表） */
  last_content?: string;
  last_msg_type?: number;
  last_direction?: 'in' | 'out';
  last_at?: string;
  messages?: QywxMessage[];
}

/** 本地维护的企微会话（key = robot_id:contact_user_id） */
export interface QywxConversation {
  key: string;
  robot_id: number | string;
  contact_user_id: string;
  contact_nick: string;
  robot_name: string;
  online: boolean;
  pinned: boolean;
  manual_unread: boolean;
  avatar: number | string;
  /** 服务端给的未读数（本地有消息时以本地未读为准） */
  fallback_unread: number;
  /** 会话列表接口给的最后一条摘要，历史未拉取时用于列表展示 */
  last_content?: string;
  last_msg_type?: number;
  last_direction?: 'in' | 'out';
  last_at?: string;
  messages: QywxMessage[];
}

/** 企微快捷回复 */
export interface QywxQuickReply {
  id: number | string;
  content: string;
}

export interface RecordItem {
  id: string;
  messageSessionId: string;
  visitorId: string;
  visitorName: string;
  customerServiceName?: string;
  customerServiceGroupName?: string;
  sessionStartTime: number;
  sessionEndTime: number;
  visitorEnterTime: number;
  channel?: number;
  isReply?: number;
  /** 留言状态：1=未处理 2=已处理 */
  resolutionStatus?: number;
  /** 回复人 / 回复时间（秒）/ 回复内容 */
  handlerName?: string;
  handlerTime?: number;
  replyContent?: string;
  customerServiceMsgNum?: number;
  visitorMsgNum?: number;
}

/** AI 请求协议 */
export type AiMethod = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface AiConfig {
  /** 接口根地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  method: AiMethod;
  /** 系统提示词（默认提示词，可在设置里修改） */
  prompt: string;
}

export type ThemeMode = 'light' | 'dark' | 'system';

/** 每日自动学习：到点总结当天客服处理写入知识库 */
export interface LearnConfig {
  enabled: boolean;
  /** 每天执行时间 HH:mm */
  time: string;
}

/** 新消息提醒方式 */
export type NotifyMode = 'system' | 'popup' | 'both';

/** 来信息提醒配置 */
export interface NotifyConfig {
  enabled: boolean;
  /** system=系统通知 popup=屏幕居中置顶弹窗 both=两者都要 */
  mode: NotifyMode;
  /** 弹窗多少秒后自动关闭（0 = 不自动关） */
  autoCloseSec: number;
}

/** 某个客服号一次学习的结果 */
export interface LearnResult {
  accountId: string;
  account: string;
  sessions: number;
  ok: boolean;
  message: string;
}

export interface Settings {
  /** 掉线后自动续期 */
  autoRefresh: boolean;
  /** 掉线后自动重新登录（企微客服 / 权限号） */
  autoRelogin: AutoRelogin;
  theme: ThemeMode;
  ai: AiConfig;
  /** accountId -> 知识库文件夹路径 */
  knowledge: Record<string, string>;
  learn: LearnConfig;
  /** accountId -> 该客服号的快捷回复（不同客服号互不影响） */
  quickReplies: Record<string, QuickReply[]>;
  /** accountId -> 该客服号标记为「待处理」的会话 */
  pending: Record<string, PendingSession[]>;
  /** 关键词自动推荐回复（全局共用，不分客服号） */
  keywords: KeywordRule[];
  /** 是否开启关键词自动推荐 */
  keywordsEnabled: boolean;
  /** 来信息提醒（开关 + 提醒方式） */
  notify: NotifyConfig;
  /** 局域网互通配置 */
  lan: LanConfig;
  /** 本机持有的远程会话（拉取来的 / 别人推来的） */
  lanSessions: LanSession[];
  /** 从局域网上「映射」过来的远端客服（不持有凭据，操作转发） */
  lanAccounts: LanAccount[];
  /** 账号 -> GM 站点的设备凭证（带它登录可免验证码） */
  deviceIds: Record<string, string>;
  /** accountId -> 该客服号自定义的头像与昵称 */
  profiles: Record<string, AccountProfile>;
  /** 账号分组：把指定的客服账号归到一组 */
  groups: AccountGroup[];
  /** 收起（折叠）起来的分组 id */
  collapsedGroups: string[];
  /** accountId -> 该权限号保存的物品表 / 装备表 */
  itemTables: Record<string, GmItemTables>;
}

/** 一张「ID ↔ 名称」对照表的解析参数 */
export interface GmItemTable {
  /** 源文件绝对路径 */
  file: string;
  /** 工作表名 */
  sheet: string;
  /** ID 所在列（0 基） */
  idCol: number;
  /** 名称所在列（0 基） */
  nameCol: number;
  /** 舍弃前几行 */
  skipRows: number;
  /** 解析出的行数 */
  count: number;
  parsedAt: number;
}

/** 一个权限号保存的两张表 */
export interface GmItemTables {
  item?: GmItemTable;
  equip?: GmItemTable;
}

/** 掉线后自动重新登录：企微客服 / 权限号各自独立开关 */
export interface AutoRelogin {
  /** 企微客服 token 失效时，用登录时记住的账号密码自动重登 */
  qywx: boolean;
  /** 权限号 token 失效时，用它登录时记住的账号密码自动重登 */
  gmAuth: boolean;
}

/** 客服号的展示资料：可自定义头像与昵称，覆盖登录信息里的默认值 */
export interface AccountProfile {
  /** 自定义昵称（留空则用登录返回的名字） */
  name?: string;
  /** 头像（data URL） */
  avatar?: string;
}

/** 账号分组 */
export interface AccountGroup {
  id: string;
  name: string;
  /** 归在该组下的账号 id（Account.id）；没归组的账号在列表里单独展示 */
  accountIds: string[];
  /** 该分组对应的游戏 ID（一个分组 = 一个游戏） */
  gameId?: string;
  /** 该分组对应的游戏名（展示用） */
  gameName?: string;
}

/** 局域网：手动补充的对方机器 */
export interface LanPeer {
  id: string;
  addr: string;
  name?: string;
}

/** 局域网互通配置 */
export interface LanConfig {
  enabled: boolean;
  name: string;
  port: number;
  token: string;
  autoDiscover: boolean;
  manual: LanPeer[];
}

/** 一台局域网设备上的客服号 */
export interface LanAccountBrief {
  id: string;
  name: string;
  account: string;
  uid: string;
  companyId: string;
}

/** 局域网里的一台设备 */
export interface LanPeerInfo {
  addr: string;
  id: string;
  name: string;
  source: 'manual' | 'auto';
  online: boolean;
  lastSeen: number;
  accounts: LanAccountBrief[];
}

export interface LanStatus {
  enabled: boolean;
  name: string;
  port: number;
  token: string;
  autoDiscover: boolean;
  manual: LanPeer[];
  instanceId: string;
  selfAccounts: LanAccountBrief[];
  peers: LanPeerInfo[];
}

/** 「映射」到本机的远端客服：不持有凭据，看会话/发消息都转发给对方机器 */
export interface LanAccount {
  /** 对端地址 ip:port */
  addr: string;
  peerName: string;
  /** 对端机器上的客服号 id */
  accountId: string;
  name: string;
  account: string;
  uid: string;
  addedAt: number;
}

/** 一条远程会话：从别人的机器拉过来的，或别人推给本机的 */
export interface LanSession {
  peerId: string;
  peerName: string;
  accountId: string;
  accountName: string;
  uid: string;
  session: Session;
  from: 'pull' | 'push';
  addedAt: number;
}

/** 关键词自动推荐回复 */
export interface KeywordRule {
  id: string;
  /** 关键词（可配置多个，命中任意一个即推荐；英文不区分大小写） */
  keywords: string[];
  /** 命中的推荐回复内容 */
  reply: string;
}

/** 快捷回复短语 */
export interface QuickReply {
  id: string;
  content: string;
}

/**
 * 标记为「待处理」的会话。
 * 存的是会话快照，所以即使会话结束、掉出服务端列表，也依旧留在列表里。
 */
export interface PendingSession extends Session {
  /** 标记时间（毫秒） */
  markedAt: number;
}
