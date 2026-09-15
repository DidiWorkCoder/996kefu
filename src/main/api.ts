import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { getKeys } from './keys';
import { logLine, truncate } from './logger';
import type { Account } from './store';

/**
 * 接口地址与 AES 口令会随控制台发版变化，由 keys.ts 定时从控制台 JS 里提取。
 * 这三个变量是内置兜底值，每次请求前 syncKeys() 会同步成最新值。
 */
let API = 'https://api.kf.996sdk.net';
let MGN = 'https://mgn-api.kf.996sdk.net/chatroom-clientele';
let AES_KEY = 'secret key 1234';

/** 从 keys.ts 同步最新值（拉取失败时就是内置兜底值） */
function syncKeys(): void {
  const k = getKeys();
  API = k.API;
  MGN = k.MGN;
  AES_KEY = k.AES_KEY;
}

const APPID = 'pBQOqktZJ9Gv';
const APPKEY = 'M6F6GzDHQK0osAIKxy5keOKhd9ly';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function nonce(len = 16): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += NONCE_CHARS[bytes[i] % NONCE_CHARS.length];
  return s;
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** 复刻 crypto-js AES.encrypt(text, passphrase).toString()（OpenSSL KDF + AES-256-CBC） */
function aesEncrypt(text: string, passphrase?: string): string {
  syncKeys();
  const salt = randomBytes(8);
  const pass = Buffer.from(passphrase || AES_KEY, 'utf8');
  // EVP_BytesToKey(MD5, 1 iteration)：派生 32B key + 16B iv
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = createHash('md5').update(Buffer.concat([block, pass, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  const key = derived.subarray(0, 32);
  const iv = derived.subarray(32, 48);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__'), salt, ct]).toString('base64');
}

/** 参与签名的 body：FormData 时取非文件字段排序拼接，否则 JSON 字符串 */
function signBodyOf(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const parts: string[] = [];
    for (const [k, v] of body.entries()) {
      if (typeof v === 'string') parts.push(`${k}=${v}`);
    }
    return parts.sort().join('&');
  }
  return JSON.stringify(body);
}

/** 签名/鉴权只需要这几个字段，不一定是一个已保存的账号 */
export interface SignSubject {
  xToken: string;
  token: string;
  uid: string;
}

/**
 * 996 接口签名:
 *   sign = MD5( METHOD \n PATH_WITH_QUERY \n 排序后的 name=value(x-996sdk-*) \n body \n key=APPKEY )
 * 服务端还会校验 Referer / Origin，缺失返回「签名错误」。
 */
function signedHeaders(
  method: string,
  url: string,
  acc: SignSubject,
  signBody: string,
  isForm: boolean,
  extra?: Record<string, string>,
): Record<string, string> {
  const x996: Record<string, string> = {
    'x-996sdk-appid': APPID,
    'x-996sdk-algo': 'MD5',
    'x-996sdk-nonce': nonce(16),
    'x-996sdk-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const path = url.replace(/(https?:?)?\/\/.+?\//i, '/');
  const lines = [method.toUpperCase(), path];
  Object.keys(x996)
    .sort()
    .forEach((k) => lines.push(`${k}=${x996[k]}`));
  lines.push(signBody);
  lines.push(`key=${APPKEY}`);

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'x-client-version': '3.0.0',
    'x-requested-with': 'XMLHttpRequest',
    Referer: 'https://console.kf.996sdk.net/',
    Origin: 'https://console.kf.996sdk.net',
    'juhe-token': 'null',
    'x-token': acc.xToken,
    'x-ct-token': acc.xToken,
    token: acc.token,
    // mgn-api 系列需要
    gw_gm_user_id: acc.uid,
    ...x996,
    'x-996sdk-sign': md5(lines.join('\n')),
    ...extra,
  };
  // FormData 由 fetch 自动带 boundary，不能手动设置 content-type
  if (!isForm && signBody) headers['content-type'] = 'application/json;charset=UTF-8';
  return headers;
}

async function request<T = any>(
  acc: SignSubject,
  method: string,
  url: string,
  body?: unknown,
  extra?: Record<string, string>,
  /** 静默请求：不写请求/响应日志（供 5s 探活使用） */
  silent = false,
): Promise<T> {
  syncKeys();
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const signBody = signBodyOf(body);

  if (!silent) logLine('REQ', { uid: acc.uid, method, url, body: truncate(signBody, 800) });

  const res = await fetch(url, {
    method,
    headers: signedHeaders(method, url, acc, signBody, isForm, extra),
    body: body === undefined ? undefined : isForm ? (body as FormData) : signBody,
  });

  const raw = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw: raw.slice(0, 500) };
  }

  if (!silent) logLine('RES', { url, http: res.status, code: json?.code, msg: json?.msg, data: truncate(json?.data, 800) });

  if (json?.code !== 200) {
    const msg = String(json?.msg || `请求失败 HTTP ${res.status}`);
    // 同账号在别处重新登录会把旧 token 顶掉
    if (/token无效|token失效|未登录|登录已失效|请重新登录/.test(msg)) {
      throw new Error('客服号已掉线，请点该账号的「续期」重新上线');
    }
    throw new Error(msg);
  }
  return json.data as T;
}

const qs = (obj: Record<string, unknown>) =>
  Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

/** 会话列表：会话中 / 已结束 / 排队中 */
export const querySessionList = (acc: Account) =>
  request<{ onlineSessionList: any[]; endSessionList: any[]; queueSessionList: any[] }>(
    acc,
    'GET',
    `${API}/api/message/querySessionList?${qs({ companyId: acc.companyId, customerServiceId: acc.uid })}`,
  );

/** 某个会话的消息列表 */
export const queryMessageList = (acc: Account, p: { messageSessionId: string | number; pageNum?: number; pageSize?: number }) =>
  request<{ records: any[] }>(
    acc,
    'GET',
    `${API}/api/message/queryMessageList?${qs({ messageSessionId: p.messageSessionId, pageNum: p.pageNum ?? 1, pageSize: p.pageSize ?? 30 })}`,
  );

