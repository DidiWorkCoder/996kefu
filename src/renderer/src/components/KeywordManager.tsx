import { useState } from 'react';
import { App as AntApp, Button, Checkbox, Empty, Input, Modal, Space, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { KeywordRule } from '../types';

interface Props {
  open: boolean;
  rules: KeywordRule[];
  /** 保存规则列表（设置面板里写回草稿；局域网同步时直接落库） */
  onSave: (list: KeywordRule[]) => Promise<void> | void;
  onClose: () => void;
}

export const newKeywordId = () => `kw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 关键词管理：新增 / 修改 / 删除 / 全选删除，交互与快捷回复管理保持一致 */
export default function KeywordManager({ open, rules, onSave, onClose }: Props) {
  const { message, modal } = AntApp.useApp();
  const [selected, setSelected] = useState<string[]>([]);
  /** 正在编辑的规则（id 为空表示新增） */
  const [editor, setEditor] = useState<{ id: string; keywords: string[]; reply: string } | null>(null);
  /** 关键词输入框里还没回车确认的内容 */
  const [kwDraft, setKwDraft] = useState('');
  const [saving, setSaving] = useState(false);

  /** 打开编辑框（清掉未确认的输入） */
  const openEditor = (v: { id: string; keywords: string[]; reply: string }) => {
    setKwDraft('');
    setEditor(v);
  };

  /** 把输入框内容拆成一个或多个关键词补进当前规则（去掉重复，忽略大小写） */
  const mergeDraft = (base: string[], draft: string) => {
    const parts = draft
      .split(/[,，|]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set(base.map((k) => k.toLowerCase()));
    const add: string[] = [];
    parts.forEach((p) => {
      if (seen.has(p.toLowerCase())) return;
      seen.add(p.toLowerCase());
      add.push(p);
    });
    return add;
  };

  /** 回车 / 失焦 / 逗号：把输入框内容作为一个关键词加进去 */
  const commitKeyword = () => {
    if (!kwDraft.trim()) return;
    setEditor((s) => (s ? { ...s, keywords: [...s.keywords, ...mergeDraft(s.keywords, kwDraft)] } : s));
    setKwDraft('');
  };

  const removeKeyword = (k: string) =>
    setEditor((s) => (s ? { ...s, keywords: s.keywords.filter((x) => x !== k) } : s));

  const close = () => {
    setSelected([]);
    setEditor(null);
    setKwDraft('');
    onClose();
  };

  const save = async (list: KeywordRule[]) => {
    setSaving(true);
    try {
      await onSave(list);
      setSelected((sel) => sel.filter((id) => list.some((it) => it.id === id)));
    } catch (e: any) {
      message.error(e?.message || '保存关键词失败');
    } finally {
      setSaving(false);
    }
  };

  const submitEditor = async () => {
    if (!editor) return;
    // 输入框里还没回车确认的内容也算上，避免点「保存」时被丢掉
    const keywords = [...editor.keywords, ...mergeDraft(editor.keywords, kwDraft)];
    const reply = editor.reply.trim();
    if (!keywords.length) {
      message.warning('请至少输入一个关键词');
      return;
    }
    if (!reply) {
      message.warning('请输入命中后要推荐的回复内容');
      return;
    }
    const list = editor.id
      ? rules.map((it) => (it.id === editor.id ? { ...it, keywords, reply } : it))
      : [...rules, { id: newKeywordId(), keywords, reply }];
    await save(list);
    setEditor(null);
    setKwDraft('');
  };

  const toggle = (id: string) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const removeSelected = () => {
    if (!selected.length) {
      message.warning('请先勾选要删除的关键词');
      return;
    }
    modal.confirm({
      title: `删除选中的 ${selected.length} 条关键词？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await save(rules.filter((it) => !selected.includes(it.id)));
        setSelected([]);
      },
    });
  };

  const removeAll = () => {
    if (!rules.length) return;
    modal.confirm({
      title: `全选删除：将删除全部 ${rules.length} 条关键词？`,
      okText: '全部删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await save([]);
        setSelected([]);
      },
    });
  };

  return (
    <>
      <Modal
        open={open}
        title="关键词自动推荐回复"
        width={640}
        destroyOnHidden
        onCancel={close}
        footer={<Button onClick={close}>关闭</Button>}
      >
        <Space style={{ marginBottom: 8 }} wrap>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={saving}
            onClick={() => openEditor({ id: '', keywords: [], reply: '' })}
          >
            新增
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={saving || !selected.length} onClick={removeSelected}>
            删除选中{selected.length ? `(${selected.length})` : ''}
          </Button>
          <Button size="small" danger disabled={saving || !rules.length} onClick={removeAll}>
            全选删除
          </Button>
        </Space>

        <div className="kw-mgr-list">
          {rules.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有关键词" />
          ) : (
            rules.map((it) => (
              <div className="kw-mgr-item" key={it.id}>
                <Checkbox checked={selected.includes(it.id)} onChange={() => toggle(it.id)} />
                <span className="kw-mgr-tags">
                  {it.keywords.map((k) => (
                    <Tag color="orange" key={k}>
                      {k}
                    </Tag>
                  ))}
                </span>
                <span className="kw-mgr-text">{it.reply}</span>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => openEditor({ id: it.id, keywords: [...it.keywords], reply: it.reply })}
                />
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => save(rules.filter((x) => x.id !== it.id))}
                />
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal
        open={!!editor}
        title={editor?.id ? '编辑关键词' : '新增关键词'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
        onOk={submitEditor}
        onCancel={() => {
          setEditor(null);
          setKwDraft('');
        }}
      >
        <div className="set-field">
          <div className="set-tip">关键词：输入后按回车成为一个，可加多个；命中任意一个即推荐（英文不区分大小写）</div>
          <div className="kw-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
            {editor?.keywords.map((k) => (
              <Tag key={k} color="orange" closable onClose={() => removeKeyword(k)}>
                {k}
              </Tag>
            ))}
            <Input
              variant="borderless"
              value={kwDraft}
              placeholder={editor?.keywords.length ? '' : '输入关键词后按回车'}
              onChange={(e) => setKwDraft(e.target.value)}
              onPressEnter={commitKeyword}
              onBlur={commitKeyword}
            />
          </div>
        </div>
        <div className="set-field">
          <div className="set-tip">推荐的回复内容</div>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 8 }}
            maxLength={500}
            showCount
            value={editor?.reply || ''}
            placeholder="命中后推荐给客服的回复"
            onChange={(e) => setEditor((s) => (s ? { ...s, reply: e.target.value } : s))}
          />
        </div>
      </Modal>
    </>
  );
}
