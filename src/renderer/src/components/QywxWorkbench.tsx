import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  FileOutlined,
  PauseCircleFilled,
  PictureOutlined,
  PlayCircleFilled,
  PlusOutlined,
  PushpinOutlined,
  SendOutlined,
} from '@ant-design/icons';
import EmojiPicker from './EmojiPicker';
import ImagePreview from './ImagePreview';
import type { Account, QywxConversation, QywxMedia, QywxMessage } from '../types';

/** 会话在列表里的保留时间窗：24 小时（与网页端一致） */
const RETAIN_MS = 24 * 3600 * 1000;

/** 消息类型（与网页端 msg_type 映射一致） */
export const MSG_TYPE_NAME: Record<number, string> = {
  2: '文本',
  14: '图片',
  29: 'GIF',
  15: '文件',
  23: '视频',
  16: '语音',
  41: '名片',
  78: '小程序',
  141: '视频号',
  13: '卡片链接',
  6: '位置',
  4: '合并',
  2063: '撤回',
};

const convKeyOf = (robotId: number | string, contactUserId: string) => `${robotId}:${contactUserId}`;

const newTraceId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 媒体字段：服务端可能给对象，也可能给 JSON 字符串 */
export function mediaOf(m: QywxMessage): QywxMedia {
  const md = m.media;
  if (!md) return {};
  if (typeof md === 'object') return md;
  try {
    return JSON.parse(String(md));
  } catch {
    return {};
  }
}

/** 相对路径补上中心地址前缀 */
function absUrl(u: string, origin: string): string {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const base = origin.replace(/\/+$/, '');
  return base + (u.startsWith('/') ? u : `/${u}`);
}

/** 取媒体地址：local_url > url > path */
export function mediaUrl(m: QywxMessage, origin: string): string {
  const md = mediaOf(m);
  return absUrl(String(md.local_url || md.url || md.path || ''), origin);
}

export function fmtTime(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文件大小展示 */
function fmtSize(n: number): string {
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 会话预览文本 */
function previewOfMsg(m?: QywxMessage): string {
  if (!m) return '';
  const name = MSG_TYPE_NAME[Number(m.msg_type)] || '消息';
  const prefix = m.direction === 'out' ? '我: ' : '';
  if (Number(m.msg_type) === 2) return prefix + String(m.content || '');
  return prefix + `[${name}]`;
}

/** 会话预览文本：优先用本地最后一条消息，否则用会话列表接口给的摘要 */
function previewOfConv(c: QywxConversation): string {
  const last = c.messages[c.messages.length - 1];
  if (last) return previewOfMsg(last);
  if (!c.last_at && !c.last_content) return '';
  const name = MSG_TYPE_NAME[Number(c.last_msg_type)] || '消息';
  const prefix = c.last_direction === 'out' ? '我: ' : '';
  if (Number(c.last_msg_type) === 2) return prefix + String(c.last_content || '');
  return prefix + `[${name}]`;
}

/** 会话时间：本地最后一条消息优先，否则用 last_at */
function timeOfConv(c: QywxConversation): string {
  const last = c.messages[c.messages.length - 1];
  return fmtTime(last?.created_at || c.last_at);
}

/** 未读数：本地有消息时以「对方发来且未读」为准，否则用服务端给的兜底值 */
function unreadOf(c: QywxConversation): number {
  if (c.messages.length) {
    const n = c.messages.filter((m) => m.direction === 'in' && !m.read_at).length;
    if (n > 0) return n;
  }
  return c.fallback_unread || (c.manual_unread ? 1 : 0);
}

/** 最近活跃时间戳：本地最后一条消息优先，否则用 last_at */
function sortKeyOf(c: QywxConversation): number {
  const last = c.messages[c.messages.length - 1];
  const t = Date.parse(last?.created_at || c.last_at || '');
  return Number.isNaN(t) ? 0 : t;
}

function cloneConv(c: QywxConversation): QywxConversation {
  return { ...c, messages: c.messages.slice() };
}

/** 取会话（不存在则新建空会话），返回可安全修改的副本，已写回 map */
function ensureConv(map: Map<string, QywxConversation>, robotId: number | string, contactUserId: string): QywxConversation {
  const key = convKeyOf(robotId, contactUserId);
  const prev = map.get(key);
  const c: QywxConversation = prev
    ? cloneConv(prev)
    : {
        key,
        robot_id: robotId,
        contact_user_id: contactUserId,
        contact_nick: '',
        robot_name: '',
        online: false,
        pinned: false,
        manual_unread: false,
        avatar: '',
        fallback_unread: 0,
        messages: [],
      };
  map.set(key, c);
  return c;
}

/** 合并会话元信息（昵称/头像/在线/置顶/未读/最后一条摘要），字段存在时才覆盖 */
function applyConvMeta(c: QywxConversation, r: any) {
  if (r.contact_nick) c.contact_nick = String(r.contact_nick);
  if (r.robot_name) c.robot_name = String(r.robot_name);
  if (r.avatar !== undefined && r.avatar !== null) c.avatar = String(r.avatar);
  if (r.online !== undefined && r.online !== null) c.online = !!r.online;
  if (r.pinned !== undefined && r.pinned !== null) c.pinned = !!r.pinned;
  if (r.manual_unread !== undefined && r.manual_unread !== null) c.manual_unread = !!r.manual_unread;
  if (r.unread_count !== undefined && r.unread_count !== null) c.fallback_unread = Number(r.unread_count) || 0;
  if (r.last_content !== undefined && r.last_content !== null) c.last_content = String(r.last_content);
  if (r.last_msg_type !== undefined && r.last_msg_type !== null) c.last_msg_type = Number(r.last_msg_type);
  if (r.last_direction) c.last_direction = r.last_direction;
  if (r.last_at) c.last_at = r.last_at;
}

/** 一条消息合入会话（同 id 合并，否则按数值 id 升序插入） */
function applyMsg(map: Map<string, QywxConversation>, raw: any): QywxMessage | null {
  if (!raw) return null;
  const src = raw.message && typeof raw.message === 'object' ? { ...raw, ...raw.message } : raw;
  const robotId = src.robot_id ?? src.robotId;
  const contactUserId = src.contact_user_id ?? src.contactUserId;
  if (robotId === undefined || contactUserId === undefined) return null;
  const msg: QywxMessage = {
    ...src,
    id: String(src.id ?? newTraceId()),
    robot_id: robotId,
    contact_user_id: contactUserId,
  };
  const c = ensureConv(map, robotId, contactUserId);
  const list = c.messages;
  const idx = list.findIndex((x) => String(x.id) === String(msg.id));
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...msg };
  } else {
    const idn = Number(msg.id);
    let i = list.length;
    while (i > 0 && Number(list[i - 1].id) > idn) i--;
    list.splice(i, 0, msg);
  }
  return msg;
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(f);
  });
}

