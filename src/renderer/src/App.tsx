import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Alert, Button, Empty, Input, Modal, Segmented, Select, Space, Tag, Typography } from 'antd';
import { ApiOutlined, FileTextOutlined, FolderOpenOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import AccountSider from './components/AccountSider';
import ChatPanel from './components/ChatPanel';
import GmUserSearchPanel from './components/GmUserSearchPanel';
import GmWorkbench from './components/GmWorkbench';
import LanPanel from './components/LanPanel';
import QywxWorkbench from './components/QywxWorkbench';
import RecordDrawer from './components/RecordDrawer';
import SessionList, { type TabKey } from './components/SessionList';
import SettingsDrawer from './components/SettingsDrawer';
import { isOfflineError, showApiError } from './apiError';
import type {
  Account,
  AccountProfile,
  ChatMessage,
  LanAccount,
  LanSession,
  PendingSession,
  QuickReply,
  Session,
  SessionBuckets,
  Settings,
} from './types';

const EMPTY_BUCKETS: SessionBuckets = { online: [], end: [], queue: [] };

/** 客服状态：1=在线 4=小休 6=挂起（与控制台一致：在线/小休/挂起 = 1/4/6） */
const STATUS_TEXT: Record<number, string> = { 1: '在线', 4: '小休', 6: '挂起' };

/** 会话列表里的「最后一条消息」是 HTML 串，转成纯文本预览 */
function previewOf(content?: string): string {
  const c = content || '';
  if (/<img/i.test(c)) return '[图片]';
  if (/<video/i.test(c)) return '[视频]';
  if (/<a\s/i.test(c)) return '[文件]';
  return c.replace(/<[^>]+>/g, '').trim().slice(0, 60);
}

/** 发送消息时必须带 messageSessionRecordId */
const recordIdOf = (s: Session) => s.messageSessionRecordId || s.messageSessionRecord?.id || '';

/** 发送消息时必须带 customerServiceGroupId */
const groupIdOf = (s: Session) => s.messageSessionRecord?.customerServiceGroupId || (s as any).customerServiceGroupId || '';

export default function App() {
  const { message } = AntApp.useApp();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState('');
  const [adding, setAdding] = useState(false);
  /** 账号密码登录弹窗（非空表示已打开）；autoDevice=设备 ID 从本机浏览器自动读取 */
  const [pwLogin, setPwLogin] = useState<{
    username: string;
    password: string;
    kind?: 'kf996' | 'gmAuth';
    autoDevice?: boolean;
  } | null>(null);
  const [pwSubmitting, setPwSubmitting] = useState(false);
  /** 正在从本机浏览器读设备凭证 */
  const [browserDeviceLoading, setBrowserDeviceLoading] = useState(false);

  const [buckets, setBuckets] = useState<SessionBuckets>(EMPTY_BUCKETS);
  const [tab, setTab] = useState<TabKey>('online');
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** accountId -> 未读消息数（左侧账号列表上的红点 + 条数） */
  const [accountUnread, setAccountUnread] = useState<Record<string, number>>({});

  const [loadingSessions, setLoadingSessions] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [wsOnline, setWsOnline] = useState(false);
  const [csStatus, setCsStatus] = useState(1);
  const [changingStatus, setChangingStatus] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptText, setScriptText] = useState('');
  /** 「设备凭证」脚本弹窗（用于账号密码登录免验证码） */
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [deviceText, setDeviceText] = useState('');
  /** 「客服登录」弹窗：在里面选 996 客服的具体登录方式 */
  const [kfLoginOpen, setKfLoginOpen] = useState(false);
  /** 「企微客服登录」弹窗（账号密码 + 中心地址） */
  const [qywxOpen, setQywxOpen] = useState(false);
  const [qywx, setQywx] = useState({ serverUrl: 'http://127.0.0.1:9000', username: '', password: '' });
  const [qywxLoading, setQywxLoading] = useState(false);
  /**
   * 企微客服账号不参与 996 的会话/WS/巡检逻辑，
   * 所以单独用一个选中 id，activeId 只表示「当前选中的 996 客服号」。
   */
  const [activeQywxId, setActiveQywxId] = useState('');
  /**
   * 权限号（996 只读查询号）同样不参与客服会话/WS 逻辑，
   * 单独记录选中 id；它只用来在右侧打开 GM 只读查询工作台。
   */
  const [activeGmAuthId, setActiveGmAuthId] = useState('');
  /** 「权限号登录」弹窗：在里面选具体登录方式 */
  const [authLoginOpen, setAuthLoginOpen] = useState(false);
  /** 正在绑定游戏的分组 id（非空表示「绑定游戏」弹窗打开） */
  const [gameBindGroup, setGameBindGroup] = useState('');
  /** 授权游戏列表（绑定分组用） */
  const [gamePickList, setGamePickList] = useState<any[]>([]);
  const [gamePicking, setGamePicking] = useState(false);
  /** 这份授权游戏列表是用哪个账号的凭据拉的（展示用） */
  const [gamePickFrom, setGamePickFrom] = useState('');
  /** 绑定游戏弹窗里选择/手填的 gameId */
  const [gamePickValue, setGamePickValue] = useState('');
  const [gameManualId, setGameManualId] = useState('');
  /** 服务记录 → 搜索此用户：右侧常驻覆盖面板 */
  const [gmSearch, setGmSearch] = useState<{ open: boolean; roleId: string; visitorName: string }>({
    open: false,
    roleId: '',
    visitorName: '',
  });

  /** 全局设置（掉线自动续期 / 主题 / AI / 各客服号知识库） */
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 局域网面板开关 */
  const [lanOpen, setLanOpen] = useState(false);
  /** 当前打开的局域网远程会话（非空表示回复要转发到对方机器） */
  const [activeRemote, setActiveRemote] = useState<LanSession | null>(null);
  const activeRemoteRef = useRef<LanSession | null>(null);
  activeRemoteRef.current = activeRemote;
  /**
   * 当前选中的「映射过来的远端客服」（局域网 → 获取远端客服 → 映射到本机）。
   * 非空时：左侧账号切走，右侧显示对方那台机器上的会话，看历史/回复全部走转发。
   */
  const [mappedAccount, setMappedAccount] = useState<LanAccount | null>(null);
  const mappedRef = useRef<LanAccount | null>(null);
  mappedRef.current = mappedAccount;
  /**
   * 当前客服号已判定掉线时停掉各处轮询：
   * 否则会话列表 5s、消息 3s、客服状态 10s 会一直失败请求，
   * 很快触发服务端频率限制，连「续期」都会因为限流失败。
   * 续期成功（auth:state ok=true）后自动恢复。
   */
  const authExpiredRef = useRef(false);
  authExpiredRef.current = authExpired;
  /** 强制刷新消息（局域网通知有更新时用） */
  const [refreshTick, setRefreshTick] = useState(0);
  /** 正在配置知识库的客服号 id（非空则弹出知识库弹窗） */
  const [knowledgeTarget, setKnowledgeTarget] = useState('');
  const [knowledgeDir, setKnowledgeDir] = useState('');
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);

  const activeAccount = accounts.find((a) => a.id === activeId) || null;
  /** 当前选中的企微客服账号（与 996 账号互斥） */
  const activeQywx = accounts.find((a) => a.id === activeQywxId) || null;
  /** 当前选中的权限号（只读查询，与 996/企微互斥） */
  const activeGmAuth = accounts.find((a) => a.id === activeGmAuthId) || null;
  /** 一个账号所在的分组（分组 = 一个游戏） */
  const groupOfAccount = (id: string) => (settings?.groups || []).find((g) => g.accountIds.includes(id)) || null;

  /** 供 applyBuckets 读取当前账号（避免 useCallback 依赖变化） */
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  /** 会话 id -> 上次的未读数，用于识别「新客户 / 新消息」 */
  const seenRef = useRef<{ accountId: string; unread: Map<string, number> }>({ accountId: '', unread: new Map() });
  /** 当前打开的会话（applyBuckets 里读取，避免 useCallback 依赖变化） */
  const activeSessionRef = useRef<Session | null>(null);
  activeSessionRef.current = activeSession;

  const loadAccounts = useCallback(async () => {
    const list = (await window.kefu.listAccounts()) as Account[];
    setAccounts(list);
    return list;
  }, []);

  useEffect(() => {
    loadAccounts().then((list) => {
      const first = list.find((a) => a.kind !== 'qywx' && a.kind !== 'gmAuth');
      if (first) setActiveId(first.id);
    });
  }, [loadAccounts]);

  // 加载设置（主题/自动续期/AI/知识库/局域网）
  const loadSettings = useCallback(async () => {
    try {
      setSettings((await window.kefu.settings()) as Settings);
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 设置被主进程改动（局域网同步数据、别人推来玩家）时刷新
  useEffect(() => {
    return window.kefu.onSettingsChanged(() => {
      void loadSettings();
    });
  }, [loadSettings]);

  // 局域网事件：别人推来玩家时提醒；远程会话有新消息时立即刷新
  useEffect(() => {
    return window.kefu.onLanEvent((evt: any) => {
      if (evt?.type === 'shared') {
        message.info(`${evt.data?.peerName || '同事'} 推给你一个玩家：${evt.data?.visitorName || ''}`);
        void loadSettings();
      } else if (evt?.type === 'session.changed') {
        if (activeRemoteRef.current && String(evt.data?.uid) === String(activeRemoteRef.current.uid)) {
          setRefreshTick((t) => t + 1);
        }
      }
    });
  }, [loadSettings, message]);

  /** 保存某客服号的自定义头像 / 昵称（右键左侧账号修改） */
  const handleSetProfile = async (id: string, patch: AccountProfile) => {
    try {
      setSettings((await window.kefu.setProfile(id, patch)) as Settings);
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    }
  };

  /** 选择一张图片作为该客服号的头像 */
  const handlePickAvatar = async (id: string) => {
    try {
      const avatar = await window.kefu.pickAvatar();
      if (!avatar) return;
      await handleSetProfile(id, { avatar });
    } catch (e: any) {
      message.error(e?.message || '上传头像失败');
    }
  };

  /** 保存设置；主题变化时广播给 main.tsx 立即切换 */
  const handleSaveSettings = async (patch: Partial<Settings>) => {
    const next = (await window.kefu.saveSettings(patch)) as Settings;
    setSettings(next);
    if (patch.theme) window.dispatchEvent(new CustomEvent('kefu:theme', { detail: next.theme }));
  };

  /** 打开某个客服号的知识库配置 */
  const handleOpenKnowledge = (id: string) => {
    setKnowledgeTarget(id);
    setKnowledgeDir(settings?.knowledge?.[id] || '');
  };

  /** 可视化选择知识库文件夹 */
  const handlePickKnowledgeDir = async () => {
    const dir = await window.kefu.pickDir(knowledgeDir || undefined);
    if (dir) setKnowledgeDir(dir);
  };

  /** 保存该客服号的知识库目录（留空 = 清除） */
  const handleSaveKnowledge = async () => {
    setKnowledgeSaving(true);
    try {
      const dir = knowledgeDir.trim();
      const knowledge = { ...(settings?.knowledge || {}) };
      if (dir) knowledge[knowledgeTarget] = dir;
      else delete knowledge[knowledgeTarget];
      const next = (await window.kefu.saveSettings({ knowledge })) as Settings;
      setSettings(next);
      message.success(dir ? '知识库已保存' : '已清除该客服号的知识库');
      setKnowledgeTarget('');
    } catch (e: any) {
      showApiError(message, e, '保存失败');
    } finally {
      setKnowledgeSaving(false);
    }
  };

  /**
   * 快捷回复是按客服号分开存的，这里要动态识别当前会话属于哪个客服号：
   * 远端会话（映射过来的 / 别人推来的）用它在那台机器上的客服号 id
   * —— 局域网同步过来的快捷回复就是按这个 id 存的；
   * 本地会话才用本机客服号 id。
   */
  const quickReplyOwnerId = activeRemote?.accountId || mappedAccount?.accountId || activeAccount?.id || '';
  /** 当前客服号的快捷回复（每个客服号独立存储，互不混合） */
  const quickReplies = quickReplyOwnerId ? settings?.quickReplies?.[quickReplyOwnerId] || [] : [];

  /** 保存当前客服号的快捷回复 */
  const handleSaveQuickReplies = async (list: QuickReply[]) => {
    if (!quickReplyOwnerId) return;
    await handleSaveSettings({ quickReplies: { ...(settings?.quickReplies || {}), [quickReplyOwnerId]: list } });
  };

  /**
   * 标记为「待处理」的会话。
   * 服务端列表里还有这条会话时用最新数据（未读数/最后消息），否则用保存的快照，
   * 所以会话结束后依然会留在列表里。
   */
  const pendingSessions: PendingSession[] = (() => {
    if (!activeAccount) return [];
    const saved = settings?.pending?.[activeAccount.id] || [];
    if (!saved.length) return [];
    const live = [...buckets.online, ...buckets.queue, ...buckets.end];
    return saved.map((p) => {
      const cur = live.find((s) => s.id === p.id);
      return cur ? { ...cur, markedAt: p.markedAt } : p;
    });
  })();

  /** 标记 / 取消「待处理」 */
  const handleTogglePending = async (s: Session) => {
    if (!activeAccount) return;
    const saved = settings?.pending?.[activeAccount.id] || [];
    const next = saved.some((p) => p.id === s.id)
      ? saved.filter((p) => p.id !== s.id)
      : [...saved, { ...s, markedAt: Date.now() }];
    try {
      await handleSaveSettings({ pending: { ...(settings?.pending || {}), [activeAccount.id]: next } });
    } catch (e: any) {
      message.error(e?.message || '标记失败');
    }
  };

  /** 局域网远程会话（别人推来的 / 本机拉来的） */
  const lanSessions: LanSession[] = settings?.lanSessions || [];
  /** 从局域网映射过来的远端客服 */
  const mappedAccounts: LanAccount[] = settings?.lanAccounts || [];
  const mappedKey = mappedAccount ? `${mappedAccount.addr}|${mappedAccount.accountId}` : '';

  /** 切到某个映射过来的远端客服：右侧展示它那台机器上的会话 */
  const selectMappedAccount = (a: LanAccount) => {
    setMappedAccount(a);
    setActiveId('');
    setActiveGmAuthId('');
    setActiveQywxId('');
    setActiveRemote(null);
    setActiveSession(null);
    setTab('online');
  };

  /** 退出映射，回到本机账号视图 */
  const exitMapped = () => {
    setMappedAccount(null);
    setActiveRemote(null);
    setActiveSession(null);
    setBuckets(EMPTY_BUCKETS);
  };

  /** 取消映射（远端客服从左侧列表移除） */
  const handleUnmap = async (a: LanAccount) => {
    try {
      await window.kefu.lanUnmapAccount(a.addr, a.accountId);
      if (mappedAccount?.addr === a.addr && mappedAccount?.accountId === a.accountId) exitMapped();
      await loadSettings();
      message.success(`已取消映射：${a.name}`);
    } catch (e: any) {
      showApiError(message, e, '取消映射失败');
    }
  };

  /** 打开本地会话 */
  const selectLocalSession = (s: Session) => {
    setActiveRemote(null);
    setActiveSession(s);
  };

  /**
   * 打开映射客服的会话：包装成一条「远程会话」，
   * 之后看历史、发消息都复用现有的局域网转发通道。
   */
  const selectMappedSession = (s: Session) => {
    const m = mappedRef.current;
    if (!m) return;
    setActiveRemote({
      peerId: m.addr,
      peerName: m.peerName,
      accountId: m.accountId,
      accountName: m.name,
      uid: m.uid,
      session: s,
      from: 'pull',
      addedAt: Date.now(),
    });
    setActiveSession(s);
  };

  /** 打开一条远程会话：看历史与回复都走局域网转发 */
  const selectRemoteSession = (it: LanSession) => {
    setActiveRemote(it);
    setActiveSession(it.session);
  };

  const handleRemoveRemote = async (it: LanSession) => {
    try {
      await window.kefu.lanRemoveRemote(it.peerId, it.session?.id || '');
      if (activeRemoteRef.current?.session?.id === it.session?.id) {
        setActiveRemote(null);
        setActiveSession(null);
      }
      await loadSettings();
    } catch (e: any) {
      message.error(e?.message || '移除失败');
    }
  };

  // 任意接口报「掉线」时，顶部显示「续期」按钮
  useEffect(() => {
    const onOffline = () => setAuthExpired(true);
    window.addEventListener('kefu:offline', onOffline);
    return () => window.removeEventListener('kefu:offline', onOffline);
  }, []);

  // 主进程每 5s 用「会话记录」接口主动巡检 token，按结果更新顶部「续期」提示
  useEffect(() => {
    return window.kefu.onAuthState((p) => {
      if (p.accountId !== activeIdRef.current) return;
      setAuthExpired(!p.ok);
    });
  }, []);

  // 每日自动学习完成时提示（手动触发已在设置面板内提示，避免重复）
  useEffect(() => {
    return window.kefu.onLearnDone((p) => {
      if (p.trigger !== 'auto') return;
      const detail = p.results.map((r) => `${r.account}：${r.message}`).join('；');
      if (p.results.some((r) => !r.ok)) message.error(`每日学习失败：${detail}`);
      else if (p.results.some((r) => r.sessions > 0)) message.success(`每日学习完成：${detail}`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 更新会话三态；识别新客户做提醒；处理「点击通知后打开会话」 */
  const applyBuckets = useCallback((next: SessionBuckets) => {
    setBuckets(next);
    setActiveSession((cur) => {
      if (!cur) return cur;
      const fresh = [...next.online, ...next.queue, ...next.end].find((x) => x.id === cur.id);
      return fresh && fresh.unReadCount !== cur.unReadCount ? { ...cur, unReadCount: fresh.unReadCount } : cur;
    });

    const accountId = activeIdRef.current;
    // 映射的远端客服只展示会话，不做新消息提醒（实际收发在对方机器上）
    if (mappedRef.current) return;

    // 出现新会话 id => 新客户；未读数变大 => 新消息
    const incoming = [...next.online, ...next.queue, ...next.end];
    const seen = seenRef.current;
    if (seen.accountId !== accountId) {
      // 首次加载（或切换账号）：只记录，不提醒
      seenRef.current = { accountId, unread: new Map(incoming.map((s) => [s.id, s.unReadCount || 0])) };
      return;
    }
    const notify = (s: Session, title: string) => {
      window.kefu
        .notifyNewSession({
          accountId,
          sessionId: s.id,
          messageSessionId: s.messageSessionId,
          visitorName: s.visitorName,
          content: previewOf(s.lastMessageContent),
          title,
        })
        .catch(() => {});
    };
    const viewingId = activeSessionRef.current?.id;
    incoming.forEach((s) => {
      const prev = seen.unread.get(s.id);
      const unread = s.unReadCount || 0;
      seen.unread.set(s.id, unread);
      if (s.id === viewingId) return; // 正在看的会话不打扰
      if (prev === undefined) notify(s, '新客户接入');
      else if (unread > prev) notify(s, '新消息');
    });
  }, []);

  // 会话列表：本地账号每 5s 轮询；选中映射的远端客服时改为向对方机器拉取
  useEffect(() => {
    if (!activeId && !mappedAccount) {
      setBuckets(EMPTY_BUCKETS);
      return;
    }
    let alive = true;
    const load = async (silent: boolean) => {
      // 已判定掉线：不再打接口，等续期成功后自动恢复（远端客服与本地掉线无关）
      if (authExpiredRef.current && !mappedAccount) return;
      if (!silent) setLoadingSessions(true);
      try {
        const d = mappedAccount
          ? await window.kefu.lanRemoteSessions(mappedAccount.addr, mappedAccount.accountId)
          : await window.kefu.sessions(activeId);
        if (!alive) return;
        applyBuckets({
          online: d.onlineSessionList || [],
          end: d.endSessionList || [],
          queue: d.queueSessionList || [],
        });
        setAuthExpired(false);
      } catch (e: any) {
        // 会话列表接口报掉线 = 需要续期（远端客服的失败与本地掉线无关）
        if (!mappedAccount && isOfflineError(e)) setAuthExpired(true);
        if (!silent) showApiError(message, e, '加载会话失败');
      } finally {
        if (!silent) setLoadingSessions(false);
      }
    };
    load(false);
    const timer = setInterval(() => load(true), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeId, mappedAccount, message, applyBuckets]);

  // WebSocket 在线状态（在线才能发消息）
  useEffect(() => {
    if (!activeId) {
      setWsOnline(false);
      return;
    }
    let alive = true;
    const check = () =>
      window.kefu
        .wsStatus(activeId)
        .then((v) => alive && setWsOnline(!!v))
        .catch(() => {});
    check();
    const timer = setInterval(check, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeId]);

  // 客服状态（在线 / 小休 / 挂起）：进入账号加载，之后每 10s 同步
  useEffect(() => {
    if (!activeId) return;
    let alive = true;
    const load = () => {
      // 掉线时不再同步客服状态，避免加重限流
      if (authExpiredRef.current) return Promise.resolve();
      return window.kefu
        .status(activeId)
        .then((d: any) => {
          if (alive) setCsStatus(Number(d?.state ?? 1));
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeId]);

  /**
   * 后台账号（已登录但当前没选中）的未读快照。
   * 切走账号后 WS 推送照样会来，但界面上没有它的会话列表，
   * 所以这里按账号记快照，用来识别「新客户 / 新消息」。
   */
  const bgSeenRef = useRef<Map<string, Map<string, number>>>(new Map());
  const bgBusyRef = useRef<Set<string>>(new Set());

  /** 更新某账号的未读总数（左侧账号列表红点） */
  const setUnreadOf = useCallback((id: string, n: number) => {
    if (!id) return;
    setAccountUnread((m) => (m[id] === n ? m : { ...m, [id]: n }));
  }, []);

  // 当前 996 账号的未读总数 = 各会话未读之和
  useEffect(() => {
    if (!activeId) return;
    const n = [...buckets.online, ...buckets.queue, ...buckets.end].reduce(
      (s, x) => s + (x.unReadCount || 0),
      0,
    );
    setUnreadOf(activeId, n);
  }, [activeId, buckets, setUnreadOf]);

  /** 后台账号收到推送时拉一次会话列表，有新消息就弹提醒（避免切走后收不到消息） */
  const pollBackgroundSessions = useCallback(async (accountId: string) => {
    if (!accountId || bgBusyRef.current.has(accountId)) return;
    bgBusyRef.current.add(accountId);
    try {
      const d = await window.kefu.sessions(accountId);
      const incoming: Session[] = [
        ...(d.onlineSessionList || []),
        ...(d.queueSessionList || []),
        ...(d.endSessionList || []),
      ];
      const seen = bgSeenRef.current.get(accountId);
      // 后台账号的未读总数也要更新，左侧列表才显示红点
      setUnreadOf(
        accountId,
        incoming.reduce((s, x) => s + (x.unReadCount || 0), 0),
      );
      // 首次看到该账号：只记录，不提醒（否则登录后会一次性弹一堆）
      if (!seen) {
        bgSeenRef.current.set(accountId, new Map(incoming.map((s) => [s.id, s.unReadCount || 0])));
        return;
      }
      incoming.forEach((s) => {
        const prev = seen.get(s.id);
        const unread = s.unReadCount || 0;
        seen.set(s.id, unread);
        const isNew = prev === undefined;
        if (!isNew && unread <= prev) return;
        void window.kefu
          .notifyNewSession({
            accountId,
            sessionId: s.id,
            messageSessionId: s.messageSessionId,
            visitorName: s.visitorName,
            content: previewOf(s.lastMessageContent),
            title: isNew ? '新客户接入' : '新消息',
          })
          .catch(() => {});
      });
    } catch {
      /* 后台账号拉取失败（掉线等）忽略，等下次推送 */
    } finally {
      bgBusyRef.current.delete(accountId);
    }
  }, [setUnreadOf]);

  /** 供常驻订阅调用，避免闭包拿到旧账号 */
  const refreshSessionsRef = useRef<() => void>(() => {});
  const reloadMessagesRef = useRef<() => void>(() => {});

  // WebSocket 推送：常驻订阅，不随账号切换注销。
  // 当前账号直接刷新列表与消息；后台账号拉一次会话并弹提醒，
  // 否则切到别的账号后原账号就收不到消息了。
  useEffect(() => {
    const off = window.kefu.onWsEvent(({ accountId, data }: any) => {
      if (data?.type === 'PONG') return;
      if (accountId === activeIdRef.current) {
        void refreshSessionsRef.current();
        void reloadMessagesRef.current();
        return;
      }
      void pollBackgroundSessions(accountId);
    });
    return off;
  }, [pollBackgroundSessions]);

  // 消息：选中会话后每 3s 轮询；远程会话走局域网拉取
  useEffect(() => {
    const sid = activeSession?.messageSessionId;
    const remote = activeRemote;
    if (!sid || (!remote && !activeId)) {
      setMessages([]);
      return;
    }
    let alive = true;
    const load = async (silent: boolean) => {
      // 已判定掉线：不再拉消息，等续期成功后自动恢复（远程会话与本地掉线无关）
      if (authExpiredRef.current && !remote) return;
      if (!silent) setLoadingMessages(true);
      try {
        const d = remote
          ? await window.kefu.lanHistory({ uid: remote.uid, messageSessionId: sid, pageNum: 1, pageSize: 50 })
          : await window.kefu.messages(activeId, { messageSessionId: sid, pageNum: 1, pageSize: 50 });
        if (!alive) return;
        setMessages(((d.records || []) as ChatMessage[]).slice().reverse());
      } catch (e: any) {
        if (!silent) showApiError(message, e, '加载消息失败');
      } finally {
        if (!silent) setLoadingMessages(false);
      }
    };
    load(false);
    const timer = setInterval(() => load(true), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeId, activeSession?.messageSessionId, activeRemote, refreshTick, message]);

  // 打开/刷新会话时若有未读，标记为已读（访客端即可看到「已读」）；远程会话由对方处理
  useEffect(() => {
    const s = activeSession;
    if (!activeId || !s || !s.unReadCount || activeRemoteRef.current) return;
    let alive = true;
    window.kefu
      .allRead(activeId, { messageSessionId: s.messageSessionId, messageSourceUid: s.visitorId })
      .then(() => {
        if (!alive) return;
        setActiveSession((cur) => (cur && cur.id === s.id ? { ...cur, unReadCount: 0 } : cur));
        setBuckets((b) => ({
          online: b.online.map((x) => (x.id === s.id ? { ...x, unReadCount: 0 } : x)),
          end: b.end.map((x) => (x.id === s.id ? { ...x, unReadCount: 0 } : x)),
          queue: b.queue.map((x) => (x.id === s.id ? { ...x, unReadCount: 0 } : x)),
        }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeSession?.id, activeSession?.unReadCount, activeSession?.messageSessionId]);

  const handleAdd = async (autoFill?: { username: string; password: string }) => {
    setAdding(true);
    try {
      const acc = await window.kefu.login(autoFill);
      if (acc) {
        await loadAccounts();
        setActiveQywxId('');
        setActiveGmAuthId('');
        setActiveId(acc.id);
        setActiveSession(null);
        setActiveRemote(null);
        setTab('online');
      }
    } catch (e: any) {
      showApiError(message, e, '添加客服号失败');
    } finally {
      setAdding(false);
    }
  };

  /**
   * 权限号登录（只读查询号）：打开登录窗口，登录后站点会跳到 /myGame，
   * 此时就把 GM 凭据导进来。成功后右侧打开 GM 只读查询工作台。
   */
  const handleAddAuth = async (autoFill?: { username: string; password: string }) => {
    setAdding(true);
    try {
      const acc = await window.kefu.loginAuthWindow(autoFill);
      if (acc) {
        await loadAccounts();
        setMappedAccount(null);
        setActiveId('');
        setActiveQywxId('');
        setActiveGmAuthId(acc.id);
        setActiveSession(null);
        setActiveRemote(null);
      }
    } catch (e: any) {
      showApiError(message, e, '添加权限号失败');
    } finally {
      setAdding(false);
    }
  };

  /**
   * 应用内账号密码登录：
   * 能直接换到 token 就导入；服务端要求验证码时改走登录窗口，账号密码已经填好。
   */
  const handlePasswordLogin = async () => {
    const form = pwLogin;
    if (!form?.username.trim() || !form.password) {
      message.warning('请输入账号和密码');
      return;
    }
    setPwSubmitting(true);
    const isAuth = form.kind === 'gmAuth';
    const cred = { username: form.username.trim(), password: form.password };
    try {
      const r = isAuth ? await window.kefu.loginAuth(cred) : await window.kefu.loginByPassword(cred);
      setPwLogin(null);
      if (!r.ok) {
        message.info('该账号在新设备登录需要验证码，已在登录窗口填好账号密码，请补验证码');
        await (isAuth ? handleAddAuth(cred) : handleAdd(cred));
        return;
      }
      await loadAccounts();
      setActiveQywxId('');
      setActiveSession(null);
      setActiveRemote(null);
      if (isAuth) {
        setActiveId('');
        setActiveGmAuthId(r.account.id);
      } else {
        setActiveGmAuthId('');
        setActiveId(r.account.id);
        setTab('online');
      }
      message.success(`已登录：${r.account.name || r.account.account}`);
    } catch (e: any) {
      showApiError(message, e, isAuth ? '权限号登录失败' : '账号密码登录失败');
    } finally {
      setPwSubmitting(false);
    }
  };

  /**
   * 企微客服登录：调企微客服中心的 /api/auth/login，
   * 成功后账号存进列表（kind=qywx），右侧展示该账号信息。
   */
  const handleQywxLogin = async () => {
    const serverUrl = qywx.serverUrl.trim();
    const username = qywx.username.trim();
    if (!serverUrl || !username || !qywx.password) {
      message.warning('请填写中心地址、账号和密码');
      return;
    }
    setQywxLoading(true);
    try {
      const acc = await window.kefu.qywxLogin({ serverUrl, username, password: qywx.password });
      await loadAccounts();
      setQywxOpen(false);
      setQywx((s) => ({ ...s, username: '', password: '' }));
      setMappedAccount(null);
      setActiveId('');
      setActiveSession(null);
      setActiveRemote(null);
      setActiveQywxId(acc.id);
      message.success(`已登录企微客服：${acc.name || acc.account}`);
    } catch (e: any) {
      showApiError(message, e, '企微客服登录失败');
    } finally {
      setQywxLoading(false);
    }
  };

  const handleRemove = async (id: string) => {
    const list = (await window.kefu.removeAccount(id)) as Account[];
    setAccounts(list);
    if (id === activeQywxId) {
      setActiveQywxId('');
      setActiveSession(null);
    } else if (id === activeGmAuthId) {
      setActiveGmAuthId('');
    } else if (id === activeId) {
      setActiveId(list.find((a) => a.kind !== 'qywx' && a.kind !== 'gmAuth')?.id || '');
      setActiveSession(null);
    }
  };

  /**
   * 打开「绑定游戏」：分组 = 一个游戏。
   * 授权游戏是「跟账号走」的，所以拉列表时必须用**这个分组里实际做查询的账号**自己的凭据，
   * 否则新加的权限号会显示成另一个老账号的授权游戏（对应不上）。
   */
  const openBindGame = async (groupId: string, preferAccountId?: string) => {
    setGameBindGroup(groupId);
    setGamePickList([]);
    setGamePickFrom('');
    const cur = (settings?.groups || []).find((g) => g.id === groupId);
    setGamePickValue(cur?.gameId || '');
    setGameManualId('');
    const inGroup = cur ? accounts.filter((a) => cur.accountIds.includes(a.id)) : [];
    const donor =
      accounts.find((a) => a.id === preferAccountId && a.kind !== 'qywx') ||
      inGroup.find((a) => a.kind === 'gmAuth') ||
      accounts.find((a) => a.kind === 'gmAuth') ||
      accounts.find((a) => a.kind !== 'qywx');
    if (!donor) {
      message.info('请先登录任意客服号或权限号，才能拉取授权游戏列表');
      return;
    }
    setGamePicking(true);
    try {
      const d = await window.kefu.gmCall(donor.id, '', 'gmGameAuthList', { adminGameType: 1 });
      setGamePickList(d?.list || []);
      setGamePickFrom(donor.name || donor.account);
    } catch (e: any) {
      showApiError(message, e, '拉取授权游戏失败');
      setGamePickList([]);
    } finally {
      setGamePicking(false);
    }
  };

  /**
   * 账号右键 →「绑定游戏」。
   * 游戏是挂在分组上的：账号还没归到任何分组时，先用账号名建一个分组再打开绑定弹窗
   * （否则用户没有分组就没有任何绑定入口）。新分组会一并收进其它还没分组的账号，
   * 这样「客服号 + 权限号同属一个游戏」的用法不用再手动归组。
   */
  const bindGameForAccount = async (accountId: string) => {
    const gs = settings?.groups || [];
    let gid = gs.find((g) => g.accountIds.includes(accountId))?.id || '';
    if (!gid) {
      const acc = accounts.find((a) => a.id === accountId);
      gid = `grp-${Date.now().toString(36)}`;
      const name = settings?.profiles?.[accountId]?.name || acc?.name || acc?.account || '我的分组';
      const loose = accounts
        .filter((a) => !gs.some((g) => g.accountIds.includes(a.id)))
        .map((a) => a.id);
      const saved = (await window.kefu.saveSettings({
        groups: [...gs, { id: gid, name, accountIds: loose.includes(accountId) ? loose : [accountId] }],
      })) as Settings;
      setSettings(saved);
    }
    await openBindGame(gid, accountId);
  };

  /** 把 gameId / gameName 写回该分组 */
  const saveGroupGame = async (gameId: string, gameName: string) => {
    const next = (settings?.groups || []).map((g) => (g.id === gameBindGroup ? { ...g, gameId, gameName } : g));
    await handleSaveSettings({ groups: next });
    setGameBindGroup('');
    message.success(gameId ? `已绑定游戏：${gameName || gameId}` : '已清除该分组的游戏绑定');
  };

  const refreshSessions = async () => {
    if (!activeId && !mappedAccount) return;
    setLoadingSessions(true);
    try {
      const d = mappedAccount
        ? await window.kefu.lanRemoteSessions(mappedAccount.addr, mappedAccount.accountId)
        : await window.kefu.sessions(activeId);
      applyBuckets({
        online: d.onlineSessionList || [],
        end: d.endSessionList || [],
        queue: d.queueSessionList || [],
      });
    } catch (e: any) {
      showApiError(message, e, '刷新失败');
    } finally {
      setLoadingSessions(false);
    }
  };

  const reloadMessages = async (session = activeSession) => {
    if (!session) return;
    const remote = activeRemoteRef.current;
    if (!remote && !activeId) return;
    const d = remote
      ? await window.kefu.lanHistory({ uid: remote.uid, messageSessionId: session.messageSessionId, pageNum: 1, pageSize: 50 })
      : await window.kefu.messages(activeId, { messageSessionId: session.messageSessionId, pageNum: 1, pageSize: 50 });
    setMessages(((d.records || []) as ChatMessage[]).slice().reverse());
  };

  // 常驻 WS 订阅里调用最新的刷新逻辑（不复用旧账号的闭包）
  refreshSessionsRef.current = refreshSessions;
  reloadMessagesRef.current = reloadMessages;

  const handleSend = async (content: string) => {
    if (!activeSession) return;
    const remote = activeRemoteRef.current;
    if (!remote && !activeId) return;
    setSending(true);
    try {
      const payload = {
        messageSessionId: activeSession.messageSessionId,
        messageSessionRecordId: recordIdOf(activeSession),
        customerServiceGroupId: groupIdOf(activeSession),
        visitorId: activeSession.visitorId,
        visitorName: activeSession.visitorName,
        content,
      };
      // 远程会话：由持有该客服号的设备真实发送
      if (remote) await window.kefu.lanReply({ uid: remote.uid, ...payload });
      else await window.kefu.send(activeId, payload);
      await reloadMessages();
    } catch (e: any) {
      showApiError(message, e, '发送失败');
      throw e;
    } finally {
      setSending(false);
    }
  };

  /** 上传文件（图片/视频/文件）后自动发送，msgType: 5=图片 6=视频 7=文件 */
  const handleUpload = async (file: File) => {
    if (!activeSession || !activeId) return;
    if (activeRemoteRef.current) {
      message.warning('远程会话暂不支持发送附件');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error('文件不能超过 5MB');
      return;
    }
    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      const url = await window.kefu.upload(activeId, { name: file.name, type: file.type, base64 });

      const isImage = file.type.startsWith('image');
      const isVideo = file.type.startsWith('video');
      const msgType = isImage ? 5 : isVideo ? 6 : 7;
      const content = isImage
        ? `<img class='send-img' src="${url}"></img>`
        : isVideo
          ? `<video src="${url}" preload="metadata" crossorigin='anonymous' autoplay controls class='send-video'></video>`
          : `<a href="${url}" download class='send-file' target="_blank">${file.name}</a>`;

      await window.kefu.send(activeId, {
        messageSessionId: activeSession.messageSessionId,
        messageSessionRecordId: recordIdOf(activeSession),
        customerServiceGroupId: groupIdOf(activeSession),
        visitorId: activeSession.visitorId,
        visitorName: activeSession.visitorName,
        content,
        msgType,
      });
      await reloadMessages();
      message.success('已发送');
    } catch (e: any) {
      showApiError(message, e, '上传/发送失败');
    } finally {
      setUploading(false);
    }
  };

  // 脚本导入成功（本地回调服务收到的凭据已落库）-> 刷新账号列表
  useEffect(() => {
    return window.kefu.onAccountsChanged((p: any) => {
      loadAccounts().then((list) => {
        if (!activeIdRef.current && list.length) setActiveId(list[0].id);
      });
      setAuthExpired(false);
      message.success(`已导入登录态：${p?.name || ''}`);
    });
  }, [loadAccounts, message]);

  /** 手动续期：用已保存的 GM 凭据重新换 token 上线 */
  const handleRefresh = async (id: string) => {
    setAdding(true);
    try {
      const acc = await window.kefu.refreshLogin(id);
      setAuthExpired(false);
      await loadAccounts();
      await refreshSessions();
      message.success(`已续期上线：${acc?.name || ''}`);
    } catch (e: any) {
      showApiError(message, e, '续期失败');
    } finally {
      setAdding(false);
    }
  };

  /** 打开「登录脚本」弹窗（kind=gmAuth 时生成权限号脚本，落地页 /myGame） */
  const handleShowScript = async (kind?: 'kf996' | 'gmAuth') => {
    try {
      setScriptText(await window.kefu.gmScript(kind));
      setScriptOpen(true);
    } catch (e: any) {
      showApiError(message, e, '获取脚本失败');
    }
  };

  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(scriptText);
      message.success('脚本已复制，去 gm.tj.996sdk.com 的控制台粘贴执行');
    } catch {
      message.error('复制失败，请手动全选脚本复制');
    }
  };

  /** 打开「设备凭证」脚本弹窗：在已经不用验证码的浏览器里执行，之后本机登录同一账号免验证码 */
  const handleShowDeviceScript = async () => {
    try {
      setDeviceText(await window.kefu.deviceScript(pwLogin?.username.trim() || ''));
      setDeviceOpen(true);
    } catch (e: any) {
      showApiError(message, e, '获取脚本失败');
    }
  };

  const handleCopyDeviceScript = async () => {
    try {
      await navigator.clipboard.writeText(deviceText);
      message.success('脚本已复制，去已经登录过的 gm.tj.996sdk.com 页面控制台粘贴执行');
    } catch {
      message.error('复制失败，请手动全选脚本复制');
    }
  };

  /**
   * 只读：从本机浏览器（Edge/Firefox/QQ/夸克）的 localStorage 直接取该账号的 deviceid。
   * 不需要用户手输、也不用去控制台跑脚本。silent=true 时不弹「没找到」的提示（用于自动触发）。
   */
  const handleBrowserDevice = async (silent = false) => {
    const account = pwLogin?.username.trim() || '';
    if (!account) {
      if (!silent) message.info('请先填写账号');
      return;
    }
    setBrowserDeviceLoading(true);
    try {
      const r = await window.kefu.browserDevice(account);
      if ('deviceId' in r) {
        await loadSettings();
        message.success(`已从本机 ${r.browser} 读取到设备凭证，登录可免验证码`);
      } else if (!silent) {
        message.warning(r.reason || '本机浏览器里没找到该账号的设备凭证，可改用 JS 脚本导入');
      }
    } catch (e: any) {
      if (!silent) showApiError(message, e, '自动获取设备凭证失败');
    } finally {
      setBrowserDeviceLoading(false);
    }
  };

  /** 切换客服状态：1=在线 4=小休 6=挂起 */
  const handleStatusChange = async (status: number) => {
    if (!activeId || changingStatus) return;
    setChangingStatus(true);
    try {
      // 先取服务端真实状态：本地状态可能因掉线 / 其它端登录 / 刚切账号而过期，
      // 直接按本地状态切换会出现「点了没反应」或「请不要选择当前状态进行切换」
      let cur = csStatus;
      try {
        const d: any = await window.kefu.status(activeId);
        cur = Number(d?.state ?? csStatus);
        setCsStatus(cur);
      } catch {
        /* 取不到真实状态时退回本地值 */
      }
      if (cur === status) {
        message.info(`当前已是${STATUS_TEXT[status] || status}`);
        return;
      }
      await window.kefu.setStatus(activeId, status);
      setCsStatus(status);
      message.success(`已切换为${STATUS_TEXT[status] || status}`);
    } catch (e: any) {
      // 失败后再对齐一次真实状态，避免界面长期停在与服务端不一致的选项上
      try {
        const d: any = await window.kefu.status(activeId);
        setCsStatus(Number(d?.state ?? csStatus));
      } catch {
        /* ignore */
      }
      showApiError(message, e, '状态切换失败');
    } finally {
      setChangingStatus(false);
    }
  };

  /** 撤回自己发出的消息 */
  const handleRecall = async (m: ChatMessage) => {
    if (!activeSession) return;
    if (activeRemoteRef.current) {
      message.warning('远程会话暂不支持撤回');
      return;
    }
    if (!activeId) return;
    try {
      await window.kefu.recall(activeId, {
        messageSessionId: activeSession.messageSessionId,
        messageId: m.id,
        visitorId: activeSession.visitorId,
        visitorName: activeSession.visitorName,
      });
      message.success('已撤回');
      await reloadMessages();
      await refreshSessions();
    } catch (e: any) {
      showApiError(message, e, '撤回失败');
    }
  };

  return (
    <div className="app">
      <AccountSider
        accounts={accounts}
        activeId={activeQywxId || activeGmAuthId || activeId}
        unread={accountUnread}
        adding={adding}
        knowledge={settings?.knowledge || {}}
        profiles={settings?.profiles || {}}
        groups={settings?.groups || []}
        onSaveGroups={(g) => void handleSaveSettings({ groups: g })}
        collapsed={settings?.collapsedGroups || []}
        onSaveCollapsed={(ids) => void handleSaveSettings({ collapsedGroups: ids })}
        onSetProfile={handleSetProfile}
        onPickAvatar={handlePickAvatar}
        mapped={mappedAccounts}
        activeMappedKey={mappedKey}
        onSelectMapped={selectMappedAccount}
        onRemoveMapped={handleUnmap}
        onSelect={(id) => {
          const kind = accounts.find((a) => a.id === id)?.kind;
          setMappedAccount(null);
          setActiveSession(null);
          setActiveRemote(null);
          // 企微 / 权限号都不走 996 的会话/WS 逻辑，各自单独记录选中
          if (kind === 'qywx') {
            setActiveId('');
            setActiveGmAuthId('');
            setActiveQywxId(id);
          } else if (kind === 'gmAuth') {
            setActiveId('');
            setActiveQywxId('');
            setActiveGmAuthId(id);
          } else {
            setActiveQywxId('');
            setActiveGmAuthId('');
            setActiveId(id);
          }
        }}
        onAddKf={() => setKfLoginOpen(true)}
        onAddQywx={() => setQywxOpen(true)}
        onAddAuth={() => setAuthLoginOpen(true)}
        onBindGroupGame={(gid) => void openBindGame(gid)}
        onBindAccountGame={(aid) => void bindGameForAccount(aid)}
        onRefresh={handleRefresh}
        onKnowledge={handleOpenKnowledge}
        onRemove={handleRemove}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="main">
        <div className="main-header">
          <div className="header-info">
            {mappedAccount ? (
              <>
                <div className="header-row">
                  <Typography.Text strong style={{ fontSize: 15 }}>
                    {mappedAccount.name}
                  </Typography.Text>
                  <Tag color="purple">局域网 · {mappedAccount.peerName}</Tag>
                  <Typography.Text className="header-sub" type="secondary">
                    {mappedAccount.account} · ID {mappedAccount.uid}
                  </Typography.Text>
                </div>
                <div className="header-row">
                  <Tag color="blue">转发模式：会话与回复都由对方机器实际收发，对方不会掉线</Tag>
                  <Button size="small" onClick={exitMapped}>
                    退出映射
                  </Button>
                </div>
              </>
            ) : activeAccount ? (
              <>
                <div className="header-row">
                  <Typography.Text strong style={{ fontSize: 15 }}>
                    {settings?.profiles?.[activeAccount.id]?.name || activeAccount.name}
                  </Typography.Text>
                  <Tag color="blue">{activeAccount.account}</Tag>
                  {authExpired && (
                    <Button size="small" danger icon={<SyncOutlined />} onClick={() => activeId && handleRefresh(activeId)}>
                      登录失效，点此续期
                    </Button>
                  )}
                  <Typography.Text className="header-sub" type="secondary">
                    公司 {activeAccount.companyId} · ID {activeAccount.uid}
                  </Typography.Text>
                </div>
                <div className="header-row">
                  <Segmented
                    size="small"
                    value={csStatus}
                    disabled={changingStatus}
                    onChange={(v) => handleStatusChange(Number(v))}
                    options={[
                      { label: '在线', value: 1 },
                      { label: '小休', value: 4 },
                      { label: '挂起', value: 6 },
                    ]}
                  />
                  <Tag color={wsOnline ? 'green' : 'red'}>{wsOnline ? '已连接' : '未连接'}</Tag>
                </div>
              </>
            ) : activeQywx ? (
              <>
                <div className="header-row">
                  <Typography.Text strong style={{ fontSize: 15 }}>
                    {settings?.profiles?.[activeQywx.id]?.name || activeQywx.name}
                  </Typography.Text>
                  <Tag color="green">企微客服</Tag>
                  <Typography.Text className="header-sub" type="secondary">
                    {activeQywx.serverUrl} · {activeQywx.account}
                  </Typography.Text>
                </div>
              </>
            ) : activeGmAuth ? (
              <>
                <div className="header-row">
                  <Typography.Text strong style={{ fontSize: 15 }}>
                    {settings?.profiles?.[activeGmAuth.id]?.name || activeGmAuth.name}
                  </Typography.Text>
                  <Tag color="orange">权限号 · 只读查询</Tag>
                  <Tag color="blue">{activeGmAuth.account}</Tag>
                  <Typography.Text className="header-sub" type="secondary">
                    ID {activeGmAuth.gmUserId || activeGmAuth.uid}
                  </Typography.Text>
                </div>
                <div className="header-row">
                  {groupOfAccount(activeGmAuth.id)?.gameId ? (
                    <Tag color="geekblue">
                      游戏：{groupOfAccount(activeGmAuth.id)?.gameName || groupOfAccount(activeGmAuth.id)?.gameId}
                    </Tag>
                  ) : (
                    <Tag color="red">未绑定游戏：请右键左侧分组 → 绑定游戏</Tag>
                  )}
                </div>
              </>
            ) : (
              <Typography.Text type="secondary">未选择客服号</Typography.Text>
            )}
          </div>
          <div className="header-actions">
            <Button icon={<ReloadOutlined />} onClick={refreshSessions} disabled={!activeId && !mappedAccount}>
              刷新
            </Button>
            <Button icon={<ApiOutlined />} onClick={() => setLanOpen(true)}>
              局域网
            </Button>
            <Button icon={<FileTextOutlined />} onClick={() => setRecordOpen(true)} disabled={!activeId}>
              会话记录
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={() => window.kefu.openLog()}>
              日志
            </Button>
          </div>
        </div>

        {/* 996 工作台：切到企微/权限号时只隐藏、不卸载，避免切回时重新拉取 */}
        <div
          className="workspace"
          style={!activeQywx && !activeGmAuth && (activeAccount || mappedAccount) ? undefined : { display: 'none' }}
        >
          <SessionList
            buckets={buckets}
            tab={tab}
            active={activeSession}
            loading={loadingSessions}
            pending={pendingSessions}
            remote={mappedAccount ? [] : lanSessions}
            onTabChange={setTab}
            onSelect={mappedAccount ? selectMappedSession : selectLocalSession}
            onTogglePending={handleTogglePending}
            onSelectRemote={selectRemoteSession}
            onRemoveRemote={handleRemoveRemote}
          />
          <ChatPanel
            account={activeAccount}
            session={activeSession}
            messages={messages}
            loading={loadingMessages}
            sending={sending}
            uploading={uploading}
            quickReplies={quickReplies}
            keywordRules={settings?.keywordsEnabled ? settings?.keywords || [] : []}
            ownerUid={activeRemote?.uid || activeAccount?.uid || mappedAccount?.uid || ''}
            remoteLabel={
              activeRemote
                ? `局域网 · ${activeRemote.peerName}${activeRemote.accountName ? ' · ' + activeRemote.accountName : ''}`
                : undefined
            }
            onSaveQuickReplies={handleSaveQuickReplies}
            onSend={handleSend}
            onUpload={handleUpload}
            onRecall={handleRecall}
            onSearchUser={(p) => setGmSearch({ open: true, roleId: p.roleId, visitorName: p.visitorName })}
          />
        </div>

        {/* 企微工作台：所有企微账号常驻挂载，用 visible 控制显隐；
            否则切走账号时组件卸载会注销 WS 订阅，导致收不到消息 */}
        {accounts
          .filter((a) => a.kind === 'qywx')
          .map((a) => (
            <QywxWorkbench
              key={a.id}
              account={a}
              visible={a.id === activeQywxId}
              onUnreadChange={setUnreadOf}
            />
          ))}

        {/* 权限号工作台（GM 只读查询）：常驻挂载 + visible 显隐，切换账号不丢查询状态 */}
        {accounts
          .filter((a) => a.kind === 'gmAuth')
          .map((a) => (
            <GmWorkbench
              key={a.id}
              account={a}
              visible={a.id === activeGmAuthId}
              gameId={groupOfAccount(a.id)?.gameId || ''}
              gameName={groupOfAccount(a.id)?.gameName || ''}
              itemTables={settings?.itemTables?.[a.id] || {}}
              onSavedItemTables={loadSettings}
            />
          ))}

        {!activeQywx && !activeGmAuth && !activeAccount && !mappedAccount && (
          <div className="center-tip" style={{ flex: 1 }}>
            <Empty description="点左侧「新增」登录客服账号" />
          </div>
        )}
      </div>

      {/* 服务记录 → 搜索此用户：右侧向左展开的常驻覆盖面板（关闭后保留查询结果） */}
      <GmUserSearchPanel
        open={gmSearch.open}
        roleId={gmSearch.roleId}
        visitorName={gmSearch.visitorName}
        activeAccount={activeAccount}
        accounts={accounts}
        groups={settings?.groups || []}
        itemTables={settings?.itemTables || {}}
        onClose={() => setGmSearch((s) => ({ ...s, open: false }))}
      />

      <RecordDrawer open={recordOpen} account={activeAccount} onClose={() => setRecordOpen(false)} />

      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />

      <LanPanel
        open={lanOpen}
        onClose={() => setLanOpen(false)}
        accounts={accounts}
        activeAccountId={activeId}
        buckets={buckets}
        pending={pendingSessions}
        lanSessions={lanSessions}
        onChanged={loadSettings}
      />

      <Modal
        open={!!knowledgeTarget}
        title={`知识库配置 · ${accounts.find((a) => a.id === knowledgeTarget)?.name || ''}`}
        onCancel={() => setKnowledgeTarget('')}
        onOk={handleSaveKnowledge}
        okText="保存"
        cancelText="取消"
        confirmLoading={knowledgeSaving}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="该客服号的 AI 回复会读取此文件夹下的文本文件（.txt/.md/.csv/.json 等）作为知识库"
        />
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={knowledgeDir}
            placeholder="请选择或粘贴文件夹路径"
            onChange={(e) => setKnowledgeDir(e.target.value)}
          />
          <Button icon={<FolderOpenOutlined />} onClick={handlePickKnowledgeDir}>
            选择文件夹
          </Button>
        </Space.Compact>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          留空并保存可清除该客服号的知识库。
        </Typography.Text>
      </Modal>

      <Modal
        open={kfLoginOpen}
        title="客服登录"
        onCancel={() => setKfLoginOpen(false)}
        footer={null}
        width={420}
        destroyOnHidden
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          选择 996 客服的登录方式
        </Typography.Text>
        <div className="login-methods">
          <button
            className="login-method"
            onClick={() => {
              setKfLoginOpen(false);
              setPwLogin({ username: '', password: '', kind: 'kf996' });
            }}
          >
            <span className="login-method-title">账号密码登录</span>
            <span className="login-method-desc">用 GM 站点（gm.tj.996sdk.com）的账号密码直接登录</span>
          </button>
          <button
            className="login-method"
            onClick={() => {
              setKfLoginOpen(false);
              setPwLogin({ username: '', password: '', kind: 'kf996', autoDevice: true });
            }}
          >
            <span className="login-method-title">账号密码登录（自动读设备）</span>
            <span className="login-method-desc">
              设备 ID 不用输也不用跑脚本，从本机浏览器（Edge/Firefox/QQ/夸克）自动读取，免验证码
            </span>
          </button>
          <button
            className="login-method"
            onClick={() => {
              setKfLoginOpen(false);
              void handleShowScript();
            }}
          >
            <span className="login-method-title">登录脚本导入</span>
            <span className="login-method-desc">在已经登录的浏览器控制台执行脚本，导入登录态</span>
          </button>
          <button
            className="login-method"
            onClick={() => {
              setKfLoginOpen(false);
              void handleAdd();
            }}
          >
            <span className="login-method-title">打开窗口登录</span>
            <span className="login-method-desc">打开官方登录页，需要输入验证码时用这个</span>
          </button>
        </div>
      </Modal>

      <Modal
        open={authLoginOpen}
        title="权限号登录"
        onCancel={() => setAuthLoginOpen(false)}
        footer={null}
        width={420}
        destroyOnHidden
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          权限号只用于查询玩家数据，不会对玩家做任何操作。登录方式与客服号一致，登录后停在
          gm.tj.996sdk.com/myGame 即算登录成功。
        </Typography.Text>
        <div className="login-methods">
          <button
            className="login-method"
            onClick={() => {
              setAuthLoginOpen(false);
              setPwLogin({ username: '', password: '', kind: 'gmAuth' });
            }}
          >
            <span className="login-method-title">账号密码登录</span>
            <span className="login-method-desc">用 GM 站点（gm.tj.996sdk.com）的账号密码直接登录</span>
          </button>
          <button
            className="login-method"
            onClick={() => {
              setAuthLoginOpen(false);
              setPwLogin({ username: '', password: '', kind: 'gmAuth', autoDevice: true });
            }}
          >
            <span className="login-method-title">账号密码登录（自动读设备）</span>
            <span className="login-method-desc">
              设备 ID 不用输也不用跑脚本，从本机浏览器（Edge/Firefox/QQ/夸克）自动读取，免验证码
            </span>
          </button>
          <button
            className="login-method"
            onClick={() => {
              setAuthLoginOpen(false);
              void handleShowScript('gmAuth');
            }}
          >
            <span className="login-method-title">登录脚本导入</span>
            <span className="login-method-desc">在已经登录的浏览器控制台执行脚本，导入登录态</span>
          </button>
          <button
            className="login-method"
            onClick={() => {
              setAuthLoginOpen(false);
              void handleAddAuth();
            }}
          >
            <span className="login-method-title">打开窗口登录</span>
            <span className="login-method-desc">打开官方登录页，需要输入验证码时用这个</span>
          </button>
        </div>
      </Modal>

      <Modal
        open={qywxOpen}
        title="企微客服登录"
        onCancel={() => setQywxOpen(false)}
        onOk={handleQywxLogin}
        okText="登录"
        cancelText="取消"
        confirmLoading={qywxLoading}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="登录企微客服中心"
          description="填写企微客服中心的地址和账号密码，登录成功后账号会出现在左侧列表中。"
        />
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input
            placeholder="中心地址，如 http://127.0.0.1:9000"
            value={qywx.serverUrl}
            onChange={(e) => setQywx((s) => ({ ...s, serverUrl: e.target.value }))}
          />
          <Input
            autoFocus
            placeholder="账号"
            value={qywx.username}
            onChange={(e) => setQywx((s) => ({ ...s, username: e.target.value }))}
          />
          <Input.Password
            placeholder="密码"
            value={qywx.password}
            onChange={(e) => setQywx((s) => ({ ...s, password: e.target.value }))}
            onPressEnter={handleQywxLogin}
          />
        </Space>
      </Modal>

      <Modal
        open={!!pwLogin}
        title={pwLogin?.kind === 'gmAuth' ? '权限号登录' : '账号密码登录'}
        onCancel={() => setPwLogin(null)}
        onOk={handlePasswordLogin}
        okText="登录"
        cancelText="取消"
        confirmLoading={pwSubmitting}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="使用 GM 站点（gm.tj.996sdk.com）的账号密码"
          description={
            pwLogin?.autoDevice
              ? '设备 ID 不用手输：填好账号后会自动从本机浏览器（Edge/Firefox/QQ/夸克）读取该账号的设备凭证，登录免验证码。'
              : '服务端在「新设备」上会要求验证码。点「从本机浏览器自动获取」直接读设备凭证，或用 JS 脚本导入，这里就能直接登录。'
          }
        />
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input
            autoFocus
            placeholder="账号"
            value={pwLogin?.username || ''}
            onChange={(e) => setPwLogin((s) => ({ ...s, username: e.target.value, password: s?.password || '' }))}
            onBlur={() => {
              if (pwLogin?.autoDevice) void handleBrowserDevice(true);
            }}
          />
          <Input.Password
            placeholder="密码"
            value={pwLogin?.password || ''}
            onChange={(e) => setPwLogin((s) => ({ ...s, username: s?.username || '', password: e.target.value }))}
            onPressEnter={handlePasswordLogin}
          />
          <div className="device-cred">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {pwLogin?.username && settings?.deviceIds?.[pwLogin.username.trim()]
                ? '已导入设备凭证，登录可免验证码'
                : '没有设备凭证：新设备登录会被要求验证码'}
            </Typography.Text>
            <Space size={8}>
              <Button
                size="small"
                loading={browserDeviceLoading}
                disabled={!pwLogin?.username.trim()}
                onClick={() => void handleBrowserDevice()}
              >
                从本机浏览器自动获取
              </Button>
              <Button size="small" disabled={!pwLogin?.username.trim()} onClick={handleShowDeviceScript}>
                用 JS 脚本导入
              </Button>
            </Space>
          </div>
        </Space>
      </Modal>

      <Modal
        open={deviceOpen}
        title="导入设备凭证"
        width={720}
        onCancel={() => setDeviceOpen(false)}
        footer={[
          <Button key="copy" type="primary" onClick={handleCopyDeviceScript}>
            复制脚本
          </Button>,
          <Button key="close" onClick={() => setDeviceOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="使用步骤"
          description={
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li>
                在<b>已经登录过、且不用验证码</b>的那个浏览器里打开 https://gm.tj.996sdk.com
                {pwLogin?.kind === 'gmAuth' ? '/myGame' : '/myTool'}
              </li>
              <li>按 F12 打开控制台（Console），把下面的脚本粘进去回车</li>
              <li>看到「设备凭证已发送到 996 客服管理器」就完成了，回到这里直接点登录</li>
            </ol>
          }
        />
        <Input.TextArea value={deviceText} readOnly autoSize={{ minRows: 10, maxRows: 16 }} />
      </Modal>

      <Modal
        open={scriptOpen}
        title="登录脚本"
        width={760}
        onCancel={() => setScriptOpen(false)}
        footer={[
          <Button key="copy" type="primary" onClick={handleCopyScript}>
            复制脚本
          </Button>,
          <Button key="close" onClick={() => setScriptOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="使用步骤"
          description={
            <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li>
                在浏览器打开并登录 <b>https://gm.tj.996sdk.com/myTool</b>
              </li>
              <li>按 F12 打开控制台（Console），把下面的脚本粘进去回车</li>
              <li>看到「已发送到 996 客服管理器」就完成了；之后 token 失效时点账号上的「续期」即可</li>
              <li>
                脚本会一起带上 <b>deviceid</b>（站点判断是否「新设备登录」的凭据）：从这台浏览器导入后，
                以后在管理器里登录同一个账号就不用再输验证码
              </li>
            </ol>
          }
        />
        <Input.TextArea value={scriptText} readOnly autoSize={{ minRows: 12, maxRows: 18 }} />
      </Modal>

      <Modal
        open={!!gameBindGroup}
        title={`绑定游戏 · ${(settings?.groups || []).find((g) => g.id === gameBindGroup)?.name || ''}`}
        onCancel={() => setGameBindGroup('')}
        footer={null}
        width={520}
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="一个分组 = 一个游戏"
          description={
            <>
              该分组下的权限号查询玩家时，用的就是这里绑定的 gameId。
              {gamePickFrom && (
                <>
                  <br />
                  当前列表来自账号「{gamePickFrom}」的授权游戏；若不对，请右键要用的那个权限号 →
                  「绑定游戏」。
                </>
              )}
            </>
          }
        />
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Select
            showSearch
            allowClear
            loading={gamePicking}
            style={{ width: '100%' }}
            placeholder="从授权游戏列表中选择"
            optionFilterProp="label"
            value={gamePickValue || undefined}
            onChange={(v) => {
              const id = v || '';
              setGamePickValue(id);
              const g = gamePickList.find((x) => String(x.game_id) === String(id));
              if (g) void saveGroupGame(String(g.game_id), String(g.game_name || ''));
            }}
            options={gamePickList.map((g) => ({
              value: String(g.game_id),
              label: `${g.game_name}（${g.game_id}）`,
            }))}
          />
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="或手动填写 gameId"
              value={gameManualId}
              onChange={(e) => setGameManualId(e.target.value)}
            />
            <Button
              type="primary"
              disabled={!gameManualId.trim()}
              onClick={() => void saveGroupGame(gameManualId.trim(), gameManualId.trim())}
            >
              保存
            </Button>
          </Space.Compact>
          <Button danger disabled={!(settings?.groups || []).find((g) => g.id === gameBindGroup)?.gameId} onClick={() => void saveGroupGame('', '')}>
            清除绑定
          </Button>
        </Space>
      </Modal>
    </div>
  );
}
