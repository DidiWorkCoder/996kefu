import { BrowserWindow, dialog, ipcMain } from 'electron';
import * as api from './api';
import { getAccount, type Account } from './store';
import { itemTablesOf, setItemTable, type GmItemTable } from './settings';
import { xlsMtime, xlsPreview, xlsRows, xlsSheets } from './xls';

/**
 * GM 只读查询 IPC。
 *
 * 全部走一个 `gm:call` 通道 + 函数白名单：渲染层只能按名字调用这里列出的函数，
 * 白名单里全是 api.ts 中的**只读查询**，不存在任何改动玩家数据的入口。
 */
type GmFn = (acc: Account, gameId: string, p: any) => Promise<any>;

const GM_FNS: Record<string, GmFn> = {
  // 游戏 / 区服
  gmGameAuthList: (a, _g, p) => api.gmGameAuthList(a.token, p?.adminGameType ?? 1),
  gmAreaList: (a, g) => api.gmAreaList(api.gmCtx(a, g)),
  gmServerList: (a, g, p) => api.gmServerList(api.gmCtx(a, g), p || {}),
  gmServerMergeList: (a, g, p) => api.gmServerMergeList(api.gmCtx(a, g), p?.pageNum ?? 1),
  gmPlatformList: (a, g) => api.gmPlatformList(api.gmCtx(a, g)),
  gmGameInfo: (a, g) => api.gmGameInfo(api.gmCtx(a, g)),
  // 玩家
  gmPlayerPage: (a, g, p) => api.gmPlayerPage(api.gmCtx(a, g), p),
  gmUserQueryPage: (a, g, p) => api.gmUserQueryPage(api.gmCtx(a, g), p || {}),
  gmCurrencyAmount: (a, g, p) => api.gmCurrencyAmount(api.gmCtx(a, g), p),
  gmLoginPage: (a, g, p) => api.gmLoginPage(api.gmCtx(a, g), p),
  gmOnlineStatus: (a, g, p) => api.gmOnlineStatus(api.gmCtx(a, g), p),
  gmBanList: (a, g, p) => api.gmBanList(api.gmCtx(a, g), p),
  gmIpBanPage: (a, g, p) => api.gmIpBanPage(api.gmCtx(a, g), p || {}),
  gmIpLogs: (a, g, p) => api.gmIpLogs(api.gmCtx(a, g), p || {}),
  // 记录
  gmItemLog: (a, g, p) => api.gmItemLog(api.gmCtx(a, g), p),
  gmCurrencyLog: (a, g, p) => api.gmCurrencyLog(api.gmCtx(a, g), p),
  gmGoodsActionList: (a, g, p) => api.gmGoodsActionList(api.gmCtx(a, g), p?.type || 'goods'),
  gmChatLogPage: (a, g, p) => api.gmChatLogPage(api.gmCtx(a, g), p),
  gmMailLogPage: (a, g, p) => api.gmMailLogPage(api.gmCtx(a, g), p),
  gmCustomLogArgs: (a, g) => api.gmCustomLogArgs(api.gmCtx(a, g)),
  gmCustomLogPage: (a, g, p) => api.gmCustomLogPage(api.gmCtx(a, g), p),
  gmRolePageLog: (a, g, p) => api.gmRolePageLog(api.gmCtx(a, g), p),
  gmSensitiveWordPage: (a, g, p) => api.gmSensitiveWordPage(api.gmCtx(a, g), p || {}),
  gmYidunBanPage: (a, g, p) => api.gmYidunBanPage(api.gmCtx(a, g), p),
  gmBlackPageList: (a, g, p) => api.gmBlackPageList(api.gmCtx(a, g), p || {}),
  gmPlayerRankPage: (a, g, p) => api.gmPlayerRankPage(api.gmCtx(a, g), p),
  // 统计
  gmRoleLevelStatistics: (a, g, p) => api.gmRoleLevelStatistics(api.gmCtx(a, g), p),
  gmRoleLevelFirstPayStatistics: (a, g, p) => api.gmRoleLevelFirstPayStatistics(api.gmCtx(a, g), p),
  gmRoleLineTimeStatistics: (a, g, p) => api.gmRoleLineTimeStatistics(api.gmCtx(a, g), p),
  // 新版日志（ad 域）
  gmPlayerLog: (a, g, p) => api.gmPlayerLog(api.gmCtx(a, g), p.kind, p),
  gmCurrencyRecord: (a, g, p) => api.gmCurrencyRecord(api.gmCtx(a, g), p),
  gmActionType: (a, g) => api.gmActionType(api.gmCtx(a, g)),
};

/** 不需要 gameId 的只读函数（授权游戏列表是账号级的） */
const NO_GAME_FNS = new Set(['gmGameAuthList']);

/* ---------------- 物品/装备对照表 ---------------- */

/** 已解析的行缓存：key -> { mtime, rows } */
const rowCache = new Map<string, { mtime: number; rows: [string, string][] }>();

