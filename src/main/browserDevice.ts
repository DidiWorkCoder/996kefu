import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logLine } from './logger';

/**
 * 只读：从「本机浏览器的 localStorage」里读取 gm.tj.996sdk.com 的本地存储，
 * 其中的 deviceid:<账号> 就是 GM 站点判断「是否新设备登录」的设备凭证
 * （和「登录脚本导入」里那段 JS 取到的值完全一致）。
 *
 * 用途：账号密码登录时设备 ID 不用手输、也不用去浏览器控制台跑脚本，
 * 直接按注册表 / 默认路径定位浏览器用户数据目录，离线把 localStorage 解析出来。
 *
 * 支持 Edge / Chrome / Firefox / QQ 浏览器 / 夸克浏览器：
 *  - Chromium 系（Edge、Chrome、QQ、夸克）：Local Storage\leveldb 下的 .ldb + .log（LevelDB）
 *  - Firefox：storage\default\https+++gm.tj.996sdk.com\ls\data.sqlite（SQLite，明文扫描）
 * 全程只读：不修改浏览器任何文件，也不对游戏做任何操作。
 */

const GM_HOST = 'gm.tj.996sdk.com';
const LOCAL = process.env.LOCALAPPDATA || '';
const ROAM = process.env.APPDATA || '';
/** 单个文件读取上限：localStorage 文件不该这么大，超过就跳过，避免卡住 */
const MAX_FILE = 64 * 1024 * 1024;

/* ------------------------------ 注册表读取 ------------------------------ */

const HIVES: Record<string, string> = {
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCR: 'HKEY_CLASSES_ROOT',
  HKU: 'HKEY_USERS',
  HKCC: 'HKEY_CURRENT_CONFIG',
};

/** 注册表路径统一成完整 hive 名，便于比对（reg.exe 输出里是完整名） */
const normKey = (key: string) => {
  const [hive, ...rest] = String(key || '').split('\\');
  return [HIVES[hive.toUpperCase()] || hive.toUpperCase(), ...rest].join('\\').toLowerCase();
};

/** reg.exe 输出用的是控制台代码页（中文系统是 GBK），解码时别直接当 UTF-8 */
function decodeConsole(buf: Buffer): string {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 执行只读的 reg query，失败（键不存在等）返回空串 */
function reg(args: string[]): string {
  try {
    const out = execFileSync('reg', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return decodeConsole(out as unknown as Buffer);
  } catch {
    return '';
  }
}

/** 某个注册表键下的直接子键名 */
function regSubKeys(key: string): string[] {
  const out = new Set<string>();
  const want = normKey(key);
  for (const line of reg(['query', key]).split(/\r?\n/)) {
    const t = line.trim();
    if (!/^HKEY_/i.test(t)) continue;
    const segs = t.split('\\');
    const parent = segs.slice(0, -1).join('\\');
    if (normKey(parent) !== want) continue;
    const name = segs[segs.length - 1].trim();
    if (name) out.add(name);
  }
  return [...out];
}

/**
 * 从某个注册表键里读出「看起来像目录」的字符串（安装路径 / 用户数据目录）。
 * 用于定位浏览器位置：有些浏览器（QQ、夸克）用户数据目录不在固定位置，注册表里才有。
 */
function regDirValues(key: string): string[] {
  const out: string[] = [];
  for (const line of reg(['query', key]).split(/\r?\n/)) {
    const m = /^\s+(.+?)\s{2,}(REG_\S+)\s{2,}(.*)$/.exec(line);
    if (!m || !/^REG_(SZ|EXPAND_SZ)$/i.test(m[2])) continue;
    const raw = m[3].trim().replace(/^"|"$/g, '');
    // REG_EXPAND_SZ 里可能带 %LOCALAPPDATA% 这类变量
    const expanded = raw.replace(/%([^%]+)%/g, (_s, n) => process.env[n] || process.env[String(n).toUpperCase()] || '');
    if (/^[a-zA-Z]:\\/.test(expanded)) out.push(expanded);
  }
  return out;
}

/* --------------------------- Chromium（LevelDB） --------------------------- */

interface Kv {
  key: Buffer;
  value: Buffer;
}

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let b = 0;
  do {
    b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  return [result, pos];
}

/** raw Snappy 解压（LevelDB 块压缩用） */
function snappyDecompress(input: Buffer): Buffer {
  let pos = 0;
  let expected = 0;
  let shift = 0;
  let b = 0;
  do {
    b = input[pos++];
    expected += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);
  const out = Buffer.alloc(expected);
  let op = 0;
  while (pos < input.length && op < expected) {
    const tag = input[pos++];
    const t = tag & 0x03;
    if (t === 0) {
      let len = (tag >> 2) + 1;
      if (len > 60) {
        const extra = len - 60;
        len = 0;
        for (let i = 0; i < extra; i++) len += input[pos++] * Math.pow(2, 8 * i);
        len += 1;
      }
      input.copy(out, op, pos, pos + len);
      pos += len;
      op += len;
    } else {
      let len: number;
      let offset: number;
      if (t === 1) {
        len = ((tag >> 2) & 0x07) + 4;
        offset = ((tag >> 5) << 8) | input[pos++];
      } else if (t === 2) {
        len = (tag >> 2) + 1;
        offset = input[pos] | (input[pos + 1] << 8);
        pos += 2;
      } else {
        len = (tag >> 2) + 1;
        offset = (input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24)) >>> 0;
        pos += 4;
      }
      let src = op - offset;
      for (let i = 0; i < len; i++) out[op++] = out[src++];
    }
  }
  return out.subarray(0, op);
}

/** 解析一个 data block（varint 前缀压缩 + 尾部 restart 数组） */
function parseBlock(content: Buffer): Kv[] {
  const out: Kv[] = [];
  const numRestarts = content.readUInt32LE(content.length - 4);
  const entriesEnd = content.length - 4 - numRestarts * 4;
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < entriesEnd) {
    let shared: number;
    let nonShared: number;
    let valueLen: number;
    [shared, pos] = readVarint(content, pos);
    [nonShared, pos] = readVarint(content, pos);
    [valueLen, pos] = readVarint(content, pos);
    const keyPart = content.subarray(pos, pos + nonShared);
    pos += nonShared;
    key = Buffer.concat([key.subarray(0, shared), keyPart]);
    const value = Buffer.from(content.subarray(pos, pos + valueLen));
    pos += valueLen;
    out.push({ key: Buffer.from(key), value });
  }
  return out;
}

