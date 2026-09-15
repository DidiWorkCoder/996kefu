import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import { logLine } from './logger';
import { getSettings, saveSettings, type LanConfig } from './settings';
import { listAccounts } from './store';
import { acceptWebSocket, type WsConn } from './wsServer';

/**
 * 局域网客服管理：
 *   - UDP 广播自动发现同网段实例（识别码一致才互通），也支持手动填 ip:port；
 *   - 每对实例之间维持一条 WebSocket，用于请求（拉取会话/远程回复/同步数据）
 *     和事件推送（对方推送了玩家、会话有新消息……）。
 */

const APP_TAG = '996kefu-lan';
/** UDP 发现端口 */
const DISCOVERY_PORT = 17331;
/** 广播间隔 */
const BEACON_MS = 5_000;
/** 自动发现的设备多久没广播就丢弃 */
const AUTO_PEER_TTL = 60_000;
/** 掉线后重连间隔 */
const RECONNECT_MS = 5_000;
/** 心跳间隔 */
const HEART_MS = 10_000;
/** 请求超时 */
const REQ_TIMEOUT = 15_000;

export interface AccountBrief {
  id: string;
  name: string;
  account: string;
  uid: string;
  companyId: string;
}

type LanHandler = (fromAddr: string, data: any) => Promise<any> | any;

interface Peer {
  /** 唯一键：ip:port */
  addr: string;
  /** 对端实例 id（握手后才知道） */
  id: string;
  name: string;
  /** manual=手动添加 auto=自动发现 */
  source: 'manual' | 'auto';
  online: boolean;
  /** 最近一次收到广播的时间 */
  seenAt: number;
  /** 最近一次收到消息的时间 */
  lastSeen: number;
  accounts: AccountBrief[];
  conn: WsConn | null;
  ws: WebSocket | null;
  pending: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>;
}

const peers = new Map<string, Peer>();
const handlers = new Map<string, LanHandler>();

let instanceId = randomUUID();
let server: Server | null = null;
let udp: dgram.Socket | null = null;
let beaconTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let heartTimer: ReturnType<typeof setInterval> | null = null;
let listeningPort = 0;

let listener: ((evt: { type: string; data?: any }) => void) | null = null;

/* ---------------- 对外接口 ---------------- */

export function setLanListener(fn: (evt: { type: string; data?: any }) => void): void {
  listener = fn;
}

/** 注册一个来自其它机器的请求处理器 */
export function registerHandler(type: string, fn: LanHandler): void {
  handlers.set(type, fn);
}

/** 本机信息 */
export function selfInfo(): { instanceId: string; name: string; port: number } {
  return { instanceId, name: selfName(), port: listeningPort || getSettings().lan.port };
}

function emit(type: string, data?: any): void {
  listener?.({ type, data });
}

function selfName(): string {
  return getSettings().lan.name?.trim() || os.hostname();
}

function briefAccounts(): AccountBrief[] {
  return listAccounts().map((a) => ({ id: a.id, name: a.name, account: a.account, uid: a.uid, companyId: a.companyId }));
}