/**
 * 发送消息（仅由用户主动触发）
 * msgType: 1=文本 5=图片 6=视频 7=文件
 * 图片/视频/文件时 content 为 HTML 串，例如 <img class='send-img' src="URL"></img>
 * 必须带 messageSessionRecordId，否则报「消息会话记录id不能为空」
 */
export const sendMessage = (
  acc: Account,
  p: {
    messageSessionId: string | number;
    messageSessionRecordId?: string | number;
    visitorId: string | number;
    visitorName?: string;
    customerServiceGroupId?: string | number;
    content: string;
    msgType?: number;
  },
) =>
  request(acc, 'POST', `${API}/api/message/send`, {
    companyId: acc.companyId,
    messageSessionId: p.messageSessionId,
    messageSessionRecordId: p.messageSessionRecordId ?? '',
    messageFromId: acc.uid,
    messageFromName: acc.name,
    messageToId: p.visitorId,
    messageToName: p.visitorName ?? '',
    content: p.content,
    format: '1',
    msgType: p.msgType ?? 1,
    customerServiceGroupId: p.customerServiceGroupId ?? '',
    messageSendSource: 1,
  });

/** 撤回消息 */
export const recallMessage = (
  acc: Account,
  p: {
    messageSessionId: string | number;
    messageId: string | number;
    visitorId: string | number;
    visitorName?: string;
  },
) =>
  request(acc, 'POST', `${API}/api/message/recallMessage`, {
    messageSessionId: p.messageSessionId,
    messageId: p.messageId,
    messageFromId: acc.uid,
    messageFromName: acc.name,
    messageToId: p.visitorId,
    messageToName: p.visitorName ?? '',
    messageSendSource: 1,
  });

/** 标记该会话消息已读（让访客端看到「已读」） */
export const allMessageRead = (
  acc: Account,
  p: { messageSessionId: string | number; messageSourceUid: string | number },
) =>
  request(acc, 'POST', `${API}/api/message/allMessageRead`, {
    messageSessionId: p.messageSessionId,
    messageSourceUid: p.messageSourceUid,
  });

/** 上传文件，返回可访问的 URL */
export const uploadFile = (acc: Account, file: { name: string; type: string; data: Buffer }) => {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(file.data)], { type: file.type || 'application/octet-stream' }), file.name);
  const identifier = aesEncrypt(file.name);
  logLine('UPLOAD', { name: file.name, type: file.type, size: file.data.length, identifier });
  return request<string>(acc, 'POST', `${API}/api/oss/upload?${qs({ identifier })}`, fd);
};

/** 图片/视频/文件消息的 content 包装 */
export const mediaContent = {
  image: (url: string) => `<img class='send-img' src="${url}"></img>`,
  video: (url: string) => `<video src="${url}" preload="metadata" crossorigin='anonymous' autoplay controls class='send-video'></video>`,
  file: (url: string, name: string) => `<a href="${url}" download class='send-file' target="_blank">${name}</a>`,
};

/** 标记已读 */
export const messageRead = (acc: Account, p: Record<string, unknown>) => request(acc, 'POST', `${API}/api/message/messageRead`, p);

/** 客服在线状态 */
export const getUserStatus = (acc: Account) =>
  request(acc, 'GET', `${API}/api/member/getUserStatus?${qs({ customerServiceId: acc.uid })}`);

/** 切换客服状态：1=在线 4=小休 6=挂起（0=离线） */
export const changeUserStatus = (acc: Account, status: number) =>
  request(acc, 'POST', `${API}/api/member/changeUserStatus`, { uid: acc.uid, status });

/* ---------------- GM 站点（gm.tj.996sdk.com）登录态 ---------------- */

/** GM 站点的登录凭据，全部来自 gm.tj.996sdk.com 的 localStorage */
export interface GmCred {
  /** localStorage.996sdk_accesstoken */
  gmToken: string;
  /** localStorage.Juhetoken */
  juheToken: string;
  /** localStorage.996sdk_user_info.uid */
  gmUserId: string;
}

const MGN_GM = 'https://mgn-gw.tj.996sdk.com/mgn_gm_api';

/** GM 相关请求的公共头（与浏览器实际请求对齐，缺 juhe-token 会「未获得授权」） */
const gmHeaders = (c: GmCred): Record<string, string> => ({
  'x-token': c.gmToken,
  'x-ct-token': c.gmToken,
  token: c.gmToken,
  'juhe-token': c.juheToken,
  gw_gm_user_id: c.gmUserId,
  'x-client-version': '6.0.0',
  Referer: 'https://gm.tj.996sdk.com/',
  Origin: 'https://gm.tj.996sdk.com',
});

/** 用 GM 凭据换客服控制台的 token(JWT) */
export const gmLogin = (c: GmCred) =>
  request<{ token: string; url: string }>(
    { xToken: c.gmToken, token: c.gmToken, uid: c.gmUserId },
    'POST',
    `${MGN_GM}/api/researchTool/v1/chatroom/gmLogin?${qs({ token: c.gmToken })}`,
    undefined,
    gmHeaders(c),
  );

/** 用刚换到的 JWT 拉客服账号信息（拿 uid / companyId / 昵称） */
export const kfUserInfo = (jwt: string, c: GmCred) =>
  request<{ id: string; companyId: string; account: string; name?: string; realName?: string; gmUserId?: string }>(
    { xToken: jwt, token: c.gmToken, uid: c.gmUserId },
    'GET',
    `${MGN}/api/user/v1/userInfo`,
    undefined,
    { ...gmHeaders(c), 'x-token': jwt, 'x-ct-token': jwt },
  );

/* ---------------- GM 站点账号密码登录（mapi.tj.996sdk.com） ---------------- */

const GM_MAPI = 'https://mapi.tj.996sdk.com';
const GM_JH_API = 'https://jh-apis.tj.996sdk.com';

/**
 * GM 站点自己的接口：签名算法与客服接口一致，区别只在于来源头和 token。
 * 站点的 axios 拦截器就是拿 localStorage 里的 996sdk_accesstoken 当 X-Token。
 */