/**
 * 读一个 block：Chromium 写出的 .ldb 里 BlockHandle.size 有两种约定
 * （是否含 5 字节 block trailer），两种都试，用 trailer 的类型字节（0=无压缩 / 1=Snappy）校验。
 */
function readBlockEntries(buf: Buffer, offset: number, size: number): Kv[] {
  for (const sz of size > 5 ? [size, size - 5] : [size]) {
    if (sz <= 0 || offset + sz > buf.length) continue;
    const type = buf[offset + sz];
    if (type !== 0 && type !== 1) continue;
    try {
      const raw = buf.subarray(offset, offset + sz);
      return parseBlock(type === 1 ? snappyDecompress(raw) : raw);
    } catch {
      /* 换下一种约定 */
    }
  }
  return [];
}

/** 读 .ldb（SSTable）：footer -> index block -> 各 data block */
function readTable(file: string): Kv[] {
  const buf = readFileSync(file);
  if (buf.length < 48) return [];
  const footer = buf.subarray(buf.length - 48);
  let p = 0;
  let indexOff: number;
  let indexSize: number;
  [, p] = readVarint(footer, p);
  [, p] = readVarint(footer, p);
  [indexOff, p] = readVarint(footer, p);
  [indexSize, p] = readVarint(footer, p);
  const kvs: Kv[] = [];
  for (const e of readBlockEntries(buf, indexOff, indexSize)) {
    let q = 0;
    let off: number;
    let size: number;
    [off, q] = readVarint(e.value, q);
    [size, q] = readVarint(e.value, q);
    if (!size) continue;
    kvs.push(...readBlockEntries(buf, off, size));
  }
  return kvs;
}