/** 当前状态（渲染层用） */
export function getLanStatus() {
  const lan = getSettings().lan;
  return {
    enabled: lan.enabled,
    name: selfName(),
    port: listeningPort || lan.port,
    token: lan.token,
    autoDiscover: lan.autoDiscover,
    manual: lan.manual,
    instanceId,
    selfAccounts: briefAccounts(),
    peers: [...peers.values()]
      .map((p) => ({
        addr: p.addr,
        id: p.id,
        name: p.name || p.addr,
        source: p.source,
        online: p.online,
        lastSeen: p.lastSeen,
        accounts: p.accounts,
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
  };
}

/** 广播状态变化给渲染层 */
function pushStatus(): void {
  emit('status', getLanStatus());
}

/* ---------------- 生命周期 ---------------- */

function ensureToken(): LanConfig {
  const lan = getSettings().lan;
  if (!lan.token) {
    return saveSettings({ lan: { ...lan, token: randomUUID().replace(/-/g, '').slice(0, 12) } }).lan;
  }
  return lan;
}

export function startLan(): void {
  if (server) return;
  const lan = ensureToken();
  if (!lan.enabled) return;

  instanceId = randomUUID();
  startServer(lan.port);
  if (lan.autoDiscover) startDiscovery();
  // 手动添加的地址先建连接
  lan.manual.forEach((m) => ensurePeer(m.addr, m.name, 'manual'));

  sweepTimer = setInterval(sweep, 10_000);
  heartTimer = setInterval(heartbeat, HEART_MS);
  logLine('LAN_START', { port: listeningPort, name: selfName(), manual: lan.manual.length });
  pushStatus();
}

export function stopLan(): void {
  [...peers.values()].forEach((p) => closePeer(p));
  peers.clear();
  if (beaconTimer) clearInterval(beaconTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  if (heartTimer) clearInterval(heartTimer);
  beaconTimer = sweepTimer = heartTimer = null;
  try {
    udp?.close();
  } catch {
    /* ignore */
  }
  udp = null;
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  server = null;
  listeningPort = 0;
  logLine('LAN_STOP', {});
  pushStatus();
}

/** 设置变更后重启（端口/开关/识别码变了都要重来） */
export function restartLan(): void {
  const wasRunning = !!server;
  stopLan();
  const lan = getSettings().lan;
  if (lan.enabled) startLan();
  else if (wasRunning) logLine('LAN_DISABLED', {});
}

/* ---------------- HTTP + WebSocket 服务端 ---------------- */

function json(res: any, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json;charset=UTF-8' });
  res.end(JSON.stringify(body));
}

function startServer(port: number): void {
  server = createServer((req, res) => {
    if ((req.url || '').startsWith('/lan/info')) {
      json(res, 200, { app: APP_TAG, id: instanceId, name: selfName(), port: listeningPort || port });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req, socket) => {
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://lan');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/lan') {
      socket.destroy();
      return;
    }
    // 识别码不对直接拒掉
    if (url.searchParams.get('token') !== getSettings().lan.token) {
      logLine('LAN_REJECT', { reason: 'token 不匹配', from: req.socket.remoteAddress });
      socket.destroy();
      return;
    }
    const conn = acceptWebSocket(req, socket);
    if (!conn) return;
    const remoteId = url.searchParams.get('id') || '';
    const remoteName = decodeURIComponent(url.searchParams.get('name') || '');
    if (remoteId && remoteId === instanceId) {
      // 自己连自己（同一台机器重复启动），忽略
      conn.close();
      return;
    }
    const addr = `${req.socket.remoteAddress?.replace(/^::ffff:/, '') || ''}:${url.searchParams.get('port') || ''}`;
    const isManual = getSettings().lan.manual.some((m) => m.addr === addr);
    const peer = ensurePeer(addr, remoteName, isManual ? 'manual' : 'auto');
    if (remoteId) peer.id = remoteId;
    peer.name = remoteName || peer.name;
    bind(peer, conn);
    logLine('LAN_IN', { addr, name: peer.name });
  });

  server.on('error', (e: any) => logLine('LAN_SERVER_ERR', { err: String(e?.message || e) }));
  server.listen(port, '0.0.0.0', () => {
    listeningPort = port;
    logLine('LAN_SERVER', { port });
  });
}

/* ---------------- UDP 自动发现 ---------------- */

function startDiscovery(): void {
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e: any) => logLine('LAN_UDP_ERR', { err: String(e?.message || e) }));
    sock.on('message', (buf, rinfo) => {
      let m: any;
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (m?.app !== APP_TAG || m.id === instanceId) return;
      if (m.token !== getSettings().lan.token) return;
      const addr = `${rinfo.address}:${m.port}`;
      const peer = ensurePeer(addr, String(m.name || ''), 'auto');
      peer.id = String(m.id || '');
      peer.name = String(m.name || peer.name);
      peer.seenAt = Date.now();
      if (!peer.online && !peer.ws) connect(peer);
      pushStatus();
    });
    sock.bind(DISCOVERY_PORT, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* 某些网卡不允许广播 */
      }
    });
    udp = sock;
    beaconTimer = setInterval(() => {
      const m = JSON.stringify({ app: APP_TAG, id: instanceId, name: selfName(), port: listeningPort, token: getSettings().lan.token });
      for (const addr of broadcastAddrs()) {
        try {
          udp?.send(m, DISCOVERY_PORT, addr);
        } catch {
          /* ignore */
        }
      }
    }, BEACON_MS);
  } catch (e: any) {
    logLine('LAN_UDP_ERR', { err: String(e?.message || e) });
  }
}

