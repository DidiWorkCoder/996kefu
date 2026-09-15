/**
 * 结果表里「物品」的通用渲染：把 ID 简洁地显示成名字。
 *
 * 各处查询返回的物品字段名并不统一（itemIdx / itemId / itemUniqueId / accessory / item …），
 * 如果只在某一个表里做映射，其它记录页就还是裸 ID。这里统一判定 + 渲染，
 * 所有结果表（服务记录面板、权限号工作台）共用。
 */
import { Tag, Tooltip } from 'antd';

/** 一条附件/物品记录 */
export interface GmItemEntry {
  /** 物品或装备 ID */
  Index: any;
  /** 数量 */
  Count?: any;
  /** 绑定标记（有值即为绑定） */
  Bind?: any;
}

/** 字段名是否「物品 / 装备 ID」列（itemIdx / itemId / itemUniqueId / equipId / nitemidx …） */
export const isItemIdField = (key: string): boolean =>
  /(item|equip)[_a-z]*?(idx|id|index|uniqueid)$/i.test(key) || /^n?itemidx$/i.test(key);

/** 字段名是否「物品列表」列（邮件附件等） */
export const isItemListField = (key: string): boolean =>
  /^(accessory|accessories|item|items|itemlist|item_list)$/i.test(key);

/** 字段名是否走装备对照表（唯一 ID 类） */
export const isEquipField = (key: string): boolean => /unique|equip/i.test(key);

/**
 * 任意值 → 简洁一行文本。
 *
 * 后端返回里经常夹带对象/数组（主区 `mainServer`、黑名单的 `gameList/accountList/ipList` …），
 * 直接 `JSON.stringify` 铺出来又长又难读，这里统一收敛：
 *   对象 → `名字（ID）`（按常见字段名挑 name/id）；数组 → `首项 等 N 项`；兜底截断的 JSON。
 */
const NAME_KEYS = ['name', 'serverName', 'roleName', 'userName', 'account', 'title', 'label', 'gameName', 'mainServerName'];
const ID_KEYS = ['id', 'serverId', 'mainServerId', 'roleId', 'userId', 'accountId', 'gameId'];

const firstOf = (obj: any, keys: string[]): any => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

export const plainOf = (v: any): string => {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '';
    const parts = v.slice(0, 3).map(plainOf).filter(Boolean);
    if (!parts.length) return '';
    return v.length > 3 ? `${parts.join('、')} 等 ${v.length} 项` : parts.join('、');
  }
  const name = firstOf(v, NAME_KEYS);
  const id = firstOf(v, ID_KEYS);
  if (name !== undefined) return id !== undefined ? `${name}（${id}）` : String(name);
  if (id !== undefined) return String(id);
  let s = '';
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

/**
 * 把附件字段规整成列表：
 * 正常是数组（`[{Index,Count,Bind}]`），也可能是 JSON 字符串，空串/其它一律返回 []。
 */
export const parseItemList = (v: any): GmItemEntry[] => {
  let arr: any = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || (s[0] !== '[' && s[0] !== '{')) return [];
    try {
      arr = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === 'object') arr = [arr];
    else return [];
  }
  return arr
    .filter((x: any) => x && typeof x === 'object' && (x.Index ?? x.index) !== undefined)
    .map((x: any) => ({ Index: x.Index ?? x.index, Count: x.Count ?? x.count, Bind: x.Bind ?? x.bind }));
};

/** 单个物品 ID → 简洁标签（名字取不到就显示 #ID） */
export function ItemTag({ id, count, bind, name }: { id: any; count?: any; bind?: any; name?: string }) {
  return (
    <Tooltip title={`物品ID ${id}${bind ? ` · 绑定 ${bind}` : ''}`}>
      <Tag style={{ marginInlineEnd: 4 }}>
        {name || `#${id}`}
        {count !== undefined && count !== null && count !== '' ? ` ×${count}` : ''}
      </Tag>
    </Tooltip>
  );
}

/** 附件列表 → 简洁标签组（默认最多显示 3 个，其余折叠成「等 N 项」） */
export function ItemListTags({ list, nameOf, max = 3 }: { list: GmItemEntry[]; nameOf: (v: any) => string; max?: number }) {
  if (!list.length) return <>-</>;
  return (
    <>
      {list.slice(0, max).map((a, i) => (
        <ItemTag key={i} id={a.Index} count={a.Count} bind={a.Bind} name={nameOf(a.Index)} />
      ))}
      {list.length > max ? <Tag>等 {list.length} 项</Tag> : null}
    </>
  );
}
