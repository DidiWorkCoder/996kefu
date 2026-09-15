import { useState } from 'react';
import { App as AntApp, Button, Checkbox, Empty, Input, Modal, Space, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import type { QuickReply } from '../types';

interface Props {
  /** 当前客服号的快捷回复（每个客服号独立存储） */
  items: QuickReply[];
  /** 保存当前客服号的快捷回复列表 */
  onSave: (list: QuickReply[]) => Promise<void> | void;
  /** 点击某条快捷回复 -> 填入输入框 */
  onPick: (content: string) => void;
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function QuickReplyPanel({ items, onSave, onPick }: Props) {
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="quick-col">
      <div className="quick-header">
        <Typography.Text strong>快捷回复</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {items.length} 条
        </Typography.Text>
      </div>

      <div className="quick-list">
        {items.length === 0 ? (
          <div className="center-tip">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有快捷回复" />
          </div>
        ) : (
          items.map((it) => (
            <div className="quick-item" key={it.id} title={it.content} onClick={() => onPick(it.content)}>
              <div className="quick-text">{it.content}</div>
            </div>
          ))
        )}
      </div>

      <div className="quick-footer">
        <Button block icon={<EditOutlined />} onClick={() => setManageOpen(true)}>
          编辑
        </Button>
      </div>

      <QuickReplyManager
        open={manageOpen}
        items={items}
        onSave={onSave}
        onClose={() => setManageOpen(false)}
      />
    </div>
  );
}

/** 快捷回复管理面板：新增 / 修改 / 删除 / 全选删除 */
function QuickReplyManager({
  open,
  items,
  onSave,
  onClose,
}: {
  open: boolean;
  items: QuickReply[];
  onSave: Props['onSave'];
  onClose: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const [selected, setSelected] = useState<string[]>([]);
  /** 正在编辑的条目（id 为空表示新增） */
  const [editor, setEditor] = useState<{ id: string; content: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    setSelected([]);
    setEditor(null);
    onClose();
  };

  const save = async (list: QuickReply[]) => {
    setSaving(true);
    try {
      await onSave(list);
      setSelected((sel) => sel.filter((id) => list.some((it) => it.id === id)));
    } catch (e: any) {
      message.error(e?.message || '保存快捷回复失败');
    } finally {
      setSaving(false);
    }
  };

  const submitEditor = async () => {
    if (!editor) return;
    const content = editor.content.trim();
    if (!content) {
      message.warning('请输入快捷回复内容');
      return;
    }
    const list = editor.id
      ? items.map((it) => (it.id === editor.id ? { ...it, content } : it))
      : [...items, { id: newId(), content }];
    await save(list);
    setEditor(null);
  };

  const toggle = (id: string) =>
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const removeSelected = () => {
    if (!selected.length) {
      message.warning('请先勾选要删除的快捷回复');
      return;
    }
    modal.confirm({
      title: `删除选中的 ${selected.length} 条快捷回复？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await save(items.filter((it) => !selected.includes(it.id)));
        setSelected([]);
      },
    });
  };

  const removeAll = () => {
    if (!items.length) return;
    modal.confirm({
      title: `全选删除：将删除该客服号的全部 ${items.length} 条快捷回复？`,
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
        title="快捷回复管理"
        width={520}
        destroyOnHidden
        onCancel={close}
        footer={<Button onClick={close}>关闭</Button>}
      >
        <Space style={{ marginBottom: 8 }} wrap>
          <Button size="small" type="primary" icon={<PlusOutlined />} disabled={saving} onClick={() => setEditor({ id: '', content: '' })}>
            新增
          </Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={saving || !selected.length} onClick={removeSelected}>
            删除选中{selected.length ? `(${selected.length})` : ''}
          </Button>
          <Button size="small" danger disabled={saving || !items.length} onClick={removeAll}>
            全选删除
          </Button>
        </Space>

        <div className="quick-mgr-list">
          {items.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有快捷回复" />
          ) : (
            items.map((it) => (
              <div className="quick-mgr-item" key={it.id}>
                <Checkbox checked={selected.includes(it.id)} onChange={() => toggle(it.id)} />
                <span className="quick-mgr-text">{it.content}</span>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => setEditor({ id: it.id, content: it.content })}
                />
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => save(items.filter((x) => x.id !== it.id))}
                />
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal
        open={!!editor}
        title={editor?.id ? '编辑快捷回复' : '新增快捷回复'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        destroyOnHidden
        onOk={submitEditor}
        onCancel={() => setEditor(null)}
      >
        <Input.TextArea
          autoSize={{ minRows: 3, maxRows: 8 }}
          maxLength={500}
          showCount
          value={editor?.content || ''}
          placeholder="请输入快捷回复内容"
          onChange={(e) => setEditor((s) => (s ? { ...s, content: e.target.value } : s))}
        />
      </Modal>
    </>
  );
}