/** 读 .log（写前日志）：32KB 物理块 + 7 字节记录头 + FULL/FIRST/MIDDLE/LAST 重组 */
function readLog(file: string): Kv[] {
  const buf = readFileSync(file);
  const BLOCK = 32768;
  const HEADER = 7;
  const records: Buffer[] = [];
  let fragments: Buffer[] = [];
  for (let blockPos = 0; blockPos < buf.length; blockPos += BLOCK) {
    const blockEnd = Math.min(blockPos + BLOCK, buf.length);
    let pos = blockPos;
    while (pos + HEADER <= blockEnd) {
      const len = buf.readUInt16LE(pos + 4);
      const type = buf[pos + 6];
      if (!type || !len || pos + HEADER + len > blockEnd) break;
      const data = buf.subarray(pos + HEADER, pos + HEADER + len);
      pos += HEADER + len;
      if (type === 1) {
        fragments = [];
        records.push(Buffer.from(data));
      } else if (type === 2) fragments = [data];
      else if (type === 3) fragments.push(data);
      else if (type === 4) {
        fragments.push(data);
        records.push(Buffer.concat(fragments));
        fragments = [];
      }
    }
  }
  const kvs: Kv[] = [];
  for (const rec of records) {
    if (rec.length < 12) continue;
    const count = rec.readUInt32LE(8);
    let p = 12;
    for (let i = 0; i < count && p < rec.length; i++) {
      const t = rec[p++];
      let klen: number;
      [klen, p] = readVarint(rec, p);
      const key = Buffer.from(rec.subarray(p, p + klen));
      p += klen;
      if (t !== 1) continue;
      let vlen: number;
      [vlen, p] = readVarint(rec, p);
      kvs.push({ key, value: Buffer.from(rec.subarray(p, p + vlen)) });
      p += vlen;
    }
  }
  return kvs;
}

/**
 * leveldb 的 key 形如 `_<origin>\x00<类型><键名>`，类型 0=UTF-16LE、1=Latin-1。
 * META:<origin> 这类 key 不是业务数据，返回 null。
 */
function decodeChromiumKey(key: Buffer): { origin: string; name: string } | null {
  if (key.length < 2 || key[0] !== 0x5f) return null;
  const sep = key.indexOf(0x00, 1);
  if (sep < 0) return null;
  const origin = key.subarray(1, sep).toString('latin1');
  const type = key[sep + 1];
  const rest = key.subarray(sep + 2);
  if (type === 0x00) return { origin, name: rest.toString('utf16le') };
  if (type === 0x01) return { origin, name: rest.toString('latin1') };
  return null;
}

/** 值的首字节是类型标记（0=UTF-16LE、1=Latin-1），之后才是内容 */
function decodeChromiumValue(value: Buffer): string {
  if (!value.length) return '';
  if (value[0] === 0x00) return value.subarray(1).toString('utf16le');
  if (value[0] === 0x01) return value.subarray(1).toString('latin1');
  return value.toString('utf8');
}

/** 从键名里取 deviceid:<账号>（解析出来可能带少量二进制噪声，只取可打印字符） */
function deviceIdKey(name: string): string | null {
  const i = name.indexOf('deviceid:');
  if (i < 0) return null;
  const m = /^[\x20-\x7e]{1,64}/.exec(name.slice(i + 'deviceid:'.length));
  return m ? `deviceid:${m[0]}` : null;
}

/** `{"expireAt":0,"data":"..."}` -> data；不是 JSON 时按普通字符串处理 */
function valueToDeviceId(text: string): string {
  const s = String(text || '').trim();
  try {
    const o = JSON.parse(s);
    const d = o?.data;
    return typeof d === 'string' ? d : String(d ?? '');
  } catch {
    return s;
  }
}

/** 扫一个 Local Storage\leveldb 目录，返回 gm 站点的本地存储（含 deviceid:*） */
function scanChromium(dir: string, account: string): { account: string; deviceId: string; storage: Record<string, string> } | null {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  // 先读 .ldb（旧的、已落盘的），再读 .log（较新的写入），后者覆盖前者
  const ordered = [
    ...files.filter((f) => f.endsWith('.ldb')).sort(),
    ...files.filter((f) => f.endsWith('.log')).sort(),
  ];
  const storage: Record<string, string> = {};
  let hitAccount = '';
  let hitDeviceId = '';
  for (const f of ordered) {
    const full = join(dir, f);
    try {
      if (statSync(full).size > MAX_FILE) continue;
      const kvs = f.endsWith('.ldb') ? readTable(full) : readLog(full);
      for (const { key, value } of kvs) {
        const d = decodeChromiumKey(key);
        if (!d || d.origin.indexOf(GM_HOST) < 0) continue;
        const text = decodeChromiumValue(value);
        const dk = deviceIdKey(d.name);
        if (!dk) continue;
        storage[dk] = text;
        if (dk.slice('deviceid:'.length).toLowerCase() === account.toLowerCase()) {
          const dev = valueToDeviceId(text);
          if (dev) {
            hitAccount = dk.slice('deviceid:'.length);
            hitDeviceId = dev;
          }
        }
      }
    } catch (e: any) {
      logLine('BROWSER_DEVICE_FILE', { file: full, err: String(e?.message || e) });
    }
  }
  return hitDeviceId ? { account: hitAccount, deviceId: hitDeviceId, storage } : null;
}

