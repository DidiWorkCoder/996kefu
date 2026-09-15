/**
 * 服务记录 →「搜索此用户」：右侧向左展开的**常驻覆盖面板**。
 *
 * 注意：这个组件挂在 App 根节点上，**始终挂载、不卸载**（收起来只是 `translateX(100%)`），
 * 所以关掉面板、切换访客/客服之后再点开，之前查到的结果仍然在。
 *
 * 全程只读：所有请求都走 main 进程 `gm:call` 的只读白名单，没有任何写操作。
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  ConfigProvider,
  DatePicker,
  Divider,
  Empty,
  Input,
  Modal,
  Pagination,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  theme,
  Tooltip,
  Typography,
} from 'antd';
import { CloseOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { showApiError } from '../apiError';
import { colTitle } from '../gmMenus';
import { buildMailColumns } from '../mailColumns';
import {
  ItemListTags,
  isEquipField,
  isItemIdField,
  isItemListField,
  parseItemList,
  plainOf,
} from '../itemCell';
import type { Account, AccountGroup, GmItemTables } from '../types';

interface Props {
  open: boolean;
  /** 从服务记录页带过来的角色 ID（可能为空，可在面板里手改） */
  roleId: string;
  visitorName: string;
  /** 当前正在看的 996 客服号（用它所属分组确定游戏） */
  activeAccount: Account | null;
  accounts: Account[];
  groups: AccountGroup[];
  itemTables: Record<string, GmItemTables>;
  onClose: () => void;
}

/** 记录类型标签页 */
interface RecTab {
  key: string;
  label: string;
  fn: string;
  /** 新版日志（ad 域）用的 kind */
  kind?: string;
  /** 日期参数形式：ts=startTime/endTime(unix秒) date=startDate/endDate send=startSendTime/endSendTime */
  date?: 'ts' | 'date' | 'send';
  /** 需要 serverId + roleId */
  needRole?: boolean;
  /** 还需要 accountId（封禁记录） */
  needAccountId?: boolean;
  /** 返回的是布尔（在线状态） */
  online?: boolean;
  note?: string;
}

const TABS: RecTab[] = [
  { key: 'item', label: '物品记录', fn: 'gmItemLog', date: 'ts', needRole: true },
  { key: 'currency', label: '货币记录', fn: 'gmCurrencyLog', date: 'ts', needRole: true },
  { key: 'login', label: '登录记录', fn: 'gmLoginPage', needRole: true },
  { key: 'online', label: '在线状态', fn: 'gmOnlineStatus', needRole: true, online: true },
  { key: 'ban', label: '封禁记录', fn: 'gmBanList', needRole: true, needAccountId: true },
  { key: 'chat', label: '聊天记录', fn: 'gmChatLogPage', date: 'ts', needRole: true },
  { key: 'death', label: '死亡日志', fn: 'gmPlayerLog', kind: 'Death', date: 'date', needRole: true },
  { key: 'loginNew', label: '登录日志(新)', fn: 'gmPlayerLog', kind: 'Login', date: 'date', needRole: true },
  { key: 'logoutNew', label: '登出日志(新)', fn: 'gmPlayerLog', kind: 'Logout', date: 'date', needRole: true },
  { key: 'upgradeNew', label: '升级日志(新)', fn: 'gmPlayerLog', kind: 'Upgrade', date: 'date', needRole: true },
  { key: 'actionNew', label: '行为日志(新)', fn: 'gmPlayerLog', kind: 'Action', date: 'date', needRole: true },
  { key: 'roleDel', label: '角色删除日志', fn: 'gmRolePageLog', needRole: true },
  { key: 'mail', label: '邮件记录', fn: 'gmMailLogPage', date: 'send', needRole: true },
];

const PAGE_SIZE = 20;
const TIME_FMT = 'YYYY-MM-DD HH:mm:ss';

/** 返回体里的数组统一提取 */
const pickRows = (res: any): any[] => {
  if (Array.isArray(res)) return res;
  const r = res?.records ?? res?.lists ?? res?.list ?? res?.data;
  return Array.isArray(r) ? r : [];
};

