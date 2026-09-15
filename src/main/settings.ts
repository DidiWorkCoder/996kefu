import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** AI 请求协议：OpenAI Chat / OpenAI Responses / Anthropic Messages */
export type AiMethod = 'openai-chat' | 'openai-responses' | 'anthropic';

/** 界面主题 */
export type ThemeMode = 'light' | 'dark' | 'system';

export interface AiConfig {
  /** 接口根地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  method: AiMethod;
  /** 系统提示词（默认提示词，可在设置里修改） */
  prompt: string;
}

/** 每日自动学习：总结当天客服处理写入知识库 */
export interface LearnConfig {
  enabled: boolean;
  /** 每天执行时间 HH:mm */
  time: string;
}

/** 快捷回复短语 */
export interface QuickReply {
  id: string;
  content: string;
}

/** 关键词自动推荐回复：访客消息命中任一关键词时，在输入框上方推荐该回复 */
export interface KeywordRule {
  id: string;
  /** 关键词（可配置多个，命中任意一个即推荐；英文不区分大小写） */
  keywords: string[];
  /** 命中的推荐回复内容 */
  reply: string;
}

/** 关键词统一小写后比较（英文不区分大小写，中文不受影响） */
export const keywordKey = (k: string) => String(k || '').trim().toLowerCase();

/**
 * 归一化关键词规则：兼容旧数据的单关键词写法（keyword: string），去掉空关键词。
 * 关键词或回复为空的规则直接丢弃。
 */
export function normalizeKeywordRules(list: unknown): KeywordRule[] {
  return (Array.isArray(list) ? list : [])
    .map((k: any) => {
      const raw = Array.isArray(k?.keywords) ? k.keywords : k?.keyword ? [k.keyword] : [];
      const keywords = raw.map((s: unknown) => String(s ?? '').trim()).filter(Boolean);
      return {
        id: String(k?.id || `kw-${Math.random().toString(36).slice(2, 10)}`),
        keywords,
        reply: String(k?.reply ?? ''),
      };
    })
    .filter((k) => k.keywords.length > 0 && k.reply.trim() !== '');
}

/** 标记为「待处理」的会话快照（会话结束、掉出服务端列表后依旧保留） */
export interface PendingSession {
  id: string;
  messageSessionId: string;
  visitorId: string;
  visitorName: string;
  headImg?: string;
  lastMessageContent?: string;
  messageTime?: string;
  unReadCount?: number;
  messageSessionRecordId?: string;
  /** 标记时间（毫秒） */
  markedAt: number;
}

/** 局域网：手动补充的对方机器 */
export interface LanPeer {
  id: string;
  /** ip:port */
  addr: string;
  name?: string;
}

/** 新消息提醒方式 */
export type NotifyMode = 'system' | 'popup' | 'both';

/** 来信息提醒配置 */
export interface NotifyConfig {
  /** 总开关 */
  enabled: boolean;
  /** system=系统通知 popup=屏幕居中置顶弹窗 both=两者都要 */
  mode: NotifyMode;
  /** 弹窗多少秒后自动关闭（0 = 不自动关，手动关） */
  autoCloseSec: number;
}

/** 局域网互通配置 */
export interface LanConfig {
  enabled: boolean;
  /** 本机显示名 */
  name: string;
  /** 监听端口（HTTP + WebSocket） */
  port: number;
  /** 识别码：两端一致才互通 */
  token: string;
  /** 自动发现同网段实例 */
  autoDiscover: boolean;
  /** 自动发现失败时手动补充的地址 */
  manual: LanPeer[];
}

/** 一条「远程会话」：从别的机器拉过来的，或别人推给本机的 */
export interface LanSession {
  peerId: string;
  peerName: string;
  /** 对端机器上的客服账号 */
  accountId: string;
  accountName: string;
  /** 会员 uid，用于回复时定位持有者 */
  uid: string;
  /** 会话快照 */
  session: Record<string, any>;
  /** pull=本机拉过来的 push=别人推给本机的 */
  from: 'pull' | 'push';
  addedAt: number;
}

/** 客服号的展示资料：可自定义头像与昵称，覆盖登录信息里的默认值 */
export interface AccountProfile {
  /** 自定义昵称（留空则用登录返回的名字） */
  name?: string;
  /** 头像（上传后转成的 data URL） */
  avatar?: string;
}

/**
 * 「映射」到本机的远端客服：不复制登录凭据，
 * 只记住它属于哪台机器，看会话/发消息都通过局域网转发给对方那台机器。
 */
export interface LanAccount {
  /** 对端地址 ip:port */
  addr: string;
  /** 对端机器显示名 */
  peerName: string;
  /** 对端机器上的客服号 id */
  accountId: string;
  /** 客服昵称 */
  name: string;
  /** 登录账号 */
  account: string;
  /** customerServiceId */
  uid: string;
  addedAt: number;
}

