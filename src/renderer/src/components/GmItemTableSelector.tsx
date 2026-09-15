/**
 * 物品 / 装备对照表选择器。
 *
 * 用 Excel（.xls / .xlsx）里的一列 ID + 一列名称，建立「ID ↔ 物品名」对照，
 * 按权限号（accountId）保存；查询时既能按名字搜，也能按 ID 搜。
 *
 * 解析全部在 main 进程做（`xls.ts`），这里只负责选文件 / 选工作表 / 舍弃前几行 /
 * 指定 ID 列与名称列 / 预览 / 保存。
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, FileExcelOutlined, SaveOutlined } from '@ant-design/icons';
import { showApiError } from '../apiError';
import type { GmItemTable, GmItemTables } from '../types';

type Kind = 'item' | 'equip';

const KIND_LABEL: Record<Kind, string> = { item: '物品表', equip: '装备表' };
const PREVIEW_ROWS = 20;

interface Props {
  open: boolean;
  /** 保存到哪个权限号名下 */
  accountId: string;
  /** 该权限号已保存的表（来自 settings） */
  tables: GmItemTables;
  onClose: () => void;
  /** 保存 / 移除成功后通知 App 重新拉设置 */
  onSaved: () => void;
}

/** 取路径里的文件名 */
function baseName(p: string): string {
  return String(p || '').split(/[\\/]/).pop() || p;
}