/** 秒/毫秒时间戳 → 可读时间（空值或非法值返回空串） */
const fmtStamp = (v: any): string => {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0) return '';
  // 13 位是毫秒，10 位是秒
  const d = String(Math.trunc(n)).length >= 13 ? dayjs(n) : dayjs.unix(n);
  return d.isValid() ? d.format(TIME_FMT) : '';
};

export default function GmUserSearchPanel({
  open,
  roleId,
  visitorName,
  activeAccount,
  accounts,
  groups,
  itemTables,
  onClose,
}: Props) {
  const { message } = AntApp.useApp();
  /** 跟随 antd 主题取色：深色主题下面板底色/分割线不能写死成白色 */
  const { token } = theme.useToken();

  /* ---- 用哪个权限号 + 哪个游戏 ---- */
  const group = groups.find((g) => g.accountIds.includes(activeAccount?.id || '')) || null;
  const gameId = group?.gameId || '';
  const queryAccount =
    accounts.find((a) => a.kind === 'gmAuth' && group?.accountIds.includes(a.id)) ||
    accounts.find((a) => a.kind === 'gmAuth') ||
    activeAccount ||
    null;
  const ready = !!gameId && !!queryAccount;
  const itemCfg = queryAccount ? itemTables[queryAccount.id]?.item : undefined;

  /* ---- 查询状态（收起面板不清理，下次点开还在） ---- */
  const [roleIdInput, setRoleIdInput] = useState('');
  const [searchingRole, setSearchingRole] = useState(false);
  const [accountStr, setAccountStr] = useState('');
  const [accountIdStr, setAccountIdStr] = useState('');
  const [hitRole, setHitRole] = useState<any>(null);
  const [roles, setRoles] = useState<any[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [selectedRole, setSelectedRole] = useState<any>(null);

  const [tabKey, setTabKey] = useState(TABS[0].key);
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>([dayjs().subtract(7, 'day').startOf('day'), dayjs()]);
  const [itemId, setItemId] = useState('');
  const [itemOptions, setItemOptions] = useState<{ label: string; value: string }[]>([]);
  const [itemSearching, setItemSearching] = useState(false);
  const [currencyId, setCurrencyId] = useState('');

  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [online, setOnline] = useState<boolean | null>(null);
  /** 物品 / 装备 ID → 名称 缓存（分表存，避免两张表 ID 撞号） */
  const itemNames = useRef(new Map<string, string>());
  const equipNames = useRef(new Map<string, string>());
  /** 邮件正文（HTML，太长不直接铺在表格里） */
  const [mailDetail, setMailDetail] = useState<{ title: string; html: string } | null>(null);
  /** 已自动查过的角色 ID，避免重复触发 */
  const autoQueried = useRef('');

  const tab = TABS.find((t) => t.key === tabKey) || TABS[0];

  /** 统一的只读调用 */
  const call = async (fn: string, p?: any) => {
    if (!queryAccount) throw new Error('没有可用的权限号，请先登录一个权限号');
    if (!gameId) throw new Error('该客服所在分组未绑定游戏');
    return await window.kefu.gmCall(queryAccount.id, gameId, fn, p);
  };

  const roleServerId = (r: any) => String(r?.serverId ?? r?.serverid ?? '');
  const roleIdOf = (r: any) => String(r?.roleId ?? r?.roleid ?? r?.userid ?? '');

  /**
   * 区服显示：优先「主区名（主区ID）」。
   * 部分接口（如战力榜）返回的是 mainServer 对象，只取 *Name 字段会退化成裸 ID。
   */
  const serverLabel = (r: any): string => {
    const name = String(r?.mainServerName || r?.serverName || r?.mainServer?.name || '').trim();
    const id = r?.serverId ?? r?.serverid ?? r?.mainServer?.serverId ?? r?.mainServer?.id ?? '';
    if (!name) return id === '' || id === undefined ? '-' : String(id);
    return id === '' || id === undefined ? name : `${name}（${id}）`;
  };

  /** 组装某个记录类型的请求参数 */
  const buildParams = (t: RecTab, pageNum: number, role: any): any => {
    const r = role || {};
    const rid = roleIdOf(r);
    const sid = roleServerId(r);
    const start = (range?.[0] || dayjs().subtract(7, 'day')).format(TIME_FMT);
    const end = (range?.[1] || dayjs()).format(TIME_FMT);

    if (t.online || t.needAccountId) {
      return { pageNum: pageNum, pageSize: PAGE_SIZE, serverId: sid, roleId: rid, accountId: accountIdStr };
    }
    if (t.kind) {
      // 新版日志（ad 域）：角色 ID + 时间字符串（时间是必填）
      // 有角色 ID 时只按角色 ID 过滤：账号 + 角色 ID 同时传会被服务端「相与」而查空。
      return {
        pageNum: pageNum,
        pageSize: PAGE_SIZE,
        kind: t.kind,
        areaId: 0,
        account: rid ? '' : accountStr,
        userid: rid,
        startDate: start,
        endDate: end,
      };
    }
    const p: any = { pageNum: pageNum, pageSize: PAGE_SIZE, serverId: sid, roleId: rid, roleName: String(r?.roleName || '') };
    if (t.date === 'ts') {
      p.startTime = (range?.[0] || dayjs().subtract(7, 'day')).unix();
      p.endTime = (range?.[1] || dayjs()).unix();
    } else if (t.date === 'send') {
      // 邮件接口的发送时间要 unix 秒（实测传字符串会返回 code 500「参数类型错误」）
      p.startSendTime = (range?.[0] || dayjs().subtract(7, 'day')).unix();
      p.endSendTime = (range?.[1] || dayjs()).unix();
    }
    if (t.key === 'item') {
      p.serverType = 'main';
      if (itemId) p.itemIdx = itemId;
    } else if (t.key === 'currency') {
      p.serverType = 'mix';
      if (currencyId) p.currencyId = currencyId;
    } else if (t.key === 'chat') {
      p.time = [start, end];
    }
    return p;
  };

  /** 把结果里出现的物品/装备 ID 反查成名字（缓存 + 静默失败） */
  const preloadItemNames = async (list: any[]) => {
    const aid = queryAccount?.id;
    if (!aid) return;
    const want: { kind: 'item' | 'equip'; val: string }[] = [];
    const push = (kind: 'item' | 'equip', v: any) => {
      const s = String(v ?? '');
      if (!s) return;
      if ((kind === 'item' ? itemNames.current : equipNames.current).has(s)) return;
      want.push({ kind, val: s });
    };
    for (const r of list) {
      for (const k of Object.keys(r || {})) {
        if (isItemListField(k)) {
          // 附件列表（邮件等）：物品/装备两张表都试
          for (const a of parseItemList((r as any)[k])) {
            push('item', a.Index);
            push('equip', a.Index);
          }
        } else if (isItemIdField(k)) {
          // 物品唯一 ID 走装备表，其余走物品表
          push(isEquipField(k) ? 'equip' : 'item', (r as any)[k]);
        }
      }
    }
    await Promise.all(
      want.slice(0, 80).map(async (w) => {
        try {
          // 必须 ID 完全相等：主进程是「包含」匹配，否则 1 会命中 1001（绑定元宝显示成传说斗笠Lv5）
          const l = await window.kefu.gmItemLookup({ accountId: aid, kind: w.kind, id: w.val, limit: 5, exact: true });
          if (l?.[0]?.name) (w.kind === 'item' ? itemNames.current : equipNames.current).set(w.val, l[0].name);
        } catch {
          /* 没配置对照表就跳过 */
        }
      }),
    );
  };

  /** 查某个记录类型 */
  const runQuery = async (t: RecTab, pageNum: number, roleOverride?: any) => {
    const role = roleOverride || selectedRole;
    if (t.needRole && !role) {
      message.warning('请先在上面选一个角色');
      return;
    }
    setLoading(true);
    setPage(pageNum);
    setOnline(null);
    if (pageNum === 1) setRows([]);
    try {
      const res = await call(t.fn, buildParams(t, pageNum, role));
      if (t.online) {
        setOnline(res === true);
        setRows([]);
        setTotal(0);
        return;
      }
      const list = pickRows(res);
      setRows(list);
      setTotal(Number(res?.total ?? res?.pageTotal ?? list.length) || list.length);
      // 任何记录里只要带物品/附件字段就反查成名字（没配对照表则静默跳过）
      await preloadItemNames(list);
      // 名称是查完才进缓存的，这里换一个数组引用让表格重渲染
      setRows([...list]);
    } catch (e: any) {
      showApiError(message, e, `查询${t.label}失败`);
    } finally {
      setLoading(false);
    }
  };

  /** ② 用账号查该账号下的全部角色 */
  const loadRoles = async (acc: string) => {
    if (!acc) return;
    setLoadingRoles(true);
    try {
      const res = await call('gmUserQueryPage', { account: acc, pageNum: 1, pageSize: 100 });
      setRoles(pickRows(res));
    } catch (e: any) {
      showApiError(message, e, '查询该账号的角色失败');
    } finally {
      setLoadingRoles(false);
    }
  };

  /** ① 用角色 ID 查账号（然后自动 ②） */
  const searchByRoleId = async (ridArg?: string) => {
    const rid = String(ridArg ?? roleIdInput).trim();
    if (!rid) {
      message.warning('请先填角色 ID');
      return;
    }
    setSearchingRole(true);
    setHitRole(null);
    setAccountStr('');
    setAccountIdStr('');
    setRoles([]);
    setSelectedRole(null);
    setRows([]);
    setTotal(0);
    setOnline(null);
    try {
      const res = await call('gmUserQueryPage', { roleId: rid, pageNum: 1, pageSize: 20 });
      const list = pickRows(res);
      if (!list.length) {
        message.info('没查到该角色 ID 对应的账号');
        return;
      }
      const hit = list[0];
      setHitRole(hit);
      setAccountStr(String(hit.account || ''));
      setAccountIdStr(String(hit.accountId || ''));
      setSelectedRole(hit);
      await loadRoles(String(hit.account || ''));
      void runQuery(tab, 1, hit);
    } catch (e: any) {
      showApiError(message, e, '按角色 ID 查账号失败');
    } finally {
      setSearchingRole(false);
    }
  };

  /** 物品/装备名字 ↔ ID：下拉搜索 */
  const searchItems = async (kw: string) => {
    const aid = queryAccount?.id;
    const k = String(kw || '').trim();
    if (!aid || !k) {
      setItemOptions([]);
      return;
    }
    setItemSearching(true);
    try {
      const l = /^\d+$/.test(k)
        ? await window.kefu.gmItemLookup({ accountId: aid, kind: 'item', id: k, limit: 20 })
        : await window.kefu.gmItemLookup({ accountId: aid, kind: 'item', name: k, limit: 20 });
      setItemOptions((l || []).map((x) => ({ label: `${x.name}（${x.id}）`, value: x.id })));
    } catch {
      setItemOptions([]);
    } finally {
      setItemSearching(false);
    }
  };

  /* 打开面板：带入角色 ID，并把上次没查过的自动查一次 */
  useEffect(() => {
    if (!open) return;
    if (roleId) setRoleIdInput(roleId);
    if (!ready || !roleId) return;
    if (autoQueried.current === `${queryAccount?.id}|${roleId}`) return;
    autoQueried.current = `${queryAccount?.id}|${roleId}`;
    void searchByRoleId(roleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, roleId, ready]);

  /* 切换记录类型：清空上一次的结果与筛选 */
  const onTabChange = (k: string) => {
    setTabKey(k);
    setRows([]);
    setTotal(0);
    setOnline(null);
    setPage(1);
    setItemId('');
    setItemOptions([]);
    setCurrencyId('');
  };

  /** 物品/装备 ID → 名称（只读缓存里取，取不到就空） */
  const nameOf = (v: any): string => {
    const s = String(v);
    return itemNames.current.get(s) || equipNames.current.get(s) || '';
  };

  const columns = (() => {
    const first = rows[0] || {};
    const keys = Object.keys(first).filter((k) => !k.startsWith('__'));
    if (!keys.length) return [];
    return keys.map((k) => ({
      key: k,
      title: colTitle(k),
      dataIndex: k,
      ellipsis: true,
      width: 150,
      render: (v: any) => {
        if (v === null || v === undefined || v === '') return '-';
        // 附件/物品列表：简洁显示成「名字 ×数量」，不再铺一长串 ID
        if (isItemListField(k) || typeof v === 'object') {
          const list = parseItemList(v);
          if (list.length) return <ItemListTags list={list} nameOf={nameOf} />;
          if (typeof v === 'object') return plainOf(v);
        }
        // 物品 / 装备 ID 列：显示名字（悬停看 ID）
        if (isItemIdField(k)) {
          const nm = nameOf(v);
          if (nm) return <Tooltip title={`ID：${v}`}>{nm}</Tooltip>;
        }
        return String(v);
      },
    }));
  })();

  /**
   * 邮件记录专用列（与工作台「实时邮件」共用同一份定义）。
   * 原始返回有 20 个字段（多为空串、正文是超长 HTML、item 是 JSON 串），
   * 直接按字段铺开会又宽又难看，这里只留关键几列。
   */
  const mailColumns = buildMailColumns({
    nameOf,
    onViewMemo: (title, html) => setMailDetail({ title, html }),
  });

  const roleColumns = [
    { key: 'roleName', title: '角色', dataIndex: 'roleName', ellipsis: true },
    { key: 'roleId', title: '角色ID', dataIndex: 'roleId', width: 110 },
    { key: 'server', title: '区服', width: 150, render: (_: any, r: any) => serverLabel(r) },
    { key: 'level', title: '等级', dataIndex: 'level', width: 60 },
    { key: 'jobName', title: '职业', dataIndex: 'jobName', width: 80 },
  ];

  return (
    // 面板本身 z-index 高于普通弹窗，会让 antd 的弹出层（日期选择/下拉）被压在下面点不开，
    // 这里把面板内部所有弹出层的基准 z-index 抬到面板之上。
    <ConfigProvider theme={{ token: { zIndexPopupBase: 1200 } }}>
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          width: 560,
          zIndex: 1100,
          background: token.colorBgElevated,
          boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.16)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform .25s ease',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* 标题行 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
        <SearchOutlined />
        <Typography.Text strong>搜索此用户</Typography.Text>
        {visitorName ? <Tag>{visitorName}</Tag> : null}
        {roleId ? <Tag color="blue">角色ID {roleId}</Tag> : null}
        <span style={{ marginLeft: 'auto' }} />
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose}>
          收起
        </Button>
      </div>

      {/* flex 子项默认 min-height:auto 不会收缩，必须给 0，否则表格会把面板撑出屏幕 */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
        {!ready ? (
          <Alert
            type="warning"
            showIcon
            message="还不能查"
            description="该账号还没绑定游戏，或本机还没登录 996 权限号。请在左侧账号上右键 →『绑定游戏』（没分组会自动建一个），再登录一个 996 权限号。"
          />
        ) : (
          <>
            <Space wrap size={6} style={{ marginBottom: 8 }}>
              <Tag color="orange">权限号 {queryAccount?.name || queryAccount?.account}</Tag>
              <Tag color="green">游戏 {group?.gameName || gameId}</Tag>
            </Space>

            {/* 步骤①：角色 ID → 账号 */}
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={roleIdInput}
                onChange={(e) => setRoleIdInput(e.target.value)}
                onPressEnter={() => void searchByRoleId()}
                placeholder="角色 ID（可从服务记录自动带入，也可手动改）"
                allowClear
              />
              <Button type="primary" loading={searchingRole} onClick={() => void searchByRoleId()}>
                查账号
              </Button>
            </Space.Compact>

            {/* 步骤②：账号 → 全部角色 */}
            {accountStr ? (
              <div style={{ marginTop: 10 }}>
                <Space wrap size={6}>
                  <Tag>账号 {accountStr}</Tag>
                  {accountIdStr ? <Tag>账号ID {accountIdStr}</Tag> : null}
                  <Button size="small" icon={<ReloadOutlined />} loading={loadingRoles} onClick={() => void loadRoles(accountStr)}>
                    重新查该账号全部角色
                  </Button>
                </Space>
                {hitRole ? (
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                    命中角色：{hitRole.roleName}（{hitRole.roleId}） · 区服 {serverLabel(hitRole)}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 步骤③：选角色 */}
            {roles.length ? (
              <div style={{ marginTop: 10 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  共 {roles.length} 个角色，点一行选中后再查下面的记录
                </Typography.Text>
                <Table
                  size="small"
                  style={{ marginTop: 6 }}
                  rowKey={(r: any) => `${r.serverId ?? ''}-${r.roleId ?? ''}`}
                  dataSource={roles}
                  columns={roleColumns as any}
                  pagination={false}
                  scroll={{ y: 180, x: 'max-content' }}
                  loading={loadingRoles}
                  rowSelection={{
                    type: 'radio',
                    selectedRowKeys: selectedRole ? [`${roleServerId(selectedRole)}-${roleIdOf(selectedRole)}`] : [],
                    onChange: (_k, selected) => selected[0] && setSelectedRole(selected[0]),
                  }}
                  onRow={(r: any) => ({ onClick: () => setSelectedRole(r), style: { cursor: 'pointer' } })}
                />
              </div>
            ) : null}

            <Divider style={{ margin: '12px 0' }} />

            {/* 记录类型 */}
            <Tabs size="small" activeKey={tabKey} onChange={onTabChange} items={TABS.map((t) => ({ key: t.key, label: t.label }))} />

            <Space wrap size={6} style={{ marginBottom: 8 }}>
              {tab.date ? (
                <DatePicker.RangePicker
                  size="small"
                  showTime
                  value={range as any}
                  onChange={(v) => setRange(v as any)}
                  allowClear={false}
                />
              ) : null}
              {tab.key === 'item' ? (
                <Select
                  size="small"
                  showSearch
                  allowClear
                  style={{ minWidth: 240 }}
                  placeholder={itemCfg ? '物品名或物品 ID' : '未配置物品表（先到权限号工作台配置）'}
                  value={itemId || undefined}
                  onSearch={(kw) => void searchItems(kw)}
                  onChange={(v) => setItemId(v || '')}
                  filterOption={false}
                  options={itemOptions}
                  notFoundContent={itemSearching ? <Spin size="small" /> : '输入物品名或 ID'}
                />
              ) : null}
              {tab.key === 'currency' ? (
                <Input
                  size="small"
                  style={{ width: 160 }}
                  value={currencyId}
                  onChange={(e) => setCurrencyId(e.target.value)}
                  placeholder="货币 ID（可空）"
                  allowClear
                />
              ) : null}
              <Button
                size="small"
                type="primary"
                icon={<SearchOutlined />}
                loading={loading}
                disabled={!selectedRole}
                onClick={() => void runQuery(tab, 1)}
              >
                查询
              </Button>
              {!selectedRole ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  先按角色 ID 查出账号并选一个角色
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当前角色：{selectedRole.roleName}（{roleIdOf(selectedRole)}）
                </Typography.Text>
              )}
            </Space>

            {tab.note ? (
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{tab.note}</div>
            ) : null}

            {/* 结果 */}
            {tab.online ? (
              <div style={{ padding: '24px 0', textAlign: 'center' }}>
                {online === null ? (
                  <Typography.Text type="secondary">点「查询」看该角色当前是否在线</Typography.Text>
                ) : online ? (
                  <Tag color="green" style={{ fontSize: 16, padding: '4px 12px' }}>
                    在线
                  </Tag>
                ) : (
                  <Tag style={{ fontSize: 16, padding: '4px 12px' }}>离线</Tag>
                )}
              </div>
            ) : rows.length ? (
              <>
                <Table
                  size="small"
                  rowKey={(_r: any, i?: number) => String(i)}
                  dataSource={rows}
                  columns={(tab.key === 'mail' ? mailColumns : columns) as any}
                  pagination={false}
                  loading={loading}
                  scroll={{ x: 'max-content' }}
                />
                <div style={{ marginTop: 8, textAlign: 'right' }}>
                  <Pagination
                    size="small"
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={total}
                    showSizeChanger={false}
                    onChange={(p) => void runQuery(tab, p)}
                  />
                </div>
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '查询中…' : '暂无结果'} style={{ marginTop: 24 }} />
            )}
          </>
        )}
      </div>
      </div>

      {/* 邮件正文是游戏内按深色底设计的 HTML，铺在表格里太宽，改成点击后用弹窗渲染 */}
      <Modal
        open={!!mailDetail}
        title={mailDetail?.title}
        footer={null}
        width={560}
        onCancel={() => setMailDetail(null)}
        styles={{ body: { maxHeight: '60vh', overflow: 'auto', lineHeight: 1.8 } }}
      >
        <div
          style={{ padding: 12, borderRadius: 6, background: '#141414', wordBreak: 'break-word' }}
          dangerouslySetInnerHTML={{ __html: mailDetail?.html || '' }}
        />
      </Modal>
    </ConfigProvider>
  );
}
