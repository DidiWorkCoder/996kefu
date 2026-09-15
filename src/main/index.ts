import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ai from './ai';
import * as api from './api';
import { readDeviceIdFromBrowsers } from './browserDevice';
import { callbackScript, deviceScript, startCallbackServer } from './gm';
import { registerGmIpc } from './gmQuery';
import { startKeyRefresh } from './keys';
import * as lan from './lan';
import * as learn from './learn';
import { logDir, logLine } from './logger';
import * as qywx from './qywx';
import {
  deviceIdOf,
  getSettings,
  keywordKey,
  knowledgeDirOf,
  saveSettings,
  setDeviceId,
  setProfile,
  type AccountProfile,
  type AiConfig,
  type KeywordRule,
  type LanConfig,
  type Settings,
} from './settings';
import { getAccount, isGmAuth, isQywx, listAccounts, removeAccount, upsertAccount, type Account, type AccountKind } from './store';
import * as ws from './ws';

const LOGIN_URL = 'https://gm.tj.996sdk.com/login';
/** 登录成功后 GM 站点会跳到这里，只在这个页面读凭据（客服号） */
const MYTOOL_PATH = '/myTool';
/** 权限号（只读查询）登录后的落地页：授权游戏列表 */
const MYGAME_PATH = '/myGame';
/** 程序图标（取自客服控制台的 favicon，已转成 256x256 PNG） */
const ICON = join(__dirname, '../../resources/icon.png');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 真正的退出（点击托盘退出 / 系统退出）时才关窗口，否则只隐藏到后台 */
let isQuitting = false;

/** 从托盘/通知里唤出主窗口 */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 托盘图标：关闭窗口后在后台常驻 */
function createTray(): void {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('996 客服管理器');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

/** 解析 JWT 的 payload（拿 exp / companyId） */
function parseJwt(token: string): any {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'));
  } catch {
    return {};
  }
}

/**
 * 读取 GM 站点 localStorage 里的登录凭据。
 * 站点把值都包了一层 { expireAt, data }，取法与「登录脚本」保持一致。
 * 顺带把 deviceid:<账号> 也读出来，下次登录补写回去可免验证码。
 */
const READ_GM_CRED = `(function () {
  var g = function (k) { try { return JSON.parse(localStorage.getItem(k)).data } catch (e) { return null } };
  var info = g('996sdk_user_info') || {};
  var dev = null;
  try { dev = JSON.parse(localStorage.getItem('deviceid:' + info.account)).data } catch (e) { dev = null }
  return JSON.stringify({
    gmToken: g('996sdk_accesstoken'),
    juheToken: g('Juhetoken'),
    gmUserId: String(info.uid || ''),
    account: String(info.account || ''),
    deviceId: dev ? String(dev) : ''
  });
})()`;

/**
 * 把已知的 deviceid:<账号> 补写进登录窗口的 localStorage。
 * 站点在账号输入框失焦时会带着 deviceid 调 /mapi/v1/user/isRemote，
 * 服务端返回 is_remote=1 就要求验证码。全新窗口没有这个 deviceid，
 * 所以必须靠这里补上，之后登录同一个账号就不用再输验证码。
 * 写入格式要和站点一致（{ expireAt, data }），只补空缺、不覆盖已有值。
 */
const seedDeviceIds = (seeds: Record<string, string>) => `(function (seeds) {
  try {
    for (var k in seeds) {
      var key = 'deviceid:' + k;
      var cur = null;
      try { cur = JSON.parse(localStorage.getItem(key)).data } catch (e) { cur = null }
      if (cur) continue;
      localStorage.setItem(key, JSON.stringify({ expireAt: 0, data: seeds[k] }));
    }
  } catch (e) {}
})(${JSON.stringify(seeds)})`;

/** 登录页表单：把账号填进去并触发失焦（站点会拿 deviceid 去问是否需要验证码） */
const FILL_USERNAME = (username: string) => `(function (v) {
  var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  var el = [].slice.call(document.querySelectorAll('input')).filter(function (n) {
    return n.type !== 'password' && n.type !== 'hidden' && !n.disabled && n.offsetParent !== null;
  })[0];
  if (!el) return false;
  el.focus();
  d.set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
  el.blur();
  return true;
})(${JSON.stringify(username)})`;

/** 站点判断「异地登录」后会在表单里多出验证码输入框 */
const HAS_CAPTCHA = `!!document.querySelector('input[placeholder*="验证码"]')`;

/** 填密码并提交登录 */
const SUBMIT_LOGIN = (password: string) => `(function (v) {
  var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  var el = document.querySelector('input[type="password"]');
  if (!el) return false;
  el.focus();
  d.set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  var btn = document.querySelector('.el-form .el-button--primary') || document.querySelector('.el-button--primary');
  if (btn) { btn.click(); return true }
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return true;
})(${JSON.stringify(password)})`;


/** 某账号在 GM 站点的设备凭证：设置里存的优先，其次账号记录里带的 */
function deviceIdFor(account: string): string {
  const key = String(account || '').trim();
  return deviceIdOf(key) || listAccounts().find((a) => a.account === key)?.deviceId || '';
}

/**
 * 打开登录窗口：用户在 gm.tj.996sdk.com 登录并进入落地页后读取凭据。
 * 客服号落地页是 /myTool；权限号（只读查询）落地页是 /myGame。
 * 先验证 token 确实可用，可用才导入，否则继续等。
 * autoFill 传入账号密码时会自动填表提交（账号密码 + 已导入的设备凭证 = 免验证码）。
 */