export default function GmItemTableSelector({ open, accountId, tables, onClose, onSaved }: Props) {
  return (
    <Modal open={open} width={1080} title="物品 / 装备对照表" onCancel={onClose} footer={null}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="选一张表、指定「ID 列」和「物品名列」，保存后即可用名字或 ID 查询"
        description="例：物品表.xls / 装备表.xlsx。表格最上方若有标题行，用「舍弃前几行」跳过。"
      />
      {/* 两列用 minmax(0, 1fr)：预览表格有 scroll.x，默认的 min-width:auto 会被表格内容
          撑宽，选完文件后整个弹窗就往右越撑越大 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
        <TableConfig kind="item" accountId={accountId} saved={tables?.item} onSaved={onSaved} />
        <TableConfig kind="equip" accountId={accountId} saved={tables?.equip} onSaved={onSaved} />
      </div>
    </Modal>
  );
}

/** 单张表的配置卡片：①选文件 → ②选工作表 → ③舍弃前几行 → ④预览选列 → ⑤保存 */
function TableConfig({
  kind,
  accountId,
  saved,
  onSaved,
}: {
  kind: Kind;
  accountId: string;
  saved?: GmItemTable;
  onSaved: () => void;
}) {
  const { message } = AntApp.useApp();
  const [file, setFile] = useState('');
  const [sheet, setSheet] = useState('');
  const [sheets, setSheets] = useState<string[]>([]);
  const [skipRows, setSkipRows] = useState(0);
  const [preview, setPreview] = useState<string[][]>([]);
  const [idCol, setIdCol] = useState<number | null>(null);
  const [nameCol, setNameCol] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 已保存过的配置回填到表单 */
  useEffect(() => {
    if (!saved) return;
    setFile(saved.file);
    setSheet(saved.sheet);
    setSkipRows(saved.skipRows);
    setIdCol(saved.idCol);
    setNameCol(saved.nameCol);
  }, [saved]);

  /** 文件变化 → 拉工作表列表（当前工作表不在新文件里就选第一个） */
  useEffect(() => {
    if (!file) {
      setSheets([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const list = await window.kefu.gmItemTableSheets(file);
        if (!alive) return;
        setSheets(list);
        setSheet((cur) => (cur && list.includes(cur) ? cur : list[0] || ''));
      } catch (e: any) {
        if (alive) {
          showApiError(message, e, '读取工作表失败');
          setSheets([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  /** 文件 / 工作表 / 舍弃行数变化 → 刷新预览 */
  useEffect(() => {
    if (!file || !sheet) {
      setPreview([]);
      return;
    }
    let alive = true;
    void (async () => {
      setLoading(true);
      try {
        const rows = await window.kefu.gmItemTablePreview({ file, sheet, skipRows, limit: PREVIEW_ROWS });
        if (alive) setPreview(rows);
      } catch (e: any) {
        if (alive) {
          showApiError(message, e, '预览失败');
          setPreview([]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, sheet, skipRows]);

  const pickFile = async () => {
    try {
      const f = await window.kefu.gmItemTablePickFile();
      if (!f) return;
      setFile(f);
      setSheet('');
      setSheets([]);
      setIdCol(null);
      setNameCol(null);
      setPreview([]);
    } catch (e: any) {
      showApiError(message, e, '选择文件失败');
    }
  };

  /** 点「ID 列」/「名称列」：同一列被两个角色占用时，把另一角色清掉 */
  const pick = (which: 'id' | 'name', i: number) => {
    if (which === 'id') {
      setIdCol(i);
      if (nameCol === i) setNameCol(null);
    } else {
      setNameCol(i);
      if (idCol === i) setIdCol(null);
    }
  };

  const save = async () => {
    if (!file || !sheet) {
      message.warning('请先选择 Excel 文件和工作表');
      return;
    }
    if (idCol === null || nameCol === null) {
      message.warning('请在预览表头点选「ID 列」和「名称列」');
      return;
    }
    if (idCol === nameCol) {
      message.warning('ID 列和名称列不能是同一列');
      return;
    }
    setSaving(true);
    try {
      const r = await window.kefu.gmItemTableSave({ accountId, kind, file, sheet, idCol, nameCol, skipRows });
      message.success(`${KIND_LABEL[kind]}已保存，共 ${r.count} 条`);
      onSaved();
    } catch (e: any) {
      showApiError(message, e, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await window.kefu.gmItemTableRemove({ accountId, kind });
      message.success(`${KIND_LABEL[kind]}配置已移除`);
      onSaved();
    } catch (e: any) {
      showApiError(message, e, '移除失败');
    }
  };

  /** 预览的表格列：有多少列就画多少列，表头下带「ID 列 / 名称列」选择按钮 */
  const colCount = preview.reduce((n, r) => Math.max(n, r.length), 0);
  const headRow = preview[0] || [];
  const columns = Array.from({ length: colCount }, (_, i) => {
    const isId = idCol === i;
    const isName = nameCol === i;
    return {
      key: String(i),
      dataIndex: String(i),
      width: 130,
      ellipsis: true,
      title: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
          <span style={{ fontWeight: 600 }}>
            第 {i + 1} 列
            {isId ? <Typography.Text type="danger"> · ID</Typography.Text> : null}
            {isName ? <Typography.Text type="success"> · 名称</Typography.Text> : null}
          </span>
          {headRow[i] ? (
            <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
              {headRow[i]}
            </Typography.Text>
          ) : null}
          <Space size={2}>
            <Button size="small" type={isId ? 'primary' : 'default'} onClick={() => pick('id', i)}>
              ID 列
            </Button>
            <Button size="small" type={isName ? 'primary' : 'default'} onClick={() => pick('name', i)}>
              名称列
            </Button>
          </Space>
        </div>
      ),
      render: (v: any) => (v === null || v === undefined || v === '' ? '-' : String(v)),
    };
  });
  const data = preview.map((r, ri) => {
    const o: Record<string, any> = { __k: String(ri) };
    for (let i = 0; i < colCount; i++) o[String(i)] = r[i] ?? '';
    return o;
  });

  return (
    <Card
      size="small"
      title={KIND_LABEL[kind]}
      style={{ minWidth: 0 }}
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } }}
      extra={
        saved ? (
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => void remove()}>
            移除
          </Button>
        ) : null
      }
    >
      {/* 当前已保存的配置 */}
      {saved ? (
        <Alert
          type="success"
          showIcon
          style={{ fontSize: 12 }}
          message={`已保存：${baseName(saved.file)} · ${saved.sheet} · ID 第 ${saved.idCol + 1} 列 · 名称第 ${saved.nameCol + 1} 列 · 舍弃 ${saved.skipRows} 行 · 共 ${saved.count} 条`}
        />
      ) : (
        <Alert type="warning" showIcon style={{ fontSize: 12 }} message={`还没有配置${KIND_LABEL[kind]}`} />
      )}

      {/* ① 选文件 */}
      <Space size={6} wrap>
        <Button size="small" icon={<FileExcelOutlined />} onClick={() => void pickFile()}>
          选择 Excel
        </Button>
        <Tooltip title={file || '未选择文件'}>
          <Typography.Text type={file ? undefined : 'secondary'} style={{ fontSize: 12, maxWidth: 260 }} ellipsis>
            {file ? baseName(file) : '未选择文件'}
          </Typography.Text>
        </Tooltip>
      </Space>

      {/* ② 选工作表 + ③ 舍弃前几行 */}
      <Space size={6} wrap>
        <span style={{ fontSize: 12 }}>工作表</span>
        <Select
          size="small"
          style={{ minWidth: 140 }}
          placeholder="先选文件"
          value={sheet || undefined}
          onChange={(v) => setSheet(v)}
          options={sheets.map((s) => ({ label: s, value: s }))}
          disabled={!sheets.length}
        />
        <span style={{ fontSize: 12 }}>舍弃前</span>
        <InputNumber size="small" min={0} max={50} style={{ width: 70 }} value={skipRows} onChange={(v) => setSkipRows(Number(v) || 0)} />
        <span style={{ fontSize: 12 }}>行</span>
      </Space>

      {/* ④ 预览 + 点选列 */}
      {preview.length ? (
        <>
          <Space size={6} wrap style={{ fontSize: 12 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              ID 列 = 第 {idCol === null ? '—' : idCol + 1} 列 / 名称列 = 第 {nameCol === null ? '—' : nameCol + 1} 列
            </Typography.Text>
          </Space>
          <Table
            size="small"
            bordered
            rowKey="__k"
            dataSource={data}
            columns={columns as any}
            pagination={false}
            loading={loading}
            style={{ minWidth: 0 }}
            scroll={{ x: 'max-content', y: 220 }}
          />
        </>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={loading ? '读取中…' : file && sheet ? '没读到数据，试试调「舍弃前几行」' : '选择 Excel 与工作表后在这里预览'}
          style={{ margin: '12px 0' }}
        />
      )}

      {/* ⑤ 保存 */}
      <div style={{ textAlign: 'right' }}>
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          loading={saving}
          disabled={!file || !sheet || idCol === null || nameCol === null || idCol === nameCol}
          onClick={() => void save()}
        >
          保存{KIND_LABEL[kind]}
        </Button>
      </div>
    </Card>
  );
}
