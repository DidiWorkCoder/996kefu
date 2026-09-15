import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App as AntApp, Avatar, Button, Empty, Input, Space, Spin, Tag, Typography } from 'antd';
import { CloseOutlined, DownloadOutlined, FileOutlined, SendOutlined } from '@ant-design/icons';
import ChatPanel from './components/ChatPanel';
import { MSG_TYPE_NAME, fmtTime, mediaOf, mediaUrl } from './components/QywxWorkbench';
import { showApiError } from './apiError';
import type { Account, ChatMessage, QywxMessage, QuickReply, Session, Settings } from './types';

/** 发送消息时必须带 messageSessionRecordId */
const recordIdOf = (s: Session) => s.messageSessionRecordId || s.messageSessionRecord?.id || '';
/** 发送消息时必须带 customerServiceGroupId */
const groupIdOf = (s: Session) => s.messageSessionRecord?.customerServiceGroupId || (s as any).customerServiceGroupId || '';

interface Target {
  accountId: string;
  sessionId: string;
  /** 会话的消息接口 id：带上它就能和账号/设置并行加载，弹出后立刻出聊天记录 */
  messageSessionId: string;
  /** 访客昵称（企微：客户昵称），先显示在标题上，不用等消息拉回来 */
  visitorName: string;
}

