import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logLine } from './logger';

/**
 * 客服控制台的接口地址与 AES 口令会随前端发版变化。
 * 这里定时把 console.kf.996sdk.net 的 JS 拉下来，从代码里提取这些常量，
 * 取不全就沿用上次缓存，再退回打包内置的兜底值，保证请求始终可用。
 */

/** 内置兜底值（控制台 JS 拉取失败时使用） */
const FALLBACK: KfKeys = {
  API: 'https://api.kf.996sdk.net',
  MGN: 'https://mgn-api.kf.996sdk.net/chatroom-clientele',
  AES_KEY: 'secret key 1234',
};

export interface KfKeys {
  API: string;
  MGN: string;
  AES_KEY: string;
}

/** 控制台站点（JS 资源来源） */
const CONSOLE_ORIGIN = 'https://console.kf.996sdk.net';
/** 每隔 6 小时重新拉一次 */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** 单次最多下载多少个 JS（找到全部目标值就提前停） */
const MAX_SCRIPTS = 30;
/** 单个 JS 最大处理长度（超出只截前 4MB，避免爆内存） */
const MAX_JS_LEN = 4 * 1024 * 1024;

interface CacheFile {
  values: KfKeys;
  fetchedAt: number;
  /** 每个值取自哪个 JS，便于排查 */
  sources: string[];
}

let cache: KfKeys = { ...FALLBACK };
let cacheFile: CacheFile | null = null;
let loaded = false;

function filePath(): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'keys.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as CacheFile;
    if (raw?.values) {
      cacheFile = raw;
      cache = { ...FALLBACK, ...raw.values };
    }
  } catch {
    /* 没缓存就用兜底值 */
  }
}

/** 当前生效的密钥/地址（同步返回，每次请求都可直接调用） */
export function getKeys(): KfKeys {
  load();
  return cache;
}

/**
 * 从 JS 里提取 AES 口令。
 * 写法可能是字面量 `AES.encrypt(x, "secret key 1234")`，
 * 也可能是变量 `var e="secret key 1234", t=AES.encrypt(x, e)`。
 */
function extractAesKey(js: string): string | null {
  const TAG = 'AES.encrypt(';
  let i = js.indexOf(TAG);
  while (i >= 0) {
    // 用括号配对找出这次调用的完整参数（第一参数里可能有嵌套调用）
    let depth = 0;
    let end = i + TAG.length - 1;
    for (; end < js.length; end++) {
      if (js[end] === '(') depth++;
      else if (js[end] === ')' && --depth === 0) break;
    }
    const args = js.slice(i + TAG.length, end);
    const last = (args.split(',').pop() || '').trim();
    if (/^["'][^"']{3,64}["']$/.test(last)) return last.slice(1, -1);
    if (/^[A-Za-z_$][\w$]*$/.test(last)) {
      // 变量形式：往前找最近的赋值语句
      const before = js.slice(Math.max(0, i - 300), i);
      const m = before.match(new RegExp(`(?:^|[^\\w$.])${last}\\s*=\\s*["']([^"']{3,64})["']`));
      if (m) return m[1];
    }
    i = js.indexOf(TAG, i + TAG.length);
  }
  return null;
}

