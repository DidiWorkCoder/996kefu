import { useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Descriptions, Drawer, Empty, Spin, Tag } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import MessageList from './MessageList';
import { showApiError } from '../apiError';
import type { Account, ChatMessage } from '../types';

interface Props {
  open: boolean;
  account: Account | null;
  visitorId?: string;
  groupId?: string;
  messageSessionRecordId?: string;
  visitorName?: string;
  /** 点标题行最右侧「搜索此用户」时回调；roleId 从 customField 自动提取（可能为空，可在面板里手改） */
  onSearchUser?: (p: { roleId: string; visitorName: string }) => void;
  onClose: () => void;
}

export default function ServiceRecordDrawer({
  open,
  account,
  visitorId,
  groupId,
  messageSessionRecordId,
  visitorName,
  onSearchUser,
  onClose,
}: Props) {
  const { message } = AntApp.useApp();
  const [records, setRecords] = useState<any[]>([]);
  const [visitor, setVisitor] = useState<any>(null);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState(false);
  /** 右侧对话滚动容器：新内容加载后自动贴底 */
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, loadingMsg]);

  const loadMessages = async (messageSessionId: string | number) => {
    if (!account) return;
    setActiveId(String(messageSessionId));
    setLoadingMsg(true);
    try {
      const d = await window.kefu.messages(account.id, { messageSessionId, pageNum: 1, pageSize: 100 });
      setMessages(((d.records || []) as ChatMessage[]).slice().reverse());
    } catch (e: any) {
      showApiError(message, e, '加载对话失败');
    } finally {
      setLoadingMsg(false);
    }
  };

  useEffect(() => {
    if (!open || !account || !visitorId) return;
    let alive = true;
    (async () => {
      setLoading(true);
      setRecords([]);
      setMessages([]);
      setVisitor(null);
      try {
        const [recs, v] = await Promise.all([
          window.kefu.serviceRecord(account.id, { visitorId, customerServiceGroupId: groupId || '' }),
          window.kefu.visitor(account.id, { visitorId, messageSessionRecordId: messageSessionRecordId || '' }),
        ]);
        if (!alive) return;
        const list = ((recs as any[]) || []).slice().sort((a, b) => (b.sessionStartTime || 0) - (a.sessionStartTime || 0));
        setRecords(list);
        setVisitor(v);
        if (list[0]) await loadMessages(list[0].messageSessionId);
      } catch (e: any) {
        showApiError(message, e, '加载服务记录失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id, visitorId, groupId]);

  const fmt = (v?: number) => (v ? dayjs.unix(v).format('YYYY-MM-DD HH:mm') : '-');

  let custom: any[] = [];
  try {
    custom = JSON.parse(visitor?.customField || '[]');
  } catch {
    custom = [];
  }

  /** 从 customField 里找「角色ID」：优先属性名含 角色+ID/编号，其次取 5 位以上纯数字字段 */
  const pickRoleId = (list: any[]): string => {
    const hit = list.find((c) => /角色.{0,4}(id|编号)/i.test(String(c?.attributeName || '')));
    if (hit && String(hit.attributeValue || '').trim()) return String(hit.attributeValue).trim();
    const num = list.find((c) => /^\d{5,}$/.test(String(c?.attributeValue ?? '').trim()));
    return num ? String(num.attributeValue).trim() : '';
  };
  const roleId = pickRoleId(custom);

  return (
    <Drawer
      title={`服务记录 / 历史${visitorName ? ' — ' + visitorName : ''}`}
      width={1080}
      open={open}
      onClose={onClose}
      destroyOnHidden
      // 关键：关闭 antd 的焦点锁。本抽屉打开后会在根节点再叠一个常驻的
      // 「搜索此用户」面板，焦点锁会把该面板里输入控件的焦点抢回本抽屉，
      // 表现为「货币输入 / 物品输入 无法输入」，故这里关闭 focus trap。
      focusable={{ trap: false }}
      extra={
        <Button
          size="small"
          icon={<UserOutlined />}
          disabled={!onSearchUser}
          onClick={() =>
            onSearchUser?.({ roleId, visitorName: visitorName || visitor?.name || '' })
          }
        >
          搜索此用户
        </Button>
      }
    >
      {visitor && (
        <Descriptions
          size="small"
          bordered
          column={2}
          style={{ marginBottom: 12 }}
          items={[
            { key: 'name', label: '访客', children: visitor.name },
            { key: 'account', label: '账号', children: visitor.account || '-' },
            { key: 'phone', label: '手机', children: visitor.phone || '-' },
            ...custom.slice(0, 7).map((c: any, i: number) => ({
              key: 'c' + i,
              label: c.attributeName,
              children: c.attributeValue,
            })),
          ]}
        />
      )}

      <div className="split" style={{ height: 520 }}>
        <div className="split-left">
          {loading ? (
            <div className="center-tip">
              <Spin />
            </div>
          ) : records.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无服务记录" />
          ) : (
            records.map((r) => (
              <div
                key={r.id}
                className={`rec-item ${activeId === String(r.messageSessionId) ? 'active' : ''}`}
                onClick={() => loadMessages(r.messageSessionId)}
              >
                <div>
                  <b>{r.customerServiceName || '未分配'}</b> <Tag>{r.gameName || '—'}</Tag>
                </div>
                <div className="rec-meta">
                  {fmt(r.sessionStartTime)} ~ {fmt(r.sessionEndTime)}
                </div>
                <div className="rec-meta">
                  客服/访客消息 {r.customerServiceMsgNum ?? 0} / {r.visitorMsgNum ?? 0}
                </div>
                {r.replyContent && <div className="rec-meta">回复：{String(r.replyContent).slice(0, 28)}</div>}
              </div>
            ))
          )}
        </div>
        <div className="split-right">
          {loadingMsg ? (
            <div className="center-tip">
              <Spin />
            </div>
          ) : (
            <div className="chat-body" ref={bodyRef} style={{ height: '100%', borderRadius: 6 }}>
              <MessageList
                messages={messages}
                myUid={account?.uid || ''}
                visitorName={visitorName}
                emptyText="选择左侧一条服务记录查看对话"
              />
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