/** 来消息时居中置顶弹出的提醒窗：直接显示该会话的聊天记录和回复框 */
export default function NotifyWindow() {
  const { message } = AntApp.useApp();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [target, setTarget] = useState<Target>(() => ({
    accountId: params.get('accountId') || '',
    sessionId: params.get('sessionId') || '',
    messageSessionId: params.get('messageSessionId') || '',
    visitorName: params.get('visitorName') || '',
  }));
  const { accountId, sessionId, messageSessionId, visitorName } = target;

  const [account, setAccount] = useState<Account | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);

  /** 企微账号走自己的消息接口与实时事件，与 996 的会话/消息模型完全不同 */
  const isQywx = account?.kind === 'qywx';

  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  /** 切换会话后，丢弃上一次会话还没回来的响应 */
  const targetRef = useRef(target);
  targetRef.current = target;

  const loadSession = useCallback(async () => {
    if (!accountId) return;
    try {
      const b = await window.kefu.sessions(accountId);
      if (targetRef.current.accountId !== accountId) return;
      const all: Session[] = [...(b?.onlineSessionList || []), ...(b?.queueSessionList || []), ...(b?.endSessionList || [])];
      const hit = all.find((s) => s.id === sessionId);
      if (hit && targetRef.current.sessionId === sessionId) setSession(hit);
    } catch {
      /* ignore */
    }
  }, [accountId, sessionId]);

  const reloadMessages = useCallback(
    async (s: Session | null) => {
      const t = targetRef.current;
      const sid = s?.messageSessionId || t.messageSessionId;
      if (!sid || !t.accountId) return;
      try {
        const d = await window.kefu.messages(t.accountId, { messageSessionId: sid, pageNum: 1, pageSize: 50 });
        if (targetRef.current.sessionId !== t.sessionId) return;
        setMessages(((d.records || []) as ChatMessage[]).slice().reverse());
      } catch {
        /* ignore */
      }
    },
    [],
  );

  /** 主进程复用同一个窗口时，直接推会话过来：换会话不重载页面，同一会话只刷新消息 */
  useEffect(() => {
    const off = window.kefu?.onNotifySwitch?.((p: any) => {
      const next: Target = {
        accountId: String(p?.accountId || ''),
        sessionId: String(p?.sessionId || ''),
        messageSessionId: String(p?.messageSessionId || ''),
        visitorName: String(p?.visitorName || ''),
      };
      const prev = targetRef.current;
      if (prev.accountId === next.accountId && prev.sessionId === next.sessionId) {
        void reloadMessages(sessionRef.current);
        return;
      }
      setTarget(next);
    });
    return () => off?.();
  }, [reloadMessages]);

  // 初始化：账号 / 设置 / 会话 / 消息，弹出后尽快出内容
  useEffect(() => {
    // 没有 preload（例如在浏览器里直接打开）时不至于白屏
    if (!window.kefu) {
      setLoading(false);
      return;
    }
    let alive = true;
    const t = { accountId, sessionId, messageSessionId };
    setLoading(true);
    setMessages([]);
    setSession(null);

    const pSettings = window.kefu
      .settings()
      .then((s) => {
        if (alive) setSettings(s as Settings);
      })
      .catch(() => {});

    void (async () => {
      // 先判定账号类型：企微走自己的接口，996 才走会话/消息接口
      const list = await window.kefu.listAccounts().catch(() => []);
      if (!alive) return;
      const acc = ((list || []) as Account[]).find((a) => a.id === t.accountId) || null;
      setAccount(acc);
      if (acc?.kind === 'qywx') {
        // 消息由 QywxNotifyView 自己拉取
        setLoading(false);
        await pSettings;
        return;
      }
      const d = t.messageSessionId
        ? await window.kefu
            .messages(t.accountId, { messageSessionId: t.messageSessionId, pageNum: 1, pageSize: 50 })
            .catch(() => null)
        : null;
      await Promise.all([pSettings, loadSession()]);
      if (!alive || targetRef.current.sessionId !== t.sessionId) return;
      if (d) setMessages(((d.records || []) as ChatMessage[]).slice().reverse());
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [accountId, sessionId, messageSessionId, loadSession]);

  // 轮询：会话信息 + 消息（3s）；企微由 QywxNotifyView 自己刷新
  useEffect(() => {
    if (loading || isQywx) return;
    const timer = setInterval(() => {
      void loadSession();
      void reloadMessages(sessionRef.current);
    }, 3000);
    return () => clearInterval(timer);
  }, [loading, isQywx, loadSession, reloadMessages]);

  // 实时刷新：WS 有变动、或设置被改（快捷回复/关键词）时
  useEffect(() => {
    if (!window.kefu?.onWsEvent) return;
    const offWs = window.kefu.onWsEvent((p: any) => {
      if (isQywx) return;
      if (p?.accountId !== accountId) return;
      if (p?.data?.type === 'PONG') return;
      void reloadMessages(sessionRef.current);
    });
    const offSettings = window.kefu.onSettingsChanged(() =>
      void window.kefu
        .settings()
        .then((s) => setSettings(s as Settings))
        .catch(() => {}),
    );
    return () => {
      offWs();
      offSettings();
    };
  }, [accountId, isQywx, reloadMessages]);

  const handleSend = async (content: string) => {
    if (!session) return;
    setSending(true);
    try {
      await window.kefu.send(accountId, {
        messageSessionId: session.messageSessionId,
        messageSessionRecordId: recordIdOf(session),
        customerServiceGroupId: groupIdOf(session),
        visitorId: session.visitorId,
        visitorName: session.visitorName,
        content,
      });
      await reloadMessages(session);
    } catch (e: any) {
      showApiError(message, e, '发送失败');
      throw e;
    } finally {
      setSending(false);
    }
  };

  /** 上传文件（图片/视频/文件）后自动发送，msgType: 5=图片 6=视频 7=文件 */
  const handleUpload = async (file: File) => {
    if (!session || !accountId) return;
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
      const url = await window.kefu.upload(accountId, { name: file.name, type: file.type, base64 });
      const isImage = file.type.startsWith('image');
      const isVideo = file.type.startsWith('video');
      const msgType = isImage ? 5 : isVideo ? 6 : 7;
      const content = isImage
        ? `<img class='send-img' src="${url}"></img>`
        : isVideo
          ? `<video src="${url}" preload="metadata" crossorigin='anonymous' autoplay controls class='send-video'></video>`
          : `<a href="${url}" download class='send-file' target="_blank">${file.name}</a>`;
      await window.kefu.send(accountId, {
        messageSessionId: session.messageSessionId,
        messageSessionRecordId: recordIdOf(session),
        customerServiceGroupId: groupIdOf(session),
        visitorId: session.visitorId,
        visitorName: session.visitorName,
        content,
        msgType,
      });
      await reloadMessages(session);
      message.success('已发送');
    } catch (e: any) {
      showApiError(message, e, '上传/发送失败');
    } finally {
      setUploading(false);
    }
  };

  const handleRecall = async (m: ChatMessage) => {
    if (!session || !accountId) return;
    try {
      await window.kefu.recall(accountId, {
        messageSessionId: session.messageSessionId,
        messageId: m.id,
        visitorId: session.visitorId,
        visitorName: session.visitorName,
      });
      message.success('已撤回');
      await reloadMessages(session);
    } catch (e: any) {
      showApiError(message, e, '撤回失败');
    }
  };

  const quickReplies: QuickReply[] = account ? settings?.quickReplies?.[account.id] || [] : [];
  const keywordRules = settings?.keywordsEnabled ? settings?.keywords || [] : [];

  return (
    <div className="notify-wrap">
      <div className="notify-head">
        <Space size={8} align="center">
          <Typography.Text strong>{session?.visitorName || visitorName || '新消息'}</Typography.Text>
          {account && <Tag color="blue">{account.name || account.account}</Tag>}
        </Space>
        <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => void window.kefu?.closeNotify?.()} />
      </div>
      <div className="notify-body">
        {isQywx && account ? (
          <QywxNotifyView account={account} sessionId={sessionId} />
        ) : session ? (
          <ChatPanel
            account={account}
            session={session}
            messages={messages}
            loading={loading}
            sending={sending}
            uploading={uploading}
            quickReplies={quickReplies}
            keywordRules={keywordRules}
            ownerUid={account?.uid}
            onSaveQuickReplies={() => {
              /* 弹窗里只读：快捷回复请到主窗口设置 */
            }}
            onSend={handleSend}
            onUpload={handleUpload}
            onRecall={handleRecall}
          />
        ) : loading ? (
          <div className="center-tip">
            <Spin />
          </div>
        ) : (
          <div className="center-tip">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="会话已结束或已被接走" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 企微会话在提醒弹窗里的展示：聊天记录 + 文本回复。
 * sessionId = `${robotId}:${contactUserId}`，消息与回复都走企微自己的接口。
 */
function QywxNotifyView({ account, sessionId }: { account: Account; sessionId: string }) {
  const { message } = AntApp.useApp();
  const origin = account.serverUrl || '';
  const sep = sessionId.indexOf(':');
  const robotId = sep >= 0 ? sessionId.slice(0, sep) : sessionId;
  const contactUserId = sep >= 0 ? sessionId.slice(sep + 1) : '';

  const [messages, setMessages] = useState<QywxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 是否停在底部：正在上翻看历史时，新消息/轮询不要把视图拽回底部 */
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const load = useCallback(async () => {
    if (!contactUserId) return;
    try {
      const rows = await window.kefu.qywxMessages(account.id, { robotId, contactUserId });
      setMessages((rows || []) as QywxMessage[]);
    } catch {
      /* 忽略：弹窗只做提醒，拉不到也不弹错 */
    } finally {
      setLoading(false);
    }
  }, [account.id, robotId, contactUserId]);

  // 打开弹窗即视为已读（把服务端未读数清零）
  useEffect(() => {
    void window.kefu.qywxRead(account.id, { robotId, contactUserId }).catch(() => null);
  }, [account.id, robotId, contactUserId]);

  // 初次加载 + 实时推送刷新 + 兜底轮询
  useEffect(() => {
    void load();
    const off = window.kefu.onQywxEvent((p: any) => {
      if (p?.accountId !== account.id) return;
      if (p?.type !== 'message' && p?.type !== 'message-updated') return;
      const src = p.data?.message && typeof p.data.message === 'object' ? { ...p.data, ...p.data.message } : p.data;
      const rid = src?.robot_id ?? src?.robotId;
      const cid = src?.contact_user_id ?? src?.contactUserId;
      if (String(rid) === String(robotId) && String(cid) === String(contactUserId)) void load();
    });
    const timer = setInterval(() => void load(), 3000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [account.id, robotId, contactUserId, load]);

  useEffect(() => {
    // 只有本来就停在底部才跟随新消息；否则保持用户当前的滚动位置
    if (atBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  const submit = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await window.kefu.qywxReply(account.id, {
        robotId,
        contactUserId,
        msgType: 2,
        content,
        traceId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      setText('');
      // 自己发的消息：无论之前滚到哪，都跳到底部看发送结果
      atBottomRef.current = true;
      await load();
      scrollToBottom();
    } catch (e: any) {
      message.error(e?.message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  const renderBubble = (m: QywxMessage) => {
    const mine = m.direction === 'out';
    const type = Number(m.msg_type);
    if (type === 2063) {
      return (
        <div className="msg system" key={m.id}>
          <span className="system-pill">{mine ? '你撤回了一条消息' : '对方撤回了一条消息'}</span>
        </div>
      );
    }
    const url = mediaUrl(m, origin);
    const md = mediaOf(m);
    const imageLike = type === 14 || type === 29;
    const mediaBubble = imageLike || type === 23 || type === 16;
    let body: ReactNode;
    if (type === 2) {
      body = <span>{String(m.content || '')}</span>;
    } else if (imageLike && url) {
      body = <img className="chat-img" src={url} alt="" />;
    } else if (type === 23 && url) {
      body = <video className="chat-video" src={url} controls preload="metadata" />;
    } else if (type === 16) {
      body = <audio src={url} controls preload="metadata" />;
    } else if (type === 15 && url) {
      const fname = String(md.filename || '文件');
      body = (
        <a className="chat-file" href={url} target="_blank" rel="noreferrer" download title={fname}>
          <FileOutlined className="chat-file-icon" />
          <span className="chat-file-meta">
            <span className="chat-file-name">{fname}</span>
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
        {!mine && <Avatar size={30} className="qywx-avatar">?</Avatar>}
        <div className="msg-content">
          <div className={`bubble ${mediaBubble ? 'media' : ''}`}>{body}</div>
          <div className="msg-time">{fmtTime(m.created_at)}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="chat-main">
      <div
        className="chat-body"
        ref={bodyRef}
        onScroll={() => {
          const el = bodyRef.current;
          if (!el) return;
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {loading && messages.length === 0 ? (
          <div className="center-tip">
            <Spin />
          </div>
        ) : messages.length === 0 ? (
          <div className="center-tip">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史消息" />
          </div>
        ) : (
          messages.map(renderBubble)
        )}
      </div>
      <div className="chat-footer">
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="输入回复内容，Enter 发送，Shift+Enter 换行"
          autoSize={{ minRows: 2, maxRows: 5 }}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={submit}>
            发送
          </Button>
        </div>
      </div>
    </div>
  );
}
