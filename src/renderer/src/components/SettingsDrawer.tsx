import { useEffect, useState } from 'react';
import { App as AntApp, AutoComplete, Button, Collapse, Drawer, Input, InputNumber, Segmented, Select, Space, Switch, Typography } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, EditOutlined, ExperimentOutlined, ReloadOutlined } from '@ant-design/icons';
import KeywordManager from './KeywordManager';
import type { AiConfig, AiMethod, LearnConfig, NotifyMode, Settings, ThemeMode } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings | null;
  /** 保存设置（写盘后把最新设置回传，用于切主题） */
  onSave: (patch: Partial<Settings>) => Promise<void>;
}

interface TestState {
  loading?: boolean;
  ok?: boolean;
  message?: string;
}

const METHOD_OPTIONS: { label: string; value: AiMethod }[] = [
  { label: 'OpenAI Chat（/chat/completions）', value: 'openai-chat' },
  { label: 'OpenAI Responses（/responses）', value: 'openai-responses' },
  { label: 'Anthropic（/messages）', value: 'anthropic' },
];

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
  { label: '跟随系统', value: 'system' },
];

const NOTIFY_OPTIONS: { label: string; value: NotifyMode }[] = [
  { label: '系统通知', value: 'system' },
  { label: '居中弹窗', value: 'popup' },
  { label: '两者都要', value: 'both' },
];

/** 与主进程 settings.ts 里的 DEFAULT_AI_PROMPT 保持一致 */
const DEFAULT_AI_PROMPT =
  '你是一名专业的在线客服。请根据下面的知识库和聊天记录，用简体中文生成「一条」可以直接发送给访客的回复。' +
  '要求：只输出回复正文，不要加引号、不要加解释、不要输出多余的前后缀。';