async function gmMapiRequest<T = any>(method: string, url: string, body?: unknown, gmToken = ''): Promise<T> {
  syncKeys();
  const signBody = signBodyOf(body);
  const x996: Record<string, string> = {
    'x-996sdk-appid': APPID,
    'x-996sdk-algo': 'MD5',
    'x-996sdk-nonce': nonce(16),
    'x-996sdk-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const path = url.replace(/(https?:?)?\/\/.+?\//i, '/');
  const lines = [method.toUpperCase(), path];
  Object.keys(x996)
    .sort()
    .forEach((k) => lines.push(`${k}=${x996[k]}`));
  lines.push(signBody);
  lines.push(`key=${APPKEY}`);

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'X-Client-Version': '6.0.0',
    'x-requested-with': 'XMLHttpRequest',
    Referer: 'https://gm.tj.996sdk.com/',
    Origin: 'https://gm.tj.996sdk.com',
    'x-token': gmToken,
    'x-ct-token': gmToken,
    token: gmToken,
    ...x996,
    'x-996sdk-sign': md5(lines.join('\n')),
  };
  if (signBody) headers['content-type'] = 'application/json;charset=UTF-8';

  logLine('GM_REQ', { method, url, body: truncate(signBody, 500) });
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : signBody });
  const raw = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw: raw.slice(0, 500) };
  }
  logLine('GM_RES', { url, http: res.status, code: json?.code, msg: json?.msg, data: truncate(json?.data, 500) });
  if (json?.code !== 200) throw new Error(String(json?.msg || `请求失败 HTTP ${res.status}`));
  return json.data as T;
}

/**
 * 服务端判断这个「账号 + 设备标识」是不是异地登录。
 * is_remote === 1 时登录必须带验证码。
 */
export const gmIsRemote = (username: string, deviceId: string) =>
  gmMapiRequest<{ is_remote: number }>('POST', `${GM_MAPI}/mapi/v1/user/isRemote`, { username, deviceid: deviceId });

/** 账号密码登录：返回的 deviceid 要存下来，下次登录带上就不再需要验证码 */
export const gmUserLogin = (p: { username: string; password: string; code?: string; deviceid?: string }) =>
  gmMapiRequest<{ token: string; uid: number | string; deviceid?: string; is_bind_wx?: number }>(
    'POST',
    `${GM_MAPI}/mapi/v1/user/login`,
    p,
  );

/** 用 GM 的 996sdk_accesstoken 换 Juhetoken（客服系统要 juhe-token 头） */
export const gmJuheLogin = (gmToken: string) =>
  gmMapiRequest<{ token: string }>('POST', `${GM_JH_API}/v4/auth/login`, { token: gmToken }, gmToken);

/** 登录后拉 GM 用户信息（拿 uid / account 写进 localStorage 的同款数据） */
export const gmUserInfo = (gmToken: string) =>
  gmMapiRequest<{ uid: number | string; account: string }>('GET', `${GM_MAPI}/mapi/v1/user/info`, undefined, gmToken);

/* ---------------- GM 玩家管理：只读查询接口 ---------------- */
/**
 * 以下全部为「只读查询」，不实现任何改动玩家数据的操作（封禁/解封、发放/扣除、
 * 踢下线、改属性、发邮件等一律不在此层）。
 *
 * 三个后端：
 *   https://mgn-gw.tj.996sdk.com  → /mgn_gm_api/*  与 /gm_auth_api/*
 *   https://ad.tj.996sdk.com      → /v1/gm/playerManage/*（新版日志）
 *   https://mapi.tj.996sdk.com    → /mapi/v1/*（授权游戏 / 导航树）
 *
 * 公共请求头：token / x-token = GM 站点 token，juhe-token，webgameid=游戏ID，
 *            webroutername=当前页路由名，x-996sdk-module-type=渠道(默认 2)。
 * 签名：MD5( METHOD \n PATH_WITH_QUERY \n 排序后的 x-996sdk-* \n body \n key=APPKEY )
 */

const GM_MGN_GW = 'https://mgn-gw.tj.996sdk.com';
const GM_AD = 'https://ad.tj.996sdk.com';
const GM_MGN_API = `${GM_MGN_GW}/mgn_gm_api`;
const GM_AUTH_API = `${GM_MGN_GW}/gm_auth_api`;
const GM_PM = `${GM_AD}/v1/gm/playerManage`;

/** 一次 GM 查询固定在某个游戏下 */
export interface GmCtx {
  /** GM 站点 token（localStorage.996sdk_accesstoken） */
  gmToken: string;
  /** localStorage.Juhetoken */
  juheToken: string;
  /** GM 用户 id，如 58127（gmId） */
  gmUserId: string;
  /** 游戏 ID，如 207730 */
  gameId: number | string;
  /** 渠道（module type），默认 2 */
  gameChannel?: number;
  /** gameType 字符串：admin 切 1→cq996、2→cs996、4→c3996，默认 cq996 */
  gameType?: string;
  /** 当前页路由名，默认玩家列表 */
  router?: string;
}

/** 用已保存账号 + 游戏 ID 生成查询上下文 */
export const gmCtx = (acc: Account, gameId: number | string): GmCtx => ({
  gmToken: acc.token,
  juheToken: acc.juheToken || '',
  gmUserId: acc.gmUserId || acc.uid,
  gameId,
});