/** 提取客服接口地址 */
function extractApi(js: string): string | null {
  const m = js.match(/["'](https:\/\/api\.kf\.996sdk\.net)["']/);
  return m ? m[1] : null;
}

/** 提取会话记录接口地址（VUE_APP_NEW_CHATROOM_CLIENT_API） */
function extractMgn(js: string): string | null {
  const m =
    js.match(/VUE_APP_NEW_CHATROOM_CLIENT_API:\s*["']([^"']+\/chatroom-clientele)["']/) ||
    js.match(/["'](https:\/\/mgn-api\.kf\.996sdk\.net\/chatroom-clientele)["']/);
  return m ? m[1] : null;
}

/** 带超时的文本下载（失败返回空串，不抛错） */
async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
        Referer: `${CONSOLE_ORIGIN}/`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return '';
    return (await res.text()).slice(0, MAX_JS_LEN);
  } catch {
    return '';
  }
}

/** 属性的值可能带双引号、单引号，也可能不带引号（控制台页面就是不带引号的） */
const attrRe = (name: string) => new RegExp(`<[a-z]+[^>]*\\s${name}=("([^"]+)"|'([^']+)'|([^\\s>]+))`, 'gi');

/** 从 HTML 里取出同站点的 JS 地址（含 <link rel=preload as=script>） */
function scriptUrlsOf(html: string): string[] {
  const urls: string[] = [];
  const push = (raw: string) => {
    try {
      const abs = new URL(raw, `${CONSOLE_ORIGIN}/`);
      if (abs.origin === CONSOLE_ORIGIN && !urls.includes(abs.href)) urls.push(abs.href);
    } catch {
      /* 非法地址忽略 */
    }
  };
  const scan = (re: RegExp, text: string, needAsScript = false) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (needAsScript && !/as=["']?script/i.test(m[0])) continue;
      push(m[2] || m[3] || m[4]);
    }
  };
  scan(attrRe('src'), html);
  scan(attrRe('href'), html, true);
  return urls;
}

/**
 * 从 JS 里找出懒加载的 chunk 地址。
 * webpack runtime 里是 `"chunk-2391caf8":"ebf57af7"` 这种映射，拼出 /static/js/<名>.<hash>.js。
 */
function chunkUrlsOf(js: string, known: Set<string>): string[] {
  const urls: string[] = [];
  const push = (href: string) => {
    if (!known.has(href) && !urls.includes(href)) urls.push(href);
  };
  const mapRe = /["']?([\w-]{3,60})["']?\s*:\s*["']([a-f0-9]{8})["']/g;
  const directRe = /["'((]((?:static\/js\/)?[\w-]+\.[a-f0-9]{8}\.js)["')]/g;
  let m: RegExpExecArray | null;
  while ((m = mapRe.exec(js))) push(`${CONSOLE_ORIGIN}/static/js/${m[1]}.${m[2]}.js`);
  while ((m = directRe.exec(js))) {
    const path = m[2].startsWith('static/') ? m[2] : `static/js/${m[2]}`;
    push(`${CONSOLE_ORIGIN}/${path}`);
  }
  return urls;
}

let running: Promise<KfKeys> | null = null;

/**
 * 立即从控制台 JS 重新提取密钥（并发去重）。
 * 三个值都取到才写缓存；取不全就保留原值。
 */
export function refreshKeys(): Promise<KfKeys> {
  if (running) return running;
  running = (async () => {
    load();
    const html = await fetchText(`${CONSOLE_ORIGIN}/`);
    if (!html) {
      logLine('KEYS_FETCH', { ok: false, reason: '页面拉取失败' });
      return cache;
    }

    const found: Partial<KfKeys> = {};
    const sources: string[] = [];
    const scan = (url: string, js: string) => {
      if (!js) return;
      if (!found.AES_KEY) {
        const v = extractAesKey(js);
        if (v) {
          found.AES_KEY = v;
          sources.push(`AES_KEY@${url}`);
        }
      }
      if (!found.API) {
        const v = extractApi(js);
        if (v) {
          found.API = v;
          sources.push(`API@${url}`);
        }
      }
      if (!found.MGN) {
        const v = extractMgn(js);
        if (v) {
          found.MGN = v;
          sources.push(`MGN@${url}`);
        }
      }
    };
    const done = () => !!found.AES_KEY && !!found.API && !!found.MGN;

    // 1) 先扫 HTML 直接引用的入口 JS
    const entry = scriptUrlsOf(html);
    const seen = new Set(entry);
    const texts: string[] = [];
    for (const url of entry) {
      const js = await fetchText(url);
      texts.push(js);
      scan(url, js);
    }

    // 2) 再从 webpack 映射里补拉懒加载 chunk（AES 口令藏在聊天页 chunk 里）
    const queue: string[] = [];
    for (const js of texts) for (const u of chunkUrlsOf(js, seen)) queue.push(u);
    for (let i = 0; i < queue.length && texts.length < MAX_SCRIPTS && !done(); i++) {
      const js = await fetchText(queue[i]);
      texts.push(js);
      scan(queue[i], js);
      for (const u of chunkUrlsOf(js, seen)) {
        seen.add(u);
        queue.push(u);
      }
    }

    if (!done()) {
      logLine('KEYS_FETCH', { ok: false, reason: '未取全', found: Object.keys(found), scripts: texts.length });
      return cache;
    }

    const values: KfKeys = { API: found.API!, MGN: found.MGN!, AES_KEY: found.AES_KEY! };
    const changed = values.AES_KEY !== cache.AES_KEY || values.API !== cache.API || values.MGN !== cache.MGN;
    cache = values;
    cacheFile = { values, fetchedAt: Date.now(), sources };
    try {
      writeFileSync(filePath(), JSON.stringify(cacheFile, null, 2), 'utf-8');
    } catch {
      /* 写缓存失败不影响本次使用 */
    }
    logLine('KEYS_FETCH', { ok: true, changed, sources });
    return cache;
  })()
    .catch((e: any) => {
      logLine('KEYS_FETCH', { ok: false, reason: String(e?.message || e) });
      return cache;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** 启动时拉一次，之后每 6 小时拉一次 */
export function startKeyRefresh(): void {
  refreshKeys();
  setInterval(() => {
    refreshKeys();
  }, REFRESH_MS);
}
