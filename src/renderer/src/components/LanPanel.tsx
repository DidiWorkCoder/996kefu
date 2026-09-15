import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Button, Checkbox, Divider, Drawer, Dropdown, Empty, Input, Modal, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { previewOf } from './MessageList';
import type {
  Account,
  LanAccountBrief,
  LanConfig,
  LanPeerInfo,
  LanSession,
  LanStatus,
  PendingSession,
  Session,
  SessionBuckets,
  Settings,
} from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  activeAccountId: string;
  buckets: SessionBuckets;
  pending: PendingSession[];
  /** 本机持有的远程会话 */
  lanSessions: LanSession[];
  /** 设置被改动（同步 / 收到推送）后通知外层刷新 */
  onChanged: () => void;
}

const empty = (t: string) => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t} />;

export default function LanPanel({ open, onClose, accounts, activeAccountId, buckets, pending, lanSessions, onChanged }: Props) {
  const { message, modal } = AntApp.useApp();
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [draft, setDraft] = useState<LanConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [newAddr, setNewAddr] = useState('');
  /** 拉取对方提问：选好设备+客服号后弹出的会话选择框 */
  const [pull, setPull] = useState<{ peer: LanPeerInfo; account: LanAccountBrief; list: Session[]; selected: string[] } | null>(
    null,
  );
  /** 推送玩家：选择本机会话 + 目标设备 */
  const [push, setPush] = useState<{ addr: string; sessionId: string }>({ addr: '', sessionId: '' });
  /** 导出数据：关键词 + 指定客服号的快捷回复 */
  const [exportOpen, setExportOpen] = useState(false);
  const [expKeywords, setExpKeywords] = useState(true);
  const [expAccounts, setExpAccounts] = useState<string[]>([]);

  const refresh = async () => {
    const st = (await window.kefu.lanStatus()) as LanStatus;
    setStatus(st);
    setDraft({
      enabled: st.enabled,
      name: st.name,
      port: st.port,
      token: st.token,
      autoDiscover: st.autoDiscover,
      manual: st.manual,
    });
  };

  useEffect(() => {
    if (open) refresh().catch(() => {});
  }, [open]);

  useEffect(() => {
    return window.kefu.onLanStatus((st: LanStatus) => setStatus(st));
  }, []);

  /** 本机可推送的会话（当前客服号的会话 + 待处理） */
  const localSessions = useMemo(() => {
    const all = [...pending, ...buckets.online, ...buckets.queue, ...buckets.end];
    const seen = new Set<string>();
    return all.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [buckets, pending]);

  const saveConfig = async (patch: Partial<LanConfig>) => {
    setBusy(true);
    try {
      const st = (await window.kefu.lanSave(patch)) as LanStatus;
      setStatus(st);
      setDraft((d) => (d ? { ...d, ...patch } : d));
      message.success('已保存');
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const addPeer = async () => {
    const addr = newAddr.trim();
    if (!addr) return;
    try {
      const st = (await window.kefu.lanAddPeer({ addr })) as LanStatus;
      setStatus(st);
      setNewAddr('');
      message.success('已添加，正在尝试连接');
    } catch (e: any) {
      message.error(e?.message || '添加失败');
    }
  };

  const removePeer = (peer: LanPeerInfo) => {
    modal.confirm({
      title: `移除设备 ${peer.name}？`,
      content: '仅从本机列表移除（自动发现的设备仍可能重新出现）。',
      okText: '移除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setStatus((await window.kefu.lanRemovePeer(peer.addr)) as LanStatus);
      },
    });
  };

  /** 同步快捷回复 / 关键词 */
  const sync = async (peer: LanPeerInfo, kind: 'pull' | 'push' | 'pullQuick' | 'pullKeywords') => {
    const kinds = kind === 'pullQuick' ? ['quickReplies'] : kind === 'pullKeywords' ? ['keywords'] : ['quickReplies', 'keywords'];
    setBusy(true);
    try {
      if (kind === 'push') {
        await window.kefu.lanSyncTo(peer.addr, kinds);
        message.success(`已把本机的快捷回复/关键词推送给 ${peer.name}`);
      } else {
        const r = await window.kefu.lanSyncFrom(peer.addr, kinds);
        message.success(`已从 ${peer.name} 同步：快捷回复 ${r.quickReplyAccounts} 个客服号、关键词 ${r.keywords} 条`);
        onChanged();
      }
    } catch (e: any) {
      message.error(e?.message || '同步失败');
    } finally {
      setBusy(false);
    }
  };

  /** 复制到本地（接管）：凭据 + 待处理玩家都搬到本机，之后由本机收发 */
  const copyAccount = (peer: LanPeerInfo, acc: LanAccountBrief) => {
    modal.confirm({
      title: `复制到本地（接管）：${acc.name}`,
      content: '会把该客服号的登录凭据（可自动续期）和它的待处理玩家复制到本机，之后由本机收发；对方那条会掉线。',
      okText: '复制并接管',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await window.kefu.lanCopyAccount(peer.addr, acc.id);
          message.success(`已复制 ${r.account.name}（待处理 ${r.pendingCount} 个）`);
          onChanged();
        } catch (e: any) {
          message.error(e?.message || '复制失败');
          throw e;
        }
      },
    });
  };

  /** 映射到本机（转发）：不复制凭据，看会话/发消息都转发给对方机器，对方不会掉线 */
  const mapAccount = async (peer: LanPeerInfo, acc: LanAccountBrief) => {
    setBusy(true);
    try {
      await window.kefu.lanMapAccount(peer.addr, acc.id);
      message.success(`已把 ${acc.name} 映射到本机（转发模式，实际收发仍在 ${peer.name}）`);
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '映射失败');
    } finally {
      setBusy(false);
    }
  };

  /** 拉取对方的提问：先取会话列表再让用户勾选 */
  const openPull = async (peer: LanPeerInfo, acc: LanAccountBrief) => {
    setBusy(true);
    try {
      const d = await window.kefu.lanRemoteSessions(peer.addr, acc.id);
      const list = [...(d.onlineSessionList || []), ...(d.queueSessionList || []), ...(d.endSessionList || [])];
      if (!list.length) {
        message.info(`${acc.name} 当前没有会话`);
        return;
      }
      setPull({ peer, account: acc, list, selected: [] });
    } catch (e: any) {
      message.error(e?.message || '拉取失败');
    } finally {
      setBusy(false);
    }
  };

  const confirmPull = async () => {
    if (!pull) return;
    if (!pull.selected.length) {
      message.warning('请先勾选要拉过来的会话');
      return;
    }
    setBusy(true);
    try {
      for (const id of pull.selected) {
        const s = pull.list.find((x) => x.id === id);
        if (!s) continue;
        await window.kefu.lanAddRemote({
          addr: pull.peer.addr,
          accountId: pull.account.id,
          accountName: pull.account.name,
          uid: pull.account.uid,
          session: s,
        });
      }
      message.success(`已拉取 ${pull.selected.length} 个会话，回复时会转发到 ${pull.peer.name}`);
      setPull(null);
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '拉取失败');
    } finally {
      setBusy(false);
    }
  };

  /** 把本机会话推送给指定设备 */
  const confirmPush = async () => {
    const peer = status?.peers.find((p) => p.addr === push.addr);
    const s = localSessions.find((x) => x.id === push.sessionId);
    if (!peer || !s) {
      message.warning('请选择设备和会话');
      return;
    }
    const acc = accounts.find((a) => a.id === activeAccountId);
    if (!acc) {
      message.warning('请先选择客服号');
      return;
    }
    setBusy(true);
    try {
      await window.kefu.lanShareSession(peer.addr, acc.id, s);
      message.success(`已推送给 ${peer.name}`);
      setPush({ addr: '', sessionId: '' });
    } catch (e: any) {
      message.error(e?.message || '推送失败');
    } finally {
      setBusy(false);
    }
  };

  /** 导出数据：关键词 + 选中的客服号的快捷回复 */
  const doExport = async () => {
    if (!expKeywords && !expAccounts.length) {
      message.warning('请选择要导出的内容');
      return;
    }
    try {
      const s = (await window.kefu.settings()) as Settings;
      const data: Record<string, unknown> = {
        exportedAt: new Date().toISOString(),
        from: status?.name || '',
      };
      if (expKeywords) data.keywords = s.keywords || [];
      if (expAccounts.length) {
        const qr: Record<string, unknown> = {};
        expAccounts.forEach((id) => {
          qr[id] = s.quickReplies?.[id] || [];
        });
        data.quickReplies = qr;
        data.accountNames = Object.fromEntries(accounts.filter((a) => expAccounts.includes(a.id)).map((a) => [a.id, a.name]));
      }
      const text = JSON.stringify(data, null, 2);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `996kefu-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
      message.success('已导出');
    } catch (e: any) {
      message.error(e?.message || '导出失败');
    }
  };

  const removeRemote = async (it: LanSession) => {
    try {
      await window.kefu.lanRemoveRemote(it.peerId, it.session?.id || '');
      message.success('已移除');
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '移除失败');
    }
  };

  const peers = status?.peers || [];
  const online = peers.filter((p) => p.online);

  return (
    <Drawer title="局域网客服管理" width={760} open={open} onClose={onClose}>
      {!draft || !status ? null : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="同一局域网内、识别码相同的设备会自动发现并互连；可把对方的提问/玩家拉到自己这边，也可以把本机的推送给对方，回复会通过局域网转发到持有账号的那一端真实发送。"
          />

          <div className="lan-row">
            <div className="lan-label">
              启用局域网
              <div className="set-tip">关闭后不再监听端口，也不会连接其它设备</div>
            </div>
            <Switch checked={draft.enabled} onChange={(v) => saveConfig({ enabled: v })} />
          </div>

          <div className="lan-row">
            <div className="lan-label">
              本机名称
              <div className="set-tip">其它设备上显示的名字</div>
            </div>
            <Input
              style={{ width: 200 }}
              value={draft.name}
              placeholder={status.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onBlur={(e) => saveConfig({ name: e.target.value.trim() })}
            />
          </div>

          <div className="lan-row">
            <div className="lan-label">
              监听端口
              <div className="set-tip">两端端口可以不同，改完立即重启服务</div>
            </div>
            <Input
              style={{ width: 120 }}
              value={draft.port}
              onChange={(e) => setDraft({ ...draft, port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
              onBlur={(e) => saveConfig({ port: Number(e.target.value) || draft.port })}
            />
          </div>

          <div className="lan-row">
            <div className="lan-label">
              识别码
              <div className="set-tip">两台机器必须填一样的识别码才会互通，可复制给同事</div>
            </div>
            <Space.Compact>
              <Input
                style={{ width: 200 }}
                value={draft.token}
                onChange={(e) => setDraft({ ...draft, token: e.target.value.trim() })}
                onBlur={(e) => saveConfig({ token: e.target.value.trim() })}
              />
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(draft.token);
                  message.success('识别码已复制');
                }}
              >
                复制
              </Button>
            </Space.Compact>
          </div>

          <div className="lan-row">
            <div className="lan-label">
              自动发现同网段设备
              <div className="set-tip">关掉后只能手动添加地址</div>
            </div>
            <Switch checked={draft.autoDiscover} onChange={(v) => saveConfig({ autoDiscover: v })} />
          </div>

          <Divider titlePlacement="start" plain>
            设备（在线 {online.length} / 共 {peers.length}）
          </Divider>

          <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
            <Input
              value={newAddr}
              placeholder="自动发现不到时手动填：192.168.1.20:17330"
              onChange={(e) => setNewAddr(e.target.value)}
              onPressEnter={addPeer}
            />
            <Button icon={<PlusOutlined />} onClick={addPeer}>
              添加
            </Button>
          </Space.Compact>

          {peers.length === 0 ? (
            empty('还没有发现其它设备')
          ) : (
            <div className="lan-peers">
              {peers.map((p) => (
                <div className={`lan-peer ${p.online ? '' : 'offline'}`} key={p.addr}>
                  <div className="lan-peer-head">
                    <span className={`lan-dot ${p.online ? 'on' : ''}`} />
                    <Typography.Text strong>{p.name}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {p.addr}
                    </Typography.Text>
                    {p.source === 'manual' && <Tag>手动</Tag>}
                    <span style={{ flex: 1 }} />
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removePeer(p)} />
                  </div>

                  <div className="lan-peer-accounts">
                    {p.accounts.length === 0 ? (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        该设备还没有添加客服号
                      </Typography.Text>
                    ) : (
                      p.accounts.map((a) => (
                        <Tag key={a.id} color={a.uid === accounts.find((x) => x.id === activeAccountId)?.uid ? 'blue' : undefined}>
                          {a.name} · {a.account}
                        </Tag>
                      ))
                    )}
                  </div>

                  <Space wrap style={{ marginTop: 8 }}>
                    <Dropdown
                      disabled={!p.online || busy}
                      menu={{
                        items: [
                          { key: 'pull', label: '拉取对方的快捷回复 + 关键词' },
                          { key: 'pullQuick', label: '只拉取快捷回复' },
                          { key: 'pullKeywords', label: '只拉取关键词' },
                          { type: 'divider' },
                          { key: 'push', label: '把本机的推送给对方' },
                        ],
                        onClick: ({ key }) => sync(p, key as any),
                      }}
                    >
                      <Button size="small" icon={<SyncOutlined />}>
                        同步数据
                      </Button>
                    </Dropdown>

                    <Dropdown
                      disabled={!p.online || busy}
                      menu={{
                        items: p.accounts.length
                          ? p.accounts.map((a) => ({
                              key: a.id,
                              label: a.name,
                              children: [
                                { key: `map:${a.id}`, label: '映射到本机（转发，对方不掉线）' },
                                { key: `copy:${a.id}`, label: '复制到本地（接管，对方会掉线）' },
                              ],
                            }))
                          : [{ key: 'none', label: '对方没有客服号', disabled: true }],
                        onClick: ({ key }) => {
                          const [mode, id] = String(key).split(':');
                          const acc = p.accounts.find((a) => a.id === id);
                          if (!acc) return;
                          if (mode === 'map') void mapAccount(p, acc);
                          else copyAccount(p, acc);
                        },
                      }}
                    >
                      <Button size="small" icon={<ImportOutlined />}>
                        获取远端客服
                      </Button>
                    </Dropdown>

                    <Dropdown
                      disabled={!p.online || busy}
                      menu={{
                        items: p.accounts.length
                          ? p.accounts.map((a) => ({ key: a.id, label: `查看 ${a.name} 的提问` }))
                          : [{ key: 'none', label: '对方没有客服号', disabled: true }],
                        onClick: ({ key }) => {
                          const acc = p.accounts.find((a) => a.id === key);
                          if (acc) openPull(p, acc);
                        },
                      }}
                    >
                      <Button size="small" icon={<CloudDownloadOutlined />}>
                        拉取提问
                      </Button>
                    </Dropdown>

                    <Tooltip title={p.online ? '' : '对方离线'}>
                      <Button
                        size="small"
                        icon={<CloudUploadOutlined />}
                        disabled={!p.online || busy || !activeAccountId}
                        onClick={() => setPush({ addr: p.addr, sessionId: '' })}
                      >
                        推送玩家
                      </Button>
                    </Tooltip>
                  </Space>
                </div>
              ))}
            </div>
          )}

          <Divider titlePlacement="start" plain>
            远程会话（{lanSessions.length}）
          </Divider>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            别人推给本机的、或本机从别人那拉过来的会话。点开后可看历史，回复会转发到持有该客服号的设备发出。
          </Typography.Text>

          <div className="lan-remote-list">
            {lanSessions.length === 0
              ? empty('还没有远程会话')
              : lanSessions.map((it) => (
                  <div className="lan-remote-item" key={`${it.peerId}-${it.session?.id}`}>
                    <Tag color={it.from === 'push' ? 'green' : 'blue'}>{it.from === 'push' ? '别人推来' : '我拉来的'}</Tag>
                    <span className="lan-remote-name">{it.session?.visitorName || '(未知访客)'}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {it.peerName} · {it.accountName}
                    </Typography.Text>
                    <span style={{ flex: 1 }} />
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeRemote(it)} />
                  </div>
                ))}
          </div>

          <Divider titlePlacement="start" plain>
            导出数据
          </Divider>
          <Button icon={<ExportOutlined />} onClick={() => setExportOpen(true)}>
            导出关键词 / 快捷回复
          </Button>
        </>
      )}

      {/* 导出数据 */}
      <Modal
        open={exportOpen}
        title="导出数据"
        okText="导出 JSON"
        cancelText="取消"
        destroyOnHidden
        onOk={doExport}
        onCancel={() => setExportOpen(false)}
      >
        <div className="set-field">
          <Checkbox checked={expKeywords} onChange={(e) => setExpKeywords(e.target.checked)}>
            关键词及对应的推荐回复
          </Checkbox>
        </div>
        <div className="set-field">
          <div className="set-tip">选择要一起导出的客服号快捷回复（可多选）</div>
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="选择客服号"
            value={expAccounts}
            options={accounts.map((a) => ({ label: `${a.name} · ${a.account}`, value: a.id }))}
            onChange={setExpAccounts}
          />
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setExpAccounts(accounts.map((a) => a.id))}>
            全选客服号
          </Button>
        </div>
      </Modal>

      {/* 拉取提问：选择要拉过来的会话 */}
      <Modal
        open={!!pull}
        title={`拉取提问 · ${pull?.peer.name || ''} · ${pull?.account.name || ''}`}
        width={640}
        okText={`拉取选中(${pull?.selected.length || 0})`}
        cancelText="取消"
        confirmLoading={busy}
        destroyOnHidden
        onOk={confirmPull}
        onCancel={() => setPull(null)}
      >
        <Checkbox
          style={{ marginBottom: 8 }}
          checked={!!pull?.list.length && pull?.selected.length === pull?.list.length}
          onChange={(e) => setPull((p) => (p ? { ...p, selected: e.target.checked ? p.list.map((s) => s.id) : [] } : p))}
        >
          全选
        </Checkbox>
        <div className="lan-pick-list">
          {pull?.list.map((s) => (
            <label className="lan-pick-item" key={s.id}>
              <Checkbox
                checked={pull.selected.includes(s.id)}
                onChange={() =>
                  setPull((p) =>
                    p
                      ? { ...p, selected: p.selected.includes(s.id) ? p.selected.filter((x) => x !== s.id) : [...p.selected, s.id] }
                      : p,
                  )
                }
              />
              <span className="lan-pick-name">{s.visitorName}</span>
              <span className="lan-pick-last">{previewOf(s.lastMessageContent) || '(无消息)'}</span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {s.messageTime || ''}
              </Typography.Text>
            </label>
          ))}
        </div>
      </Modal>

      {/* 推送玩家 */}
      <Modal
        open={!!push.addr}
        title="推送玩家给对方"
        okText="推送"
        cancelText="取消"
        confirmLoading={busy}
        destroyOnHidden
        onOk={confirmPush}
        onCancel={() => setPush({ addr: '', sessionId: '' })}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`将把该会话（含历史记录）推送给 ${status?.peers.find((p) => p.addr === push.addr)?.name || ''}，对方可以直接查看并回复。`}
        />
        <div className="set-field">
          <div className="set-tip">选择要推送的会话（当前客服号）</div>
          <Select
            style={{ width: '100%' }}
            value={push.sessionId || undefined}
            placeholder="选择会话"
            showSearch
            optionFilterProp="label"
            options={localSessions.map((s) => ({
              value: s.id,
              label: `${s.visitorName}｜${(s.lastMessageContent || '').replace(/<[^>]+>/g, '').slice(0, 30)}`,
            }))}
            onChange={(v) => setPush((p) => ({ ...p, sessionId: v }))}
          />
        </div>
        <div className="set-tip">
          目标设备：{status?.peers.find((p) => p.addr === push.addr)?.name || ''}（
          {accounts.find((a) => a.id === activeAccountId)?.name || '未选择客服号'}）
        </div>
      </Modal>
    </Drawer>
  );
}