/** 全网段广播 + 本机各网卡的定向广播地址 */
function broadcastAddrs(): string[] {
  const list = new Set<string>(['255.255.255.255']);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      list.add(ip.map((n, i) => ((n & mask[i]) | (~mask[i] & 255)) >>> 0).join('.'));
    }
  }
  return [...list];
}

/* ---------------- 连接管理 ---------------- */

function ensurePeer(addr: string, name: string, source: 'manual' | 'auto'): Peer {
  let p = peers.get(addr);
  if (!p) {
    p = {
      addr,
      id: '',
      name: name || addr,
      source,
      online: false,
      seenAt: Date.now(),
      lastSeen: 0,
      accounts: [],
      conn: null,
      ws: null,
      pending: new Map(),
    };
    peers.set(addr, p);
  } else {
    if (name) p.name = name;
    if (source === 'manual') p.source = 'manual';
  }
  return p;
}

function connect(peer: Peer): void {
  if (peer.ws) return;
  const lan = getSettings().lan;
  if (!lan.enabled) return;
  const url =
    `ws://${peer.addr}/lan?id=${encodeURIComponent(instanceId)}` +
    `&name=${encodeURIComponent(selfName())}&port=${listeningPort || lan.port}` +
    `&token=${encodeURIComponent(lan.token)}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e: any) {
    logLine('LAN_CONN_ERR', { addr: peer.addr, err: String(e?.message || e) });
    return;
  }
  peer.ws = ws;

  ws.addEventListener('open', () => {
    peer.online = true;
    peer.lastSeen = Date.now();
    sendHello(peer);
    pushStatus();
  });
  ws.addEventListener('message', (ev: any) => {
    const peer2 = peers.get(peer.addr);
    if (peer2) onText(peer2, String(ev?.data ?? ''));
  });
  ws.addEventListener('close', () => {
    peer.online = false;
    peer.conn = null;
    peer.ws = null;
    failPending(peer, '连接已断开');
    pushStatus();
  });
  ws.addEventListener('error', () => {
    logLine('LAN_CONN_ERR', { addr: peer.addr });
  });
}

function closePeer(peer: Peer): void {
  failPending(peer, '连接已关闭');
  try {
    peer.conn?.close();
  } catch {
    /* ignore */
  }
  try {
    peer.ws?.close();
  } catch {
    /* ignore */
  }
  peer.conn = null;
  peer.ws = null;
  peer.online = false;
}

/** 收到对端（服务端侧）建连后绑定 */
function bind(peer: Peer, conn: WsConn): void {
  failPending(peer, '连接被替换');
  peer.conn = conn;
  peer.online = true;
  peer.lastSeen = Date.now();
  conn.onMessage = (text) => onText(peer, text);
  conn.onClose = () => {
    peer.online = false;
    peer.conn = null;
    failPending(peer, '连接已断开');
    pushStatus();
  };
  sendHello(peer);
  pushStatus();
}

function sendHello(peer: Peer): void {
  const payload = { t: 'hello', id: instanceId, name: selfName(), port: listeningPort, accounts: briefAccounts() };
  rawSend(peer, payload);
  pushStatus();
}

function rawSend(peer: Peer, msg: unknown): void {
  const text = JSON.stringify(msg);
  try {
    if (peer.conn) peer.conn.send(text);
    else if (peer.ws && peer.ws.readyState === 1) peer.ws.send(text);
  } catch (e: any) {
    logLine('LAN_SEND_ERR', { addr: peer.addr, err: String(e?.message || e) });
  }
}

function failPending(peer: Peer, reason: string): void {
  peer.pending.forEach((p) => {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  });
  peer.pending.clear();
}

/* ---------------- 消息处理 ---------------- */

function onText(peer: Peer, text: string): void {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  peer.lastSeen = Date.now();
  peer.seenAt = Date.now();

  if (m.t === 'hello') {
    peer.id = String(m.id || peer.id);
    peer.name = String(m.name || peer.name);
    peer.accounts = Array.isArray(m.accounts) ? m.accounts : [];
    peer.online = true;
    pushStatus();
    return;
  }
  if (m.t === 'ping') {
    rawSend(peer, { t: 'pong' });
    return;
  }
  if (m.t === 'pong') return;
  if (m.t === 'res') {
    const p = peer.pending.get(String(m.rid));
    if (!p) return;
    clearTimeout(p.timer);
    peer.pending.delete(String(m.rid));
    if (m.ok) p.resolve(m.data);
    else p.reject(new Error(String(m.error || '对端执行失败')));
    return;
  }
  if (m.t === 'req') {
    void handleIncoming(peer, m);
    return;
  }
  if (m.t === 'evt') {
    emit('peer-event', { addr: peer.addr, peerId: peer.id, peerName: peer.name, type: m.type, data: m.data });
    return;
  }
}

async function handleIncoming(peer: Peer, m: any): Promise<void> {
  const fn = handlers.get(String(m.type || ''));
  if (!fn) {
    rawSend(peer, { t: 'res', rid: m.rid, ok: false, error: `不支持的操作：${m.type}` });
    return;
  }
  try {
    const data = await fn(peer.addr, m.data);
    rawSend(peer, { t: 'res', rid: m.rid, ok: true, data });
  } catch (e: any) {
    rawSend(peer, { t: 'res', rid: m.rid, ok: false, error: String(e?.message || e) });
  }
}

/** 向指定设备发起请求 */
export function callPeer<T = any>(addr: string, type: string, data?: any): Promise<T> {
  const peer = peers.get(addr);
  if (!peer || !peer.online) return Promise.reject(new Error('对方设备不在线'));
  const rid = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.pending.delete(rid);
      reject(new Error('请求超时，对方可能已关闭'));
    }, REQ_TIMEOUT);
    peer.pending.set(rid, { resolve, reject, timer });
    rawSend(peer, { t: 'req', rid, type, data });
  });
}

/** 向指定设备推送事件（不关心结果） */
export function sendEvent(addr: string, type: string, data?: any): void {
  const peer = peers.get(addr);
  if (!peer || !peer.online) return;
  rawSend(peer, { t: 'evt', type, data });
}

/** 向所有在线设备推送事件 */
export function broadcastEvent(type: string, data?: any): void {
  peers.forEach((p) => {
    if (p.online) rawSend(p, { t: 'evt', type, data });
  });
}

/** 找出持有某个 uid 的设备地址 */
export function findPeersByUid(uid: string): string[] {
  return [...peers.values()].filter((p) => p.online && p.accounts.some((a) => a.uid === uid)).map((p) => p.addr);
}

/** 读取某台设备上的账号列表 */
export function peerAccounts(addr: string): AccountBrief[] {
  return peers.get(addr)?.accounts || [];
}

/** 手动添加一台设备（自动发现失败时用） */
export function addManualPeer(addr: string, name?: string): void {
  const clean = addr.trim();
  if (!clean) return;
  const lan = getSettings().lan;
  if (!lan.manual.some((m) => m.addr === clean)) {
    saveSettings({ lan: { ...lan, manual: [...lan.manual, { id: randomUUID(), addr: clean, name }] } });
  }
  const peer = ensurePeer(clean, name || '', 'manual');
  if (!peer.online && !peer.ws) connect(peer);
  pushStatus();
}

/** 移除手动添加的设备 */
export function removeManualPeer(addr: string): void {
  const lan = getSettings().lan;
  saveSettings({ lan: { ...lan, manual: lan.manual.filter((m) => m.addr !== addr) } });
  const peer = peers.get(addr);
  if (peer) {
    closePeer(peer);
    peers.delete(addr);
  }
  pushStatus();
}

/** 写入局域网配置（改完由 index.ts 调 restartLan 生效） */
export function saveLanConfig(patch: Partial<LanConfig>): LanConfig {
  const lan = getSettings().lan;
  return saveSettings({ lan: { ...lan, ...patch } }).lan;
}

/* ---------------- 心跳 / 清理 ---------------- */

function heartbeat(): void {
  [...peers.values()].forEach((p) => {
    if (!p.online) return;
    rawSend(p, { t: 'ping' });
    // 顺带重发一次 hello，让对端拿到最新的账号列表
    sendHello(p);
  });
}

function sweep(): void {
  const now = Date.now();
  let changed = false;
  [...peers.values()].forEach((p) => {
    // 自动发现的设备长时间没广播 + 没连接 => 移除
    if (p.source === 'auto' && !p.online && now - p.seenAt > AUTO_PEER_TTL) {
      peers.delete(p.addr);
      changed = true;
      return;
    }
    // 掉线重连
    if (!p.online && !p.ws) {
      const manual = p.source === 'manual' || getSettings().lan.manual.some((m) => m.addr === p.addr);
      if (manual || now - p.seenAt < AUTO_PEER_TTL) connect(p);
    }
  });
  if (changed) pushStatus();
}
