/**
 * 邮件记录（侧边栏「邮件记录」与工作台「实时邮件」）的结果列。
 *
 * 两处原来各写一套，工作台那套按返回字段裸铺 20 列（含超长 HTML 正文、JSON 附件串），
 * 这里收敛成同一份定义，保证两边显示完全一致。
 *
 * 纯展示，不含任何写操作。
 */
import { Button, Tag } from 'antd';
import dayjs from 'dayjs';
import { ItemListTags, parseItemList, type GmItemEntry } from './itemCell';

const TIME_FMT = 'YYYY-MM-DD HH:mm:ss';

/** 秒/毫秒时间戳 → 可读时间（空值或非法值返回空串） */
const fmtStamp = (v: any): string => {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0) return '';
  // 13 位是毫秒，10 位是秒
  const d = String(Math.trunc(n)).length >= 13 ? dayjs(n) : dayjs.unix(n);
  return d.isValid() ? d.format(TIME_FMT) : '';
};

/** 邮件附件：正常在 accessory 数组里，accessory 为空时兜底解析 item（JSON 字符串） */
const accOf = (r: any): GmItemEntry[] => {
  const a = parseItemList(r?.accessory);
  return a.length ? a : parseItemList(r?.item);
};

/** 邮件正文是 HTML（游戏内深色底渲染的），换行统一成 <br/> */
export const mailHtmlOf = (v: any): string =>
  String(v ?? '')
    .replace(/\r?\n/g, '<br/>')
    .replace(/\\n/g, '<br/>');

export interface MailColumnCtx {
  /** 物品/装备 ID → 名称 */
  nameOf: (v: any) => string;
  /** 点「查看」看邮件正文 */
  onViewMemo: (title: string, html: string) => void;
}

export const buildMailColumns = ({ nameOf, onViewMemo }: MailColumnCtx) => [
  {
    key: 'sendTime',
    title: '发送时间',
    width: 140,
    render: (_: any, r: any) => fmtStamp(r?.dcreateTimeStamp || r?.dcreateTime) || '-',
  },
  {
    key: 'lable',
    title: '邮件标题',
    dataIndex: 'lable',
    ellipsis: true,
    width: 120,
    render: (v: any) => v || '-',
  },
  { key: 'sendName', title: '发件人', dataIndex: 'sendName', width: 70, render: (v: any) => v || '-' },
  {
    key: 'memo',
    title: '邮件内容',
    width: 70,
    render: (_: any, r: any) =>
      r?.memo ? (
        <Button
          size="small"
          type="link"
          style={{ padding: 0 }}
          onClick={() => onViewMemo(String(r?.lable || '邮件内容'), mailHtmlOf(r?.memo))}
        >
          查看
        </Button>
      ) : (
        '-'
      ),
  },
  {
    key: 'accessory',
    title: '附件物品',
    width: 170,
    render: (_: any, r: any) => <ItemListTags list={accOf(r)} nameOf={nameOf} />,
  },
  {
    key: 'recvTime',
    title: '领取时间',
    width: 140,
    render: (_: any, r: any) => fmtStamp(r?.drecvTimeStamp || r?.drecvTime) || '-',
  },
  {
    key: 'read',
    title: '已读',
    width: 70,
    render: (_: any, r: any) => (Number(r?.readFlag) === 1 ? <Tag color="green">已读</Tag> : <Tag>未读</Tag>),
  },
  {
    key: 'recv',
    title: '已领取',
    width: 80,
    render: (_: any, r: any) => (Number(r?.recvFlag) === 1 ? <Tag color="blue">已领取</Tag> : <Tag>未领取</Tag>),
  },
  {
    key: 'deleted',
    title: '已删除',
    width: 80,
    render: (_: any, r: any) => (Number(r?.deleted) === 1 ? <Tag color="red">已删除</Tag> : <Tag>正常</Tag>),
  },
];