/** GM 通用签名请求（只读） */
async function gmSigned<T = any>(c: GmCtx, method: string, url: string, body?: unknown): Promise<T> {
  syncKeys();
  const signBody = signBodyOf(body);
  const x996: Record<string, string> = {
    'x-996sdk-appid': APPID,
    'x-996sdk-algo': 'MD5',
    'x-996sdk-module-type': String(c.gameChannel ?? 2),
    'x-996sdk-nonce': nonce(16),
    'x-996sdk-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const path = url.replace(/(https?:?)?\/\/.+?\//i, '/');
  const lines = [method.toUpperCase(), path];
  Object.keys(x996)
    .sort()
    .forEach((k) => lines.push(`${k}=${x996[k]}`));
  lines.push(signBody);
  lines.push(`key=${APPKEY}`);

  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'X-Client-Version': '6.0.0',
    'x-requested-with': 'XMLHttpRequest',
    Referer: 'https://gm.tj.996sdk.com/',
    Origin: 'https://gm.tj.996sdk.com',
    token: c.gmToken,
    'x-token': c.gmToken,
    'juhe-token': c.juheToken,
    ...(c.gameId ? { webgameid: String(c.gameId) } : {}),
    webroutername: c.router || 'playerManagePlayerListNew',
    ...x996,
    'x-996sdk-sign': md5(lines.join('\n')),
  };
  if (signBody) headers['content-type'] = 'application/json';

  logLine('GM_REQ', { method, url, body: truncate(signBody, 500) });
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : signBody });
  const raw = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw: raw.slice(0, 500) };
  }
  logLine('GM_RES', { url, http: res.status, code: json?.code, msg: json?.msg, data: truncate(json?.data, 500) });
  if (json?.code !== 200) throw new Error(String(json?.msg || `请求失败 HTTP ${res.status}`));
  return json.data as T;
}

/** /v1/gm/playerManage/* 的公共 body 参数 */
const pmBody = (c: GmCtx, router: string, extra: Record<string, unknown> = {}) => ({
  gameId: Number(c.gameId),
  gmId: Number(c.gmUserId),
  gm_id: Number(c.gmUserId),
  gameChannel: c.gameChannel ?? 2,
  'X-Token': c.gmToken,
  gameType: c.gameType || 'cq996',
  channelType: -1,
  webRouterName: router,
  appid: '',
  web_domain: 'default',
  ...extra,
});

/** /v1/gm/playerManage/* 的公共 query 参数 */
const pmQuery = (c: GmCtx, router: string, extra: Record<string, unknown> = {}) =>
  qs({
    gameId: c.gameId,
    gmId: c.gmUserId,
    gameChannel: c.gameChannel ?? 2,
    'X-Token': c.gmToken,
    gameType: c.gameType || 'cq996',
    channelType: -1,
    webRouterName: router,
    ...extra,
  });

/* --- 游戏 / 区服 --- */

/** 当前账号的授权游戏列表（/myGame 页面数据）。授权游戏可能多于一页，这里全部翻完再返回 */
export const gmGameAuthList = async (gmToken: string, adminGameType = 1): Promise<{ total: number; list: any[] }> => {
  const pageSize = 100;
  const fetchPage = (pageNumber: number) =>
    gmSigned<{ total: number; list: any[] }>(
      { gmToken, juheToken: '', gmUserId: '', gameId: '' },
      'POST',
      `${GM_MAPI}/mapi/v1/gameAccredit/sdkGameAuthList`,
      { channel_type: '0', game_key: '', page_number: pageNumber, page_size: pageSize, is_hide: 1, sort_name: '', sort_val: 1, admin_game_type: adminGameType },
    );
  const first = await fetchPage(1);
  const total = Number(first?.total || 0);
  const list = [...(first?.list || [])];
  for (let n = 2; list.length < total && n <= 20; n += 1) {
    const chunk = (await fetchPage(n))?.list || [];
    if (!chunk.length) break;
    list.push(...chunk);
  }
  return { total, list };
};

/** 授权游戏数量统计 */
export const gmGameAuthTotal = (gmToken: string, adminGameType = 1) =>
  gmSigned<{ my_game: number; auth_game: number; union_game: number }>(
    { gmToken, juheToken: '', gmUserId: '', gameId: '' },
    'POST',
    `${GM_MAPI}/mapi/v1/gameAccredit/getAllGameTotal`,
    { admin_game_type: adminGameType },
  );

/** 主区列表（玩家列表页「区服」下拉的数据源） */
export const gmAreaList = (c: GmCtx) =>
  gmSigned<any[]>(c, 'GET', `${GM_PM}/getAreaList?${pmQuery(c, c.router || 'playerManagePlayerListNew')}`);

/** 区服列表（主区/子区） */
export const gmServerList = (c: GmCtx, p: { main?: boolean; compositeCondition?: string } = {}) =>
  gmSigned<{ id: number; name: string; serverId: number }[]>(
    c,
    'GET',
    `${GM_MGN_API}/server/list/idName?${qs({
      gameId: c.gameId,
      main: p.main !== false,
      merging: '',
      all: 'false',
      isBigServer: 'true',
      isSubServer: p.main === false,
      compositeCondition: p.compositeCondition,
    })}`,
  );

/** 合服区服列表 */
export const gmServerMergeList = (c: GmCtx, pageNum = 1) =>
  gmSigned<{ id: number; name: string; serverId: number }[]>(
    c,
    'GET',
    `${GM_MGN_API}/server/list/idNameMerge?${qs({ gameId: c.gameId, main: true, merging: '', pageNum })}`,
  );

/* --- 玩家 --- */

/** 玩家列表分页（主查询，serverId 必填） */
export const gmPlayerPage = (
  c: GmCtx,
  p: {
    serverId: string | number;
    pageNum?: number;
    pageSize?: number;
    account?: string;
    accountId?: string;
    roleName?: string;
    roleId?: string;
    userAccount?: string;
    userId?: string;
    platformId?: string | number;
    reLevel?: string | number;
    deleted?: string | number;
    job?: string | number;
    banStatus?: string | number;
    status?: string;
    promoteUserId?: string;
    startTime?: string;
    endTime?: string;
  },
) =>
  gmSigned<{ records: any[]; total: number }>(
    c,
    'GET',
    `${GM_MGN_API}/gm/game/user/paging?${qs({
      pageNum: p.pageNum ?? 1,
      pageSize: p.pageSize ?? 30,
      gameId: c.gameId,
      serverId: p.serverId,
      account: p.account,
      accountId: p.accountId,
      roleName: p.roleName,
      roleId: p.roleId,
      userAccount: p.userAccount,
      userId: p.userId,
      platformId: p.platformId ?? '',
      job: p.job,
      reLevel: p.reLevel,
      deleted: p.deleted,
      banStatus: p.banStatus,
      status: p.status,
      startTime: p.startTime,
      endTime: p.endTime,
      promoteUserId: p.promoteUserId ?? '',
      promoteAccount: '',
    })}`,
  );

