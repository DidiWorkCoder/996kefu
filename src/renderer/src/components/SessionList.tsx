import { Badge, Empty, Segmented, Spin, Tooltip } from 'antd';
import { ApiOutlined, CloseCircleOutlined, FlagFilled, FlagOutlined } from '@ant-design/icons';
import { previewOf } from './MessageList';
import type { LanSession, PendingSession, Session, SessionBuckets } from '../types';

export type TabKey = 'online' | 'end' | 'queue';

interface Props {
  buckets: SessionBuckets;
  tab: TabKey;
  active: Session | null;
  loading?: boolean;
  /** 当前客服号标记为「待处理」的会话（始终固定在最上方） */
  pending: PendingSession[];
  /** 局域网里的远程会话（别人推来的 / 本机拉来的） */
  remote: LanSession[];
  onTabChange: (t: TabKey) => void;
  onSelect: (s: Session) => void;
  /** 标记 / 取消「待处理」 */
  onTogglePending: (s: Session) => void;
  /** 打开一条远程会话 */
  onSelectRemote: (it: LanSession) => void;
  /** 移除一条远程会话 */
  onRemoveRemote: (it: LanSession) => void;
}

export default function SessionList({
  buckets,
  tab,
  active,
  loading,
  pending,
  remote,
  onTabChange,
  onSelect,
  onTogglePending,
  onSelectRemote,
  onRemoveRemote,
}: Props) {
  const pendingIds = new Set(pending.map((p) => p.id));
  const remoteIds = new Set(remote.map((r) => r.session?.id));
  // 待处理 / 远程已展示过的，下面 tab 列表里就不再重复
  const list = (buckets[tab] || []).filter((s) => !pendingIds.has(s.id) && !remoteIds.has(s.id));

  const options = [
    { label: `会话中(${buckets.online.length})`, value: 'online' },
    { label: `已结束(${buckets.end.length})`, value: 'end' },
    { label: `排队中(${buckets.queue.length})`, value: 'queue' },
  ];

  const renderItem = (s: Session, marked: boolean) => (
    <div key={s.id} className={`session-item ${active?.id === s.id ? 'active' : ''}`} onClick={() => onSelect(s)}>
      <div className="session-row">
        <span className="session-name">{s.visitorName}</span>
        <span className="session-time">{s.messageTime}</span>
        <Tooltip title={marked ? '取消待处理' : '标记待处理'} placement="left">
          {marked ? (
            <FlagFilled
              className="session-flag on"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePending(s);
              }}
            />
          ) : (
            <FlagOutlined
              className="session-flag"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePending(s);
              }}
            />
          )}
        </Tooltip>
      </div>
      <div className="session-row" style={{ marginTop: 4 }}>
        <span className="session-last">{previewOf(s.lastMessageContent) || '(无消息)'}</span>
        {!!s.unReadCount && <Badge count={s.unReadCount} />}
      </div>
    </div>
  );

  /** 局域网远程会话（回复会转发到持有账号的设备） */
  const renderRemote = (it: LanSession) => (
    <div
      key={`r-${it.peerId}-${it.session?.id}`}
      className={`session-item ${active?.id === it.session?.id ? 'active' : ''}`}
      onClick={() => onSelectRemote(it)}
    >
      <div className="session-row">
        <span className="session-name">{it.session?.visitorName || '(未知访客)'}</span>
        <span className="session-time">{it.session?.messageTime || ''}</span>
        <Tooltip title={`移除（来自 ${it.peerName}）`} placement="left">
          <CloseCircleOutlined
            className="session-remove"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveRemote(it);
            }}
          />
        </Tooltip>
      </div>
      <div className="session-row" style={{ marginTop: 4 }}>
        <ApiOutlined className="session-lan" />
        <span className="session-last">{previewOf(it.session?.lastMessageContent) || '(无消息)'}</span>
        {!!it.session?.unReadCount && <Badge count={it.session.unReadCount} />}
      </div>
    </div>
  );

  const empty = list.length === 0 && pending.length === 0 && remote.length === 0;

  return (
    <div className="session-col">
      <div className="session-tabs">
        <Segmented block size="small" options={options} value={tab} onChange={(v) => onTabChange(v as TabKey)} />
      </div>
      <div className="session-ul">
        {remote.length > 0 && (
          <>
            <div className="session-group">局域网 ({remote.length})</div>
            {remote.map(renderRemote)}
            <div className="session-group">{options.find((o) => o.value === tab)?.label}</div>
          </>
        )}

        {pending.length > 0 && (
          <>
            <div className="session-group">待处理 ({pending.length})</div>
            {pending.map((s) => renderItem(s, true))}
            <div className="session-group">{options.find((o) => o.value === tab)?.label}</div>
          </>
        )}

        {loading && empty ? (
          <div className="center-tip">
            <Spin />
          </div>
        ) : empty ? (
          <Empty style={{ marginTop: 48 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />
        ) : (
          list.map((s) => renderItem(s, false))
        )}
      </div>
    </div>
  );
}
