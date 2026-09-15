import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Empty, Input, Space, Spin, Tag, Typography, Upload } from 'antd';
import { CloseOutlined, DownOutlined, HistoryOutlined, PictureOutlined, RobotOutlined, SendOutlined } from '@ant-design/icons';
import MessageList, { roleOf } from './MessageList';
import EmojiPicker from './EmojiPicker';
import QuickReplyPanel from './QuickReplyPanel';
import ServiceRecordDrawer from './ServiceRecordDrawer';
import type { Account, ChatMessage, KeywordRule, QuickReply, Session } from '../types';

interface Props {
  account: Account | null;
  session: Session | null;
  messages: ChatMessage[];
  loading?: boolean;
  sending?: boolean;
  uploading?: boolean;
  /** 当前客服号的快捷回复 */
  quickReplies: QuickReply[];
  /** 关键词自动推荐回复规则（全局共用） */
  keywordRules: KeywordRule[];
  /** 该会话所属客服号的 uid（远程会话时是对方的 uid，用于区分消息左右） */
  ownerUid?: string;
  /** 非空表示这是局域网远程会话，用于在标题上提示 */
  remoteLabel?: string;
  onSaveQuickReplies: (list: QuickReply[]) => Promise<void> | void;
  onSend: (content: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  onRecall: (m: ChatMessage) => void;
  /** 服务记录里「搜索此用户」→ 打开 GM 只读查询面板 */
  onSearchUser?: (p: { roleId: string; visitorName: string }) => void;
}

/** 待发送的附件（粘贴或选择后先预览，手动决定发送或取消） */
interface PendingItem {
  id: string;
  file: File;
  kind: 'image' | 'video' | 'file';
  /** 本地预览地址（图片/视频） */
  url: string;
}

/** 喂给 AI 的历史消息：媒体消息转成占位文本，去掉 HTML 标签 */
function toPlainText(content: string): string {
  const c = content || '';
  if (/<img/i.test(c)) return '[图片]';
  if (/<video/i.test(c)) return '[视频]';
  if (/<a\s/i.test(c)) return '[文件]';
  return c.replace(/<[^>]+>/g, '').trim();
}

export default function ChatPanel({
  account,
  session,
  messages,
  loading,
  sending,
  uploading,
  quickReplies,
  keywordRules,
  ownerUid,
  remoteLabel,
  onSaveQuickReplies,
  onSend,
  onUpload,
  onRecall,
  onSearchUser,
}: Props) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState('');
  const [serviceOpen, setServiceOpen] = useState(false);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [aiLoading, setAiLoading] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<any>(null);
  /** 是否贴着底部（用 ref 存，避免滚动时频繁触发重渲染） */
  const atBottomRef = useRef(true);
  /** 点击「回到底部」后平滑滚动期间，忽略滚动事件判定 */
  const jumpingRef = useRef(false);
  const prevCountRef = useRef(0);
  /** 上一次的最后一条消息 id，用于识别「列表数量没变但内容变了」 */
  const lastIdRef = useRef('');
  const [showJump, setShowJump] = useState(false);
  const sessionId = session?.messageSessionId;
  /** 判断消息左右用的 uid：远程会话时是对方客服号的 uid */
  const myUid = ownerUid || account?.uid || '';