/** 渠道分包列表（玩家列表「渠道分包」下拉的数据源） */
export const gmPlatformList = (c: GmCtx) =>
  gmSigned<{ id: string; name: string; clientType: number }[]>(c, 'GET', `${GM_MGN_API}/gm/platform/list?${qs({ gameId: c.gameId })}`);

/** 账号维度查角色（跨区服，userQuery 页） */
export const gmUserQueryPage = (c: GmCtx, p: { pageNum?: number; pageSize?: number; account?: string; roleName?: string; roleId?: string }) =>
  gmSigned<{ records: any[]; total: number }>(c, 'POST', `${GM_AUTH_API}/userQuery/userList/pageC2`, {
    pageNum: p.pageNum ?? 1,
    pageSize: p.pageSize ?? 30,
    gameId: Number(c.gameId),
    account: p.account ?? '',
    roleName: p.roleName ?? '',
    roleId: p.roleId ?? '',
  });

/** 游戏开关信息（角色禁用状态、按钮权限） */
export const gmGameInfo = (c: GmCtx) =>
  gmSigned<any>(c, 'GET', `${GM_MGN_API}/gm/game/setting/getGameInfo?${qs({ gameId: c.gameId })}`);

/** 玩家货币余额（currencyIdList 必填，如 [1]） */
export const gmCurrencyAmount = (c: GmCtx, p: { serverId: string | number; roleId: string | number; currencyIdList: (number | string)[] }) =>
  gmSigned<{ id: number; amount: number }[]>(c, 'POST', `${GM_MGN_API}/gm/game/user/currency/amount/list`, {
    gameId: Number(c.gameId),
    serverId: p.serverId,
    roleId: p.roleId,
    currencyIdList: p.currencyIdList,
  });

/** 玩家登录记录（serverId + roleId 必填） */
export const gmLoginPage = (c: GmCtx, p: { serverId: string | number; roleId: string | number; pageNum?: number; pageSize?: number }) =>
  gmSigned<{ records: any[] }>(
    c,
    'GET',
    `${GM_MGN_API}/gm/game/user/login/paging?${qs({
      pageNum: p.pageNum ?? 1,
      pageSize: p.pageSize ?? 30,
      gameId: c.gameId,
      serverId: p.serverId,
      roleId: p.roleId,
    })}`,
  );

/** 玩家是否在线（roleId 必填） */
export const gmOnlineStatus = (c: GmCtx, p: { serverId: string | number; roleId: string | number }) =>
  gmSigned<boolean>(c, 'GET', `${GM_MGN_API}/gm/game/user/online/status?${qs({ gameId: c.gameId, serverId: p.serverId, roleId: p.roleId })}`);

/** 玩家封禁记录（roleId + accountId 均必填） */
export const gmBanList = (c: GmCtx, p: { serverId: string | number; roleId: string | number; accountId: string | number }) =>
  gmSigned<any[]>(
    c,
    'GET',
    `${GM_MGN_API}/gm/game/user/ban/list?${qs({ pageNum: 1, pageSize: 30, gameId: c.gameId, serverId: p.serverId, roleId: p.roleId, accountId: p.accountId })}`,
  );

/** IP 封禁分页 */
export const gmIpBanPage = (c: GmCtx, p: { serverId?: string | number; pageNum?: number; pageSize?: number }) =>
  gmSigned<{ records: any[] }>(
    c,
    'GET',
    `${GM_MGN_API}/gm/game/user/ban/ip/paging?${qs({ pageNum: p.pageNum ?? 1, pageSize: p.pageSize ?? 30, gameId: c.gameId, serverId: p.serverId ?? '', roleId: '', roleName: '' })}`,
  );

/** 按账号或 IP 查登录 IP 记录（account / ip 二选一） */
export const gmIpLogs = (c: GmCtx, p: { account?: string; ip?: string; serverId?: string | number; pageNum?: number; pageSize?: number }) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/player/ip/getLogs`, {
    pageNum: p.pageNum ?? 1,
    pageSize: p.pageSize ?? 30,
    gameId: Number(c.gameId),
    serverId: p.serverId ?? '',
    account: p.account ?? '',
    ip: p.ip ?? '',
  });

/* --- 记录查询 --- */

/** 物品记录（goodsRecordNew） */
export const gmItemLog = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/gameUser/itemLog/paging`, { pageNum: 1, pageSize: 30, gameId: Number(c.gameId), ...p, serverType: (p.serverType as string) || 'main' });

/** 货币记录（currencyRecordNew） */
export const gmCurrencyLog = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/gm/currency/log/paging`, { pageNum: 1, pageSize: 30, gameId: Number(c.gameId), ...p, serverType: (p.serverType as string) || 'mix' });

/** 物品/货币动作字典（type=goods|currency） */
export const gmGoodsActionList = (c: GmCtx, type = 'goods') =>
  gmSigned<{ id: number; name: string }[]>(c, 'GET', `${GM_MGN_API}/goods/action/listGoodsAction?${qs({ type })}`);

/** 聊天记录 */
export const gmChatLogPage = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/gm/chatLog/page`, { pageNum: 1, pageSize: 30, gameId: Number(c.gameId), ...p });

/** 邮件记录 */
export const gmMailLogPage = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/email/log/pageList`, {
    pageNum: 1,
    pageSize: 30,
    gameId: Number(c.gameId),
    serverId: '',
    roleId: '',
    ...p,
  });

/** 自定义日志的可选字段（customLog） */
export const gmCustomLogArgs = (c: GmCtx) => gmSigned<any[]>(c, 'GET', `${GM_MGN_API}/gameUser/customLog/args`);

/** 自定义日志分页 */
export const gmCustomLogPage = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/gameUser/customLog/page`, {
    pageSize: 30,
    pageNum: 1,
    gameId: Number(c.gameId),
    serverId: '',
    addCond: [],
    ...p,
  });