/* ------------------------------ Firefox ------------------------------ */

/** Firefox 的 profile 目录：profiles.ini + Profiles 目录扫描兜底 */
function firefoxProfileDirs(): string[] {
  const root = ROAM ? join(ROAM, 'Mozilla', 'Firefox') : '';
  if (!root || !existsSync(root)) return [];
  const out: string[] = [];
  try {
    const ini = readFileSync(join(root, 'profiles.ini'), 'utf-8');
    for (const block of ini.split(/\[/).slice(1)) {
      const path = /(?:^|\n)\s*Path\s*=\s*(.+)/.exec(block)?.[1]?.trim();
      if (!path) continue;
      const absolute = /(?:^|\n)\s*IsRelative\s*=\s*0/.test(block);
      const dir = absolute ? path : join(root, path);
      if (existsSync(dir)) out.push(dir);
    }
  } catch {
    /* 没有 profiles.ini 就用目录扫描 */
  }
  try {
    for (const e of readdirSync(join(root, 'Profiles'))) out.push(join(root, 'Profiles', e));
  } catch {
    /* 忽略 */
  }
  return [...new Set(out)];
}

/** Firefox 里 gm 站点的 localStorage 文件（新版可能被 LSCipherKeyManager 加密，读不到就跳过） */
function firefoxStorageFiles(profileDir: string): string[] {
  const base = join(profileDir, 'storage', 'default');
  try {
    return readdirSync(base)
      .filter((e) => e.includes('996sdk'))
      .map((e) => join(base, e, 'ls', 'data.sqlite'))
      .filter((f) => existsSync(f));
  } catch {
    return [];
  }
}

/**
 * 明文扫描 data.sqlite：键与值都是明文（UTF-8 或 UTF-16LE），直接找 deviceid:<账号>。
 * 注意 SQLite 记录里键后面紧跟一个「值长度」字节，再是值 `{"expireAt":...,"data":...}`。
 * 值长度一般是 56（可打印字符 '8'），会被账号字符集一起吃掉，这里按长度把它剥掉。
 */
function scanFirefox(file: string, account: string): { account: string; deviceId: string; storage: Record<string, string> } | null {
  let buf: Buffer;
  try {
    if (statSync(file).size > MAX_FILE) return null;
    buf = readFileSync(file);
  } catch {
    return null;
  }
  const storage: Record<string, string> = {};
  let hitAccount = '';
  let hitDeviceId = '';
  for (const enc of ['latin1', 'utf16le'] as const) {
    const text = buf.toString(enc);
    const re = /deviceid:([A-Za-z0-9_.\-@]{1,52})[\s\S]{0,4}?(\{"expireAt"[\s\S]{0,600}?\})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let acct = m[1];
      const raw = m[2];
      const valueLen = Buffer.byteLength(raw, 'utf8');
      if (valueLen < 128 && acct.length > 1 && acct.charCodeAt(acct.length - 1) === valueLen) {
        acct = acct.slice(0, -1);
      }
      const dev = valueToDeviceId(raw);
      if (!dev) continue;
      storage[`deviceid:${acct}`] = raw;
      if (acct.toLowerCase() === account.toLowerCase()) {
        hitAccount = acct;
        hitDeviceId = dev;
      }
    }
  }
  return hitDeviceId ? { account: hitAccount, deviceId: hitDeviceId, storage } : null;
}

/* ------------------------------ 浏览器定位 ------------------------------ */

interface ChromiumBrowser {
  name: string;
  /** 注册表根：确认是否安装，并读它的 Profiles 子键（Edge 会在这里记录 profile 目录名） */
  regRoots: string[];
  /** 用户数据目录（User Data）候选 */
  dataDirs: string[];
}