/** 按对照表配置读取并缓存 [id, name][]（文件有改动时自动重读） */
function tableRows(t: GmItemTable): [string, string][] {
  const key = `${t.file}|${t.sheet}|${t.skipRows}|${t.idCol}|${t.nameCol}`;
  const mtime = xlsMtime(t.file);
  const hit = rowCache.get(key);
  if (hit && hit.mtime === mtime) return hit.rows;
  const rows = xlsRows(t.file, t.sheet, t.skipRows)
    .map((r) => [String(r[t.idCol] ?? '').trim(), String(r[t.nameCol] ?? '').trim()] as [string, string])
    .filter(([id, name]) => id || name);
  rowCache.set(key, { mtime, rows });
  return rows;
}

/** 名字或 ID 模糊查询对照表；exact 为真时 ID 必须完全相等（结果表反查用，避免 1 命中 1001/传说斗笠Lv5） */
function lookup(
  accountId: string,
  kind: 'item' | 'equip',
  id?: string,
  name?: string,
  limit = 50,
  exact = false,
): { id: string; name: string }[] {
  const t = itemTablesOf(accountId)[kind];
  if (!t) throw new Error(kind === 'item' ? '还没配置物品对照表' : '还没配置装备对照表');
  const rows = tableRows(t);
  const kwId = String(id ?? '').trim();
  const kwName = String(name ?? '').trim().toLowerCase();
  const out: { id: string; name: string }[] = [];
  for (const [rid, rname] of rows) {
    const hit = kwId ? (exact ? rid === kwId : rid.includes(kwId)) : kwName ? rname.toLowerCase().includes(kwName) : false;
    if (!hit) continue;
    out.push({ id: rid, name: rname });
    if (out.length >= limit) break;
  }
  return out;
}

/** 通知渲染层设置已变更（物品表保存后刷新） */
function notifySettingsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('settings:changed', {});
  }
}

/* ---------------- 注册 ---------------- */

export function registerGmIpc(): void {
  /** 与 index.ts 里的 withAccount 同款：按 id 取账号，不存在就报错 */
  const withAccount =
    <T>(fn: (acc: Account, ...args: any[]) => Promise<T> | T) =>
    async (_e: unknown, id: string, ...args: any[]) => {
      const acc = getAccount(id);
      if (!acc) throw new Error('账号不存在，请重新登录');
      return await fn(acc, ...args);
    };

  // 只读查询统一入口（白名单外的名字一律拒绝）
  ipcMain.handle(
    'gm:call',
    withAccount(async (acc, gameId: string, fn: string, p: any) => {
      const name = String(fn);
      const f = GM_FNS[name];
      if (!f) throw new Error('不支持的查询：' + fn);
      if (!NO_GAME_FNS.has(name) && !String(gameId || '').trim())
        throw new Error('缺少游戏 ID（请把权限号放进对应的游戏分组）');
      return await f(acc, String(gameId), p);
    }),
  );

  /* ---- 物品/装备对照表 ---- */
  ipcMain.handle('gm:itemTables', (_e, accountId: string) => itemTablesOf(accountId));

  ipcMain.handle('gm:itemTablePickFile', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择物品/装备对照表',
      filters: [{ name: 'Excel', extensions: ['xls', 'xlsx'] }],
      properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
  });

  ipcMain.handle('gm:itemTableSheets', (_e, file: string) => xlsSheets(String(file)));

  ipcMain.handle('gm:itemTablePreview', (_e, p: { file: string; sheet: string; skipRows: number; limit?: number }) =>
    xlsPreview({ ...p, file: String(p.file), sheet: String(p.sheet), skipRows: Number(p.skipRows) || 0 }),
  );

  ipcMain.handle(
    'gm:itemTableSave',
    (_e, p: { accountId: string; kind: 'item' | 'equip'; file: string; sheet: string; idCol: number; nameCol: number; skipRows: number }) => {
      if (p?.idCol === p?.nameCol) throw new Error('ID 列和物品名列不能是同一列');
      // 全量解析一次：确认能读到数据，并把行数回给界面
      const rows = xlsRows(String(p.file), String(p.sheet), Number(p.skipRows) || 0)
        .map((r) => [String(r[p.idCol] ?? '').trim(), String(r[p.nameCol] ?? '').trim()] as [string, string])
        .filter(([id, name]) => id || name);
      if (!rows.length) throw new Error('这两列没读到数据，请确认列和「舍弃前几行」是否选对');
      setItemTable(p.accountId, p.kind, {
        file: String(p.file),
        sheet: String(p.sheet),
        idCol: Number(p.idCol),
        nameCol: Number(p.nameCol),
        skipRows: Number(p.skipRows) || 0,
        count: rows.length,
        parsedAt: Date.now(),
      });
      notifySettingsChanged();
      return { count: rows.length };
    },
  );

  ipcMain.handle('gm:itemTableRemove', (_e, p: { accountId: string; kind: 'item' | 'equip' }) => {
    setItemTable(p.accountId, p.kind, undefined);
    rowCache.clear();
    notifySettingsChanged();
    return itemTablesOf(p.accountId);
  });

  ipcMain.handle(
    'gm:itemLookup',
    (_e, p: { accountId: string; kind: 'item' | 'equip'; id?: string; name?: string; limit?: number; exact?: boolean }) =>
      lookup(p.accountId, p.kind, p.id, p.name, p.limit, p.exact),
  );
}