/** 角色删除日志 */
export const gmRolePageLog = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/gm/engine/role/pageLog`, { pageNum: 1, pageSize: 30, gameId: Number(c.gameId), ...p });

/** 敏感词检测记录 */
export const gmSensitiveWordPage = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(
    c,
    'GET',
    `${GM_MGN_API}/gm/sensitiveWordDetect/page?${qs({ pageNum: 1, pageSize: 30, gameId: c.gameId, serverId: '', roleId: '', roleName: '', tag: '', ip: '', accountId: '', account: '', ...p })}`,
  );

/** 易盾封禁记录 */
export const gmYidunBanPage = (c: GmCtx, p: Record<string, unknown>) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/yidun/ban/page`, {
    gameId: Number(c.gameId),
    serverId: '',
    moduleType: c.gameChannel ?? 2,
    pageNum: 1,
    pageSize: 10,
    addCond: [],
    ...p,
  });

/** 黑名单分页（账号/IP） */
export const gmBlackPageList = (c: GmCtx, p: { pageNum?: number; pageSize?: number } = {}) =>
  gmSigned<{ records: any[] }>(
    c,
    'GET',
    `${GM_AUTH_API}/gameUser/black/pageList?${qs({ pageNum: p.pageNum ?? 1, pageSize: p.pageSize ?? 30, gameType: 1 })}`,
  );

/* --- 统计 --- */

/** 等级分布 */
export const gmRoleLevelStatistics = (c: GmCtx, p: { serverId?: string | number; queryTime: number }) =>
  gmSigned<any>(c, 'GET', `${GM_MGN_API}/hole/statistics/queryRoleLevelStatistics?${qs({ gameId: c.gameId, serverId: p.serverId ?? '', queryTime: p.queryTime })}`);

/** 等级 + 首充分布 */
export const gmRoleLevelFirstPayStatistics = (c: GmCtx, p: { serverId?: string | number; queryTime: number }) =>
  gmSigned<any>(
    c,
    'GET',
    `${GM_MGN_API}/hole/statistics/queryRoleLevelAndFirstPayStatistics?${qs({ gameId: c.gameId, serverId: p.serverId ?? '', queryTime: p.queryTime })}`,
  );

/** 在线时长分布 */
export const gmRoleLineTimeStatistics = (c: GmCtx, p: { serverId?: string | number; queryTime: number }) =>
  gmSigned<any>(c, 'GET', `${GM_MGN_API}/hole/statistics/queryRoleLineTimeStatistics?${qs({ gameId: c.gameId, serverId: p.serverId ?? '', queryTime: p.queryTime })}`);

/** 玩家战力榜（serverIds 必填） */
export const gmPlayerRankPage = (c: GmCtx, p: { serverIds: (string | number)[]; pageNum?: number; pageSize?: number }) =>
  gmSigned<{ records: any[] }>(c, 'POST', `${GM_MGN_API}/gm/api/game_user/rank/v1/page`, {
    pageNum: p.pageNum ?? 1,
    pageSize: p.pageSize ?? 30,
    gameId: Number(c.gameId),
    serverIds: p.serverIds,
    lowestRecharge: '',
    highestRecharge: '',
    count: '',
  });

/* --- 新版日志（ad.tj.996sdk.com /v1/gm/playerManage/*） --- */

/** 新版日志种类 */
export type GmLogKind = 'Death' | 'Login' | 'Logout' | 'Action' | 'Upgrade' | 'Ban' | 'Chat';

/**
 * 通用新版日志查询：死亡/登录/登出/行为/升级/封禁/聊天。
 *
 * 各日志的过滤参数并不一致（照官方前端真实报文对齐）：
 *   Death / Login / Logout：过滤走 `addcond`（JSON 字符串），顶层 userid / account 恒为空串，
 *     传顶层 userid 反而会被服务端「相与」成空结果；
 *   Action：顶层 actionId / roleId / roleName；
 *   Upgrade：顶层 roleId / roleName / level / type；
 *   Ban：顶层 serverId / roleName / accountId / areaName，且返回体取 records。
 */
export const gmPlayerLog = (
  c: GmCtx,
  kind: GmLogKind,
  p: {
    areaId?: number;
    startDate: string;
    endDate: string;
    /** ad 域日志的条件过滤，形如 `[{"prop":"userid","value":"…","label":"角色ID","type":""}]` */
    addcond?: string;
    account?: string;
    userid?: string;
    /** 行为 / 升级日志：顶层角色过滤 */
    roleId?: string;
    roleName?: string;
    level?: string;
    type?: string | number;
    actionId?: string;
    /** 封禁日志 */
    serverId?: string | number;
    accountId?: string;
    areaName?: string;
    pageNum?: number;
    pageSize?: number;
  },
) => {
  const body: Record<string, unknown> = {
    startDate: p.startDate,
    endDate: p.endDate,
    pageNum: p.pageNum ?? 1,
    pageSize: p.pageSize ?? 30,
  };
  if (kind === 'Ban') {
    // 官方在区服为空时明确传 null
    Object.assign(body, {
      serverId: p.serverId || null,
      roleName: p.roleName ?? '',
      accountId: p.accountId ?? '',
      areaName: p.areaName ?? '',
    });
  } else {
    body.areaId = p.areaId ?? 0;
    if (kind === 'Upgrade') {
      Object.assign(body, { roleId: p.roleId ?? '', roleName: p.roleName ?? '', level: p.level ?? '', type: p.type ?? '' });
    } else if (kind === 'Action') {
      Object.assign(body, { actionId: p.actionId ?? '', roleId: p.roleId ?? '', roleName: p.roleName ?? '' });
    } else {
      Object.assign(body, { account: p.account ?? '', userid: p.userid ?? '', addcond: p.addcond ?? '[]' });
    }
  }
  return gmSigned<{ total: number; lists?: any[]; records?: any[] }>(c, 'POST', `${GM_PM}/get${kind}Log`, pmBody(c, `playerManage${kind}Log`, body));
};

