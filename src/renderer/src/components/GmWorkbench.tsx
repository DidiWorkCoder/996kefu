/**
 * 权限号工作台：GM 端的**只读**查询界面（左侧 24 个菜单 + 右侧表单与结果）。
 *
 * 只读红线：这里只会调用 `window.kefu.gmCall`，而 main 进程的 `gm:call` 只放行
 * `src/main/gmQuery.ts` 白名单里的**查询**函数；结果表也不渲染任何操作列/写按钮。
 *
 * 常驻挂载：由 App 用 `visible` 控制显隐（不是卸载），切换账号不会丢查询状态。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  Menu,
  Modal,
  Pagination,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import GmItemTableSelector from './GmItemTableSelector';
import { GM_GROUPS, GM_MENUS, colTitle, pickGmRows, pickGmTotal, type GmField, type GmMenu } from '../gmMenus';
import { buildMailColumns } from '../mailColumns';
import {
  ItemListTags,
  isEquipField,
  isItemIdField,
  isItemListField,
  parseItemList,
  plainOf,
} from '../itemCell';
import { showApiError } from '../apiError';
import type { Account, GmItemTables } from '../types';

interface Props {
  account: Account;
  /** 是否为当前显示的账号（false 时只隐藏界面，组件仍挂载） */
  visible: boolean;
  /** 该权限号所属分组绑定的游戏 */
  gameId: string;
  gameName: string;
  /** 该权限号已保存的物品/装备对照表 */
  itemTables: GmItemTables;
  /** 物品表保存成功后通知 App 重新拉设置 */
  onSavedItemTables: () => void;
}

const PAGE_SIZE = 20;
const TIME_FMT = 'YYYY-MM-DD HH:mm:ss';

/** 下拉/表格统一显示成「名称（ID）」，ID 重复或名称为空时只显示一个 */
const withId = (name: any, id: any): string => {
  const n = String(name ?? '').trim();
  const i = String(id ?? '').trim();
  if (!n) return i;
  if (!i || n === i || n.includes(i)) return n;
  return `${n}（${i}）`;
};

/** 结果表里哪些字段是「区服 / 主区」，值为裸 ID 时反查成名称（全小写比较） */
const SERVER_ID_KEYS = new Set(['server_name', 'servername', 'serverid', 'server_id', 'pserverid', 'mainserverid', 'main_server_id']);
const AREA_ID_KEYS = new Set(['areaname', 'area_name', 'areaid', 'area_id', 'main_area_id', 'mainareaid']);

/** 表单默认值：日期范围默认最近 N 天，省得每次都要选 */
function defaultsFor(m: GmMenu): Record<string, any> {
  const v: Record<string, any> = {};
  for (const f of m.fields) {
    if (f.type === 'dateRange') v[f.name] = [dayjs().subtract(f.days ?? 7, 'day').startOf('day'), dayjs()];
  }
  return v;
}

/** 把表单值转成接口参数（日期按字段声明转换；ad 域日志的条件字段组装成 addcond） */
function buildParams(m: GmMenu, values: Record<string, any>, pageNum: number, pageSize: number): any {
  const p: any = { ...(m.fixed || {}), pageNum, pageSize };
  const conv = (d: Dayjs, f: GmField) => (f.fmt === 'unixSec' ? d.unix() : d.format(TIME_FMT));
  /** ad 域日志的附加条件：形如 [{"prop":"userid","value":"…","label":"角色ID","type":""}] */
  const conds: { prop: string; value: string; label: string; type: string }[] = [];
  /** 货币 / 物品记录的数量条件：形如 [{"key":"level","value":"10","condition":">"}] */
  const numConds: { key: string; value: string; condition: string }[] = [];
  for (const f of m.fields) {
    const v = values[f.name];
    // 数量条件即使没填也要占位（官方固定三组），所以放在空值判断之前
    if (f.type === 'cond') {
      const o = (v || {}) as { op?: string; val?: string };
      numConds.push({ key: f.condKey ?? '', value: String(o?.val ?? ''), condition: String(o?.op ?? '') });
      continue;
    }
    if (v === undefined || v === null || v === '') continue;
    // 带 condProp 的字段不进顶层参数，只组装进 addcond
    // （传顶层 userid / account 会被服务端「相与」查空，这正是「指定 ID 就查不到」的原因）
    if (f.condProp) {
      conds.push({ prop: f.condProp, value: String(v), label: f.condLabel ?? f.label, type: '' });
      continue;
    }
    if (f.type === 'dateRange') {
      const arr = v as [Dayjs, Dayjs];
      if (!arr?.[0] || !arr?.[1]) continue;
      p[f.name] = conv(arr[0], f);
      if (f.endName) p[f.endName] = conv(arr[1], f);
    } else if (f.type === 'date') {
      p[f.name] = conv(v as Dayjs, f);
    } else if (f.json) {
      try {
        p[f.name] = JSON.parse(String(v));
      } catch {
        p[f.name] = [];
      }
    } else {
      p[f.name] = v;
    }
  }
  if (conds.length) p.addcond = JSON.stringify(conds);
  if (numConds.length) p.conditions = numConds;
  return p;
}

