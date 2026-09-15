import { createServer, type Server } from 'node:http';
import { logLine } from './logger';

/**
 * 本地回调服务：用户在 gm.tj.996sdk.com 页面的控制台里跑一段脚本，
 * 脚本把 localStorage 里的 GM 凭据 POST 到 http://127.0.0.1:<PORT>/import。
 */
const PORT = 17321;

/** 允许跨域 + 私有网络访问（gm 是公网页面向 127.0.0.1 发请求） */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
};

const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { ...CORS, 'content-type': 'application/json;charset=UTF-8' });
  res.end(JSON.stringify(body));
};

export function startCallbackServer(
  onCred: (cred: any, kind: string) => Promise<string>,
  onDevice: (p: { account: string; deviceId: string }) => Promise<string>,
): Server {
  const server = createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.startsWith('/ping')) {
      json(res, 200, { ok: true, app: '996kefu' });
      return;
    }
    /** 读取 POST body 后交给对应的处理函数 */
    const handle = (fn: (body: any) => Promise<string>) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 20000) req.destroy();
      });
      req.on('end', async () => {
        try {
          const name = await fn(JSON.parse(raw || '{}'));
          logLine('GM_IMPORT', { ok: true, name });
          json(res, 200, { ok: true, name });
        } catch (e: any) {
          logLine('GM_IMPORT', { ok: false, err: String(e?.message || e) });
          json(res, 200, { ok: false, error: String(e?.message || e) });
        }
      });
    };
    if (req.method === 'POST' && url.startsWith('/import')) {
      // kind=kf996（客服，默认） / gmAuth（权限号）
      let kind = 'kf996';
      try {
        kind = new URL(url, 'http://127.0.0.1').searchParams.get('kind') || 'kf996';
      } catch {
        kind = 'kf996';
      }
      return handle((body) => onCred(body, kind));
    }
    // 只导入「设备凭证」（用于免验证码）
    if (req.method === 'POST' && url.startsWith('/device')) return handle(onDevice);
    json(res, 404, { ok: false, error: 'not found' });
  });

  server.on('error', (e: any) => logLine('GM_SERVER_ERR', { err: String(e?.message || e) }));
  server.listen(PORT, '127.0.0.1', () => logLine('GM_SERVER', { port: PORT }));
  return server;
}

/** 给用户复制到 gm.tj.996sdk.com 控制台里执行的脚本（kind=gmAuth 时用于权限号登录） */
export const callbackScript = (kind: 'kf996' | 'gmAuth' = 'kf996') => {
  const hint =
    kind === 'gmAuth'
      ? '没读到 GM 凭据：请确认已登录 gm.tj.996sdk.com，且当前在 /myGame 页面'
      : '没读到 GM 凭据：请确认已登录 gm.tj.996sdk.com，且当前在 /myTool 页面';
  return `(function () {
  var g = function (k) { try { return JSON.parse(localStorage.getItem(k)).data } catch (e) { return null } };
  var p = {
    gmToken: g('996sdk_accesstoken'),
    juheToken: g('Juhetoken'),
    gmUserId: String((g('996sdk_user_info') || {}).uid || ''),
    account: g('996sdk_user_account') || (g('996sdk_user_info') || {}).account || ''
  };
  // deviceid:<账号>：服务端判断是否「新设备登录」，带回去后同一账号就不用再输验证码
  try { p.deviceId = String(JSON.parse(localStorage.getItem('deviceid:' + p.account)).data || '') } catch (e) { p.deviceId = '' }
  if (!p.gmToken || !p.juheToken || !p.gmUserId) {
    alert(${JSON.stringify(hint)});
    return;
  }
  fetch('http://127.0.0.1:${PORT}/import?kind=${kind}', {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(p)
  })
    .then(function () { console.log('%c✅ 已发送到 996 客服管理器', 'color:#52c41a;font-size:14px'); })
    .catch(function (e) { alert('发送失败：' + e.message); });
})();`;
};

/**
 * 只导入「设备凭证」的脚本：在已经登录过、且不用验证码的浏览器里执行，
 * 把 localStorage 里的 deviceid:<账号> 送到管理器，之后用账号密码登录就不用验证码。
 */
export const deviceScript = (account: string) =>
  `(function () {
  var g = function (k) { try { return JSON.parse(localStorage.getItem(k)).data } catch (e) { return null } };
  var acct = ${JSON.stringify(account)} || g('996sdk_user_account') || (g('996sdk_user_info') || {}).account || '';
  var dev = '';
  try { dev = String(JSON.parse(localStorage.getItem('deviceid:' + acct)).data || '') } catch (e) { dev = '' }
  if (!dev) {
    alert('没读到设备凭证：请确认这个浏览器登录过账号「' + acct + '」（localStorage 里要有 deviceid:' + acct + '）');
    return;
  }
  fetch('http://127.0.0.1:${PORT}/device', {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ account: acct, deviceId: dev })
  })
    .then(function () { console.log('%c✅ 设备凭证已发送到 996 客服管理器：' + acct, 'color:#52c41a;font-size:14px'); })
    .catch(function (e) { alert('发送失败：' + e.message); });
})();`;
