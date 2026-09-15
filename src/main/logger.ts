import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 日志目录：userData/logs */
export function logDir(): string {
  const dir = join(app.getPath('userData'), 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function todayFile(): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(logDir(), `api-${day}.log`);
}

/** 追加一行日志（失败不影响业务） */
export function logLine(tag: string, payload?: unknown): void {
  try {
    const text = payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
    appendFileSync(todayFile(), `[${new Date().toISOString()}] [${tag}] ${text}\n`, 'utf-8');
  } catch {
    /* ignore */
  }
}

/** 截断过长的字符串，避免日志爆炸 */
export function truncate(v: unknown, max = 2000): unknown {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `…(+${v.length - max})` : v;
  if (v && typeof v === 'object') {
    try {
      const s = JSON.stringify(v);
      return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : v;
    } catch {
      return v;
    }
  }
  return v;
}