interface PendingItem {
  id: string;
  file: File;
  kind: 'image' | 'video';
  url: string;
}

/** 语音条：播放按钮 + 声波 + 时长，下面显示转写文本 */
function VoiceBubble({
  url,
  duration,
  text,
  busy,
  onTranscribe,
}: {
  url: string;
  duration: number;
  text?: string;
  busy: boolean;
  onTranscribe: () => void;
}) {
  const { message } = AntApp.useApp();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const sec = Math.max(1, Math.round(duration || 0));
  // 语音条宽度随时长增长，参考微信最长约 200px
  const barWidth = Math.min(200, 72 + sec * 6);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => message.warning('语音播放失败'));
    else a.pause();
  };

  return (
    <div className="qywx-voice">
      <button
        type="button"
        className={`qywx-voice-bar ${playing ? 'playing' : ''}`}
        style={{ width: barWidth }}
        onClick={toggle}
        title="点击播放语音"
      >
        <span className="qywx-voice-play">{playing ? <PauseCircleFilled /> : <PlayCircleFilled />}</span>
        <span className="qywx-voice-bars">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="qywx-voice-dur">{sec}″</span>
      </button>
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      {text ? (
        <div className="qywx-voice-text">{text}</div>
      ) : busy ? (
        <div className="qywx-voice-text muted">语音识别中…</div>
      ) : (
        <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={onTranscribe}>
          转文字
        </Button>
      )}
    </div>
  );
}

interface Props {
  account: Account;
  /** 是否为当前显示的账号。后台账号仍保持常驻与实时订阅，只隐藏界面 */
  visible: boolean;
  /** 未读总数变化时上报（左侧账号列表显示红点） */
  onUnreadChange?: (accountId: string, count: number) => void;
}