/** 新版货币记录 */
export const gmCurrencyRecord = (
  c: GmCtx,
  p: { areaId?: number; startDate: string; endDate: string; account?: string; userid?: string; addcond?: string; pageNum?: number; pageSize?: number },
) =>
  gmSigned<{ total: number; lists: any[] }>(
    c,
    'POST',
    `${GM_PM}/getCurrencyRecord`,
    pmBody(c, 'playerManageCurrencyRecordNew', {
      areaId: p.areaId ?? 0,
      startDate: p.startDate,
      endDate: p.endDate,
      account: p.account ?? '',
      userid: p.userid ?? '',
      addcond: p.addcond ?? '[]',
      pageNum: p.pageNum ?? 1,
      pageSize: p.pageSize ?? 30,
    }),
  );

/** 新版日志的动作类型字典 */
export const gmActionType = (c: GmCtx) => gmSigned<{ id: number; name: string }[]>(c, 'GET', `${GM_PM}/getActionType?${pmQuery(c, 'playerManageActionLog')}`);

/* ---------------- 企微客服中心（另一套系统，中心地址由用户填写） ---------------- */

/** 企微客服中心登录返回：token + 用户信息 */
export interface QywxLoginResult {
  token: string;
  user: Record<string, any>;
}

/** 去掉末尾斜杠，并校验中心地址格式 */
export function qywxOrigin(serverUrl: string): string {
  const url = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('中心地址必须以 http:// 或 https:// 开头');
  return url;
}

/**
 * 企微客服中心：账号密码登录。
 * POST {中心地址}/api/auth/login  body: { username, password }
 * 返回 { success, data: { token, user } }，后续请求带 Authorization: Bearer <token>。
 */
export async function qywxLogin(p: {
  serverUrl: string;
  username: string;
  password: string;
}): Promise<QywxLoginResult> {
  const origin = qywxOrigin(p.serverUrl);
  const res = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: p.username, password: p.password }),
  });
  const data = (await res.json().catch(() => null)) as any;
  // 有些网关会包一层 { success, data }，这里都兼容
  const body = data?.data ?? data;
  if (!res.ok || data?.success === false) throw new Error(data?.message || body?.message || `登录失败（HTTP ${res.status}）`);
  const token = body?.token || data?.token;
  if (!token) throw new Error(data?.message || '登录失败：服务端没有返回 token');
  return { token: String(token), user: body?.user || data?.user || {} };
}

/** 企微客服中心：校验 token 并取当前用户 */
export async function qywxMe(serverUrl: string, token: string): Promise<Record<string, any>> {
  const origin = qywxOrigin(serverUrl);
  const res = await fetch(`${origin}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as any;
  // 接口可能直接返回 user，也可能包一层 { data } / { user } / { data: { user } }
  return data?.data?.user || data?.data || data?.user || {};
}

/**
 * 企微客服中心统一请求：注入 Authorization: Bearer <token>，并把 { success, data } 解一层。
 * 页面端的 axios 拦截器就是这么做的（response => response.data），这里保持一致。
 */
async function qywxFetch(
  serverUrl: string,
  token: string,
  path: string,
  init?: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> },
): Promise<any> {
  const origin = qywxOrigin(serverUrl);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init?.headers || {}) };
  let body = init?.body;
  if (init?.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${origin}${path}`, { method: init?.method || 'GET', headers, body });
  const raw = (await res.json().catch(() => null)) as any;
  if (!res.ok || raw?.success === false) {
    throw new Error(raw?.message || raw?.error || `请求失败（HTTP ${res.status}）`);
  }
  return raw?.data !== undefined ? raw.data : raw;
}

/** 企微会话 key：robot_id + contact_user_id 唯一确定一条会话 */
export const qywxConvKey = (robotId: number | string, contactUserId: string) => `${robotId}:${contactUserId}`;

/** 会话列表（GET /api/conversations） */
export const qywxConversations = (serverUrl: string, token: string) =>
  qywxFetch(serverUrl, token, '/api/conversations') as Promise<any[]>;

/**
 * 某会话的历史消息（GET /api/conversations/{robot_id}/{contact_user_id}/messages）。
 * 传 beforeId 时向上翻页，返回更早的一批消息。
 */
export const qywxMessages = (
  serverUrl: string,
  token: string,
  robotId: number | string,
  contactUserId: string,
  beforeId?: number | string,
) => {
  const q =
    beforeId !== undefined && beforeId !== null && beforeId !== '' ? `?before_id=${encodeURIComponent(String(beforeId))}` : '';
  return qywxFetch(
    serverUrl,
    token,
    `/api/conversations/${encodeURIComponent(String(robotId))}/${encodeURIComponent(contactUserId)}/messages${q}`,
  ) as Promise<any[]>;
};

/**
 * 手动回复（POST /api/manual/reply）。
 * msg_type：2=文本（content） 14=图片（image_path） 23=视频（video_path）。
 */
export const qywxReply = (
  serverUrl: string,
  token: string,
  p: {
    robotId: number | string;
    contactUserId: string;
    msgType: number;
    content?: string;
    imagePath?: string;
    videoPath?: string;
    traceId?: string;
  },
) =>
  qywxFetch(serverUrl, token, '/api/manual/reply', {
    method: 'POST',
    json: {
      robot_id: Number(p.robotId),
      contact_user_id: p.contactUserId,
      ...(p.content !== undefined ? { content: p.content } : {}),
      msg_type: p.msgType,
      ...(p.imagePath ? { image_path: p.imagePath } : {}),
      ...(p.videoPath ? { video_path: p.videoPath } : {}),
      ...(p.traceId ? { trace_id: p.traceId } : {}),
    },
  }) as Promise<any>;

