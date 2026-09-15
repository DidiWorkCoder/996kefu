import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * 极简 WebSocket 服务端（只实现局域网互通需要的部分）：
 * 文本帧 + 分片 + ping/pong/close。客户端用主进程内置的 WebSocket 连接，
 * 这样不用引入 ws 依赖，也不影响打包。
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsConn {
  /** 发送一条文本消息 */
  send(text: string): void;
  close(): void;
  onMessage: ((text: string) => void) | null;
  onClose: (() => void) | null;
}

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 组一帧（服务端发出的帧不掩码） */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

class Conn implements WsConn {
  onMessage: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  private buf = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragOpcode = 0;
  private closed = false;
  private socket: Duplex;

  constructor(socket: Duplex) {
    this.socket = socket;
    socket.on('data', (c: Buffer) => this.push(c));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
  }

  send(text: string): void {
    if (this.closed) return;
    try {
      this.socket.write(frame(OP_TEXT, Buffer.from(text, 'utf8')));
    } catch {
      this.destroy();
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.socket.write(frame(OP_CLOSE, Buffer.alloc(0)));
    } catch {
      /* ignore */
    }
    this.destroy();
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }

  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  private push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.parse();
  }

  private parse(): void {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6);
        off = 10;
      }
      let mask: Buffer | null = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = b.subarray(off + len);
      this.handle(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  private handle(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OP_CLOSE) {
      this.close();
      return;
    }
    if (opcode === OP_PING) {
      try {
        this.socket.write(frame(OP_PONG, payload));
      } catch {
        this.destroy();
      }
      return;
    }
    if (opcode === OP_PONG) return;

    // 文本帧 / 继续帧
    if (opcode === OP_TEXT) {
      if (fin) {
        this.onMessage?.(payload.toString('utf8'));
      } else {
        this.fragOpcode = opcode;
        this.frags = [payload];
      }
      return;
    }
    if (opcode === 0x0 && this.frags.length) {
      this.frags.push(payload);
      if (fin) {
        const text = Buffer.concat(this.frags).toString('utf8');
        this.frags = [];
        if (this.fragOpcode === OP_TEXT) this.onMessage?.(text);
      }
    }
  }
}

/** 处理 HTTP Upgrade 请求，完成握手并返回连接对象（非法请求返回 null 并断开） */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = String(req.headers['sec-websocket-key'] || '');
  const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new Conn(socket);
}