export interface Settings {
  /** 掉线后自动用 GM 凭据续期 */
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
  /** 来信息提醒 */
  notify: NotifyConfig;
  /** 局域网互通 */
  lan: LanConfig;
  /** 本机持有的远程会话（拉取来的 / 别人推来的） */
  lanSessions: LanSession[];
  /** 从局域网上「映射」过来的远端客服（不持有凭据，操作转发） */
  lanAccounts: LanAccount[];
  /**
   * 账号 -> GM 站点的设备凭证（localStorage 里的 deviceid:<账号>）。
   * 服务端靠它判断是不是「新设备登录」：带上它登录就不用再输验证码。
   * 用「登录脚本」在已登录过的浏览器里执行即可导入。
   */
  deviceIds: Record<string, string>;
  /** accountId -> 该客服号自定义的头像与昵称（覆盖登录信息里的默认值） */
  profiles: Record<string, AccountProfile>;
  /** 账号分组：把指定的客服账号归到一组，方便区分不同系统 / 用途 */
  groups: AccountGroup[];
  /** 收起（折叠）起来的分组 id */
  collapsedGroups: string[];
  /**
   * accountId -> 该权限号保存的物品表 / 装备表（用于「物品ID ↔ 物品名」互查）。
   * 只存解析参数（文件/工作表/列/skipRows），行数据在查询时按需读取并内存缓存。
   */
  itemTables: Record<string, GmItemTables>;
}

/** 账号分组 */
export interface AccountGroup {
  id: string;
  name: string;
  /** 归在该组下的账号 id（Account.id）；没归组的账号在列表里单独展示 */
  accountIds: string[];
  /** 该分组对应的游戏 ID（一个分组 = 一个游戏），未绑定为空 */
  gameId?: string;
  /** 该分组对应的游戏名（展示用） */
  gameName?: string;
}

/** 一张「ID ↔ 名称」对照表的解析参数（物品表 / 装备表各一份） */
export interface GmItemTable {
  /** 源文件绝对路径 */
  file: string;
  /** 工作表名 */
  sheet: string;
  /** ID 所在列（0 基） */
  idCol: number;
  /** 名称所在列（0 基） */
  nameCol: number;
  /** 舍弃前几行（标题 / 说明行） */
  skipRows: number;
  /** 解析出的行数（展示用） */
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

const DEFAULT_AI_PROMPT =
  '你是一名专业的在线客服。请根据下面的知识库和聊天记录，用简体中文生成「一条」可以直接发送给访客的回复。' +
  '要求：只输出回复正文，不要加引号、不要加解释、不要输出多余的前后缀。';

const DEFAULT_AI: AiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  method: 'openai-chat',
  prompt: DEFAULT_AI_PROMPT,
};

const DEFAULT_LEARN: LearnConfig = { enabled: false, time: '23:00' };

const DEFAULT_NOTIFY: NotifyConfig = { enabled: true, mode: 'system', autoCloseSec: 0 };

/** 默认开启自动重新登录：需要用登录时记住的账号密码，没记住的账号会自动跳过并提示 */
const DEFAULT_AUTO_RELOGIN: AutoRelogin = { qywx: true, gmAuth: true };

const DEFAULT_LAN: LanConfig = {
  enabled: false,
  name: '',
  port: 17330,
  token: '',
  autoDiscover: true,
  manual: [],
};

const DEFAULT: Settings = {
  autoRefresh: true,
  autoRelogin: { ...DEFAULT_AUTO_RELOGIN },
  theme: 'light',
  ai: { ...DEFAULT_AI },
  knowledge: {},
  learn: { ...DEFAULT_LEARN },
  quickReplies: {},
  pending: {},
  keywords: [],
  keywordsEnabled: true,
  notify: { ...DEFAULT_NOTIFY },
  lan: { ...DEFAULT_LAN },
  lanSessions: [],
  lanAccounts: [],
  deviceIds: {},
  profiles: {},
  groups: [],
  collapsedGroups: [],
  itemTables: {},
};

let cache: Settings | null = null;

function filePath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'settings.json');
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as Partial<Settings>;
    cache = {
      ...DEFAULT,
      ...raw,
      autoRelogin: { ...DEFAULT_AUTO_RELOGIN, ...(raw?.autoRelogin || {}) },
      ai: { ...DEFAULT_AI, ...(raw?.ai || {}) },
      knowledge: { ...(raw?.knowledge || {}) },
      learn: { ...DEFAULT_LEARN, ...(raw?.learn || {}) },
      quickReplies: { ...(raw?.quickReplies || {}) },
      pending: { ...(raw?.pending || {}) },
      keywords: normalizeKeywordRules(raw?.keywords),
      notify: { ...DEFAULT_NOTIFY, ...(raw?.notify || {}) },
      lan: { ...DEFAULT_LAN, ...(raw?.lan || {}), manual: [...(raw?.lan?.manual || [])] },
      lanSessions: [...(raw?.lanSessions || [])],
      lanAccounts: [...(raw?.lanAccounts || [])],
      deviceIds: { ...(raw?.deviceIds || {}) },
      profiles: { ...(raw?.profiles || {}) },
      groups: [...(raw?.groups || [])],
      collapsedGroups: [...(raw?.collapsedGroups || [])],
      itemTables: { ...(raw?.itemTables || {}) },
    };
  } catch {
    cache = {
      ...DEFAULT,
      autoRelogin: { ...DEFAULT_AUTO_RELOGIN },
      ai: { ...DEFAULT_AI },
      knowledge: {},
      learn: { ...DEFAULT_LEARN },
      quickReplies: {},
      pending: {},
      keywords: [],
      keywordsEnabled: true,
      notify: { ...DEFAULT_NOTIFY },
      lan: { ...DEFAULT_LAN },
      lanSessions: [],
      lanAccounts: [],
      deviceIds: {},
      profiles: {},
      groups: [],
      collapsedGroups: [],
      itemTables: {},
    };
  }
  return cache;
}