  const scrollToBottom = (smooth = false) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  const handleScroll = () => {
    if (jumpingRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
    atBottomRef.current = near;
    setShowJump(!near);
  };

  const jumpToBottom = () => {
    jumpingRef.current = true;
    atBottomRef.current = true;
    setShowJump(false);
    scrollToBottom(true);
    setTimeout(() => {
      jumpingRef.current = false;
    }, 400);
  };

  /**
   * 强制贴到底部。等两帧再滚：发送接口返回后 React 可能还没把新消息渲染出来，
   * 直接滚会停在旧位置，看起来就是「发完消息没滚过去」。
   */
  const stickToBottom = () => {
    atBottomRef.current = true;
    setShowJump(false);
    requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(() => scrollToBottom());
    });
  };

  // 进入 / 切换会话：自动滚到底部
  useEffect(() => {
    prevCountRef.current = 0;
    lastIdRef.current = '';
    atBottomRef.current = true;
    setShowJump(false);
    const t = setTimeout(() => scrollToBottom(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 来了新消息：本来就在底部才跟随；手动翻上去看历史时不打扰
  useEffect(() => {
    const lastId = messages.length ? String(messages[messages.length - 1]?.id ?? '') : '';
    const grew = messages.length > prevCountRef.current || lastId !== lastIdRef.current;
    prevCountRef.current = messages.length;
    lastIdRef.current = lastId;
    if (grew && atBottomRef.current) stickToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  /**
   * 关键词推荐：从最后一条往前找。
   * 系统消息（自动欢迎语、「请您描述问题」、「接入成功」这类）不算客服回复，直接跳过；
   * 先遇到访客的消息就用它匹配，先遇到客服自己的回复就说明已经回过了，收起推荐。
   */
  const lastVisitorText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.recallMsg === 1) continue;
      const role = roleOf(m, myUid);
      if (role === 'system') continue;
      return role === 'visitor' ? toPlainText(m.content).toLowerCase() : '';
    }
    return '';
  }, [messages, myUid]);

  /** 命中的关键词规则（一条消息可命中多条；一条规则可配多个关键词，命中任意一个即可） */
  const recommendations = useMemo(
    () =>
      lastVisitorText
        ? keywordRules.filter((r) =>
            (r.keywords || []).some((k) => {
              // lastVisitorText 已转小写，英文关键词也转小写 => 不区分大小写
              const s = k.trim().toLowerCase();
              return !!s && lastVisitorText.includes(s);
            }),
          )
        : [],
    [lastVisitorText, keywordRules],
  );

  if (!session) {
    return (
      <div className="chat-col">
        <div className="chat-main">
          <div className="center-tip">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择一条会话" />
          </div>
        </div>
      </div>
    );
  }

  const groupId = session.messageSessionRecord?.customerServiceGroupId;

  const submit = async () => {
    const content = text.trim();
    if (!content || sending) return;
    try {
      await onSend(content);
      setText('');
      stickToBottom();
    } catch {
      /* 错误已在 App 层提示，保留输入内容 */
    }
  };

  /** 点击快捷回复 -> 填入输入框并聚焦 */
  const pickQuickReply = (content: string) => {
    setText(content);
    inputRef.current?.focus?.();
  };

  /** 关键词推荐 -> 直接发送 */
  const sendRecommend = async (content: string) => {
    if (sending) return;
    try {
      await onSend(content);
      stickToBottom();
    } catch {
      /* 错误已在 App 层提示 */
    }
  };

  /** AI 回复：把聊天记录 + 该客服号的知识库交给 AI，结果只填入输入区，不自动发送 */
  const handleAiReply = async () => {
    if (!account) return;
    const uid = myUid;
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    messages.forEach((m) => {
      if (m.recallMsg === 1) return;
      const role = roleOf(m, uid);
      if (role === 'system') return;
      const content = toPlainText(m.content);
      if (!content) return;
      history.push({ role: role === 'service' ? 'assistant' : 'user', content });
    });
    if (!history.length) {
      message.warning('当前会话还没有可用的聊天记录');
      return;
    }
    setAiLoading(true);
    try {
      const res = await window.kefu.aiReply({
        accountId: account.id,
        messages: history,
        visitorName: session?.visitorName,
      });
      if (!res?.content) {
        message.warning('AI 没有返回内容，请检查设置里的模型配置');
        return;
      }
      setText(res.content);
      if (res.hasKnowledge) message.success('已根据聊天记录和知识库生成回复，请确认后手动发送');
      else message.warning('已生成回复（该客服号未配置知识库），请确认后手动发送');
    } catch (e: any) {
      message.error(e?.message || 'AI 生成失败');
    } finally {
      setAiLoading(false);
    }
  };

  /** 把文件加入待发送列表（仅预览，不立即发送） */
  const addFiles = (files: File[]) => {
    // 远程会话的附件要经对方账号上传，暂不支持
    if (remoteLabel) return;
    const items: PendingItem[] = files.map((f) => {
      const kind: PendingItem['kind'] = f.type.startsWith('image') ? 'image' : f.type.startsWith('video') ? 'video' : 'file';
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file: f,
        kind,
        url: kind === 'file' ? '' : URL.createObjectURL(f),
      };
    });
    if (items.length) setPending((p) => [...p, ...items]);
  };

  const removePending = (id: string) => {
    setPending((p) => {
      const it = p.find((x) => x.id === id);
      if (it?.url) URL.revokeObjectURL(it.url);
      return p.filter((x) => x.id !== id);
    });
  };

  /** 取消：丢弃全部待发送附件 */
  const cancelPending = () => {
    setPending((p) => {
      p.forEach((it) => it.url && URL.revokeObjectURL(it.url));
      return [];
    });
  };

  /** 发送：逐个上传并在上传成功后自动发出 */
  const sendPending = async () => {
    const items = [...pending];
    for (const it of items) {
      await onUpload(it.file);
    }
    cancelPending();
    stickToBottom();
  };

  return (
    <div className="chat-col">
      <div className="chat-main">
        <div className="chat-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Typography.Text strong>{session.visitorName}</Typography.Text>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              会话 ID {session.messageSessionId}
            </Typography.Text>
            {remoteLabel && (
              <Tag color="purple" style={{ marginLeft: 8 }}>
                {remoteLabel}
              </Tag>
            )}
          </div>
          {!remoteLabel && (
            <Button size="small" icon={<HistoryOutlined />} onClick={() => setServiceOpen(true)}>
              服务记录 / 历史
            </Button>
          )}
        </div>

        <div className="chat-body-wrap">
          <div className="chat-body" ref={bodyRef} onScroll={handleScroll}>
            {loading && messages.length === 0 ? (
              <div className="center-tip">
                <Spin />
              </div>
            ) : (
              <MessageList
                messages={messages}
                myUid={myUid}
                visitorName={session.visitorName}
                visitorHeadImg={session.headImg}
                emptyText="暂无消息"
                onRecall={onRecall}
              />
            )}
          </div>
          {showJump && (
            <Button className="scroll-bottom-btn" shape="circle" size="small" icon={<DownOutlined />} onClick={jumpToBottom} />
          )}
        </div>

        <div className="chat-footer">
          {recommendations.length > 0 && (
            <div className="kw-reco-bar">
              <span className="kw-reco-label">推荐回复</span>
              <div className="kw-reco-list">
                {recommendations.map((r) => (
                  <div className="kw-reco-item" key={r.id}>
                    <span className="kw-reco-text" title={r.reply} onClick={() => pickQuickReply(r.reply)}>
                      {r.reply}
                    </span>
                    <Button size="small" type="link" disabled={!!sending} onClick={() => sendRecommend(r.reply)}>
                      立即发送
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pending.length > 0 && (
            <div className="pending-bar">
              <div className="pending-list">
                {pending.map((it) => (
                  <div className="pending-item" key={it.id}>
                    {it.kind === 'image' ? (
                      <img src={it.url} alt="" />
                    ) : it.kind === 'video' ? (
                      <video src={it.url} muted />
                    ) : (
                      <span className="pending-file">{it.file.name}</span>
                    )}
                    <CloseOutlined className="pending-del" onClick={() => removePending(it.id)} />
                  </div>
                ))}
              </div>
              <Space>
                <Button size="small" onClick={cancelPending} disabled={uploading}>
                  取消
                </Button>
                <Button size="small" type="primary" icon={<SendOutlined />} loading={uploading} onClick={sendPending}>
                  发送({pending.length})
                </Button>
              </Space>
            </div>
          )}

          <Input.TextArea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行；可直接粘贴截图"
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
                accept="image/*,video/*,.txt,.pdf,.doc,.docx,.xls,.xlsx,.zip,.rar"
                beforeUpload={(f) => {
                  addFiles([f as unknown as File]);
                  return false;
                }}
              >
                <Button icon={<PictureOutlined />} disabled={!!sending || !!remoteLabel}>
                  图片 / 文件
                </Button>
              </Upload>
              <Button icon={<RobotOutlined />} loading={aiLoading} disabled={!!sending} onClick={handleAiReply}>
                AI 回复
              </Button>
              <EmojiPicker
                disabled={!!sending}
                onPick={(emoji) => {
                  // 和官方控制台一样：插到光标处（没有光标就追加到末尾）
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
      </div>

      <QuickReplyPanel items={quickReplies} onSave={onSaveQuickReplies} onPick={pickQuickReply} />

      <ServiceRecordDrawer
        open={serviceOpen}
        account={account}
        visitorId={session.visitorId}
        groupId={groupId}
        visitorName={session.visitorName}
        onSearchUser={onSearchUser}
        onClose={() => setServiceOpen(false)}
      />
    </div>
  );
}