function openLoginWindow(autoFill?: { username: string; password: string }, kind: AccountKind = 'kf996'): Promise<Account | null> {
  return new Promise((resolve) => {
    const donePath = kind === 'gmAuth' ? MYGAME_PATH : MYTOOL_PATH;
    const win = new BrowserWindow({
      width: 1100,
      height: 780,
      title: kind === 'gmAuth' ? '登录权限账号（只读查询）' : '登录客服账号',
      icon: ICON,
      webPreferences: {
        // 固定 partition：登录态可复用，之后重新登录无需再输账号密码
        partition: 'persist:login',
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    // 登录窗口是全新的浏览器环境，先把已知账号的设备凭证补回去，避免每次都要求验证码
    const seeds: Record<string, string> = { ...getSettings().deviceIds };
    for (const a of listAccounts()) if (a.account && a.deviceId && !seeds[a.account]) seeds[a.account] = a.deviceId;
    /** dom-ready 后：补 deviceid；带账号密码时再自动填表提交 */
    const onReady = async () => {
      if (win.isDestroyed()) return;
      if (Object.keys(seeds).length) await win.webContents.executeJavaScript(seedDeviceIds(seeds), true).catch(() => {});
      if (!autoFill) return;
      const filled = await win.webContents.executeJavaScript(FILL_USERNAME(autoFill.username), true).catch(() => false);
      if (!filled) {
        logLine('LOGIN_AUTOFILL', { ok: false, reason: '找不到账号输入框' });
        return;
      }
      // 站点在账号失焦后异步问服务端要不要验证码，等它出结果
      await new Promise((r) => setTimeout(r, 1500));
      if (win.isDestroyed()) return;
      const needCaptcha = await win.webContents.executeJavaScript(HAS_CAPTCHA, true).catch(() => false);
      if (needCaptcha) {
        // 需要验证码：账号密码已填好，让用户只补验证码
        logLine('LOGIN_AUTOFILL', { ok: true, needCaptcha: true });
        win.show();
        return;
      }
      const submitted = await win.webContents.executeJavaScript(SUBMIT_LOGIN(autoFill.password), true).catch(() => false);
      logLine('LOGIN_AUTOFILL', { ok: true, needCaptcha: false, submitted });
    };
    win.webContents.on('dom-ready', () => void onReady());
    win.loadURL(LOGIN_URL);

    let settled = false;
    /** 上一次校验还没结束时不再重复触发 */
    let busy = false;
    const finish = (acc: Account | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.close();
      resolve(acc);
    };

    const timer = setInterval(async () => {
      if (win.isDestroyed()) return finish(null);
      // 还没进落地页说明登录没完成
      if (!win.webContents.getURL().includes(donePath)) return;
      if (busy) return;
      busy = true;
      try {
        const raw = await win.webContents.executeJavaScript(READ_GM_CRED, true);
        const cred = JSON.parse(raw || '{}');
        if (!cred.gmToken || !cred.juheToken || !cred.gmUserId) return;
        // 内部会换 token 校验，token 不可用会抛错
        const withLogin = { ...cred, loginUser: autoFill?.username, loginPwd: autoFill?.password };
        finish(kind === 'gmAuth' ? await applyAuthCred(withLogin) : await applyGmCred(cred));
      } catch (e: any) {
        // token 还不可用时保持窗口打开，等下一轮
        logLine('LOGIN_IMPORT', { ok: false, kind, err: String(e?.message || e) });
      } finally {
        busy = false;
      }
    }, 1500);

    win.on('closed', () => finish(null));
  });
}

/** 用 GM 凭据换新 token 并保存 / 更新账号 */
async function applyGmCred(cred: any): Promise<Account> {
  const c: api.GmCred = {
    gmToken: String(cred?.gmToken || ''),
    juheToken: String(cred?.juheToken || ''),
    gmUserId: String(cred?.gmUserId || ''),
  };
  if (!c.gmToken || !c.juheToken || !c.gmUserId) {
    throw new Error('GM 凭据不完整，请确认已登录 gm.tj.996sdk.com 且在 /myTool 页面');
  }
  const { token: jwt } = await api.gmLogin(c);
  const info = await api.kfUserInfo(jwt, c);
  const deviceId = String(cred?.deviceId || '');
  const prev = listAccounts().find((a) => a.account === info.account);
  // 记住设备凭证：以后同一账号（含账号密码登录、窗口登录）都不用再输验证码
  if (deviceId) {
    setDeviceId(info.account, deviceId);
    pushSettingsChanged();
  }
  const acc = upsertAccount({
    id: globalThis.crypto.randomUUID(),
    name: info.name || info.realName || info.account,
    account: info.account,
    uid: String(info.id),
    companyId: String(info.companyId),
    xToken: jwt,
    token: c.gmToken,
    tokenExp: Number(parseJwt(jwt)?.exp ?? 0),
    juheToken: c.juheToken,
    gmUserId: c.gmUserId,
    // 服务端下发的设备标识，下次登录补写回 localStorage 可免验证码
    deviceId: deviceId || prev?.deviceId || '',
    createdAt: Date.now(),
  });
  ws.disconnect(acc.id);
  ws.connect(acc);
  // 重新导入登录态说明换到了可用 token，恢复探活
  resumeProbe(acc.id);
  pushAuthState(acc.id, true);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accounts:changed', { name: acc.name });
  return acc;
}

/**
 * 权限号（只读查询）专用导入：不做客服侧校验（kfUserInfo）、不连 WS、不参与探活。
 * 注意不能调 api.gmLogin —— 那是客服侧聊天室网关登录，权限号没有客服权限，
 * 会返回 500「您未获得授权」。这里只用 GM 侧只读接口（user/info）验一次凭据可用。
 */
async function applyAuthCred(cred: any): Promise<Account> {
  const c: api.GmCred = {
    gmToken: String(cred?.gmToken || ''),
    juheToken: String(cred?.juheToken || ''),
    gmUserId: String(cred?.gmUserId || ''),
  };
  if (!c.gmToken || !c.juheToken || !c.gmUserId) {
    throw new Error('GM 凭据不完整，请确认已登录 gm.tj.996sdk.com 且在 /myGame 页面');
  }
  // 校验凭据可用：失败就直接抛错，让登录窗口继续等
  const info = await api.gmUserInfo(c.gmToken);
  const account = String(cred?.account || info?.account || '').trim() || `gm-${c.gmUserId}`;
  const deviceId = String(cred?.deviceId || '');
  const prev = listAccounts().find((a) => a.kind === 'gmAuth' && a.account === account);
  if (deviceId) {
    setDeviceId(account, deviceId);
    pushSettingsChanged();
  }
  const acc = upsertAccount({
    id: prev?.id || globalThis.crypto.randomUUID(),
    kind: 'gmAuth',
    name: account,
    account,
    // 权限号没有客服侧的 uid，用 GM 用户 id 占位（查询上下文实际用的是 gmUserId）
    uid: c.gmUserId,
    companyId: '',
    xToken: '',
    token: c.gmToken,
    tokenExp: 0,
    juheToken: c.juheToken,
    gmUserId: c.gmUserId,
    deviceId: deviceId || prev?.deviceId || '',
    // 记住账号密码：权限号不能轮换 token 上线，「续期」时要用它重新登录
    savedUser: String(cred?.loginUser || prev?.savedUser || account),
    savedPwd: String(cred?.loginPwd || prev?.savedPwd || ''),
    createdAt: prev?.createdAt || Date.now(),
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accounts:changed', { name: acc.name });
  return acc;
}

/** 账号密码登录的结果：要么直接导入成功，要么需要用户补验证码 */
export type LoginByPasswordResult = { ok: true; account: Account } | { ok: false; needCaptcha: true };

/**
 * 在应用内直接用账号密码登录 GM 站点，再复用 applyGmCred 导入。
 * 服务端只在「新设备」上要求验证码：先用本地存过的 deviceid 问一次 isRemote，
 * 被要求验证码就返回 needCaptcha，由渲染层改走「打开登录窗口」补验证码。
 */
async function loginByPassword(p: { username?: string; password?: string; code?: string }): Promise<LoginByPasswordResult> {
  const username = String(p?.username || '').trim();
  const password = String(p?.password || '');
  if (!username || !password) throw new Error('请输入账号和密码');
  const deviceId = deviceIdFor(username);
  if (!p.code) {
    const { is_remote } = await api.gmIsRemote(username, deviceId);
    if (is_remote === 1) return { ok: false, needCaptcha: true };
  }
  const r = await api.gmUserLogin({ username, password, code: p.code, deviceid: deviceId });
  if (!r?.token) throw new Error('登录失败：账号或密码不正确');
  const { token: juheToken } = await api.gmJuheLogin(r.token);
  const info = await api.gmUserInfo(r.token);
  const account = await applyGmCred({
    gmToken: r.token,
    juheToken,
    gmUserId: String(info?.uid ?? r.uid ?? ''),
    account: String(info?.account || username),
    deviceId: String(r.deviceid || deviceId || ''),
  });
  return { ok: true, account };
}

/**
 * 权限号账号密码登录：与客服号同一条链路（deviceid 免验证码），
 * 落地校验后走 applyAuthCred（kind=gmAuth，不做客服侧校验、不连 WS）。
 */
async function loginAuthByPassword(p: { username?: string; password?: string; code?: string }): Promise<LoginByPasswordResult> {
  const username = String(p?.username || '').trim();
  const password = String(p?.password || '');
  if (!username || !password) throw new Error('请输入账号和密码');
  const deviceId = deviceIdFor(username);
  if (!p.code) {
    const { is_remote } = await api.gmIsRemote(username, deviceId);
    if (is_remote === 1) return { ok: false, needCaptcha: true };
  }
  const r = await api.gmUserLogin({ username, password, code: p.code, deviceid: deviceId });
  if (!r?.token) throw new Error('登录失败：账号或密码不正确');
  const { token: juheToken } = await api.gmJuheLogin(r.token);
  // 只读 GM 站点的用户信息（不是客服侧的 kfUserInfo）
  const info = await api.gmUserInfo(r.token);
  const account = await applyAuthCred({
    gmToken: r.token,
    juheToken,
    gmUserId: String(info?.uid ?? r.uid ?? ''),
    account: String(info?.account || username),
    deviceId: String(r.deviceid || deviceId || ''),
    loginUser: username,
    loginPwd: password,
  });
  return { ok: true, account };
}

/** 掉线判定：这些错误说明 token 被顶掉了 */
const OFFLINE_RE = /登录已失效|掉线|token无效|token失效|未登录|请重新登录/;

/**
 * Electron 会把 ipcMain.handle 里抛出的错误连堆栈整段打到控制台。
 * 掉线属于预期内的业务状态（渲染进程会自己提示），这里只记一行日志，避免堆栈刷屏。
 */
const rawConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const head = typeof args[0] === 'string' ? args[0] : '';
  if (head.startsWith('Error occurred in handler for')) {
    const msg = String((args[1] as any)?.message || args[1] || '');
    if (OFFLINE_RE.test(msg)) {
      logLine('IPC_OFFLINE', { handler: head, message: msg });
      return;
    }
  }
  rawConsoleError(...args);
};

/**
 * 权限号续期：权限号没有客服侧的账号，不能像客服号那样拿 juheToken 轮换 token 上线
 * （那会走客服侧网关，返回「您未获得授权」）。只能用登录时记住的账号密码重新登录一次。
 */
async function refreshAuthAccount(acc: Account): Promise<Account> {
  const username = String(acc.savedUser || acc.account || '').trim();
  const password = String(acc.savedPwd || '');
  if (!username || !password) {
    throw new Error('该权限号没有保存账号密码，无法续期。请用「新增 → 权限号登录 → 账号密码登录」重新登录一次');
  }
  const r = await loginAuthByPassword({ username, password });
  if (!r.ok) throw new Error('重新登录需要验证码：请用「新增 → 权限号登录 → 打开窗口登录」补一次验证码');
  return r.account;
}

/**
 * 企微客服自动重新登录：用登录时记住的账号密码重新换 token，
 * 更新账号后断开旧 WS 并用新 token 重连。
 */
async function reloginQywx(acc: Account): Promise<Account> {
  const username = String(acc.savedUser || acc.account || '').trim();
  const password = String(acc.savedPwd || '');
  if (!acc.serverUrl || !username || !password) {
    throw new Error('该企微客服没有保存账号密码，无法重新登录。请用「新增 → 企微登录」重新登录一次');
  }
  const r = await api.qywxLogin({ serverUrl: acc.serverUrl, username, password });
  const user = r.user || {};
  const updated = upsertAccount({
    ...acc,
    name: String(user.display_name || user.nickname || user.name || user.username || acc.name || username).trim(),
    qywxToken: r.token,
    qywxUser: user,
  });
  // 换 token 后必须重连：connect 对已存在的连接会直接返回，先断开旧的
  qywx.disconnect(updated.id);
  qywx.connect(updated);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accounts:changed', { name: updated.name });
  return updated;
}

/** 用已保存的 GM 凭据换新 token 并重连 WS */
async function refreshAccount(acc: Account): Promise<Account> {
  if (isGmAuth(acc)) return refreshAuthAccount(acc);
  if (isQywx(acc)) return reloginQywx(acc);
  if (!acc.juheToken || !acc.gmUserId) throw new Error('缺少 GM 凭据，请先用「登录脚本」导入一次');
  const c: api.GmCred = { gmToken: acc.token, juheToken: acc.juheToken, gmUserId: acc.gmUserId };
  const { token: jwt } = await api.gmLogin(c);
  await api.kfUserInfo(jwt, c); // 校验新 token 真的可用
  const updated = upsertAccount({ ...acc, xToken: jwt, tokenExp: Number(parseJwt(jwt)?.exp ?? 0) });
  ws.disconnect(updated.id);
  ws.connect(updated);
  return updated;
}

/** 自动续期：同一账号并发去重，避免多个请求同时换 token */
const refreshing = new Map<string, Promise<Account>>();
function autoRefresh(acc: Account): Promise<Account> {
  const running = refreshing.get(acc.id);
  if (running) return running;
  const task = refreshAccount(acc)
    .then((r) => {
      logLine('AUTO_REFRESH', { account: acc.account, ok: true });
      return r;
    })
    .catch((e: any) => {
      logLine('AUTO_REFRESH', { account: acc.account, ok: false, err: String(e?.message || e) });
      throw e;
    })
    .finally(() => refreshing.delete(acc.id));
  refreshing.set(acc.id, task);
  return task;
}

/** 学习任务出错时：仅掉线才尝试续期，其余错误原样抛出 */
async function learnRecover(acc: Account, err: unknown): Promise<Account> {
  if (!OFFLINE_RE.test(String((err as any)?.message || '')) || !getSettings().autoRefresh) throw err;
  return autoRefresh(acc);
}

/** 执行一次「每日学习」，并把结果广播给渲染层 */
async function runLearn(trigger: 'auto' | 'manual'): Promise<learn.LearnResult[]> {
  logLine('LEARN_RUN', { trigger });
  const results = await learn.runDailyLearn({ recover: learnRecover });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('learn:done', { trigger, results });
  return results;
}

/** 每日到点自动学习：每 30s 检查一次，当天同一时刻只触发一次 */
let learnTimer: NodeJS.Timeout | null = null;
let learnDoneDay = '';
function startLearnScheduler(): void {
  if (learnTimer) return;
  learnTimer = setInterval(() => {
    const { learn: cfg } = getSettings();
    if (!cfg.enabled || !cfg.time) return;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    if (`${pad(now.getHours())}:${pad(now.getMinutes())}` !== cfg.time) return;
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (learnDoneDay === day) return;
    learnDoneDay = day;
    runLearn('auto').catch((e: any) => logLine('LEARN_RUN', { trigger: 'auto', err: String(e?.message || e) }));
  }, 30_000);
}

/* ---------------- token 主动巡检 ---------------- */

/**
 * 每 5s 用「会话记录」接口探活每个客服号。
 * 探到掉线时：设置里开了「掉线后自动续期」就自动换新 token，否则只通知界面显示「续期」按钮。
 */
const PROBE_INTERVAL = 5_000;
/** 续期失败后的退避上限 */
const PROBE_BACKOFF_MAX = 5 * 60 * 1000;
/**
 * 掉线且没开自动续期时的探活间隔（只上报一次失效，之后慢慢探）。
 * 不能完全不探，否则账号恢复（比如别人退出登录、重新导入）后界面一直停在失效状态。
 */
const PROBE_IDLE_INTERVAL = 5 * 60 * 1000;
/** accountId -> 上一次探活结果 */
const healthMap = new Map<string, boolean>();
/**
 * accountId -> 探活暂停状态。
 * 掉线时如果没开自动续期、或续期失败，就先停掉这个号的探活：
 * 否则每 5s 一次失败请求会触发服务端频率限制，连手动「续期」都会被拒。
 */
const probePause = new Map<string, { until: number; fails: number }>();
let probing = false;

/** 恢复某个客服号的探活（手动续期成功、重新导入登录态后调用） */
function resumeProbe(accountId: string): void {
  probePause.delete(accountId);
}

/** 暂停某个客服号的探活一段时间 */
function pauseProbe(accountId: string, ms: number): void {
  probePause.set(accountId, { until: Date.now() + ms, fails: 1 });
}

/** 通知渲染层某个客服号是否正常（状态没变就不重复推送） */
function pushAuthState(accountId: string, ok: boolean): void {
  const prev = healthMap.get(accountId);
  healthMap.set(accountId, ok);
  if (prev === ok) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:state', { accountId, ok });
}

/** 探活单个客服号，返回是否正常（掉线且开启自动续期时会就地续期） */
async function probeAccount(acc: Account): Promise<boolean> {
  const paused = probePause.get(acc.id);
  // 暂停期内不再打接口，直接沿用「掉线」状态
  if (paused && Date.now() < paused.until) return false;

  try {
    await api.probeRecordPage(acc);
    probePause.delete(acc.id);
    return true;
  } catch (err: any) {
    const msg = String(err?.message || '');
    // 非掉线类错误（网络抖动等）不判定为失效，沿用上一次结果
    if (!OFFLINE_RE.test(msg)) return healthMap.get(acc.id) !== false;

    if (!getSettings().autoRefresh) {
      // 没开自动续期：上报一次失效，然后转成 5 分钟探一次，等用户手动点「续期」
      if (!paused) logLine('TOKEN_PROBE', { account: acc.account, offline: true, autoRefresh: false, action: 'pause' });
      probePause.set(acc.id, { until: Date.now() + PROBE_IDLE_INTERVAL, fails: 0 });
      return false;
    }
    try {
      await autoRefresh(acc);
      probePause.delete(acc.id);
      logLine('TOKEN_PROBE', { account: acc.account, offline: true, refreshed: true });
      return true;
    } catch (e: any) {
      // 续期失败也要退避，否则同样是高频打接口
      const fails = (paused?.fails || 0) + 1;
      const backoff = Math.min(30_000 * 2 ** (fails - 1), PROBE_BACKOFF_MAX);
      probePause.set(acc.id, { until: Date.now() + backoff, fails });
      logLine('TOKEN_PROBE', {
        account: acc.account,
        offline: true,
        refreshed: false,
        nextRetryMs: backoff,
        err: String(e?.message || e),
      });
      return false;
    }
  }
}

/** 探活时判定「登录态已失效」的错误（比 OFFLINE_RE 多认 HTTP 401/403、未授权） */
const UNAUTHORIZED_RE = /登录已失效|掉线|token\s*无效|token\s*失效|未登录|请重新登录|未授权|HTTP 40[13]/i;

/**
 * 权限号 / 企微客服掉线后的恢复：
 * 开了对应开关就用登录时记住的账号密码重新登录，没开（或重登失败）就暂时停掉探活，
 * 等用户手动点账号上的「重新登录」。
 */
async function recoverAccount(acc: Account, kind: 'qywx' | 'gmAuth'): Promise<boolean> {
  const paused = probePause.get(acc.id);
  if (!getSettings().autoRelogin?.[kind]) {
    if (!paused) logLine('TOKEN_PROBE', { account: acc.account, kind, offline: true, autoRelogin: false, action: 'pause' });
    probePause.set(acc.id, { until: Date.now() + PROBE_IDLE_INTERVAL, fails: 0 });
    return false;
  }
  try {
    await autoRefresh(acc);
    probePause.delete(acc.id);
    logLine('TOKEN_PROBE', { account: acc.account, kind, offline: true, relogged: true });
    return true;
  } catch (e: any) {
    // 重登失败也要退避，否则每 5s 打一次登录接口会触发服务端限制
    const fails = (paused?.fails || 0) + 1;
    const backoff = Math.min(30_000 * 2 ** (fails - 1), PROBE_BACKOFF_MAX);
    probePause.set(acc.id, { until: Date.now() + backoff, fails });
    logLine('TOKEN_PROBE', {
      account: acc.account,
      kind,
      offline: true,
      relogged: false,
      nextRetryMs: backoff,
      err: String(e?.message || e),
    });
    return false;
  }
}

/** 企微客服探活：调 /api/auth/me（只读）校验 token，失效时按开关自动重新登录 */
async function probeQywxAccount(acc: Account): Promise<boolean> {
  const paused = probePause.get(acc.id);
  if (paused && Date.now() < paused.until) return false;
  try {
    await api.qywxMe(acc.serverUrl || '', acc.qywxToken || '');
    probePause.delete(acc.id);
    return true;
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (!UNAUTHORIZED_RE.test(msg)) return healthMap.get(acc.id) !== false;
    return recoverAccount(acc, 'qywx');
  }
}

/** 权限号探活：调只读的 GM user/info 校验 token，失效时按开关自动重新登录 */
async function probeAuthAccount(acc: Account): Promise<boolean> {
  const paused = probePause.get(acc.id);
  if (paused && Date.now() < paused.until) return false;
  try {
    await api.gmUserInfo(acc.token);
    probePause.delete(acc.id);
    return true;
  } catch (err: any) {
    const msg = String(err?.message || '');
    if (!UNAUTHORIZED_RE.test(msg)) return healthMap.get(acc.id) !== false;
    return recoverAccount(acc, 'gmAuth');
  }
}

function startTokenProbe(): void {
  setInterval(() => {
    if (probing) return;
    probing = true;
    // 三类账号都要探活：996 客服走会话记录接口；企微 / 权限号各走自己的只读接口
    const accounts = listAccounts();
    // 清掉已删除账号的暂停记录
    const ids = new Set(accounts.map((a) => a.id));
    [...probePause.keys()].forEach((id) => {
      if (!ids.has(id)) probePause.delete(id);
    });
    Promise.all(
      accounts.map(async (acc) => {
        const ok = isQywx(acc)
          ? await probeQywxAccount(acc)
          : isGmAuth(acc)
            ? await probeAuthAccount(acc)
            : await probeAccount(acc);
        pushAuthState(acc.id, ok);
      }),
    )
      .catch(() => {})
      .finally(() => {
        probing = false;
      });
  }, PROBE_INTERVAL);
}

/* ---------------- 局域网客服管理 ---------------- */

/** 推送设置变更给渲染层（对端同步数据 / 推来玩家后需要刷新） */
function pushSettingsChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed', {});
  sendToNotify('settings:changed', {});
}

/** 推送局域网事件给渲染层 */
function pushLanEvent(type: string, data?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lan:event', { type, data });
}

/** 关键词合并：按关键词逐个去重（英文不区分大小写），本机已有的保留原样 */
function mergeKeywords(mine: KeywordRule[], incoming: KeywordRule[]): KeywordRule[] {
  const seen = new Set<string>();
  mine.forEach((r) => r.keywords.forEach((k) => seen.add(keywordKey(k))));
  const merged = [...mine];
  incoming.forEach((r: any) => {
    // 兼容旧版对端发来的单关键词写法
    const raw: string[] = Array.isArray(r?.keywords) ? r.keywords : r?.keyword ? [r.keyword] : [];
    const fresh = raw.map((k) => String(k ?? '').trim()).filter((k) => k && !seen.has(keywordKey(k)));
    if (!fresh.length) return;
    fresh.forEach((k) => seen.add(keywordKey(k)));
    merged.push({ id: `kw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, keywords: fresh, reply: String(r?.reply ?? '') });
  });
  return merged;
}

/** 找出哪台在线设备持有该客服号（远程回复/取历史用） */
function ownerOfUid(uid: string): { addr: string; accountId: string } | null {
  for (const peer of lan.getLanStatus().peers) {
    if (!peer.online) continue;
    const acc = peer.accounts.find((a) => String(a.uid) === String(uid));
    if (acc) return { addr: peer.addr, accountId: acc.id };
  }
  return null;
}

/** 注册来自其它机器的请求（每个实例只需注册一次） */
function registerLanHandlers(): void {
  // 本机可同步的数据
  lan.registerHandler('data.get', () => {
    const s = getSettings();
    return { quickReplies: s.quickReplies, keywords: s.keywords };
  });

  // 对方把快捷回复/关键词推给本机 -> 合并落库
  lan.registerHandler('data.put', (_addr, d: any) => {
    const mine = getSettings();
    const patch: Partial<Settings> = {};
    if (d?.quickReplies && typeof d.quickReplies === 'object') {
      patch.quickReplies = { ...mine.quickReplies, ...d.quickReplies };
    }
    if (Array.isArray(d?.keywords)) patch.keywords = mergeKeywords(mine.keywords, d.keywords);
    if (Object.keys(patch).length) {
      saveSettings(patch);
      pushSettingsChanged();
    }
    return true;
  });

  // 本机某个客服号的会话列表（对方「拉取提问」用）
  lan.registerHandler('session.list', async (_addr, d: { accountId: string }) => {
    const acc = getAccount(d?.accountId);
    if (!acc) throw new Error('本机没有这个客服号');
    return await api.querySessionList(acc);
  });

  // 某个会话的历史消息
  lan.registerHandler('session.history', async (_addr, d: any) => {
    const acc = getAccount(d?.accountId);
    if (!acc) throw new Error('本机没有这个客服号');
    return await api.queryMessageList(acc, {
      messageSessionId: d?.messageSessionId,
      pageNum: d?.pageNum ?? 1,
      pageSize: d?.pageSize ?? 50,
    });
  });

  // 远程回复：由持有账号的一方真实发送
  lan.registerHandler('reply.send', async (_addr, d: any) => {
    const acc = getAccount(d?.accountId);
    if (!acc) throw new Error('本机没有这个客服号');
    return await api.sendMessage(acc, d);
  });

  // 复制客服数据：账号凭据 + 该客服号的待处理玩家（源端保留）
  lan.registerHandler('account.copy', (_addr, d: { accountId: string }) => {
    const acc = getAccount(d?.accountId);
    if (!acc) throw new Error('本机没有这个客服号');
    return { account: acc, pending: getSettings().pending[acc.id] || [] };
  });

  // 对方推给本机一个玩家 -> 记进本机的远程会话列表
  lan.registerHandler('session.share', (fromAddr, d: any) => {
    const peer = lan.getLanStatus().peers.find((p) => p.addr === fromAddr);
    const list = getSettings().lanSessions.filter(
      (x) => !(x.peerId === fromAddr && x.session?.id === d?.session?.id),
    );
    list.push({
      peerId: fromAddr,
      peerName: peer?.name || fromAddr,
      accountId: String(d?.accountId || ''),
      accountName: String(d?.accountName || ''),
      uid: String(d?.uid || ''),
      session: d?.session || {},
      from: 'push',
      addedAt: Date.now(),
    });
    saveSettings({ lanSessions: list });
    pushSettingsChanged();
    pushLanEvent('shared', { peerName: peer?.name || fromAddr, visitorName: d?.session?.visitorName || '' });
    return true;
  });
}

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => listAccounts());
  ipcMain.handle('accounts:remove', (_e, id: string) => {
    removeAccount(id);
    ws.disconnect(id);
    qywx.disconnect(id);
    healthMap.delete(id);
    return listAccounts();
  });
  ipcMain.handle('accounts:login', (_e, autoFill?: { username: string; password: string }) => openLoginWindow(autoFill, 'kf996'));
  // 权限号（只读查询）登录窗口：落地页换成 /myGame
  ipcMain.handle('accounts:loginAuthWindow', (_e, autoFill?: { username: string; password: string }) =>
    openLoginWindow(autoFill, 'gmAuth'),
  );
  // 应用内账号密码登录（需要验证码时返回 { ok:false, needCaptcha:true }）
  ipcMain.handle('accounts:loginByPassword', (_e, p: { username: string; password: string; code?: string }) => loginByPassword(p));
  // 权限号账号密码登录：与客服号同链路，落地后按 gmAuth 入库
  ipcMain.handle('accounts:loginAuth', (_e, p: { username: string; password: string; code?: string }) => loginAuthByPassword(p));

  // 企微客服中心登录：账号密码调对方 /api/auth/login，成功后把账号存进列表（kind=qywx）
  ipcMain.handle(
    'accounts:qywxLogin',
    async (_e, p: { serverUrl: string; username: string; password: string }) => {
      const origin = api.qywxOrigin(p?.serverUrl || '');
      const username = String(p?.username || '').trim();
      const r = await api.qywxLogin({ serverUrl: origin, username, password: String(p?.password || '') });
      const user = r.user || {};
      const prev = listAccounts().find((a) => a.kind === 'qywx' && a.account === username && a.serverUrl === origin);
      const acc = upsertAccount({
        id: prev?.id || globalThis.crypto.randomUUID(),
        kind: 'qywx',
        name: String(user.display_name || user.nickname || user.name || user.username || username).trim(),
        account: username,
        uid: '',
        companyId: '',
        xToken: '',
        token: '',
        tokenExp: 0,
        serverUrl: origin,
        qywxToken: r.token,
        qywxUser: user,
        // 记住账号密码：token 失效时自动重新登录用它再登一次
        savedUser: username,
        savedPwd: String(p?.password || ''),
        createdAt: prev?.createdAt || Date.now(),
      });
      qywx.connect(acc);
      return acc;
    },
  );

  // 复制到 gm.tj.996sdk.com 控制台执行的脚本（用于导入 GM 凭据；kind=gmAuth 时按权限号提示）
  ipcMain.handle('accounts:gmScript', (_e, kind?: AccountKind) => callbackScript(kind === 'gmAuth' ? 'gmAuth' : 'kf996'));
  // 只导入「设备凭证」的脚本（用于账号密码登录免验证码）
  ipcMain.handle('accounts:deviceScript', (_e, account: string) => deviceScript(account));
  // 只读：从本机浏览器（Edge/Firefox/QQ/夸克）的 localStorage 直接取 deviceid，免手输、免跑脚本
  ipcMain.handle('accounts:browserDevice', (_e, account: string) => {
    const acct = String(account || '').trim();
    if (!acct) return { ok: false, reason: '请先填写账号' };
    const hit = readDeviceIdFromBrowsers(acct);
    if (!hit) return { ok: false, reason: '本机浏览器里没找到该账号的设备凭证' };
    // 按用户填写的账号存（deviceIdOf 是大小写敏感的精确匹配，登录时用的也是这个键）
    setDeviceId(acct, hit.deviceId);
    pushSettingsChanged();
    logLine('BROWSER_DEVICE_HIT', { account: acct, found: hit.account, browser: hit.browser, path: hit.path });
    return { ok: true, account: acct, deviceId: hit.deviceId, browser: hit.browser, path: hit.path, storage: hit.storage };
  });

  // 权限号（只读查询）：gm:call 白名单 + 物品/装备对照表
  registerGmIpc();

  // 手动续期：用保存的 GM 凭据重新调 gmLogin 换新 token
  ipcMain.handle('accounts:refresh', async (_e, id: string) => {
    const acc = getAccount(id);
    if (!acc) throw new Error('账号不存在');
    try {
      const updated = await refreshAccount(acc);
      // 续期成功：恢复探活
      resumeProbe(id);
      pushAuthState(id, true);
      return updated;
    } catch (e) {
      // 续期失败（多半是已经被频率限制）：先停一会儿探活，别继续打接口
      pauseProbe(id, 60_000);
      throw e;
    }
  });

  const withAccount =
    <T>(fn: (acc: Account, ...args: any[]) => Promise<T> | T) =>
    async (_e: unknown, id: string, ...args: any[]) => {
      const acc = getAccount(id);
      if (!acc) throw new Error('账号不存在，请重新登录');
      // token 是否有效由 5s 主动巡检负责续期，这里不再按报错被动重试
      return await fn(acc, ...args);
    };

  ipcMain.handle('api:sessions', withAccount((acc) => api.querySessionList(acc)));
  ipcMain.handle('api:messages', withAccount((acc, p) => api.queryMessageList(acc, p)));
  ipcMain.handle('api:send', withAccount((acc, p) => api.sendMessage(acc, p)));
  ipcMain.handle('api:allRead', withAccount((acc, p) => api.allMessageRead(acc, p)));
  ipcMain.handle('api:recall', withAccount((acc, p) => api.recallMessage(acc, p)));
  ipcMain.handle('api:read', withAccount((acc, p) => api.messageRead(acc, p)));
  ipcMain.handle('api:status', withAccount((acc) => api.getUserStatus(acc)));
  ipcMain.handle('api:setStatus', withAccount((acc, status: number) => api.changeUserStatus(acc, status)));
  ipcMain.handle('api:visitor', withAccount((acc, p) => api.queryVisitorUser(acc, p)));
  ipcMain.handle('api:records', withAccount((acc, p) => api.recordPage(acc, p)));
  ipcMain.handle('api:messageRecord', withAccount((acc, p) => api.queryMessageRecord(acc, p)));
  ipcMain.handle('api:sendLeaveMessage', withAccount((acc, p) => api.sendLeaveMessage(acc, p)));
  ipcMain.handle('api:serviceRecord', withAccount((acc, p) => api.serviceRecord(acc, p)));
  ipcMain.handle('api:upload', withAccount((acc, p: { name: string; type: string; base64: string }) =>
    api.uploadFile(acc, { name: p.name, type: p.type, data: Buffer.from(p.base64, 'base64') }),
  ));

  /* ---------------- 企微客服中心（走 Bearer token，与 996 的 api:* 无关） ---------------- */

  /** 把 accountId 解析成 { serverUrl, token }，业务函数签名统一为 (serverUrl, token, ...args) */
  const withQywx =
    <T>(fn: (serverUrl: string, token: string, ...args: any[]) => Promise<T> | T) =>
    async (_e: unknown, id: string, ...args: any[]) => {
      const acc = getAccount(id);
      if (!acc || acc.kind !== 'qywx') throw new Error('企微客服账号不存在，请重新登录');
      if (!acc.serverUrl || !acc.qywxToken) throw new Error('企微客服登录信息缺失，请重新登录');
      return await fn(acc.serverUrl, acc.qywxToken, ...args);
    };

  ipcMain.handle('qywx:conversations', withQywx((s, t) => api.qywxConversations(s, t)));
  ipcMain.handle('qywx:messages', withQywx((s, t, p: { robotId: number | string; contactUserId: string; beforeId?: number | string }) =>
    api.qywxMessages(s, t, p.robotId, p.contactUserId, p.beforeId),
  ));
  ipcMain.handle('qywx:reply', withQywx((s, t, p: Parameters<typeof api.qywxReply>[2]) => api.qywxReply(s, t, p)));
  ipcMain.handle('qywx:upload', withQywx((s, t, p: { kind: 'image' | 'video'; name: string; type: string; base64: string }) =>
    api.qywxUpload(s, t, p.kind, { name: p.name, type: p.type, data: Buffer.from(p.base64, 'base64') }),
  ));
  ipcMain.handle('qywx:read', withQywx((s, t, p: { robotId: number | string; contactUserId: string }) => api.qywxRead(s, t, p)));
  ipcMain.handle('qywx:setUnread', withQywx((s, t, p: { robotId: number | string; contactUserId: string }) =>
    api.qywxSetUnread(s, t, p),
  ));
  ipcMain.handle('qywx:pin', withQywx((s, t, p: Parameters<typeof api.qywxPin>[2]) => api.qywxPin(s, t, p)));
  ipcMain.handle('qywx:removeConversation', withQywx((s, t, p: { robotId: number | string; contactUserId: string }) =>
    api.qywxDeleteConversation(s, t, p),
  ));
  ipcMain.handle('qywx:transcribe', withQywx((s, t, p: { id: number | string }) => api.qywxTranscribe(s, t, p.id)));
  ipcMain.handle('qywx:quickReplies', withQywx((s, t, p: { robotId: number | string }) => api.qywxQuickReplies(s, t, p.robotId)));
  ipcMain.handle('qywx:quickReplyAdd', withQywx((s, t, p: { robotId: number | string; content: string }) =>
    api.qywxAddQuickReply(s, t, p.robotId, p.content),
  ));
  ipcMain.handle('qywx:quickReplyUpdate', withQywx((s, t, p: { robotId: number | string; id: number | string; content: string }) =>
    api.qywxUpdateQuickReply(s, t, p.robotId, p.id, p.content),
  ));
  ipcMain.handle('qywx:quickReplyDelete', withQywx((s, t, p: { robotId: number | string; id: number | string }) =>
    api.qywxDeleteQuickReply(s, t, p.robotId, p.id),
  ));

  // 复制图片到剪贴板（消息右键菜单用）
  ipcMain.handle('img:copy', async (_e, url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
    if (img.isEmpty()) throw new Error('图片格式不支持，无法复制');
    // 统一转成 PNG 再写入，兼容 jpg/webp 等格式
    const png = new Uint8Array(img.toPNG());
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return true;
  });

  // 日志：便于后续排查发送/上传问题
  ipcMain.handle('log:path', () => logDir());
  ipcMain.handle('log:open', () => shell.openPath(logDir()));

  /* ---------------- 局域网客服管理 ---------------- */

  ipcMain.handle('lan:status', () => lan.getLanStatus());

  // 保存配置：端口/识别码/名称/开关变化时重启服务
  ipcMain.handle('lan:save', (_e, patch: Partial<LanConfig>) => {
    const before = getSettings().lan;
    const next = lan.saveLanConfig(patch);
    if (
      before.enabled !== next.enabled ||
      before.port !== next.port ||
      before.token !== next.token ||
      before.autoDiscover !== next.autoDiscover ||
      before.name !== next.name
    ) {
      lan.restartLan();
    }
    return lan.getLanStatus();
  });

  ipcMain.handle('lan:addPeer', (_e, p: { addr: string; name?: string }) => {
    lan.addManualPeer(p.addr, p.name);
    return lan.getLanStatus();
  });

  ipcMain.handle('lan:removePeer', (_e, addr: string) => {
    lan.removeManualPeer(addr);
    return lan.getLanStatus();
  });

  // 拉取对方的快捷回复/关键词，合并到本机
  ipcMain.handle('lan:syncFrom', async (_e, p: { addr: string; kinds: string[] }) => {
    const remote = await lan.callPeer<any>(p.addr, 'data.get', {});
    const mine = getSettings();
    const patch: Partial<Settings> = {};
    if (p.kinds.includes('quickReplies') && remote?.quickReplies) {
      patch.quickReplies = { ...mine.quickReplies, ...remote.quickReplies };
    }
    if (p.kinds.includes('keywords') && Array.isArray(remote?.keywords)) {
      patch.keywords = mergeKeywords(mine.keywords, remote.keywords);
    }
    const settings = Object.keys(patch).length ? saveSettings(patch) : mine;
    return {
      settings,
      quickReplyAccounts: Object.keys(remote?.quickReplies || {}).length,
      keywords: (remote?.keywords || []).length,
    };
  });

  // 把本机的快捷回复/关键词推给对方
  ipcMain.handle('lan:syncTo', async (_e, p: { addr: string; kinds: string[] }) => {
    const mine = getSettings();
    const payload: Record<string, unknown> = {};
    if (p.kinds.includes('quickReplies')) payload.quickReplies = mine.quickReplies;
    if (p.kinds.includes('keywords')) payload.keywords = mine.keywords;
    await lan.callPeer(p.addr, 'data.put', payload);
    return true;
  });

  // 对端某个客服号的会话列表（拉取提问）
  ipcMain.handle('lan:remoteSessions', (_e, p: { addr: string; accountId: string }) =>
    lan.callPeer(p.addr, 'session.list', { accountId: p.accountId }),
  );

  // 复制客服数据：凭据 + 该客服号的待处理玩家（源端保留；本机不连 WS 避免顶掉对方）
  ipcMain.handle('lan:copyAccount', async (_e, p: { addr: string; accountId: string }) => {
    const data = await lan.callPeer<{ account: Account; pending: any[] }>(p.addr, 'account.copy', { accountId: p.accountId });
    const acc = upsertAccount({ ...data.account, id: data.account.id });
    const pending = { ...getSettings().pending };
    pending[acc.id] = Array.isArray(data.pending) ? data.pending : [];
    saveSettings({ pending });
    pushSettingsChanged();
    return { account: acc, pendingCount: pending[acc.id].length };
  });

  /**
   * 把对方的客服号「映射」到本机：不复制凭据，只记住它属于哪台机器。
   * 看会话、发消息都走局域网转发，对方那台机器才是真正的收发方，不会把对方顶下线。
   */
  ipcMain.handle('lan:mapAccount', (_e, p: { addr: string; accountId: string }) => {
    const peer = lan.getLanStatus().peers.find((x) => x.addr === p.addr);
    if (!peer) throw new Error('对方设备不在线');
    const brief = peer.accounts.find((a) => a.id === p.accountId);
    if (!brief) throw new Error('对方已经没有这个客服号了');
    const lanAccounts = getSettings().lanAccounts.filter(
      (x) => !(x.addr === p.addr && x.accountId === p.accountId),
    );
    lanAccounts.push({
      addr: p.addr,
      peerName: peer.name || p.addr,
      accountId: brief.id,
      name: brief.name,
      account: brief.account,
      uid: brief.uid,
      addedAt: Date.now(),
    });
    saveSettings({ lanAccounts });
    pushSettingsChanged();
    return lanAccounts;
  });

  // 取消映射（连同该客服号拉过来的远程会话一起清掉）
  ipcMain.handle('lan:unmapAccount', (_e, p: { addr: string; accountId: string }) => {
    const mine = getSettings();
    const next = saveSettings({
      lanAccounts: mine.lanAccounts.filter((x) => !(x.addr === p.addr && x.accountId === p.accountId)),
      lanSessions: mine.lanSessions.filter((x) => !(x.peerId === p.addr && x.accountId === p.accountId)),
    });
    pushSettingsChanged();
    return next;
  });

  // 把本机的会话推送给指定设备
  ipcMain.handle('lan:shareSession', async (_e, p: { addr: string; accountId: string; session: any }) => {
    const acc = getAccount(p.accountId);
    if (!acc) throw new Error('账号不存在');
    await lan.callPeer(p.addr, 'session.share', {
      accountId: acc.id,
      accountName: acc.name,
      uid: acc.uid,
      session: p.session,
    });
    return true;
  });

  // 把对方的会话拉到自己这边（本机只记录，回复时转发回对方）
  ipcMain.handle(
    'lan:addRemote',
    (_e, p: { addr: string; accountId: string; accountName?: string; uid?: string; session: any }) => {
      const peer = lan.getLanStatus().peers.find((x) => x.addr === p.addr);
      const list = getSettings().lanSessions.filter((x) => !(x.peerId === p.addr && x.session?.id === p.session?.id));
      list.push({
        peerId: p.addr,
        peerName: peer?.name || p.addr,
        accountId: p.accountId,
        accountName: p.accountName || '',
        uid: p.uid || '',
        session: p.session,
        from: 'pull',
        addedAt: Date.now(),
      });
      return saveSettings({ lanSessions: list }).lanSessions;
    },
  );

  ipcMain.handle('lan:removeRemote', (_e, p: { peerId: string; sessionId: string }) =>
    saveSettings({
      lanSessions: getSettings().lanSessions.filter((x) => !(x.peerId === p.peerId && x.session?.id === p.sessionId)),
    }).lanSessions,
  );

  // 远程会话的历史消息（自动定位持有该客服号的设备）
  ipcMain.handle('lan:history', async (_e, p: { uid: string; messageSessionId: string; pageNum?: number; pageSize?: number }) => {
    const owner = ownerOfUid(p.uid);
    if (!owner) throw new Error('没有在线设备持有该客服号');
    return await lan.callPeer(owner.addr, 'session.history', {
      accountId: owner.accountId,
      messageSessionId: p.messageSessionId,
      pageNum: p.pageNum ?? 1,
      pageSize: p.pageSize ?? 50,
    });
  });

  // 远程回复：自动找持有该客服号的设备真实发送
  ipcMain.handle('lan:reply', async (_e, p: { uid: string } & Record<string, unknown>) => {
    const owner = ownerOfUid(p.uid);
    if (!owner) throw new Error('没有在线设备持有该客服号');
    const { uid, ...payload } = p;
    void uid;
    return await lan.callPeer(owner.addr, 'reply.send', { ...payload, accountId: owner.accountId });
  });

  /* ---------------- 设置 ---------------- */
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:save', (_e, patch: Partial<Settings>) => {
    const before = getSettings();
    const next = saveSettings(patch);
    // 打开「掉线后自动续期」/「自动重新登录」时，把之前停掉的探活重新放行
    const reloginOn =
      (!before.autoRelogin?.qywx && next.autoRelogin?.qywx) || (!before.autoRelogin?.gmAuth && next.autoRelogin?.gmAuth);
    if ((!before.autoRefresh && next.autoRefresh) || reloginOn) probePause.clear();
    return next;
  });

  // 可视化选择文件夹（知识库目录）
  ipcMain.handle('settings:pickDir', async (_e, defaultPath?: string) => {
    const opts = { properties: ['openDirectory' as const], defaultPath: defaultPath || undefined };
    if (!mainWindow || mainWindow.isDestroyed()) return '';
    const r = await dialog.showOpenDialog(mainWindow, opts);
    return r.canceled ? '' : r.filePaths[0] || '';
  });

  // 客服号自定义资料（右键账号 → 改头像 / 昵称）
  ipcMain.handle('settings:setProfile', (_e, p: { accountId: string; patch: AccountProfile }) => {
    const next = setProfile(p?.accountId || '', p?.patch || {});
    pushSettingsChanged();
    return next;
  });

  // 选择头像图片，读成 data URL 直接给 <img src> 用
  ipcMain.handle('settings:pickAvatar', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return '';
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择头像',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    const file = r.canceled ? '' : r.filePaths[0] || '';
    if (!file) return '';
    const buf = readFileSync(file);
    if (buf.length > 4 * 1024 * 1024) throw new Error('图片太大，请选择 4MB 以内的图片');
    const ext = file.split('.').pop()!.toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return `data:${mime};base64,${buf.toString('base64')}`;
  });

  // 当前程序版本（设置面板底部动态显示）
  ipcMain.handle('app:version', () => app.getVersion());

  /* ---------------- AI 客服 ---------------- */
  // 获取模型列表（用传入的配置，未保存也能先测）
  ipcMain.handle('ai:models', (_e, cfg?: AiConfig) => ai.listModels(cfg || getSettings().ai));
  // 测试某个模型能否正常回复
  ipcMain.handle('ai:test', (_e, p: { cfg?: AiConfig; model?: string }) =>
    ai.testModel(p?.cfg || getSettings().ai, p?.model),
  );
  // 根据聊天记录 + 该客服号的知识库生成回复（只返回文本，不发送）
  ipcMain.handle('ai:reply', async (_e, p: { accountId: string; messages: ai.AiMessage[]; visitorName?: string }) => {
    const cfg = getSettings().ai;
    const knowledge = ai.readKnowledge(knowledgeDirOf(p.accountId));
    logLine('AI_REPLY', { account: p.accountId, model: cfg.model, method: cfg.method, knowledge: knowledge.length });
    const content = await ai.generateReply(cfg, { messages: p.messages, knowledge, visitorName: p.visitorName });
    return { content, hasKnowledge: !!knowledge };
  });

  /* ---------------- 每日自动学习 ---------------- */
  // 立即执行一次：总结当天客服处理写入各客服号的知识库
  ipcMain.handle('learn:run', () => runLearn('manual'));

  // WebSocket 在线状态
  ipcMain.handle('ws:status', (_e, id: string) => ws.isConnected(id));
  ipcMain.handle('ws:reconnect', (_e, id: string) => {
    ws.disconnect(id);
    const acc = getAccount(id);
    if (acc) ws.connect(acc);
    return true;
  });

  // 新消息提醒：按设置走系统通知 / 屏幕居中置顶弹窗
  ipcMain.handle(
    'win:notify',
    (
      _e,
      p: {
        accountId: string;
        sessionId: string;
        messageSessionId?: string;
        visitorName?: string;
        content?: string;
        title?: string;
      },
    ) => {
      const cfg = getSettings().notify;
      if (!cfg.enabled) return false;
      const win = mainWindow;
      // 主窗口正在前台看着就不用提醒
      if (win && !win.isDestroyed() && win.isFocused() && !win.isMinimized()) return false;

      if (cfg.mode === 'popup' || cfg.mode === 'both') {
        showNotifyWindow({
          accountId: p.accountId,
          sessionId: p.sessionId,
          messageSessionId: p.messageSessionId,
          visitorName: p.visitorName,
        });
      }
      if (cfg.mode === 'system' || cfg.mode === 'both') {
        // 只做提醒：点击通知不做任何事（不弹窗、不跳转）
        new Notification({
          title: p.title || '新消息',
          body: `${p.visitorName || '访客'}${p.content ? '：' + p.content : ''}`,
        }).show();
      }
      win?.flashFrame(true);
      return true;
    },
  );

  // 关闭提醒弹窗
  ipcMain.handle('win:closeNotify', () => {
    if (notifyWin && !notifyWin.isDestroyed()) notifyWin.close();
    return true;
  });
}

/* ---------------- 来信息提醒弹窗 ---------------- */

/** 屏幕居中、始终置顶的提醒窗口：直接显示该会话的聊天记录与回复框 */
let notifyWin: BrowserWindow | null = null;
let notifyTimer: NodeJS.Timeout | null = null;
/** 弹窗渲染层是否已经加载完成（完成前只能靠 loadURL 换会话） */
let notifyReady = false;

interface NotifyTarget {
  accountId: string;
  sessionId: string;
  /** 会话的消息接口 id：带上它弹窗能和账号/设置并行加载 */
  messageSessionId?: string;
  visitorName?: string;
}

/** 弹窗加载的就是同一个渲染层，用 query 区分是弹窗模式 */
function notifyUrl(t: NotifyTarget): string {
  const q = new URLSearchParams({
    popup: '1',
    accountId: t.accountId,
    sessionId: t.sessionId,
    messageSessionId: t.messageSessionId || '',
    visitorName: t.visitorName || '',
  });
  if (process.env.ELECTRON_RENDERER_URL) return `${process.env.ELECTRON_RENDERER_URL}?${q.toString()}`;
  const file = join(__dirname, '../renderer/index.html').replace(/\\/g, '/');
  return `file://${file}?${q.toString()}`;
}

/** 显示（或切换会话到）提醒弹窗；按设置自动关闭 */
function showNotifyWindow(t: NotifyTarget): void {
  logLine('NOTIFY_POPUP', { accountId: t.accountId, sessionId: t.sessionId, visitor: t.visitorName });
  if (notifyWin && !notifyWin.isDestroyed()) {
    // 窗口已加载过就直接推给它：换会话不重载页面，同一会话则只刷新消息
    if (notifyReady) notifyWin.webContents.send('notify:switch', t);
    else notifyWin.loadURL(notifyUrl(t)).catch(() => {});
    notifyWin.setAlwaysOnTop(true, 'screen-saver');
    notifyWin.show();
    notifyWin.focus();
  } else {
    // 弹窗里同时有聊天区和快捷回复栏，太窄会挤在一起；按屏幕宽度自适应，最大 960
    const work = screen.getPrimaryDisplay().workAreaSize;
    notifyWin = new BrowserWindow({
      width: Math.min(960, Math.max(600, work.width - 120)),
      height: Math.min(760, Math.max(520, work.height - 120)),
      minWidth: 560,
      minHeight: 420,
      center: true,
      alwaysOnTop: true,
      title: '新消息',
      icon: ICON,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    notifyWin.setMenuBarVisibility(false);
    notifyWin.setAlwaysOnTop(true, 'screen-saver');
    notifyReady = false;
    notifyWin.webContents.on('did-finish-load', () => {
      notifyReady = true;
    });
    notifyWin.loadURL(notifyUrl(t)).catch(() => {});
    // 关闭时只隐藏：窗口留着不销毁，下次提醒直接复用（弹得更快）
    notifyWin.on('close', (e) => {
      if (isQuitting) return;
      e.preventDefault();
      notifyWin?.hide();
    });
    notifyWin.on('closed', () => {
      notifyWin = null;
      notifyReady = false;
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
    });
  }
  // 自动关闭计时（0 = 一直留着，手动关）
  const sec = Number(getSettings().notify.autoCloseSec) || 0;
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  if (sec > 0) {
    notifyTimer = setTimeout(() => {
      if (notifyWin && !notifyWin.isDestroyed()) notifyWin.close();
    }, sec * 1000);
  }
}

/** 提醒弹窗还在时，新一轮消息要同步刷新它 */
function sendToNotify(channel: string, payload: unknown): void {
  if (notifyWin && !notifyWin.isDestroyed()) notifyWin.webContents.send(channel, payload);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    title: '996 客服管理器',
    icon: ICON,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
  // 窗口重新获得焦点时停止任务栏闪烁
  mainWindow.on('focus', () => mainWindow?.flashFrame(false));
  // 点关闭按钮 -> 隐藏到后台（托盘常驻），不退出
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });
}

/**
 * 单实例：点 Windows 通知（或重复启动）时系统会再激活一次应用，
 * 没有这把锁就会另起一个进程、多出一个主窗口和托盘图标。抢不到锁就直接退出。
 */
const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  // 已经有一个在跑：唤起它，而不是开新窗口
  app.on('second-instance', () => showWindow());
}

app.whenReady().then(() => {
  if (!hasSingleInstance) return;
  // Windows 上托盘通知需要有 AppUserModelId 才会显示
  app.setAppUserModelId('com.996kefu.manager');
  registerIpc();
  registerLanHandlers();
  createWindow();
  createTray();
  // 本地回调服务：接收 GM 页面脚本发来的登录凭据 / 设备凭证
  startCallbackServer(
    (cred, kind) => {
      // 把 deviceid 记进日志，便于确认「免验证码」用的设备标识是否抓到了
      logLine('GM_IMPORT_CRED', { account: cred?.account, kind, deviceId: cred?.deviceId || '' });
      const done = kind === 'gmAuth' ? applyAuthCred(cred) : applyGmCred(cred);
      return done.then((a) => a.name);
    },
    async (p) => {
      const account = String(p?.account || '').trim();
      const deviceId = String(p?.deviceId || '').trim();
      logLine('GM_IMPORT_DEVICE', { account, deviceId });
      if (!account || !deviceId) throw new Error('没读到设备凭证');
      setDeviceId(account, deviceId);
      pushSettingsChanged();
      return account;
    },
  );

  // 转发 WS 事件给渲染层（用于实时刷新会话/消息）
  ws.setWsListener((accountId, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ws:event', { accountId, data });
    // 提醒弹窗也开着时同步刷新
    sendToNotify('ws:event', { accountId, data });
    // 有消息变动时通知局域网里的设备，让它们的远程会话实时刷新（心跳 PONG 不用管）
    if (data?.type === 'PONG') return;
    const acc = getAccount(accountId);
    if (acc) lan.broadcastEvent('session.changed', { uid: acc.uid });
  });
  // 保持所有已保存客服号的在线状态（不发这条会「已断开网络连接」）；企微客服、权限号不走 996 的 WS
  ws.connectAll(listAccounts().filter((a) => a.kind !== 'qywx' && a.kind !== 'gmAuth'));

  // 企微客服：实时推送转发给渲染层，并连上所有已保存的企微账号
  qywx.setQywxListener((accountId, type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qywx:event', { accountId, type, data });
    // 提醒弹窗也开着时同步刷新
    sendToNotify('qywx:event', { accountId, type, data });
  });
  qywx.connectAll(listAccounts().filter((a) => a.kind === 'qywx'));

  // 局域网：状态/事件推给渲染层，并启动服务
  lan.setLanListener((evt) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (evt.type === 'status') mainWindow.webContents.send('lan:status', evt.data);
    else mainWindow.webContents.send('lan:event', evt);
  });
  lan.startLan();

  // 每日到点自动学习
  startLearnScheduler();

  // 每 5s 主动巡检 token（走「会话记录」接口）
  startTokenProbe();

  // 从控制台 JS 自动提取接口地址/AES 口令，之后每 6 小时更新一次
  startKeyRefresh();

  app.on('activate', () => {
    // 主窗口隐藏到托盘时还在内存里，直接唤起即可，不要新建第二个主窗口
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  lan.stopLan();
  listAccounts().forEach((a) => ws.disconnect(a.id));
  listAccounts().forEach((a) => qywx.disconnect(a.id));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
