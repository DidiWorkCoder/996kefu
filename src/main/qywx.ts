import { app } from 'electron';
import { hostname } from 'node:os';
import { logLine } from './logger';
import type { Account } from './store';

/**
 * 企微客服中心的实时推送（对应网页端 index bundle 里的 y6/b6）：
 *   ws://<中心地址去 http>/ws?token=<urlencode(token)>&client=desktop&v=<版本>&mid=<机器标识>
 * 消息体是 { event, data }，event 有 7 种：
 *   snapshot / message / message-updated / messages-read
 *   conversation-unread / conversation-pinned / conversation-deleted
 * 断开后 1s 重连。
 */
const RECONNECT_MS = 1000;

interface Conn {
  ws: WebSocket;
  closedByUser?: boolean;
}

const conns = new Map<string, Conn>();
let listener: ((accountId: string, type: string, data: any) => void) | null = null;

export function setQywxListener(fn: (accountId: string, type: string, data: any) => void): void {
  listener = fn;
}

function wsUrlOf(acc: Account): string {
  const origin = String(acc.serverUrl || '').trim().replace(/\/+$/, '');
  const ws = origin.replace(/^http/i, 'ws') + '/ws';
  const params = new URLSearchParams({ client: 'desktop', v: app.getVersion(), mid: hostname() });
  return `${ws}?token=${encodeURIComponent(acc.qywxToken || '')}&${params.toString()}`;
}

export function connect(acc: Account): void {
  if (!acc.serverUrl || !acc.qywxToken) return;
  if (conns.has(acc.id)) return;

  const url = wsUrlOf(acc);

  const open = () => {
    const ws = new WebSocket(url);
    const conn: Conn = { ws };
    conns.set(acc.id, conn);

    ws.addEventListener('open', () => logLine('QYWX_WS', { account: acc.account, event: 'open' }));

    ws.addEventListener('message', (ev: any) => {
      try {
        const msg = JSON.parse(String(ev?.data ?? ''));
        if (msg?.event) listener?.(acc.id, String(msg.event), msg.data || {});
      } catch {
        /* 非 JSON 忽略 */
      }
    });

    ws.addEventListener('close', () => {
      // 仅当 map 里仍是本连接时才移除（避免旧连接 close 误删重连后的新连接）
      if (conns.get(acc.id) === conn) conns.delete(acc.id);
      logLine('QYWX_WS', { account: acc.account, event: 'closed' });
      if (!conn.closedByUser) setTimeout(open, RECONNECT_MS);
    });

    ws.addEventListener('error', () => logLine('QYWX_WS', { account: acc.account, event: 'error' }));
  };

  open();
}

export function disconnect(accountId: string): void {
  const c = conns.get(accountId);
  if (!c) return;
  c.closedByUser = true;
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
