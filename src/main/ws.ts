import { logLine, truncate } from './logger';
import type { Account } from './store';

/**
 * 客服在线状态由 WebSocket 维持：
 *   连上后先发 client_bind，再定时发 client_heart（ping），否则发送消息会报
 *   「您当前已经断开网络连接,请退出后重新发起」。
 */
const WS_URL = 'wss://ws.kf.996sdk.net';
const HEART_MS = 15000;
const RECONNECT_MS = 5000;

interface Conn {
  ws: WebSocket;
  timer?: ReturnType<typeof setInterval>;
  closedByUser?: boolean;
}

const conns = new Map<string, Conn>();
let listener: ((accountId: string, data: any) => void) | null = null;

export function setWsListener(fn: (accountId: string, data: any) => void): void {
  listener = fn;
}

export function isConnected(accountId: string): boolean {
  const c = conns.get(accountId);
  return !!c && c.ws.readyState === 1;
}

export function connect(acc: Account): void {
  if (conns.has(acc.id)) return;

  const open = () => {
    const ws = new WebSocket(WS_URL);
    const conn: Conn = { ws };
    conns.set(acc.id, conn);

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          key: 'client_bind',
          timestamp: Date.now(),
          data: {
            uid: acc.uid,
            name: acc.account,
            identityMark: 1,
            deviceId: 'xx',
            channel: 5,
            deviceName: 'x',
            appVersion: '1.0.0',
            osVersion: '28.20.0',
            language: 'zh-CN',
            companyId: acc.companyId,
          },
        }),
      );
      logLine('WS', { account: acc.account, event: 'open + client_bind' });

      conn.timer = setInterval(() => {
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              key: 'client_heart',
              timestamp: new Date().toISOString(),
              data: { type: 'ping', identityMark: 1, uid: acc.uid, companyId: acc.companyId },
            }),
          );
        }
      }, HEART_MS);
    });

    ws.addEventListener('message', (ev: any) => {
      const raw = String(ev?.data ?? '');
      logLine('WS_IN', { account: acc.account, data: truncate(raw, 600) });
      try {
        listener?.(acc.id, JSON.parse(raw));
      } catch {
        /* 非 JSON 忽略 */
      }
    });

    ws.addEventListener('close', () => {
      if (conn.timer) clearInterval(conn.timer);
      // 仅当 map 里仍是本连接时才移除（避免旧连接 close 时误删重连后的新连接）
      if (conns.get(acc.id) === conn) conns.delete(acc.id);
      logLine('WS', { account: acc.account, event: 'closed' });
      if (!conn.closedByUser) setTimeout(open, RECONNECT_MS);
    });

    ws.addEventListener('error', () => {
      logLine('WS', { account: acc.account, event: 'error' });
    });
  };

  open();
}

export function disconnect(accountId: string): void {
  const c = conns.get(accountId);
  if (!c) return;
  c.closedByUser = true;
  if (c.timer) clearInterval(c.timer);
  conns.delete(accountId);
  try {
    c.ws.close();
  } catch {
    /* ignore */
  }
}

export function connectAll(accounts: Account[]): void {
  accounts.forEach(connect);
}
