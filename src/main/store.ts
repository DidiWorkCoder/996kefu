import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 账号类型：kf996=996 客服（默认） qywx=企微客服中心 gmAuth=996 权限号（只读查询） */
export type AccountKind = 'kf996' | 'qywx' | 'gmAuth';

/** 一个客服账号（登录后被管理器保存） */
export interface Account {
  id: string;
  /** 账号类型；老数据没有这个字段，按 996 客服处理 */
  kind?: AccountKind;
  /** 客服昵称 */
  name: string;
  /** 登录账号 */
  account: string;
  /** customerServiceId（企微账号为空） */
  uid: string;
  /** 公司 ID，如 909（企微账号为空） */
  companyId: string;
  /** 请求头 x-token（JWT） */
  xToken: string;
  /** 请求头 token */
  token: string;
  /** JWT 过期时间（秒） */
  tokenExp: number;
  /** GM 站点（gm.tj.996sdk.com）凭据，token 失效时用它调 gmLogin 续期 */
  juheToken?: string;
  /** GM 用户 id，请求头 gw_gm_user_id */
  gmUserId?: string;
  /**
   * GM 站点 localStorage 里的 deviceid:<账号>。
   * 服务端靠它判断是不是「新设备登录」，没有就要输验证码；
   * 登录窗口是全新环境，需要用它把设备标识补回去。
   */
  deviceId?: string;
  /**
   * 登录时记住的账号 / 密码，掉线后自动重新登录（或手动点「重新登录」）时用它再登一次。
   * 权限号（gmAuth）与企微客服（qywx）都用这两个字段。
   */
  savedUser?: string;
  savedPwd?: string;
  /** 企微客服中心地址（kind=qywx 时用），如 http://127.0.0.1:9000 */
  serverUrl?: string;
  /** 企微客服登录返回的 token（kind=qywx 时用，后续请求头 Authorization: Bearer <token>） */
  qywxToken?: string;
  /** 企微客服登录返回的用户信息（原样保存） */
  qywxUser?: Record<string, any>;
  createdAt: number;
}

/** 是不是企微客服账号 */
export const isQywx = (a: { kind?: AccountKind }): boolean => a.kind === 'qywx';

/** 是不是 996 权限号（只读查询号） */
export const isGmAuth = (a: { kind?: AccountKind }): boolean => a.kind === 'gmAuth';

let cache: Account[] | null = null;

function filePath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'accounts.json');
}

export function listAccounts(): Account[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(filePath(), 'utf-8')) as Account[];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(): void {
  writeFileSync(filePath(), JSON.stringify(cache ?? [], null, 2), 'utf-8');
}

/** 去重：996 客服按 uid + companyId；企微客服按 中心地址 + 账号；权限号按 账号。存在则更新 */
export function upsertAccount(acc: Account): Account {
  const list = listAccounts();
  const idx = list.findIndex((a) =>
    acc.kind === 'qywx'
      ? a.kind === 'qywx' && a.account === acc.account && a.serverUrl === acc.serverUrl
      : acc.kind === 'gmAuth'
        ? a.kind === 'gmAuth' && a.account === acc.account
        : a.kind !== 'qywx' && a.kind !== 'gmAuth' && a.uid === acc.uid && a.companyId === acc.companyId,
  );
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...acc, id: list[idx].id, createdAt: list[idx].createdAt };
    persist();
    return list[idx];
  }
  list.push(acc);
  persist();
  return acc;
}

export function removeAccount(id: string): void {
  cache = listAccounts().filter((a) => a.id !== id);
  persist();
}

export function getAccount(id: string): Account | undefined {
  return listAccounts().find((a) => a.id === id);
}
