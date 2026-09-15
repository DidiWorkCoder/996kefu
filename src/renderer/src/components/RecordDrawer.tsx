import { useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Checkbox, DatePicker, Drawer, Input, Modal, Space, Spin, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import MessageList from './MessageList';
import { showApiError } from '../apiError';
import type { Account, ChatMessage, RecordItem } from '../types';

const { RangePicker } = DatePicker;

interface Props {
  open: boolean;
  account: Account | null;
  onClose: () => void;
}

type DayRange = [dayjs.Dayjs, dayjs.Dayjs];

export default function RecordDrawer({ open, account, onClose }: Props) {
  const { message } = AntApp.useApp();
  const [range, setRange] = useState<DayRange>([dayjs().startOf('day'), dayjs().endOf('day')]);
  const [data, setData] = useState<RecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 查看某条记录的对话
  const [conv, setConv] = useState<RecordItem | null>(null);
  const [convMsgs, setConvMsgs] = useState<ChatMessage[]>([]);
  const [convLoading, setConvLoading] = useState(false);
  /** 历史对话滚动容器：加载完成后自动贴底 */
  const convBodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = convBodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [convMsgs, convLoading]);

  // 留言回复（会话详情里的「回复记录」）
  const [replyText, setReplyText] = useState('');
  const [replyAgree, setReplyAgree] = useState(false);
  const [replySending, setReplySending] = useState(false);

  /** 查询会话记录；时间按「天」取，起=00:00:00，止=23:59:59 */
  const load = async (opts?: { page?: number; pageSize?: number; range?: DayRange }) => {
    if (!account) return;
    const r = opts?.range ?? range;
    const p = opts?.page ?? page;
    const ps = opts?.pageSize ?? pageSize;
    setLoading(true);
    try {
      const d = await window.kefu.records(account.id, {
        pageNum: p,
        pageSize: ps,
        visitorEnterStartTime: r[0].startOf('day').format('YYYY-MM-DD HH:mm:ss'),
        visitorEnterEndTime: r[1].endOf('day').format('YYYY-MM-DD HH:mm:ss'),
      });
      setData((d.records || []) as RecordItem[]);
      setTotal(Number(d.total ?? (d as any).totalNum ?? (d.records || []).length));
    } catch (e: any) {
      showApiError(message, e, '加载会话记录失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setRange([dayjs().startOf('day'), dayjs().endOf('day')]);
    setPage(1);
    load({ page: 1, range: [dayjs().startOf('day'), dayjs().endOf('day')] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  const openConv = async (r: RecordItem) => {
    if (!account) return;
    setConv(r);
    setConvMsgs([]);
    setReplyText('');
    setReplyAgree(false);
    setConvLoading(true);
    try {
      const d = await window.kefu.messages(account.id, { messageSessionId: r.messageSessionId, pageNum: 1, pageSize: 100 });
      setConvMsgs(((d.records || []) as ChatMessage[]).slice().reverse());
    } catch (e: any) {
      showApiError(message, e, '加载对话失败');
    } finally {
      setConvLoading(false);
    }
  };

  /** 回复留言；成功后本地更新为「已回复」，回复后无法再次发起 */
  const sendReply = async () => {
    if (!account || !conv) return;
    const content = replyText.trim();
    if (!content) {
      message.warning('请输入留言回复内容');
      return;
    }
    if (!replyAgree) {
      message.warning('请先确认勾选回复内容');
      return;
    }
    setReplySending(true);
    try {
      await window.kefu.sendLeaveMessage(account.id, { id: conv.id, content, handlerName: account.account });
      message.success('回复成功');
      const next: RecordItem = {
        ...conv,
        isReply: 1,
        handlerName: account.account,
        handlerTime: Math.floor(Date.now() / 1000),
        replyContent: content,
      };
      setConv(next);
      setData((prev) => prev.map((it) => (it.id === next.id ? next : it)));
      setReplyText('');
      setReplyAgree(false);
    } catch (e: any) {
      showApiError(message, e, '回复失败');
    } finally {
      setReplySending(false);
    }
  };

  const fmt = (v?: number) => (v ? dayjs.unix(v).format('YYYY-MM-DD HH:mm:ss') : '-');

  const columns = [
    { title: '访客', dataIndex: 'visitorName', width: 140, ellipsis: true },
    { title: '所属客服', dataIndex: 'customerServiceName', width: 110, ellipsis: true },
    { title: '分组', dataIndex: 'customerServiceGroupName', width: 140, ellipsis: true },
    { title: '开始时间', dataIndex: 'sessionStartTime', width: 160, render: fmt },
    { title: '结束时间', dataIndex: 'sessionEndTime', width: 160, render: fmt },
    {
      title: '客服/访客消息数',
      width: 120,
      render: (_: unknown, r: RecordItem) => `${r.customerServiceMsgNum ?? 0} / ${r.visitorMsgNum ?? 0}`,
    },
    {
      title: '已回复',
      dataIndex: 'isReply',
      width: 80,
      render: (v: number) => <Tag color={v ? 'green' : 'default'}>{v ? '是' : '否'}</Tag>,
    },
    {
      title: '操作',
      width: 90,
      fixed: 'end' as const,
      render: (_: unknown, r: RecordItem) => (
        <Button type="link" size="small" onClick={() => openConv(r)}>
          查看对话
        </Button>
      ),
    },
  ];

  return (
    <>
      <Drawer title="会话记录" width={1120} open={open} onClose={onClose} destroyOnHidden>
        <Space style={{ marginBottom: 12 }}>
          <RangePicker
            allowClear={false}
            value={range}
            presets={[
              { label: '今天', value: [dayjs().startOf('day'), dayjs().endOf('day')] },
              { label: '近 7 天', value: [dayjs().subtract(6, 'day').startOf('day'), dayjs().endOf('day')] },
              { label: '近 30 天', value: [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')] },
            ]}
            onChange={(v) => {
              if (!v || !v[0] || !v[1]) return;
              const next: DayRange = [v[0], v[1]];
              setRange(next);
              setPage(1);
              load({ page: 1, range: next });
            }}
          />
          <Button
            type="primary"
            onClick={() => {
              setPage(1);
              load({ page: 1 });
            }}
          >
            查询
          </Button>
          <span style={{ color: '#8c8c8c' }}>
            {range[0].format('YYYY-MM-DD')} 00:00:00 ~ {range[1].format('YYYY-MM-DD')} 23:59:59
          </span>
        </Space>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={data}
          columns={columns as any}
          scroll={{ x: 1050 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
              load({ page: p, pageSize: ps });
            },
          }}
        />
      </Drawer>

      <Modal
        title={conv ? `与 ${conv.visitorName} 的历史对话` : '历史对话'}
        open={!!conv}
        onCancel={() => setConv(null)}
        footer={null}
        width={880}
        destroyOnHidden
      >
        <div className="conv-body" ref={convBodyRef}>
          {convLoading ? (
            <div className="center-tip" style={{ height: 160 }}>
              <Spin />
            </div>
          ) : (
            <MessageList messages={convMsgs} myUid={account?.uid || ''} visitorName={conv?.visitorName} />
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>回复记录</div>
          {conv?.isReply === 1 ? (
            <Space direction="vertical" size={4}>
              <span>处理人：{conv.handlerName || '--'}</span>
              <span>处理时间：{fmt(conv.handlerTime)}</span>
              <span style={{ wordBreak: 'break-all' }}>处理内容：{conv.replyContent || '--'}</span>
            </Space>
          ) : (
            <>
              <Input.TextArea
                rows={3}
                maxLength={100}
                showCount
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="请输入留言回复内容"
              />
              <Checkbox
                style={{ marginTop: 8 }}
                checked={replyAgree}
                onChange={(e) => setReplyAgree(e.target.checked)}
              >
                我已确认回复内容无误，回复后将无法再发起
              </Checkbox>
              <div style={{ marginTop: 8 }}>
                <Button type="primary" loading={replySending} onClick={sendReply}>
                  回复
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