/** Chromium 系浏览器的用户数据目录不在注册表里存，注册表只用来确认安装 + 取 profile 名 */
const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  {
    name: 'Edge',
    regRoots: ['HKCU\\Software\\Microsoft\\Edge'],
    dataDirs: [LOCAL && join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
  },
  {
    name: 'Chrome',
    regRoots: ['HKCU\\Software\\Google\\Chrome'],
    dataDirs: [LOCAL && join(LOCAL, 'Google', 'Chrome', 'User Data')],
  },
  {
    name: 'QQ浏览器',
    regRoots: [
      'HKCU\\Software\\Tencent\\QQBrowser',
      'HKLM\\SOFTWARE\\Tencent\\QQBrowser',
      'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQBrowser',
    ],
    dataDirs: [
      LOCAL && join(LOCAL, 'Tencent', 'QQBrowser', 'User Data'),
      ROAM && join(ROAM, 'Tencent', 'QQBrowser', 'User Data'),
    ],
  },
  {
    name: '夸克浏览器',
    regRoots: ['HKCU\\Software\\Quark\\QuarkPC', 'HKCU\\Software\\Quark'],
    dataDirs: [
      LOCAL && join(LOCAL, 'Quark', 'User Data'),
      LOCAL && join(LOCAL, 'QuarkPC', 'User Data'),
      LOCAL && join(LOCAL, 'Quark', 'QuarkPC', 'User Data'),
      ROAM && join(ROAM, 'Quark', 'User Data'),
    ],
  },
].map((b) => ({ ...b, dataDirs: b.dataDirs.filter(Boolean) as string[] }));

/** 注册表里记录的安装/数据路径也一并纳入候选（QQ、夸克的用户数据目录常只在这里） */
function dataDirsOf(b: ChromiumBrowser): string[] {
  const extra: string[] = [];
  for (const root of b.regRoots) {
    for (const p of regDirValues(root)) extra.push(p, join(p, 'User Data'));
  }
  return [...new Set([...b.dataDirs, ...extra])];
}

/** 一个用户数据目录下的所有 profile 名（注册表记录的 + Local State 的 + 磁盘扫描的） */
function chromiumProfiles(dataDir: string, regRoots: string[]): string[] {
  const out: string[] = [];
  for (const root of regRoots) out.push(...regSubKeys(`${root}\\Profiles`));
  try {
    const ls = JSON.parse(readFileSync(join(dataDir, 'Local State'), 'utf-8'));
    out.push(...Object.keys(ls?.profile?.info_cache || {}));
  } catch {
    /* 没有 Local State 就靠磁盘扫描 */
  }
  try {
    for (const e of readdirSync(dataDir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(dataDir, e.name, 'Local Storage', 'leveldb'))) out.push(e.name);
    }
  } catch {
    /* 目录不存在 */
  }
  return [...new Set(out.filter(Boolean))];
}

/* ------------------------------ 对外接口 ------------------------------ */

export interface BrowserDeviceHit {
  /** 命中 deviceid 的账号 */
  account: string;
  deviceId: string;
  /** 浏览器展示名（Edge / Chrome / Firefox / QQ浏览器 / 夸克浏览器） */
  browser: string;
  /** 命中的数据位置（排查用） */
  path: string;
  /** 该来源里 gm.tj.996sdk.com 的本地存储（尽力而为，含 deviceid:*） */
  storage: Record<string, string>;
}

/**
 * 在本机所有浏览器里找 `deviceid:<account>`，返回找到的设备凭证与它所在的本地存储。
 * 只读，找不到返回 null。
 */
export function readDeviceIdFromBrowsers(account: string): BrowserDeviceHit | null {
  const acct = String(account || '').trim();
  if (!acct) return null;
  for (const b of CHROMIUM_BROWSERS) {
    for (const dataDir of dataDirsOf(b)) {
      for (const profile of chromiumProfiles(dataDir, b.regRoots)) {
        const dir = join(dataDir, profile, 'Local Storage', 'leveldb');
        if (!existsSync(dir)) continue;
        const hit = scanChromium(dir, acct);
        if (hit) return { ...hit, browser: b.name, path: dir };
      }
    }
  }
  // Firefox：注册表里只有版本号（HKCU\Software\Mozilla\Mozilla Firefox），profile 目录看 profiles.ini
  for (const profileDir of firefoxProfileDirs()) {
    for (const file of firefoxStorageFiles(profileDir)) {
      const hit = scanFirefox(file, acct);
      if (hit) return { ...hit, browser: 'Firefox', path: file };
    }
  }
  return null;
}
