import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { logLine, truncate } from './logger';
import type { AiConfig, AiMethod } from './settings';

/** 单次请求超时 */
const TIMEOUT = 60_000;
/** 知识库可读取的文本类后缀 */
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yml', '.yaml', '.ini', '.conf']);
/** 递归时跳过的目录 */
const SKIP_DIR = /^(node_modules|\.git|\$RECYCLE\.BIN|System Volume Information)$/i;
/** 单个文件最大读取体积 */
const MAX_FILE = 1024 * 1024;
/** 知识库整体最大字符数（超出截断，避免吃光上下文） */
const MAX_TOTAL = 20_000;

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 拼接 baseUrl（去掉尾部斜杠）与接口路径 */
const joinUrl = (base: string, path: string) => `${(base || '').trim().replace(/\/+$/, '')}${path}`;

function authHeaders(method: AiMethod, apiKey: string): Record<string, string> {
  if (method === 'anthropic') {
    return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

async function httpJson(url: string, init: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || json?.msg || `HTTP ${res.status}`;
      throw new Error(String(msg));
    }
    return json;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('请求超时（60s）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 相邻同角色合并；Anthropic 要求首条必须是 user */
function normalizeMessages(list: AiMessage[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const m of list || []) {
    const text = String(m?.content ?? '').trim();
    if (!text) continue;
    const role: AiMessage['role'] = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function buildSystem(prompt: string, knowledge: string, visitorName?: string): string {
  const parts: string[] = [];
  const head = (prompt || '').trim();
  if (head) parts.push(head);
  if (visitorName) parts.push(`访客昵称：${visitorName}`);
  if (knowledge) parts.push(`知识库内容（优先按此作答）：\n${knowledge}`);
  return parts.join('\n\n');
}

/** 递归读取知识库目录下的文本文件，超长截断 */
export function readKnowledge(dir: string): string {
  if (!dir || !existsSync(dir)) return '';
  const chunks: string[] = [];
  let total = 0;
  const walk = (d: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      if (total >= MAX_TOTAL) return;
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.test(name)) walk(p);
        continue;
      }
      if (!TEXT_EXT.has(extname(name).toLowerCase()) || st.size > MAX_FILE) continue;
      try {
        const piece = `\n\n### 文件：${p}\n${readFileSync(p, 'utf-8')}`;
        const left = MAX_TOTAL - total;
        const sliced = piece.slice(0, left);
        chunks.push(sliced);
        total += sliced.length;
      } catch {
        /* 单个文件读取失败忽略 */
      }
    }
  };
  walk(dir);
  return chunks.join('').trim();
}

/** 各协议的模型列表接口 */
export async function listModels(cfg: AiConfig): Promise<string[]> {
  if (!cfg.baseUrl) throw new Error('请先填写 baseUrl');
  const j = await httpJson(joinUrl(cfg.baseUrl, '/models'), { method: 'GET', headers: authHeaders(cfg.method, cfg.apiKey) });
  const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  return arr
    .map((m) => String(m?.id ?? m?.name ?? ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** 按配置的协议发一次对话请求，返回模型输出的纯文本（system 为空则不发送 system） */
export async function chat(
  cfg: AiConfig,
  p: { system?: string; messages: AiMessage[]; maxTokens?: number },
): Promise<string> {
  if (!cfg.baseUrl) throw new Error('请先在设置里配置 AI 的 baseUrl');
  if (!cfg.model) throw new Error('请先在设置里选择模型 ID');

  const messages = normalizeMessages(p.messages || []);
  if (!messages.length) throw new Error('没有可用于生成的聊天记录');
  const system = (p.system || '').trim();
  const headers = authHeaders(cfg.method, cfg.apiKey);

  if (cfg.method === 'anthropic') {
    const j = await httpJson(joinUrl(cfg.baseUrl, '/messages'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: p.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages,
      }),
    });
    const text = Array.isArray(j?.content) ? j.content.map((c: any) => c?.text || '').join('') : '';
    return text.trim();
  }

  if (cfg.method === 'openai-responses') {
    const j = await httpJson(joinUrl(cfg.baseUrl, '/responses'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, ...(system ? { instructions: system } : {}), input: messages }),
    });
    if (typeof j?.output_text === 'string' && j.output_text.trim()) return j.output_text.trim();
    const text = Array.isArray(j?.output)
      ? j.output
          .flatMap((o: any) => o?.content || [])
          .map((c: any) => c?.text || '')
          .join('')
      : '';
    return text.trim();
  }

  // openai-chat
  const j = await httpJson(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    }),
  });
  const content = j?.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text || '').join('') : '';
  return text.trim();
}

/** 调一次 AI 生成回复正文（system 由「默认提示词 + 知识库 + 访客昵称」组成） */
export async function generateReply(
  cfg: AiConfig,
  p: { messages: AiMessage[]; knowledge?: string; visitorName?: string; maxTokens?: number },
): Promise<string> {
  return chat(cfg, {
    system: buildSystem(cfg.prompt, p.knowledge || '', p.visitorName),
    messages: p.messages || [],
    maxTokens: p.maxTokens ?? 1024,
  });
}

/** 测试某个模型是否可用（真的发一条消息看有没有回复） */
export async function testModel(cfg: AiConfig, model?: string): Promise<{ ok: boolean; message: string }> {
  const use: AiConfig = { ...cfg, model: model || cfg.model };
  if (!use.model) return { ok: false, message: '请先填写模型 ID' };
  try {
    const text = await generateReply(use, { messages: [{ role: 'user', content: '你好' }], maxTokens: 64 });
    logLine('AI_TEST', { model: use.model, method: use.method, ok: true, reply: truncate(text, 200) });
    return text ? { ok: true, message: `成功：${text.slice(0, 80)}` } : { ok: false, message: '接口通了但模型没返回内容' };
  } catch (e: any) {
    const msg = String(e?.message || e);
    logLine('AI_TEST', { model: use.model, method: use.method, ok: false, err: msg });
    return { ok: false, message: msg };
  }
}