/**
 * 区服 / 主区下拉：既能从列表里选，也能**直接输入 ID**（列表里没有的新区服也能查）。
 * antd 的 Select 默认只能选已有项，这里在搜索词是纯数字且不在列表时，临时补一个「按 ID 使用」项。
 */
function IdSelect({
  value,
  onChange,
  options,
  loading,
  placeholder,
  style,
}: {
  value: any;
  onChange: (v: any) => void;
  options: { label: string; value: any }[];
  loading?: boolean;
  placeholder?: string;
  style?: any;
}) {
  const [kw, setKw] = useState('');
  const opts = useMemo(() => {
    const k = kw.trim().toLowerCase();
    const hit = k ? options.filter((o) => String(o.label).toLowerCase().includes(k) || String(o.value) === k) : options;
    const list = [] as { label: string; value: any }[];
    if (k && /^\d+$/.test(k) && !options.some((o) => String(o.value) === k)) list.push({ label: `按 ID 使用：${k}`, value: k });
    // 已选中的自定义 ID（列表里没有）也要能显示出名字，否则会只剩一个裸 ID
    if (value !== undefined && value !== null && value !== '' && !options.some((o) => String(o.value) === String(value))) {
      list.push({ label: `ID：${value}`, value });
    }
    return [...list, ...hit];
  }, [kw, options, value]);
  return (
    <Select
      size="small"
      style={style ?? { minWidth: 170 }}
      allowClear
      showSearch
      filterOption={false}
      onSearch={setKw}
      onOpenChange={(open) => {
        if (!open) setKw('');
      }}
      loading={loading}
      value={value}
      onChange={onChange}
      options={opts}
      placeholder={placeholder}
    />
  );
}