/** 合并写入设置（只传要改的字段即可） */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch };
  if (patch.autoRelogin) next.autoRelogin = { ...DEFAULT_AUTO_RELOGIN, ...patch.autoRelogin };
  if (patch.ai) next.ai = { ...DEFAULT_AI, ...patch.ai };
  if (patch.knowledge) next.knowledge = { ...patch.knowledge };
  if (patch.learn) next.learn = { ...DEFAULT_LEARN, ...patch.learn };
  if (patch.quickReplies) next.quickReplies = { ...patch.quickReplies };
  if (patch.pending) next.pending = { ...patch.pending };
  if (patch.keywords) next.keywords = normalizeKeywordRules(patch.keywords);
  if (patch.notify) next.notify = { ...DEFAULT_NOTIFY, ...patch.notify };
  if (patch.lan) next.lan = { ...DEFAULT_LAN, ...patch.lan, manual: [...(patch.lan.manual || [])] };
  if (patch.lanSessions) next.lanSessions = [...patch.lanSessions];
  if (patch.lanAccounts) next.lanAccounts = [...patch.lanAccounts];
  if (patch.deviceIds) next.deviceIds = { ...patch.deviceIds };
  if (patch.profiles) next.profiles = { ...patch.profiles };
  if (patch.groups) next.groups = [...patch.groups];
  if (patch.itemTables) next.itemTables = { ...patch.itemTables };
  cache = next;
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/** 某个客服号配置的知识库目录（未配置返回空串） */
export function knowledgeDirOf(accountId: string): string {
  return getSettings().knowledge[accountId] || '';
}

/** 设置 / 清除某个客服号的知识库目录 */
export function setKnowledgeDir(accountId: string, dir: string): Settings {
  const knowledge = { ...getSettings().knowledge };
  if (dir) knowledge[accountId] = dir;
  else delete knowledge[accountId];
  return saveSettings({ knowledge });
}

/** 某账号在 GM 站点的设备凭证（没有返回空串） */
export function deviceIdOf(account: string): string {
  return getSettings().deviceIds[String(account || '').trim()] || '';
}

/** 某客服号自定义的展示资料（没设置返回空对象） */
export function profileOf(accountId: string): AccountProfile {
  return getSettings().profiles[String(accountId || '').trim()] || {};
}

/** 设置某客服号的头像 / 昵称（传空串 = 恢复默认） */
export function setProfile(accountId: string, patch: AccountProfile): Settings {
  const key = String(accountId || '').trim();
  if (!key) return getSettings();
  const profiles = { ...getSettings().profiles };
  const cur: AccountProfile = { ...(profiles[key] || {}), ...patch };
  if (!cur.name) delete cur.name;
  if (!cur.avatar) delete cur.avatar;
  if (cur.name || cur.avatar) profiles[key] = cur;
  else delete profiles[key];
  return saveSettings({ profiles });
}

/** 记住某账号的设备凭证（带它登录可免验证码） */
export function setDeviceId(account: string, deviceId: string): Settings {
  const key = String(account || '').trim();
  const deviceIds = { ...getSettings().deviceIds };
  if (key && deviceId) deviceIds[key] = deviceId;
  else if (key) delete deviceIds[key];
  return saveSettings({ deviceIds });
}

/** 某个权限号保存的物品表 / 装备表（没有返回空对象） */
export function itemTablesOf(accountId: string): GmItemTables {
  return getSettings().itemTables[String(accountId || '').trim()] || {};
}

/** 设置 / 清除某个权限号的物品表（kind=item）/ 装备表（kind=equip） */
export function setItemTable(accountId: string, kind: 'item' | 'equip', table?: GmItemTable): Settings {
  const key = String(accountId || '').trim();
  if (!key) return getSettings();
  const itemTables = { ...getSettings().itemTables };
  const cur: GmItemTables = { ...(itemTables[key] || {}) };
  if (table) cur[kind] = table;
  else delete cur[kind];
  if (cur.item || cur.equip) itemTables[key] = cur;
  else delete itemTables[key];
  return saveSettings({ itemTables });
}
