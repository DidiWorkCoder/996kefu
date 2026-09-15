import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ai from './ai';
import * as api from './api';
import { logLine } from './logger';
import { getSettings, knowledgeDirOf } from './settings';
import { listAccounts, type Account } from './store';

/** 学习总结用的系统提示词（固定，与「AI 回复」的默认提示词无关） */
const LEARN_PROMPT =
  '你是一名资深客服主管。请阅读下面客服与访客的聊天记录，提炼对以后回答客人有帮助的知识点。' +
  '要求：用简体中文、Markdown 分条输出；每条写成「访客问题」+「建议回答 / 注意事项」；' +
  '只写与聊天记录相关的内容，不要复述寒暄，不要输出多余的解释。';

/** 一次学习最多处理的会话数 / 喂给 AI 的最大字符数 */
const MAX_SESSIONS = 20;
const MAX_CHARS = 12_000;
/** 知识库里的学习文件超过这个长度时，只保留最近的部分 */
const MAX_FILE_CHARS = 20_000;
/** 学习结果写进知识库目录下的这个文件 */
const LEARN_FILE = '自动学习.md';

export interface LearnResult {
  accountId: string;
  account: string;
  /** 参与学习的会话数 */
  sessions: number;
  ok: boolean;
  /** 失败原因或说明 */
  message: string;
}

export interface LearnOptions {
  /** 出错时尝试恢复（掉线则续期），返回可重试的账号；无法恢复则抛错 */
  recover?: (acc: Account, err: unknown) => Promise<Account>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 今天的日期串 YYYY-MM-DD（本地时区） */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** unix 秒 -> HH:mm */
function hhmm(unixSec?: number): string {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 消息内容转纯文本（媒体消息转占位符，并还原常见 HTML 实体） */
function toPlain(content: string): string {
  const c = content || '';
  if (/<img/i.test(c)) return '[图片]';
  if (/<video/i.test(c)) return '[视频]';
  if (/<a\s/i.test(c)) return '[文件]';
  return c
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** 出错时先尝试恢复（续期）再重试一次 */
async function withRetry<T>(acc: Account, opt: LearnOptions, fn: (a: Account) => Promise<T>): Promise<T> {
  try {
    return await fn(acc);
  } catch (e) {
    if (!opt.recover) throw e;
    return fn(await opt.recover(acc, e));
  }
}

/** 学习单个客服号当天的客服处理，写入其知识库目录 */
async function learnAccount(acc: Account, day: string, opt: LearnOptions): Promise<LearnResult> {
  const base = { accountId: acc.id, account: acc.name };
  const dir = knowledgeDirOf(acc.id);
  if (!dir) return { ...base, sessions: 0, ok: true, message: '未配置知识库目录' };

  const cfg = getSettings().ai;
  if (!cfg.model) return { ...base, sessions: 0, ok: true, message: '未配置 AI 模型' };

  // 当天有客服回复过的会话记录
  const listRecords = (a: Account) =>
    api
      .recordPage(a, {
        pageNum: 1,
        pageSize: 50,
        visitorEnterStartTime: `${day} 00:00:00`,
        visitorEnterEndTime: `${day} 23:59:59`,
      })
      .then((d) => (d?.records || []).filter((r: any) => r?.messageSessionId && Number(r?.customerServiceMsgNum || 0) > 0));

  const records = await withRetry(acc, opt, listRecords);

  const sections: string[] = [];
  let total = 0;
  let used = 0;
  for (const r of records.slice(0, MAX_SESSIONS)) {
    if (total >= MAX_CHARS) break;
    let msgs: any[] = [];
    try {
      const d = await withRetry(acc, opt, (a) =>
        api.queryMessageList(a, { messageSessionId: r.messageSessionId, pageNum: 1, pageSize: 200 }),
      );
      msgs = (d?.records || []).slice().reverse();
    } catch {
      continue; // 单个会话拉取失败不影响整体
    }
    const lines = msgs
      .filter((m) => m?.recallMsg !== 1)
      .map((m) => {
        const text = toPlain(String(m?.content || ''));
        return text ? `${String(m?.messageFromId) === String(acc.uid) ? '客服' : '访客'}：${text}` : '';
      })
      .filter(Boolean);
    if (!lines.length) continue;
    const body = lines.join('\n').slice(0, MAX_CHARS - total);
    sections.push(`### 访客：${r.visitorName || '未知'}（时段 ${hhmm(r.sessionStartTime)}）\n${body}`);
    total += body.length;
    used++;
  }

  if (!sections.length) return { ...base, sessions: 0, ok: true, message: '今天没有客服处理过的对话' };

  const md = await withRetry(acc, opt, () =>
    ai.chat(cfg, {
      system: LEARN_PROMPT,
      messages: [{ role: 'user', content: `日期：${day}\n\n${sections.join('\n\n')}` }],
      maxTokens: 2048,
    }),
  );
  if (!md) return { ...base, sessions: used, ok: false, message: 'AI 没有返回内容' };

  const file = join(dir, LEARN_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let old = '';
  try {
    old = readFileSync(file, 'utf-8');
  } catch {
    /* 首次学习 */
  }
  const section = `${old ? '\n\n' : ''}## 自动学习 ${day}（${used} 个会话）\n${md}\n`;
  let next = old + section;
  if (next.length > MAX_FILE_CHARS) next = next.slice(next.length - MAX_FILE_CHARS);
  writeFileSync(file, next, 'utf-8');

  return { ...base, sessions: used, ok: true, message: `已学习 ${used} 个会话` };
}

/** 学习所有客服号当天的客服处理，写入各自的知识库 */
export async function runDailyLearn(opt: LearnOptions = {}): Promise<LearnResult[]> {
  // 权限号（gmAuth）是只读查询号，没有客服会话，不参与每日学习
  const accounts = listAccounts().filter((a) => a.kind !== 'gmAuth');
  if (!accounts.length) return [];
  const day = today();
  const results: LearnResult[] = [];
  for (const acc of accounts) {
    try {
      results.push(await learnAccount(acc, day, opt));
    } catch (e: any) {
      results.push({ accountId: acc.id, account: acc.name, sessions: 0, ok: false, message: String(e?.message || e) });
    }
  }
  logLine('LEARN', { day, results });
  return results;
}