export default function GmWorkbench({ account, visible, gameId, gameName, itemTables, onSavedItemTables }: Props) {
  const { message } = AntApp.useApp();
  const [menuKey, setMenuKey] = useState(GM_MENUS[0].key);
  const [values, setValues] = useState<Record<string, any>>(() => defaultsFor(GM_MENUS[0]));
  const [rows, setRows] = useState<any[]>([]);
  const [raw, setRaw] = useState<any>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [servers, setServers] = useState<{ label: string; value: any }[]>([]);
  const [areas, setAreas] = useState<{ label: string; value: any }[]>([]);
  /** 动态下拉数据（动作字典 / 渠道分包），key 是 GmField.optionsFrom */
  const [dynOpts, setDynOpts] = useState<Record<string, { label: string; value: any }[]>>({});
  const [loadingOpts, setLoadingOpts] = useState(false);
  const [tblOpen, setTblOpen] = useState(false);
  const [itemOptions, setItemOptions] = useState<{ label: string; value: string }[]>([]);
  const [itemSearching, setItemSearching] = useState(false);
  /** 物品 ID → 名称的缓存（结果表反查用） */
  const itemNames = useRef(new Map<string, string>());
  /** 装备 ID → 名称的缓存（与物品分开存：附件会拿同一个 ID 查两张表，混存会互相覆盖） */
  const equipNames = useRef(new Map<string, string>());
  /** 邮件正文（HTML，太长不直接铺在表格里） */
  const [mailDetail, setMailDetail] = useState<{ title: string; html: string } | null>(null);

  const menu = useMemo(() => GM_MENUS.find((m) => m.key === menuKey) || GM_MENUS[0], [menuKey]);

  /** 区服 / 主区 的 ID → 「名称（ID）」映射（结果表把裸 ID 换成可读显示） */
  const serverNameOf = useMemo(() => new Map(servers.map((s) => [String(s.value), s.label])), [servers]);
  const areaNameOf = useMemo(() => new Map(areas.map((a) => [String(a.value), a.label])), [areas]);

  /** 区服 / 主区下拉：进入时按游戏拉一次 */
  const loadOptions = async (gid: string) => {
    setLoadingOpts(true);
    try {
      const [sv, ar] = await Promise.all([
        window.kefu.gmCall(account.id, gid, 'gmServerList', { main: true }),
        window.kefu.gmCall(account.id, gid, 'gmAreaList'),
      ]);
      setServers(
        (Array.isArray(sv) ? sv : []).map((s: any) => {
          const id = s?.serverId ?? s?.id ?? '';
          return { label: withId(s?.name ?? s?.serverName, id), value: id };
        }),
      );
      setAreas(
        (Array.isArray(ar) ? ar : []).map((a: any) => {
          const id = a?.area_id ?? a?.areaId ?? a?.id ?? '';
          return { label: withId(a?.area_name ?? a?.areaName ?? a?.name, id), value: id };
        }),
      );
    } catch (e: any) {
      showApiError(message, e, '拉取区服/主区列表失败');
      setServers([]);
      setAreas([]);
    } finally {
      setLoadingOpts(false);
    }
  };

  useEffect(() => {
    if (!visible || !gameId) return;
    void loadOptions(gameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, gameId, account.id]);

  /** 动态下拉数据源 → 只读接口（动作字典分货币/物品两套；渠道分包来自 /gm/platform/list） */
  const fetchDynOptions = async (src: 'goodsAction' | 'currencyAction' | 'platform') => {
    if (src === 'platform') {
      const list = await window.kefu.gmCall(account.id, gameId, 'gmPlatformList', {});
      return (Array.isArray(list) ? list : []).map((x: any) => ({ label: withId(x?.name, x?.id), value: String(x?.id ?? '') }));
    }
    const list = await window.kefu.gmCall(account.id, gameId, 'gmGoodsActionList', { type: src === 'currencyAction' ? 'currency' : 'goods' });
    // 动作下拉的 value 就是中文名（官方前端同款）
    return (Array.isArray(list) ? list : []).map((x: any) => ({ label: String(x?.name ?? x?.id ?? ''), value: String(x?.name ?? '') }));
  };

  /** 当前菜单用到的动态下拉按需加载一次 */
  useEffect(() => {
    if (!visible || !gameId) return;
    const srcs = [...new Set(menu.fields.map((f) => f.optionsFrom).filter((x): x is NonNullable<GmField['optionsFrom']> => !!x))].filter((s) => !dynOpts[s]);
    if (!srcs.length) return;
    let alive = true;
    void (async () => {
      setLoadingOpts(true);
      for (const s of srcs) {
        try {
          const opts = await fetchDynOptions(s);
          if (alive) setDynOpts((m) => ({ ...m, [s]: opts }));
        } catch (e: any) {
          if (alive) showApiError(message, e, '拉取下拉选项失败');
        }
      }
      if (alive) setLoadingOpts(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, gameId, menuKey, account.id]);

  const switchMenu = (k: string) => {
    const m = GM_MENUS.find((x) => x.key === k) || GM_MENUS[0];
    setMenuKey(k);
    setValues(defaultsFor(m));
    setRows([]);
    setRaw(null);
    setTotal(0);
    setPage(1);
    setItemOptions([]);
  };

  /** 某一类对照表是否已配置（没配就只能按 ID 查） */
  const hasTable = (kind: 'item' | 'equip') => !!itemTables?.[kind];

  /** 物品名 ↔ ID：下拉搜索（纯数字按 ID 搜，否则按名字搜） */
  const searchItems = async (kind: 'item' | 'equip', kw: string) => {
    const k = String(kw || '').trim();
    if (!k) {
      setItemOptions([]);
      return;
    }
    setItemSearching(true);
    try {
      const l = /^\d+$/.test(k)
        ? await window.kefu.gmItemLookup({ accountId: account.id, kind, id: k, limit: 20 })
        : await window.kefu.gmItemLookup({ accountId: account.id, kind, name: k, limit: 20 });
      setItemOptions((l || []).map((x) => ({ label: `${x.name}（${x.id}）`, value: x.id })));
    } catch {
      setItemOptions([]);
    } finally {
      setItemSearching(false);
    }
  };

  /** 把结果里出现的物品 ID 反查成名字（缓存 + 静默失败） */
  const preloadItemNames = async (list: any[]) => {
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
          for (const a of parseItemList((r as any)[k])) {
            push('item', a.Index);
            push('equip', a.Index);
          }
        } else if (isItemIdField(k)) {
          push(isEquipField(k) ? 'equip' : 'item', (r as any)[k]);
        }
      }
    }
    await Promise.all(
      want.slice(0, 60).map(async (w) => {
        try {
          // 必须 ID 完全相等：否则 1 会「包含」命中 1001，把绑定元宝显示成传说斗笠Lv5
          const l = await window.kefu.gmItemLookup({ accountId: account.id, kind: w.kind, id: w.val, limit: 5, exact: true });
          if (l?.[0]?.name) (w.kind === 'item' ? itemNames.current : equipNames.current).set(w.val, l[0].name);
        } catch {
          /* 没配置对照表就跳过 */
        }
      }),
    );
  };

  const submit = async (pageNum = 1) => {
    if (!gameId) {
      message.warning('该权限号所在分组还没绑定游戏');
      return;
    }
    const miss = menu.fields.filter((f) => f.required && (values[f.name] === undefined || values[f.name] === null || values[f.name] === '')).map((f) => f.label);
    if (miss.length) {
      message.warning('请先填：' + miss.join('、'));
      return;
    }
    setLoading(true);
    setPage(pageNum);
    try {
      const res = await window.kefu.gmCall(account.id, gameId, menu.fn, buildParams(menu, values, pageNum, PAGE_SIZE));
      setRaw(res);
      const list = pickGmRows(res);
      setRows(list);
      setTotal(pickGmTotal(res, list.length));
      // 结果里的物品 ID 反查成名字（查完刷新一次，让表格用上缓存）
      await preloadItemNames(list);
      setRows([...list]);
    } catch (e: any) {
      showApiError(message, e, `查询「${menu.title}」失败`);
    } finally {
      setLoading(false);
    }
  };

  /** 渲染一个表单项 */
  const renderField = (f: GmField) => {
    const v = values[f.name];
    const set = (val: any) => setValues((s) => ({ ...s, [f.name]: val }));
    const common = { size: 'small' as const, style: { minWidth: 150 }, placeholder: f.placeholder || f.label };
    switch (f.type) {
      case 'number':
        return <InputNumber {...common} value={v} onChange={(x) => set(x)} placeholder={f.placeholder || f.label} />;
      case 'select': {
        // 有 optionsFrom 的走接口动态字典（动作分货币/物品两套、渠道分包来自 /gm/platform/list）
        const opts = f.optionsFrom ? dynOpts[f.optionsFrom] || [] : f.options;
        return (
          <Select
            {...common}
            value={v}
            onChange={(x) => set(x)}
            options={opts}
            loading={f.optionsFrom ? loadingOpts : undefined}
            showSearch
            optionFilterProp="label"
            allowClear
          />
        );
      }
      case 'cond': {
        // 数量条件：运算符下拉（f.options）+ 数值输入，值结构 { op, val }
        const o = (v || {}) as { op?: string; val?: string };
        return (
          <Space size={4}>
            <Select
              size="small"
              style={{ minWidth: 100 }}
              value={o.op || undefined}
              onChange={(x) => set({ ...o, op: x })}
              options={f.options}
              placeholder="请选择"
              allowClear
            />
            <Input
              size="small"
              style={{ width: 110 }}
              value={o.val}
              onChange={(e) => set({ ...o, val: e.target.value })}
              placeholder="请输入"
              allowClear
            />
          </Space>
        );
      }
      case 'server':
        return <IdSelect value={v} onChange={set} options={servers} loading={loadingOpts} placeholder={f.placeholder || '选区服（可选或直接输 ID）'} />;
      case 'serverMulti':
        return (
          <Select
            {...common}
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            loading={loadingOpts}
            value={v}
            onChange={(x) => set(x)}
            options={servers}
            style={{ minWidth: 260 }}
          />
        );
      case 'area':
        return <IdSelect value={v} onChange={set} options={areas} loading={loadingOpts} placeholder={f.placeholder || '选择主区（可选或直接输 ID）'} />;
      case 'dateRange':
        return <DatePicker.RangePicker size="small" showTime value={v} onChange={(x) => set(x)} allowClear={false} />;
      case 'date':
        return <DatePicker size="small" showTime value={v} onChange={(x) => set(x)} />;
      case 'item': {
        const ik = f.itemKind || 'item';
        // 没配对照表：退化成普通输入框，只能按 ID 查
        if (!hasTable(ik)) {
          return (
            <Tooltip title={`未配置${ik === 'item' ? '物品' : '装备'}对照表，仅支持按 ID 查询（点上方「物品表配置」）`}>
              <Input {...common} value={v} onChange={(e) => set(e.target.value)} allowClear />
            </Tooltip>
          );
        }
        return (
          <Select
            {...common}
            style={{ minWidth: 220 }}
            allowClear
            showSearch
            filterOption={false}
            value={v}
            placeholder={f.placeholder || '输入物品名或 ID'}
            loading={itemSearching}
            onSearch={(kw) => void searchItems(ik, kw)}
            onChange={(x) => set(x)}
            options={itemOptions}
            notFoundContent={itemSearching ? '搜索中…' : null}
          />
        );
      }
      default:
        return <Input {...common} value={v} onChange={(e) => set(e.target.value)} allowClear />;
    }
  };

  /** 物品/装备 ID → 名称（先物品表后装备表，只读缓存里取，取不到就空） */
  const nameOf = (v: any): string => {
    const s = String(v);
    return itemNames.current.get(s) || equipNames.current.get(s) || '';
  };

  /** 单元格渲染：物品类字段优先显示对照表里的名字（悬停看 ID） */
  const renderCell = (key: string, x: any) => {
    if (x === null || x === undefined || x === '') return '-';
    // 附件/物品列表：简洁显示成「名字 ×数量」
    if (isItemListField(key) || typeof x === 'object') {
      const list = parseItemList(x);
      if (list.length) return <ItemListTags list={list} nameOf={nameOf} />;
      if (typeof x === 'object') return plainOf(x);
    }
    // 区服 / 主区：接口返回裸 ID（如 serverid=10001），换成「区服名（10001）」
    if (/^\d+$/.test(String(x))) {
      const s = String(x);
      const lk = key.toLowerCase();
      const nm = SERVER_ID_KEYS.has(lk) || AREA_ID_KEYS.has(lk) ? areaNameOf.get(s) || serverNameOf.get(s) : '';
      if (nm) return <Tooltip title={`ID：${s}`}>{nm}</Tooltip>;
    }
    if (isItemIdField(key)) {
      const nm = nameOf(x);
      if (nm) return <Tooltip title={`ID：${x}`}>{nm}</Tooltip>;
    }
    return String(x);
  };

  const columns = useMemo(() => {
    const first = rows[0] || {};
    const keys = Object.keys(first).filter((k) => !k.startsWith('__'));
    // 实时邮件：与服务记录侧边栏「邮件记录」共用同一份列定义（默认只有 9 列，
    // 不再把 20 个字段连超长 HTML 正文一起铺出来）。
    if (menu.fn === 'gmMailLogPage') {
      return buildMailColumns({
        nameOf,
        onViewMemo: (title, html) => setMailDetail({ title, html }),
      });
    }
    if (menu.columns?.length) {
      return menu.columns.map((c) => ({ key: c.key, title: c.title, dataIndex: c.key, ellipsis: true, render: (x: any) => renderCell(c.key, x) }));
    }
    return keys.map((k) => ({
      key: k,
      title: colTitle(k),
      dataIndex: k,
      ellipsis: true,
      width: 150,
      render: (x: any) => renderCell(k, x),
    }));
  }, [rows, menu, serverNameOf, areaNameOf]);

  const menuItems = GM_GROUPS.map((g) => ({
    type: 'group' as const,
    label: g,
    children: GM_MENUS.filter((m) => m.group === g).map((m) => ({ key: m.key, label: m.title })),
  }));

  return (
    <div className="workspace" style={visible ? undefined : { display: 'none' }}>
      {/* 左侧 24 个菜单 */}
      <div style={{ width: 190, flex: '0 0 190px', borderRight: '1px solid rgba(0,0,0,.08)', overflow: 'auto' }}>
        <Menu mode="inline" style={{ borderInlineEnd: 'none' }} selectedKeys={[menuKey]} items={menuItems as any} onClick={(e) => switchMenu(e.key)} />
      </div>

      {/* 右侧内容 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 顶部信息条 */}
        <div className="main-header" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(0,0,0,.08)' }}>
          <Tag color="orange">权限号 · 只读</Tag>
          <Tag>{account.name || account.account}</Tag>
          <Tag color={gameId ? 'green' : 'red'}>{gameId ? `游戏 ${gameName || gameId}` : '未绑定游戏'}</Tag>
          <span style={{ marginLeft: 'auto' }} />
          <Button size="small" icon={<SettingOutlined />} onClick={() => setTblOpen(true)}>
            物品表配置
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loadingOpts} onClick={() => gameId && void loadOptions(gameId)}>
            刷新区服
          </Button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12 }}>
          {!gameId ? (
            <Alert
              type="warning"
              showIcon
              message="该权限号所在分组还没有绑定游戏"
              description="请在左侧账号分组上右键 →『绑定游戏』，绑定后才能查询（一个分组对应一个游戏）。"
            />
          ) : (
            <>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                {menu.title}
              </Typography.Title>
              {menu.note ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {menu.note}
                </Typography.Text>
              ) : null}

              {/* 查询表单 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '8px 0 12px' }}>
                {menu.fields.map((f) => (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>
                      {f.label}
                      {f.required ? <span style={{ color: '#ff4d4f' }}> *</span> : null}
                    </span>
                    {renderField(f)}
                  </div>
                ))}
                <Button type="primary" size="small" icon={<SearchOutlined />} loading={loading} onClick={() => void submit(1)}>
                  查询
                </Button>
              </div>

              {/* 结果 */}
              {rows.length ? (
                <>
                  <Table
                    size="small"
                    rowKey={(_r: any, i?: number) => String(i)}
                    dataSource={rows}
                    columns={columns as any}
                    pagination={false}
                    loading={loading}
                    scroll={{ x: 'max-content', y: 'calc(100vh - 340px)' }}
                  />
                  <div style={{ marginTop: 8, textAlign: 'right' }}>
                    <Space size={4}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        共 {total} 条
                      </Typography.Text>
                      <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={(p) => void submit(p)} />
                    </Space>
                  </div>
                </>
              ) : raw && typeof raw === 'object' ? (
                <div style={{ marginTop: 40 }}>
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '查询中…' : '暂无结果'} />
                  {/* 原始返回默认折叠，避免一屏看不懂的 JSON 糊在脸上 */}
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>查看原始返回</summary>
                    <pre
                      style={{
                        maxHeight: '60vh',
                        overflow: 'auto',
                        background: 'rgba(0,0,0,.03)',
                        padding: 12,
                        borderRadius: 6,
                        fontSize: 12,
                        margin: '8px 0 0',
                      }}
                    >
                      {JSON.stringify(raw, null, 2)}
                    </pre>
                  </details>
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? '查询中…' : '暂无结果'} style={{ marginTop: 40 }} />
              )}
            </>
          )}
        </div>
      </div>

      <GmItemTableSelector
        open={tblOpen}
        accountId={account.id}
        tables={itemTables}
        onClose={() => setTblOpen(false)}
        onSaved={() => {
          onSavedItemTables();
        }}
      />

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
    </div>
  );
}
