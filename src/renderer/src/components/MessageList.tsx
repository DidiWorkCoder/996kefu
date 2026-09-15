import { useState } from 'react';
import { App as AntApp, Avatar, Dropdown, Empty, Tag } from 'antd';
import ImagePreview from './ImagePreview';
import type { ChatMessage } from '../types';

interface Props {
  messages: ChatMessage[];
  /** 当前客服的 uid，用于判断「客服」气泡 */
  myUid: string;
  visitorName?: string;
  visitorHeadImg?: string;
  emptyText?: string;
  /** 传入后，「客服」自己的消息会显示「撤回」 */
  onRecall?: (m: ChatMessage) => void;
}

export type MsgRole = 'system' | 'service' | 'visitor';

/** 系统自动文本（这些内容即使 from 是客服，也是系统自动发的） */
const AUTO_TEXT =
  /(您好，有什么可以帮助|稍后将自动结束本次会话|为您服务|请描述您的问题|接入成功|服务时间\(无客服在线\)留言|系统关闭本次会话|本次会话已超时结束|用户关闭本次会话)/;

/** 三种角色：系统 / 客服(自己) / 玩家 */
export function roleOf(m: ChatMessage, myUid: string): MsgRole {
  const from = m.messageFromId == null || m.messageFromId === '' ? '' : String(m.messageFromId);
  const isSystem =
    !from || // 996百事通 / 系统事件
    m.messageSendSource === 3 ||
    m.type === 3 ||
    m.type === 4 ||
    m.isVisible === 2 ||
    AUTO_TEXT.test(m.content || '');
  if (isSystem) return 'system';
  return from === String(myUid) ? 'service' : 'visitor';
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 去掉 URL 外层的反引号/引号/空白（实际数据里会出现 src="`https://...`"） */
function cleanUrl(u: string): string {
  return (u || '').trim().replace(/^[`'"\s]+/, '').replace(/[`'"\s]+$/, '');
}

/** 图片消息的 URL（非图片消息返回空串） */
export function imageUrlOf(content: string): string {
  const m = (content || '').match(/<img[^>]*src\s*=\s*["']?([^"'>]+)["']?/i);
  return m ? cleanUrl(m[1]) : '';
}

/**
 * 会话列表里的「最后一条消息」也是 HTML 串，转成简短纯文本预览。
 * 图片/视频/文件消息直接给 [图片] [视频] [文件]，不要把 HTML 标签显示出来。
 */
export function previewOf(content?: string): string {
  const c = content || '';
  if (/<img/i.test(c)) return '[图片]';
  if (/<video/i.test(c)) return '[视频]';
  if (/<a\s/i.test(c)) return '[文件]';
  return unescapeHtml(c.replace(/<[^>]+>/g, '')).trim().slice(0, 60);
}

/** 取纯文本（用于右键复制） */
function plainText(content: string): string {
  return unescapeHtml((content || '').replace(/<[^>]+>/g, '')).trim();
}

/**
 * 消息内容渲染。
 * 图片/视频/文件消息的 content 是 HTML 串（与官方控制台一致）：
 *   <img class='send-img' src="URL"></img>
 *   <video src="URL" ...></video>
 *   <a href="URL" download ...>文件名</a>
 * 注意：实际收到的数据里 URL 可能被反引号包裹，需要清洗。
 */
export function renderContent(content: string, onImageClick?: (url: string) => void) {
  const c = content || '';

  const url = imageUrlOf(c);
  if (url) {
    return <img className="chat-img" src={url} alt="" onClick={() => onImageClick?.(url)} />;
  }

  const video = c.match(/<video[^>]*src\s*=\s*["']?([^"'>\s]+)["']?/i);
  if (video) return <video className="chat-video" src={cleanUrl(video[1])} controls />;

  const file = c.match(/<a[^>]*href\s*=\s*["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/a>/i);
  if (file) {
    return (
      <a className="chat-file" href={cleanUrl(file[1])} target="_blank" rel="noreferrer">
        {unescapeHtml(file[2])}
      </a>
    );
  }

  return unescapeHtml(c);
}

/** 服务端限制：只能撤回 2 分钟以内的消息 */
const RECALL_WINDOW_MS = 2 * 60 * 1000;

/** 该消息是否还在可撤回时间内 */
export function canRecall(m: ChatMessage): boolean {
  if (!m.messageTime) return true;
  const t = new Date(String(m.messageTime).replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t < RECALL_WINDOW_MS;
}

/** 已读 / 未读（仅客服发出的消息有） */
function ReadTag({ status, readTime }: { status?: number; readTime?: string | null }) {
  const read = status === 2 || !!readTime;
  return <span className={`read-tag ${read ? 'read' : 'unread'}`}>{read ? '已读' : '未读'}</span>;
}

const isMedia = (content: string) => /<img|<video|<a\s/i.test(content || '');

export default function MessageList({ messages, myUid, visitorName, visitorHeadImg, emptyText = '暂无消息', onRecall }: Props) {
  const { message: antMessage } = AntApp.useApp();
  /** 正在查看的图片（空串表示未打开） */
  const [preview, setPreview] = useState('');

  /** 复制文字：优先复制鼠标选中的内容，没选中就复制整条消息 */
  const copyText = async (content: string) => {
    const selected = (window.getSelection()?.toString() || '').trim();
    const text = selected || content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      antMessage.success('已复制');
    } catch {
      antMessage.error('复制失败');
    }
  };

  const copyImage = async (url: string) => {
    try {
      await window.kefu.copyImage(url);
      antMessage.success('图片已复制');
    } catch (e: any) {
      antMessage.error(e?.message || '复制图片失败');
    }
  };

  if (!messages.length) {
    return (
      <div className="center-tip">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
      </div>
    );
  }

  return (
    <>
      {messages.map((m) => {
        const role = roleOf(m, myUid);

        // 已撤回
        if (m.recallMsg === 1) {
          return (
            <div className="msg system" key={m.id}>
              <span className="system-pill">{role === 'service' ? '你撤回了一条消息' : '对方撤回了一条消息'}</span>
            </div>
          );
        }

        if (role === 'system') {
          return (
            <div className="msg system" key={m.id}>
              <span className="system-pill">{m.content}</span>
            </div>
          );
        }

        const isService = role === 'service';
        const imgUrl = imageUrlOf(m.content);
        const recallable = isService && !!onRecall && canRecall(m);
        const menuItems = [
          { key: 'copy', label: '复制' },
          ...(recallable ? [{ key: 'recall', label: '撤回' }] : []),
        ];

        return (
          <div className={`msg ${isService ? 'mine' : ''}`} key={m.id}>
            {!isService && (
              <Avatar size={32} src={visitorHeadImg} style={{ marginRight: 8, flex: '0 0 auto' }}>
                {(m.messageFromName || visitorName || '?').slice(0, 1)}
              </Avatar>
            )}
            <div className="msg-content">
              <div className="msg-role">
                {isService ? <Tag color="blue">客服 · 我</Tag> : <Tag>玩家</Tag>}
                <span>{m.messageFromName || visitorName}</span>
              </div>
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: menuItems,
                  onClick: ({ key }) => {
                    if (key === 'recall') {
                      onRecall?.(m);
                      return;
                    }
                    if (imgUrl) copyImage(imgUrl);
                    else copyText(plainText(m.content));
                  },
                }}
              >
                <div className={`bubble ${isMedia(m.content) ? 'media' : ''}`}>
                  {renderContent(m.content, setPreview)}
                </div>
              </Dropdown>
              <div className="msg-time">
                {isService && <ReadTag status={m.status} readTime={m.messageReadTime} />}
                {m.messageTime}
                {recallable && (
                  <span className="recall-link" onClick={() => onRecall?.(m)}>
                    撤回
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {preview && <ImagePreview url={preview} onClose={() => setPreview('')} />}
    </>
  );
}