/** 上传图片 / 视频（POST /api/upload/image | /api/upload/video，FormData 字段名 file） */
export async function qywxUpload(
  serverUrl: string,
  token: string,
  kind: 'image' | 'video',
  file: { name: string; type: string; data: Buffer },
): Promise<{ url: string; filename: string }> {
  const origin = qywxOrigin(serverUrl);
  const form = new FormData();
  const bytes = new Uint8Array(file.data);
  form.append('file', new Blob([bytes], { type: file.type || 'application/octet-stream' }), file.name);
  const res = await fetch(`${origin}/api/upload/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const raw = (await res.json().catch(() => null)) as any;
  if (!res.ok || raw?.success === false) throw new Error(raw?.message || `上传失败（HTTP ${res.status}）`);
  const data = raw?.data ?? raw;
  if (!data?.url) throw new Error('上传失败：服务端没有返回地址');
  return { url: String(data.url), filename: String(data.filename || '') };
}

/** 标记某会话全部已读（POST /api/messages/read） */
export const qywxRead = (serverUrl: string, token: string, p: { robotId: number | string; contactUserId: string }) =>
  qywxFetch(serverUrl, token, '/api/messages/read', {
    method: 'POST',
    json: { robot_id: Number(p.robotId), contact_user_id: p.contactUserId },
  });

/** 手动把会话标为未读（POST /api/conversations/{r}/{c}/unread） */
export const qywxSetUnread = (
  serverUrl: string,
  token: string,
  p: { robotId: number | string; contactUserId: string },
) =>
  qywxFetch(
    serverUrl,
    token,
    `/api/conversations/${encodeURIComponent(String(p.robotId))}/${encodeURIComponent(p.contactUserId)}/unread`,
    { method: 'POST' },
  );

/** 置顶 / 取消置顶（PUT /api/conversations/{r}/{c}/pin） */
export const qywxPin = (
  serverUrl: string,
  token: string,
  p: { robotId: number | string; contactUserId: string; pinned: boolean },
) =>
  qywxFetch(
    serverUrl,
    token,
    `/api/conversations/${encodeURIComponent(String(p.robotId))}/${encodeURIComponent(p.contactUserId)}/pin`,
    { method: 'PUT', json: { pinned: p.pinned } },
  );

/** 删除会话（DELETE /api/conversations/{r}/{c}） */
export const qywxDeleteConversation = (
  serverUrl: string,
  token: string,
  p: { robotId: number | string; contactUserId: string },
) =>
  qywxFetch(
    serverUrl,
    token,
    `/api/conversations/${encodeURIComponent(String(p.robotId))}/${encodeURIComponent(p.contactUserId)}`,
    { method: 'DELETE' },
  );

/** 语音转写（POST /api/messages/{id}/transcribe）→ { text } */
export const qywxTranscribe = (serverUrl: string, token: string, messageId: number | string) =>
  qywxFetch(serverUrl, token, `/api/messages/${encodeURIComponent(String(messageId))}/transcribe`, {
    method: 'POST',
  }) as Promise<{ text?: string }>;

/** 某个机器人的快捷回复列表 */
export const qywxQuickReplies = (serverUrl: string, token: string, robotId: number | string) =>
  qywxFetch(serverUrl, token, `/api/robots/${encodeURIComponent(String(robotId))}/quick-replies`) as Promise<any[]>;

export const qywxAddQuickReply = (
  serverUrl: string,
  token: string,
  robotId: number | string,
  content: string,
) =>
  qywxFetch(serverUrl, token, `/api/robots/${encodeURIComponent(String(robotId))}/quick-replies`, {
    method: 'POST',
    json: { content },
  });

export const qywxUpdateQuickReply = (
  serverUrl: string,
  token: string,
  robotId: number | string,
  id: number | string,
  content: string,
) =>
  qywxFetch(
    serverUrl,
    token,
    `/api/robots/${encodeURIComponent(String(robotId))}/quick-replies/${encodeURIComponent(String(id))}`,
    { method: 'PUT', json: { content } },
  );

export const qywxDeleteQuickReply = (
  serverUrl: string,
  token: string,
  robotId: number | string,
  id: number | string,
) =>
  qywxFetch(
    serverUrl,
    token,
    `/api/robots/${encodeURIComponent(String(robotId))}/quick-replies/${encodeURIComponent(String(id))}`,
    { method: 'DELETE' },
  );

/** 访客信息 */
export const queryVisitorUser = (acc: Account, p: { visitorId?: string | number; messageSessionRecordId?: string | number }) =>
  request(acc, 'GET', `${MGN}/api/visitor/queryVisitorUser?${qs(p)}`);
/** 会话记录分页（/chatRecord） */
export const recordPage = (
  acc: Account,
  p: { pageNum?: number; pageSize?: number; visitorEnterStartTime?: string; visitorEnterEndTime?: string; visitorName?: string },
) =>
  request<{ records: any[]; total?: number }>(
    acc,
    'GET',
    `${MGN}/messageSessionRecord/v1/page?${qs({ userId: acc.uid, pageNum: p.pageNum ?? 1, pageSize: p.pageSize ?? 20, ...p })}`,
  );

/** 某条会话记录的全部消息 */
export const queryMessageRecord = (acc: Account, p: { messageSessionRecordId: string | number }) =>
  request(acc, 'GET', `${MGN}/messageSessionRecord/v1/queryMessageRecord?${qs(p)}`);

/**
 * 回复会话记录（会话详情里的「回复记录」）
 * body 字段顺序需与官方一致；isAgrent 是官方拼写（原意 isAgent），type 固定 2
 */
export const sendLeaveMessage = (
  acc: Account,
  p: { id: string | number; content: string; handlerName: string; type?: number },
) =>
  request<boolean>(acc, 'POST', `${MGN}/leaveMessageRecord/v1/sendLeaveMessage`, {
    content: p.content,
    type: p.type ?? 2,
    isAgrent: true,
    handlerName: p.handlerName,
    id: String(p.id),
  });

/**
 * token 探活：用「会话记录」接口判断当前 token 是否还有效。
 * 静默请求，不写日志。
 */
export const probeRecordPage = (acc: Account) =>
  request(
    acc,
    'GET',
    `${MGN}/messageSessionRecord/v1/page?${qs({ userId: acc.uid, pageNum: 1, pageSize: 1 })}`,
    undefined,
    undefined,
    true,
  );

/** 某访客的历史会话 */
export const serviceRecord = (acc: Account, p: { visitorId: string | number; customerServiceGroupId: string | number }) =>
  request(acc, 'GET', `${MGN}/messageSessionRecord/v1/serviceRecord?${qs(p)}`);