/** 24 小时制 HH:mm */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function SettingsDrawer({ open, onClose, settings, onSave }: Props) {
  const { message } = AntApp.useApp();
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [saving, setSaving] = useState(false);
  const [learning, setLearning] = useState(false);
  /** 当前程序版本（设置面板底部显示） */
  const [version, setVersion] = useState('');

  // 每次打开都以最新的已保存设置为准
  useEffect(() => {
    if (open && settings) setDraft(settings);
  }, [open, settings]);

  // 版本号从主进程取（跟随 package.json / 打包版本，不写死）
  useEffect(() => {
    window.kefu?.appVersion?.().then(setVersion).catch(() => {});
  }, []);

  const setAi = (patch: Partial<AiConfig>) => setDraft((d) => (d ? { ...d, ai: { ...d.ai, ...patch } } : d));
  const setLearn = (patch: Partial<LearnConfig>) => setDraft((d) => (d ? { ...d, learn: { ...d.learn, ...patch } } : d));
  /** 关键词规则在弹窗里管理（草稿态，点「保存」才落库） */
  const [keywordOpen, setKeywordOpen] = useState(false);

  const fetchModels = async () => {
    if (!draft) return;
    if (!draft.ai.baseUrl) {
      message.warning('请先填写 baseUrl');
      return;
    }
    setLoadingModels(true);
    try {
      const list = await window.kefu.aiModels(draft.ai);
      setModels(list);
      message.success(list.length ? `获取到 ${list.length} 个模型` : '没有获取到模型');
    } catch (e: any) {
      message.error(e?.message || '获取模型列表失败');
    } finally {
      setLoadingModels(false);
    }
  };

  const runTest = async (model: string) => {
    if (!draft) return;
    if (!model) {
      message.warning('请先填写模型 ID');
      return;
    }
    setTests((t) => ({ ...t, [model]: { loading: true } }));
    try {
      const r = await window.kefu.aiTest(draft.ai, model);
      setTests((t) => ({ ...t, [model]: { ok: r.ok, message: r.message } }));
    } catch (e: any) {
      setTests((t) => ({ ...t, [model]: { ok: false, message: String(e?.message || e) } }));
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    if (draft.learn.enabled && !TIME_RE.test(draft.learn.time)) {
      message.warning('请填写正确的执行时间，格式 HH:mm，例如 23:00');
      return;
    }
    setSaving(true);
    try {
      // 关键词与回复都填了才算有效规则，空行直接丢弃
      const keywords = draft.keywords.filter((k) => k.keywords?.length && k.reply.trim());
      await onSave({
        autoRefresh: draft.autoRefresh,
        autoRelogin: draft.autoRelogin,
        theme: draft.theme,
        ai: draft.ai,
        learn: draft.learn,
        keywords,
        keywordsEnabled: draft.keywordsEnabled,
        notify: draft.notify,
      });
      message.success('设置已保存');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /** 立即学习一次当天记录（结果写入各客服号的知识库） */
  const runLearnNow = async () => {
    setLearning(true);
    try {
      const results = await window.kefu.learnNow();
      if (!results.length) {
        message.info('还没有添加客服号');
        return;
      }
      const detail = results.map((r) => `${r.account}：${r.message}`).join('；');
      if (results.some((r) => !r.ok)) message.error(`学习失败：${detail}`);
      else if (!results.some((r) => r.sessions > 0)) message.info(detail);
      else message.success(`学习完成：${detail}`);
    } catch (e: any) {
      message.error(e?.message || '学习失败');
    } finally {
      setLearning(false);
    }
  };

  return (
    <Drawer
      title="设置"
      placement="left"
      width={480}
      open={open}
      onClose={onClose}
      footer={
        <div style={{ textAlign: 'right' }}>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={saving} onClick={handleSave}>
              保存
            </Button>
          </Space>
        </div>
      }
    >
      {!draft ? null : (
        <>
          <Typography.Text strong>常规</Typography.Text>
          <div className="set-row">
            <div className="set-label">
              掉线后自动续期
              <div className="set-tip">每 5 秒主动检测一次 token；检测到掉线时自动用 GM 凭据换新 token 重新上线，关闭则只在顶部提示手动续期</div>
            </div>
            <Switch checked={draft.autoRefresh} onChange={(v) => setDraft({ ...draft, autoRefresh: v })} />
          </div>
          <div className="set-row">
            <div className="set-label">
              企微掉线自动重新登录
              <div className="set-tip">
                每 5 秒检测一次企微 token；失效时用登录时记住的账号密码自动重登并重连，关闭则需手动点账号上的「重新登录」
              </div>
            </div>
            <Switch
              checked={draft.autoRelogin?.qywx}
              onChange={(v) => setDraft({ ...draft, autoRelogin: { ...draft.autoRelogin, qywx: v } })}
            />
          </div>
          <div className="set-row">
            <div className="set-label">
              权限号掉线自动重新登录
              <div className="set-tip">
                每 5 秒检测一次权限号登录态；失效时用登录时记住的账号密码自动重新登录，关闭则需手动点账号上的「重新登录」
              </div>
            </div>
            <Switch
              checked={draft.autoRelogin?.gmAuth}
              onChange={(v) => setDraft({ ...draft, autoRelogin: { ...draft.autoRelogin, gmAuth: v } })}
            />
          </div>
          <div className="set-row">
            <div className="set-label">
              主题
              <div className="set-tip">黑白天模式，保存后立即生效</div>
            </div>
            <Segmented
              value={draft.theme}
              options={THEME_OPTIONS}
              onChange={(v) => setDraft({ ...draft, theme: v as ThemeMode })}
            />
          </div>

          <div style={{ margin: '20px 0 8px' }}>
            <Typography.Text strong>来信息提醒</Typography.Text>
          </div>

          <div className="set-row">
            <div className="set-label">
              开启提醒
              <div className="set-tip">主窗口不在前台时，来新消息才提醒（正在看着窗口时不打扰）</div>
            </div>
            <Switch
              checked={draft.notify.enabled}
              onChange={(v) => setDraft({ ...draft, notify: { ...draft.notify, enabled: v } })}
            />
          </div>

          <div className="set-row">
            <div className="set-label">
              提醒方式
              <div className="set-tip">
                「居中弹窗」会在屏幕正中间弹出一个置顶窗口，直接带上该会话的聊天记录、快捷回复、关键词推荐和发送框
              </div>
            </div>
            <Segmented
              value={draft.notify.mode}
              disabled={!draft.notify.enabled}
              options={NOTIFY_OPTIONS}
              onChange={(v) => setDraft({ ...draft, notify: { ...draft.notify, mode: v as NotifyMode } })}
            />
          </div>

          {draft.notify.mode !== 'system' && (
            <div className="set-row">
              <div className="set-label">
                弹窗自动关闭
                <div className="set-tip">多少秒后自动关掉弹窗，0 表示一直留着（手动关闭）</div>
              </div>
              <InputNumber
                min={0}
                max={600}
                disabled={!draft.notify.enabled}
                value={draft.notify.autoCloseSec}
                onChange={(v) => setDraft({ ...draft, notify: { ...draft.notify, autoCloseSec: Number(v) || 0 } })}
                addonAfter="秒"
              />
            </div>
          )}

          <div style={{ margin: '20px 0 8px' }}>
            <Typography.Text strong>关键词自动推荐回复</Typography.Text>
          </div>

          <div className="set-row">
            <div className="set-label">
              开启关键词推荐
              <div className="set-tip">
                访客消息命中关键词时，在输入框上方显示推荐回复；点文字填入输入框，点「立即发送」直接发出
              </div>
            </div>
            <Switch checked={draft.keywordsEnabled} onChange={(v) => setDraft({ ...draft, keywordsEnabled: v })} />
          </div>

          <div className="set-row">
            <div className="set-label">
              关键词规则
              <div className="set-tip">已配置 {(draft.keywords || []).length} 条</div>
            </div>
            <Button icon={<EditOutlined />} onClick={() => setKeywordOpen(true)}>
              编辑
            </Button>
          </div>

          <Collapse
            style={{ marginTop: 20 }}
            items={[
              {
                key: 'ai',
                label: '高级（AI 客服 / 每日自动学习）',
                children: (
                  <>
                    <div style={{ margin: '0 0 8px' }}>
                      <Typography.Text strong>AI 客服</Typography.Text>
                    </div>

                    <div className="set-field">
                      <div className="set-tip">请求方法</div>
                      <Select
                        style={{ width: '100%' }}
                        value={draft.ai.method}
                        options={METHOD_OPTIONS}
                        onChange={(v) => setAi({ method: v })}
                      />
                    </div>

                    <div className="set-field">
                      <div className="set-tip">baseUrl（含版本号，如 https://api.openai.com/v1）</div>
                      <Input
                        value={draft.ai.baseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(e) => setAi({ baseUrl: e.target.value })}
                      />
                    </div>

                    <div className="set-field">
                      <div className="set-tip">apiKey</div>
                      <Input.Password
                        value={draft.ai.apiKey}
                        placeholder="sk-..."
                        onChange={(e) => setAi({ apiKey: e.target.value })}
                      />
                    </div>

                    <div className="set-field">
                      <div className="set-tip">模型 ID</div>
                      <Space.Compact style={{ width: '100%' }}>
                        <AutoComplete
                          style={{ flex: 1 }}
                          value={draft.ai.model}
                          placeholder="填或从列表里选，如 gpt-4o-mini"
                          options={models.map((m) => ({ value: m }))}
                          onChange={(v) => setAi({ model: v })}
                          filterOption={(input, opt) => String(opt?.value || '').toLowerCase().includes(input.toLowerCase())}
                        />
                        <Button icon={<ReloadOutlined />} loading={loadingModels} onClick={fetchModels}>
                          获取模型列表
                        </Button>
                      </Space.Compact>
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: 0, marginTop: 4 }}
                        icon={<ExperimentOutlined />}
                        loading={tests[draft.ai.model]?.loading}
                        onClick={() => runTest(draft.ai.model)}
                      >
                        测试当前模型
                      </Button>
                      <TestResult state={tests[draft.ai.model]} />
                    </div>

                    {models.length > 0 && (
                      <div className="set-field">
                        <div className="set-tip">模型列表（点模型名选中，点「测试链接」验证能否回复）</div>
                        <div className="model-list">
                          {models.map((m) => (
                            <div className="model-row" key={m}>
                              <a
                                className={m === draft.ai.model ? 'model-name active' : 'model-name'}
                                onClick={() => setAi({ model: m })}
                              >
                                {m}
                              </a>
                              <Button
                                size="small"
                                type="link"
                                icon={<ExperimentOutlined />}
                                loading={tests[m]?.loading}
                                onClick={() => runTest(m)}
                              >
                                测试链接
                              </Button>
                              <TestResult state={tests[m]} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="set-field">
                      <div className="set-tip">默认提示词（系统提示词，留空则只发送聊天记录与知识库）</div>
                      <Input.TextArea
                        value={draft.ai.prompt}
                        placeholder="你是一名专业的在线客服……"
                        autoSize={{ minRows: 5, maxRows: 12 }}
                        onChange={(e) => setAi({ prompt: e.target.value })}
                      />
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: 0, marginTop: 4 }}
                        onClick={() => setAi({ prompt: DEFAULT_AI_PROMPT })}
                      >
                        恢复默认提示词
                      </Button>
                    </div>

                    <div style={{ margin: '20px 0 8px' }}>
                      <Typography.Text strong>每日自动学习</Typography.Text>
                    </div>

                    <div className="set-row">
                      <div className="set-label">
                        开启每日自动学习
                        <div className="set-tip">到点自动总结当天客服处理，写入各客服号的知识库</div>
                      </div>
                      <Switch checked={draft.learn.enabled} onChange={(v) => setLearn({ enabled: v })} />
                    </div>

                    <div className="set-row">
                      <div className="set-label">
                        执行时间
                        <div className="set-tip">每天在该时间执行，24 小时制，格式 HH:mm</div>
                      </div>
                      <Input
                        style={{ width: 96, textAlign: 'center' }}
                        value={draft.learn.time}
                        placeholder="23:00"
                        maxLength={5}
                        disabled={!draft.learn.enabled}
                        onChange={(e) => setLearn({ time: e.target.value.trim() })}
                      />
                    </div>

                    <div className="set-field">
                      <Button icon={<ExperimentOutlined />} loading={learning} onClick={runLearnNow}>
                        立即学习当天记录
                      </Button>
                      <div className="set-tip" style={{ marginTop: 6 }}>
                        需要先给对应客服号配置知识库目录并配好 AI 模型；本次结果会写入知识库的「自动学习.md」
                      </div>
                    </div>
                  </>
                ),
              },
            ]}
          />

          <KeywordManager
            open={keywordOpen}
            rules={draft.keywords || []}
            onSave={(list) => setDraft((d) => (d ? { ...d, keywords: list } : d))}
            onClose={() => setKeywordOpen(false)}
          />
        </>)}

      <div className="set-version">当前版本 v{version || '—'}</div>
    </Drawer>
  );
}

/** 测试结果：成功绿色 / 失败红色，并显示接口返回的信息 */
function TestResult({ state }: { state?: TestState }) {
  if (!state || state.loading) return null;
  return (
    <div className={`model-test ${state.ok ? 'ok' : 'fail'}`}>
      {state.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
      <span>{state.message}</span>
    </div>
  );
}