/** 企微客服工作台：左会话列表 + 中聊天记录 + 右快捷回复 */
export default function QywxWorkbench({ account, visible, onUnreadChange }: Props) {
  const { message, modal } = AntApp.useApp();
  const [convs, setConvs] = useState<Map<string, QywxConversation>>(new Map());
  const [activeKey, setActiveKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [preview, setPreview] = useState('');
  const [transcribing, setTranscribing] = useState<Set<string>>(new Set());

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<any>(null);
  const atBottomRef = useRef(true);
  const jumpingRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  /** 向上翻页时用于恢复滚动位置 */
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const activeKeyRef = useRef('');
  activeKeyRef.current = activeKey;
  /** 当前账号工作台是否在前台显示（后台时收到消息不自动标记已读） */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const active = convs.get(activeKey) || null;
  const origin = account.serverUrl || '';

  /** 未读总数上报给左侧账号列表（红点 + 条数） */
  const unreadCbRef = useRef(onUnreadChange);
  unreadCbRef.current = onUnreadChange;
  useEffect(() => {
    let total = 0;
    convs.forEach((c) => {
      total += unreadOf(c);
    });
    unreadCbRef.current?.(account.id, total);
  }, [convs, account.id]);

  /** 可见会话：24 小时内有消息，或本身有未读；当前打开的会话始终保留 */
  const list = useMemo(() => {
    const now = Date.now();
    const arr = Array.from(convs.values()).filter((c) => {
      if (c.key === activeKey) return true;
      const t = sortKeyOf(c);
      if (t > 0) return t >= now - RETAIN_MS;
      return c.fallback_unread > 0 || c.manual_unread;
    });
    arr.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return sortKeyOf(b) - sortKeyOf(a);
    });
    return arr;
  }, [convs, activeKey]);

  /* ---------------- 滚动 ---------------- */

  const scrollToBottom = (smooth = false) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const stickToBottom = useCallback(() => {
    atBottomRef.current = true;
    setShowJump(false);
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(() => scrollToBottom());
    });
  }, []);

  const jumpToBottom = () => {
    jumpingRef.current = true;
    atBottomRef.current = true;
    setShowJump(false);
    scrollToBottom(true);
    setTimeout(() => {
      jumpingRef.current = false;
    }, 400);
  };

  /* ---------------- 拉取数据 ---------------- */

  const loadConversations = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await window.kefu.qywxConversations(account.id);
      const map = new Map<string, QywxConversation>();
      (rows || []).forEach((r: any) => {
        const robotId = r.robot_id ?? r.robotId;
        const contactUserId = r.contact_user_id ?? r.contactUserId;
        if (robotId === undefined || contactUserId === undefined) return;
        const c = ensureConv(map, robotId, contactUserId);
        c.messages = [];
        applyConvMeta(c, r);
        (r.messages || []).forEach((m: any) => applyMsg(map, m));
      });
      setConvs(map);
      return map;
    } catch (e: any) {
      message.error(e?.message || '获取企微会话失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [account.id, message]);

  /** 打开会话：拉历史消息并标记已读 */
  const openConv = useCallback(
    async (c: QywxConversation) => {
      setActiveKey(c.key);
      setNoMore(false);
      setLoading(true);
      try {
        const rows = await window.kefu.qywxMessages(account.id, {
          robotId: c.robot_id,
          contactUserId: c.contact_user_id,
        });
        setConvs((prev) => {
          const map = new Map(prev);
          const base = map.get(c.key);
          if (base) map.set(c.key, { ...base, messages: [] });
          (rows || []).forEach((m: any) => applyMsg(map, { ...m, robot_id: c.robot_id, contact_user_id: c.contact_user_id }));
          return map;
        });
        if (unreadOf(c) > 0) {
          await window.kefu.qywxRead(account.id, { robotId: c.robot_id, contactUserId: c.contact_user_id }).catch(() => null);
          setConvs((prev) => {
            const cur = prev.get(c.key);
            if (!cur) return prev;
            const map = new Map(prev);
            map.set(c.key, {
              ...cur,
              fallback_unread: 0,
              manual_unread: false,
              messages: cur.messages.map((m) => (m.direction === 'in' && !m.read_at ? { ...m, read_at: new Date().toISOString() } : m)),
            });
            return map;
          });
        }
      } catch (e: any) {
        message.error(e?.message || '获取聊天记录失败');
      } finally {
        setLoading(false);
        prependRef.current = null;
        requestAnimationFrame(() => scrollToBottom());
      }
    },
    [account.id, message],
  );

  /* ---------------- 首屏加载 ---------------- */

  useEffect(() => {
    setConvs(new Map());
    setActiveKey('');
    setNoMore(false);
    void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);

  /* 切回该账号时，若还没有打开的会话则自动打开最近一条 */
  useEffect(() => {
    if (!visible || activeKeyRef.current) return;
    const first = Array.from(convs.values()).sort((a, b) => sortKeyOf(b) - sortKeyOf(a))[0];
    if (first) openConv(first);
  }, [visible, convs, openConv]);

  /* ---------------- 实时推送 ---------------- */

  useEffect(() => {
    const off = window.kefu.onQywxEvent(({ accountId, type, data }) => {
      if (accountId !== account.id) return;
      const d = data || {};
      if (type === 'snapshot') {
        const rows = d.conversations || d.items || (Array.isArray(d) ? d : []);
        const map = new Map<string, QywxConversation>();
        (rows || []).forEach((r: any) => {
          const robotId = r.robot_id ?? r.robotId;
          const contactUserId = r.contact_user_id ?? r.contactUserId;
          if (robotId === undefined || contactUserId === undefined) return;
          const c = ensureConv(map, robotId, contactUserId);
          c.messages = [];
          applyConvMeta(c, r);
          (r.messages || []).forEach((m: any) => applyMsg(map, m));
        });
        // 保留当前会话已加载的更早历史
        setConvs((prev) => {
          const cur = prev.get(activeKeyRef.current);
          const nextMap = map;
          if (cur) {
            const merged = ensureConv(nextMap, cur.robot_id, cur.contact_user_id);
            merged.messages = cur.messages;
          }
          return nextMap;
        });
        return;
      }

      if (type === 'message') {
        setConvs((prev) => {
          const map = new Map(prev);
          const msg = applyMsg(map, d);
          if (!msg) return map;
          const key = convKeyOf(msg.robot_id as any, msg.contact_user_id as any);
          // 推送里可能带上会话元信息（昵称/在线等），先合并
          const cur = ensureConv(map, msg.robot_id as any, msg.contact_user_id as any);
          applyConvMeta(cur, d);
          // 前台显示中、当前打开且是对方发来 -> 立即标记已读。
          // 后台账号不能标已读，否则左侧账号列表的红点永远不亮。
          if (visibleRef.current && key === activeKeyRef.current && msg.direction === 'in') {
            msg.read_at = new Date().toISOString();
            cur.fallback_unread = 0;
            cur.manual_unread = false;
            window.kefu
              .qywxRead(account.id, { robotId: msg.robot_id as any, contactUserId: msg.contact_user_id as any })
              .catch(() => null);
          }
          return map;
        });
        if (activeKeyRef.current && atBottomRef.current) stickToBottom();
        // 对方发来新消息 -> 按设置弹提醒（系统通知 / 屏幕居中置顶弹窗）。
        // 当前正在前台看这条会话时不打扰；后台账号、别的会话都要提醒。
        const nested = d.message && typeof d.message === 'object' ? d.message : null;
        const src: any = nested ? { ...d, ...nested } : d;
        const inRobotId = src.robot_id ?? src.robotId;
        const inContactId = src.contact_user_id ?? src.contactUserId;
        if (src.direction === 'in' && inRobotId !== undefined && inContactId !== undefined) {
          const inKey = convKeyOf(inRobotId, inContactId);
          if (!(visibleRef.current && inKey === activeKeyRef.current)) {
            void window.kefu
              .notifyNewSession({
                accountId: account.id,
                sessionId: inKey,
                messageSessionId: String(inContactId),
                visitorName: String(src.contact_nick || inContactId),
                content: previewOfMsg(src as QywxMessage),
                title: '企微新消息',
              })
              .catch(() => null);
          }
        }
        return;
      }

      if (type === 'message-updated') {
        setConvs((prev) => {
          const map = new Map(prev);
          applyMsg(map, d);
          return map;
        });
        return;
      }

      if (type === 'messages-read') {
        const ids = new Set((d.ids || []).map((x: any) => String(x)));
        setConvs((prev) => {
          const map = new Map<string, QywxConversation>();
          prev.forEach((c, k) => {
            const nc = cloneConv(c);
            nc.messages = nc.messages.map((m) =>
              ids.has(String(m.id)) && !m.read_at ? { ...m, read_at: new Date().toISOString(), read_by: d.read_by } : m,
            );
            map.set(k, nc);
          });
          return map;
        });
        return;
      }

      if (type === 'conversation-unread') {
        const robotId = d.robot_id ?? d.robotId;
        const contactUserId = d.contact_user_id ?? d.contactUserId;
        if (robotId === undefined || contactUserId === undefined) return;
        setConvs((prev) => {
          const map = new Map(prev);
          const c = ensureConv(map, robotId, contactUserId);
          c.manual_unread = !!d.manual_unread;
          return map;
        });
        return;
      }

      if (type === 'conversation-pinned') {
        const robotId = d.robot_id ?? d.robotId;
        const contactUserId = d.contact_user_id ?? d.contactUserId;
        if (robotId === undefined || contactUserId === undefined) return;
        setConvs((prev) => {
          const map = new Map(prev);
          const c = ensureConv(map, robotId, contactUserId);
          c.pinned = !!d.pinned;
          return map;
        });
        return;
      }

      if (type === 'conversation-deleted') {
        const robotId = d.robot_id ?? d.robotId;
        const contactUserId = d.contact_user_id ?? d.contactUserId;
        if (robotId === undefined || contactUserId === undefined) return;
        const key = convKeyOf(robotId, contactUserId);
        setConvs((prev) => {
          const map = new Map(prev);
          map.delete(key);
          return map;
        });
        if (activeKeyRef.current === key) setActiveKey('');
      }
    });
    return off;
  }, [account.id, stickToBottom]);

  /* ---------------- 向上翻页 ---------------- */

  const loadMore = useCallback(async () => {
    const c = convs.get(activeKeyRef.current);
    if (!c || !c.messages.length || loadingMore || noMore || loading) return;
    const el = bodyRef.current;
    if (el) prependRef.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingMore(true);
    try {
      const firstId = c.messages[0].id;
      const rows = await window.kefu.qywxMessages(account.id, {
        robotId: c.robot_id,
        contactUserId: c.contact_user_id,
        beforeId: firstId,
      });
      if (!rows || rows.length === 0) {
        setNoMore(true);
        prependRef.current = null;
      } else {
        setConvs((prev) => {
          const map = new Map(prev);
          const cur = ensureConv(map, c.robot_id, c.contact_user_id);
          cur.messages = cur.messages.slice();
          (rows || []).forEach((m: any) => applyMsg(map, { ...m, robot_id: c.robot_id, contact_user_id: c.contact_user_id }));
          return map;
        });
      }
    } catch (e: any) {
      message.error(e?.message || '加载更早消息失败');
      prependRef.current = null;
    } finally {
      setLoadingMore(false);
    }
  }, [account.id, convs, loading, loadingMore, noMore, message]);

  /** 翻页插入了更早的消息：保持视口位置不跳 */
  useEffect(() => {
    const p = prependRef.current;
    const el = bodyRef.current;
    if (!p || !el) return;
    el.scrollTop = el.scrollHeight - p.height + p.top;
    prependRef.current = null;
  }, [convs]);

  const handleScroll = () => {
    if (jumpingRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
    atBottomRef.current = near;
    setShowJump(!near);
    if (el.scrollTop <= 40) loadMore();
  };

  /* ---------------- 会话操作 ---------------- */

  const pinConv = async (c: QywxConversation) => {
    const next = !c.pinned;
    setConvs((prev) => {
      const map = new Map(prev);
      const cur = ensureConv(map, c.robot_id, c.contact_user_id);
      cur.pinned = next;
      return map;
    });
    try {
      await window.kefu.qywxPin(account.id, { robotId: c.robot_id, contactUserId: c.contact_user_id, pinned: next });
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  const markRead = async (c: QywxConversation) => {
    setConvs((prev) => {
      const map = new Map(prev);
      const cur = ensureConv(map, c.robot_id, c.contact_user_id);
      cur.fallback_unread = 0;
      cur.manual_unread = false;
      cur.messages = cur.messages.map((m) => (m.direction === 'in' && !m.read_at ? { ...m, read_at: new Date().toISOString() } : m));
      return map;
    });
    try {
      await window.kefu.qywxRead(account.id, { robotId: c.robot_id, contactUserId: c.contact_user_id });
    } catch (e: any) {
      message.error(e?.message || '标记已读失败');
    }
  };

  /**
   * 已读只在「进入窗口」时发生：切到本账号前台时，把当前打开的会话标记已读。
   * 后台账号（visible=false）收到消息不标记，左侧红点才会亮。
   */
  useEffect(() => {
    if (!visible) return;
    const c = convs.get(activeKeyRef.current);
    if (c && unreadOf(c) > 0) void markRead(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const markUnread = async (c: QywxConversation) => {
    setConvs((prev) => {
      const map = new Map(prev);
      const cur = ensureConv(map, c.robot_id, c.contact_user_id);
      cur.manual_unread = true;
      cur.fallback_unread = 0;
      return map;
    });
    try {
      await window.kefu.qywxSetUnread(account.id, { robotId: c.robot_id, contactUserId: c.contact_user_id });
    } catch (e: any) {
      message.error(e?.message || '标记未读失败');
    }
  };

  const removeConv = (c: QywxConversation) => {
    const title = c.contact_nick || c.contact_user_id;
    modal.confirm({
      title: `删除与「${title}」的会话？`,
      content: '消息记录会保留，客户再发消息会自动回来',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await window.kefu.qywxRemoveConversation(account.id, {
            robotId: c.robot_id,
            contactUserId: c.contact_user_id,
          });
          setConvs((prev) => {
            const map = new Map(prev);
            map.delete(c.key);
            return map;
          });
          if (activeKeyRef.current === c.key) setActiveKey('');
        } catch (e: any) {
          message.error(e?.message || '删除会话失败');
        }
      },
    });
  };

  /** 全部标为已读 */
  const markAllRead = async () => {
    const targets = list.filter((c) => unreadOf(c) > 0);
    if (!targets.length) {
      message.info('没有未读会话');
      return;
    }
    setMarkingAll(true);
    let ok = 0;
    for (const c of targets) {
      try {
        await window.kefu.qywxRead(account.id, { robotId: c.robot_id, contactUserId: c.contact_user_id });
        ok++;
      } catch {
        /* 单个失败继续 */
      }
    }
    setConvs((prev) => {
      const map = new Map<string, QywxConversation>();
      prev.forEach((c, k) => {
        const nc = cloneConv(c);
        nc.fallback_unread = 0;
        nc.manual_unread = false;
        nc.messages = nc.messages.map((m) => (m.direction === 'in' && !m.read_at ? { ...m, read_at: new Date().toISOString() } : m));
        map.set(k, nc);
      });
      return map;
    });
    setMarkingAll(false);
    message.success(`已将 ${ok}/${targets.length} 个会话标为已读`);
  };

  /* ---------------- 发送 ---------------- */

  const submit = async () => {
    const content = text.trim();
    if (!content || !active || sending) return;
    setSending(true);
    try {
      const r = await window.kefu.qywxReply(account.id, {
        robotId: active.robot_id,
        contactUserId: active.contact_user_id,
        msgType: 2,
        content,
        traceId: newTraceId(),
      });
      if (r) {
        setConvs((prev) => {
          const map = new Map(prev);
          applyMsg(map, { ...r, robot_id: active.robot_id, contact_user_id: active.contact_user_id });
          return map;
        });
      }
      setText('');
      stickToBottom();
    } catch (e: any) {
      message.error(e?.message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  const addFiles = (files: File[]) => {
    const items: PendingItem[] = files
      .filter((f) => f.type.startsWith('image') || f.type.startsWith('video'))
      .map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file: f,
        kind: f.type.startsWith('image') ? 'image' : 'video',
        url: URL.createObjectURL(f),
      }));
    if (items.length) setPending((p) => [...p, ...items]);
  };

  const removePending = (id: string) => {
    setPending((p) => {
      const it = p.find((x) => x.id === id);
      if (it?.url) URL.revokeObjectURL(it.url);
      return p.filter((x) => x.id !== id);
    });
  };

  const cancelPending = () => {
    setPending((p) => {
      p.forEach((it) => it.url && URL.revokeObjectURL(it.url));
      return [];
    });
  };

  const sendPending = async () => {
    if (!active || !pending.length || sending) return;
    setSending(true);
    const items = [...pending];
    try {
      for (const it of items) {
        const base64 = await fileToBase64(it.file);
        const up = await window.kefu.qywxUpload(account.id, {
          kind: it.kind,
          name: it.file.name,
          type: it.file.type,
          base64,
        });
        const r = await window.kefu.qywxReply(account.id, {
          robotId: active.robot_id,
          contactUserId: active.contact_user_id,
          msgType: it.kind === 'image' ? 14 : 23,
          ...(it.kind === 'image' ? { imagePath: up.url } : { videoPath: up.url }),
          traceId: newTraceId(),
        });
        if (r) {
          setConvs((prev) => {
            const map = new Map(prev);
            applyMsg(map, { ...r, robot_id: active.robot_id, contact_user_id: active.contact_user_id });
            return map;
          });
        }
      }
      cancelPending();
      stickToBottom();
    } catch (e: any) {
      message.error(e?.message || '发送附件失败');
    } finally {
      setSending(false);
    }
  };

  /* ---------------- 语音转写 ---------------- */

  const transcribe = async (m: QywxMessage) => {
    const id = String(m.id);
    setTranscribing((s) => new Set(s).add(id));
    try {
      const r = await window.kefu.qywxTranscribe(account.id, { id: m.id });
      const t = String(r?.text || '');
      if (!t) {
        message.warning('没有识别到文字');
        return;
      }
      setConvs((prev) => {
        const map = new Map(prev);
        const c = map.get(convKeyOf(m.robot_id as any, m.contact_user_id as any));
        if (!c) return prev;
        const nc = cloneConv(c);
        nc.messages = nc.messages.map((x) =>
          String(x.id) === id ? { ...x, media: { ...mediaOf(x), voice_text: t } } : x,
        );
        map.set(c.key, nc);
        return map;
      });
    } catch (e: any) {
      message.error(e?.message || '转写失败');
    } finally {
      setTranscribing((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  /* ---------------- 渲染 ---------------- */

  const renderSession = (c: QywxConversation) => {
    const unread = unreadOf(c);
    const title = c.contact_nick || c.contact_user_id;
    return (
      <Dropdown
        key={c.key}
        trigger={['contextMenu']}
        menu={{
          items: [
            { key: 'pin', label: c.pinned ? '取消置顶' : '置顶' },
            { key: 'read', label: '标记已读' },
            { key: 'unread', label: '标记未读' },
            { type: 'divider' as const },
            { key: 'delete', label: '删除会话', danger: true },
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'pin') pinConv(c);
            else if (key === 'read') markRead(c);
            else if (key === 'unread') markUnread(c);
            else if (key === 'delete') removeConv(c);
          },
        }}
      >
        <div className={`session-item ${activeKey === c.key ? 'active' : ''}`} onClick={() => openConv(c)}>
          <div className="session-row">
            <span className="session-name">{title}</span>
            <span className="session-time">{timeOfConv(c)}</span>
            {c.pinned && <PushpinOutlined className="qywx-pin-icon" />}
          </div>
          <div className="session-row" style={{ marginTop: 4 }}>
            <span className="session-last">{previewOfConv(c) || '(无消息)'}</span>
            {!!unread && <Badge count={unread > 99 ? '99+' : unread} />}
          </div>
        </div>
      </Dropdown>
    );
  };

  const renderMessage = (m: QywxMessage) => {
    const mine = m.direction === 'out';
    if (Number(m.msg_type) === 2063) {
      return (
        <div className="msg system" key={m.id}>
          <span className="system-pill">{mine ? '你撤回了一条消息' : '对方撤回了一条消息'}</span>
        </div>
      );
    }
    const type = Number(m.msg_type);
    const url = mediaUrl(m, origin);
    const md = mediaOf(m);
    const imageLike = type === 14 || type === 29;
    /** 图片/视频/语音自带卡面，不用文字气泡的底色 */
    const mediaBubble = imageLike || type === 23 || type === 16;

    const menuItems = [
      ...(type === 2 ? [{ key: 'copy', label: '复制文字' }] : []),
      ...(imageLike && url ? [{ key: 'copyImg', label: '复制图片' }] : []),
      ...(url ? [{ key: 'save', label: '另存为…' }] : []),
    ];

    const saveAs = () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = String(md.filename || '');
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };

    let body: ReactNode;
    if (type === 2) {
      body = <span>{String(m.content || '')}</span>;
    } else if (imageLike && url) {
      body = <img className="chat-img" src={url} alt="" onClick={() => setPreview(url)} />;
    } else if (type === 23 && url) {
      body = (
        <div className="qywx-video">
          <video className="chat-video" src={url} controls preload="metadata" />
          <a className="qywx-video-save" href={url} target="_blank" rel="noreferrer" download>
            <DownloadOutlined /> 保存视频
          </a>
        </div>
      );
    } else if (type === 16) {
      body = (
        <VoiceBubble
          url={url}
          duration={Number(md.duration || 0)}
          text={md.voice_text}
          busy={transcribing.has(String(m.id))}
          onTranscribe={() => void transcribe(m)}
        />
      );
    } else if (type === 15 && url) {
      const fname = String(md.filename || md.file_name || '文件');
      const fsize = Number(md.size || 0);
      body = (
        <a className="chat-file" href={url} target="_blank" rel="noreferrer" download title={fname}>
          <FileOutlined className="chat-file-icon" />
          <span className="chat-file-meta">
            <span className="chat-file-name">{fname}</span>
            {fsize > 0 && <span className="chat-file-size">{fmtSize(fsize)}</span>}
          </span>
          <DownloadOutlined className="chat-file-dl" />
        </a>
      );
    } else if (url) {
      body = (
        <a className="chat-file" href={url} target="_blank" rel="noreferrer">
          [{MSG_TYPE_NAME[type] || '媒体'}] {String(md.filename || '')}
        </a>
      );
    } else {
      body = <span>[{MSG_TYPE_NAME[type] || '未知消息'}]</span>;
    }

    return (
      <div className={`msg ${mine ? 'mine' : ''}`} key={m.id}>
        {!mine && <Avatar size={32} className="qywx-avatar">{(active?.contact_nick || '?').slice(0, 1)}</Avatar>}
        <div className="msg-content">
          <Dropdown
            trigger={['contextMenu']}
            menu={{
              items: menuItems,
              onClick: async ({ key }) => {
                if (key === 'copy') {
                  const selected = (window.getSelection()?.toString() || '').trim();
                  try {
                    await navigator.clipboard.writeText(selected || String(m.content || ''));
                    message.success('已复制');
                  } catch {
                    message.error('复制失败');
                  }
                } else if (key === 'copyImg') {
                  try {
                    await window.kefu.copyImage(url);
                    message.success('图片已复制');
                  } catch (e: any) {
                    message.error(e?.message || '复制图片失败');
                  }
                } else if (key === 'save') {
                  saveAs();
                }
              },
            }}
          >
            <div className={`bubble ${mediaBubble ? 'media' : ''}`}>{body}</div>
          </Dropdown>
          <div className="msg-time">
            {fmtTime(m.created_at)}
            {!!m.send_error && <span className="qywx-send-err">发送失败</span>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="workspace" style={visible ? undefined : { display: 'none' }}>
      <div className="session-col">
        <div className="session-tabs qywx-session-tabs">
          <Typography.Text strong>企微会话 ({list.length})</Typography.Text>
          <Button size="small" type="link" icon={<CheckOutlined />} loading={markingAll} onClick={markAllRead}>
            全部已读
          </Button>
        </div>
        <div className="session-ul">
          {loading && list.length === 0 ? (
            <div className="center-tip">
              <Spin />
            </div>
          ) : list.length === 0 ? (
            <Empty style={{ marginTop: 48 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />
          ) : (
            list.map(renderSession)
          )}
        </div>
      </div>

      <div className="chat-col">
        <div className="chat-main">
          {active ? (
            <>
              <div className="chat-header">
                <div>
                  <Typography.Text strong>{active.contact_nick || active.contact_user_id}</Typography.Text>
                  <Tag color={active.online ? 'green' : 'default'} style={{ marginLeft: 8 }}>
                    {active.online ? '在线' : '离线'}
                  </Tag>
                  {active.robot_name && (
                    <Typography.Text type="secondary" style={{ marginLeft: 4, fontSize: 12 }}>
                      {active.robot_name}
                    </Typography.Text>
                  )}
                </div>
              </div>

              <div className="chat-body-wrap">
                <div className="chat-body" ref={bodyRef} onScroll={handleScroll}>
                  {loadingMore && <div className="qywx-load-more">加载更早的消息…</div>}
                  {!loadingMore && noMore && active.messages.length > 0 && (
                    <div className="qywx-load-more">没有更早的消息了</div>
                  )}
                  {loading && active.messages.length === 0 ? (
                    <div className="center-tip">
                      <Spin />
                    </div>
                  ) : active.messages.length === 0 ? (
                    <div className="center-tip">
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史消息" />
                    </div>
                  ) : (
                    active.messages.map(renderMessage)
                  )}
                </div>
                {showJump && (
                  <Button className="scroll-bottom-btn" shape="circle" size="small" icon={<DownOutlined />} onClick={jumpToBottom} />
                )}
              </div>

              <div className="chat-footer">
                {pending.length > 0 && (
                  <div className="pending-bar">
                    <div className="pending-list">
                      {pending.map((it) => (
                        <div className="pending-item" key={it.id}>
                          {it.kind === 'image' ? <img src={it.url} alt="" /> : <video src={it.url} muted />}
                          <CloseOutlined className="pending-del" onClick={() => removePending(it.id)} />
                        </div>
                      ))}
                    </div>
                    <Space>
                      <Button size="small" onClick={cancelPending} disabled={sending}>
                        取消
                      </Button>
                      <Button size="small" type="primary" icon={<SendOutlined />} loading={sending} onClick={sendPending}>
                        发送({pending.length})
                      </Button>
                    </Space>
                  </div>
                )}

                <Input.TextArea
                  ref={inputRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="输入回复内容，Enter 发送，Shift+Enter 换行；点图片按钮选图，或 Ctrl+V 粘贴 / 直接拖入"
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData?.files || []);
                    if (files.length) {
                      e.preventDefault();
                      addFiles(files);
                    }
                  }}
                  onPressEnter={(e) => {
                    if (!e.shiftKey) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                />
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Space>
                    <Upload
                      showUploadList={false}
                      accept="image/*,video/*"
                      beforeUpload={(f) => {
                        addFiles([f as unknown as File]);
                        return false;
                      }}
                    >
                      <Button icon={<PictureOutlined />} disabled={sending}>
                        图片 / 视频
                      </Button>
                    </Upload>
                    <EmojiPicker
                      disabled={sending}
                      onPick={(emoji) => {
                        const el: HTMLTextAreaElement | undefined = inputRef.current?.resizableTextArea?.textArea;
                        const start = el?.selectionStart ?? text.length;
                        const end = el?.selectionEnd ?? text.length;
                        setText(text.slice(0, start) + emoji + text.slice(end));
                        if (el) {
                          requestAnimationFrame(() => {
                            el.focus();
                            const p = start + emoji.length;
                            el.setSelectionRange(p, p);
                          });
                        }
                      }}
                    />
                  </Space>
                  <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={submit}>
                    发送
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="center-tip">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择一条会话" />
            </div>
          )}
        </div>

        <QywxQuickPanel
          accountId={account.id}
          robotId={active?.robot_id ?? null}
          onPick={(content) => {
            setText(content);
            inputRef.current?.focus?.();
          }}
        />
      </div>

      {preview && <ImagePreview url={preview} onClose={() => setPreview('')} />}
    </div>
  );
}

/* ---------------- 右上快捷回复（服务端存储） ---------------- */

function QywxQuickPanel({
  accountId,
  robotId,
  onPick,
}: {
  accountId: string;
  robotId: number | string | null;
  onPick: (content: string) => void;
}) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<{ id: string; content: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ id: string; content: string } | null>(null);

  const load = useCallback(async () => {
    if (robotId === null || robotId === undefined) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await window.kefu.qywxQuickReplies(accountId, { robotId });
      setItems(
        (rows || []).map((r: any) => ({
          id: String(r.id),
          content: String(r.content ?? r.text ?? ''),
        })),
      );
    } catch (e: any) {
      message.error(e?.message || '获取快捷回复失败');
    } finally {
      setLoading(false);
    }
  }, [accountId, robotId, message]);

  useEffect(() => {
    setSelected([]);
    setEditor(null);
    load();
  }, [load]);

  const submitEditor = async () => {
    if (!editor || robotId === null) return;
    const content = editor.content.trim();
    if (!content) {
      message.warning('请输入快捷回复内容');
      return;
    }
    setSaving(true);
    try {
      if (editor.id) await window.kefu.qywxQuickReplyUpdate(accountId, { robotId, id: editor.id, content });
      else await window.kefu.qywxQuickReplyAdd(accountId, { robotId, content });
      setEditor(null);
      await load();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const removeOne = async (id: string) => {
    if (robotId === null) return;
    setSaving(true);
    try {
      await window.kefu.qywxQuickReplyDelete(accountId, { robotId, id });
      await load();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    } finally {
      setSaving(false);
    }
  };

  const removeSelected = async () => {
    if (!selected.length) {
      message.warning('请先勾选要删除的快捷回复');
      return;
    }
    setSaving(true);
    try {
      for (const id of selected) await window.kefu.qywxQuickReplyDelete(accountId, { robotId: robotId as any, id });
      setSelected([]);
      await load();
    } catch (e: any) {
      message.error(e?.message || '删除失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="quick-col">
      <div className="quick-header">
        <Typography.Text strong>快捷回复</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {items.length} 条
        </Typography.Text>
      </div>

      <div className="quick-list">
        {robotId === null ? (
          <div className="center-tip">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择会话" />
          </div>
        ) : loading && items.length === 0 ? (
          <div className="center-tip">
            <Spin />
          </div>
        ) : items.length === 0 ? (
          <div className="center-tip">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有快捷回复" />
          </div>
        ) : (
          items.map((it) => (
            <div className="quick-item" key={it.id} title={it.content} onClick={() => onPick(it.content)}>
              <div className="quick-text">{it.content}</div>
            </div>
          ))
        )}
      </div>

      <div className="quick-footer">
        <Tooltip title={robotId === null ? '先选择一条会话' : ''}>
          <Button block icon={<EditOutlined />} disabled={robotId === null} onClick={() => setManageOpen(true)}>
            编辑
          </Button>
        </Tooltip>
      </div>

      <Modal
        open={manageOpen}
        title="快捷回复管理"
        width={520}
        destroyOnHidden
        onCancel={() => setManageOpen(false)}
        footer={<Button onClick={() => setManageOpen(false)}>关闭</Button>}
      >
        <Space style={{ marginBottom: 8 }} wrap>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={saving}
            onClick={() => setEditor({ id: '', content: '' })}
          >
            新增
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            disabled={saving || !selected.length}
            onClick={removeSelected}
          >
            删除选中{selected.length ? `(${selected.length})` : ''}
          </Button>
        </Space>

        <div className="quick-mgr-list">
          {items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有快捷回复" />
          ) : (
            items.map((it) => (
              <div className="quick-mgr-item" key={it.id}>
                <Checkbox
                  checked={selected.includes(it.id)}
                  onChange={() => setSelected((sel) => (sel.includes(it.id) ? sel.filter((x) => x !== it.id) : [...sel, it.id]))}
                />
                <span className="quick-mgr-text">{it.content}</span>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setEditor({ id: it.id, content: it.content })}
                />
                <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => removeOne(it.id)} />
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal
        open={!!editor}
        title={editor?.id ? '编辑快捷回复' : '新增快捷回复'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
        onOk={submitEditor}
        onCancel={() => setEditor(null)}
      >
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 8 }}
          maxLength={500}
          showCount
          value={editor?.content || ''}
          placeholder="请输入快捷回复内容"
          onChange={(e) => setEditor((s) => (s ? { ...s, content: e.target.value } : s))}
        />
      </Modal>
    </div>
  );
}
