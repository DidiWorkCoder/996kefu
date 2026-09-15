import { useState } from 'react';
import { Avatar, Badge, Button, Dropdown, Empty, Input, Modal, Popconfirm, Space, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FolderOutlined,
  PictureOutlined,
  PlusOutlined,
  RightOutlined,
  SettingOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { Account, AccountGroup, AccountProfile, LanAccount } from '../types';

interface Props {
  accounts: Account[];
  activeId: string;
  /** accountId -> 未读消息数（>0 时头像上显示红点 + 条数） */
  unread: Record<string, number>;
  adding?: boolean;
  /** accountId -> 知识库目录（用于显示是否已配置） */
  knowledge: Record<string, string>;
  /** accountId -> 自定义头像 / 昵称（右键账号修改） */
  profiles: Record<string, AccountProfile>;
  /** 账号分组（左侧按组展示） */
  groups: AccountGroup[];
  /** 保存分组（新建 / 重命名 / 删除 / 把账号归组都走这里） */
  onSaveGroups: (groups: AccountGroup[]) => void;
  /** 已收起的分组 id */
  collapsed: string[];
  /** 保存收起状态 */
  onSaveCollapsed: (ids: string[]) => void;
  /** 保存头像 / 昵称（字段传空串 = 恢复默认） */
  onSetProfile: (id: string, patch: AccountProfile) => void;
  /** 选择头像图片并保存 */
  onPickAvatar: (id: string) => void;
  /** 从局域网映射过来的远端客服 */
  mapped: LanAccount[];
  /** 当前选中的远端客服 key（addr|accountId），没选中为空 */
  activeMappedKey: string;
  onSelectMapped: (a: LanAccount) => void;
  onRemoveMapped: (a: LanAccount) => void;
  onSelect: (id: string) => void;
  /** 新增 → 客服登录（996）：弹窗里再选具体登录方式 */
  onAddKf: () => void;
  /** 新增 → 企微客服登录 */
  onAddQywx: () => void;
  /** 新增 → 权限号登录（996 只读查询号） */
  onAddAuth: () => void;
  /** 分组右键 → 绑定游戏（分组 = 一个游戏） */
  onBindGroupGame: (groupId: string) => void;
  /** 账号右键 → 绑定游戏（该账号还没分组时自动建组再绑） */
  onBindAccountGame: (accountId: string) => void;
  /** 用已保存的 GM 凭据续期 */
  onRefresh: (id: string) => void;
  /** 打开该客服号的知识库配置 */
  onKnowledge: (id: string) => void;
  onRemove: (id: string) => void;
  /** 打开全局设置面板 */
  onOpenSettings: () => void;
}

export default function AccountSider({
  accounts,
  activeId,
  unread,
  adding,
  knowledge,
  profiles,
  groups,
  onSaveGroups,
  collapsed,
  onSaveCollapsed,
  onSetProfile,
  onPickAvatar,
  mapped,
  activeMappedKey,
  onSelectMapped,
  onRemoveMapped,
  onSelect,
  onAddKf,
  onAddQywx,
  onAddAuth,
  onBindGroupGame,
  onBindAccountGame,
  onRefresh,
  onKnowledge,
  onRemove,
  onOpenSettings,
}: Props) {
  /** 正在改昵称的账号（非空则弹出输入框） */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** 正在新建 / 重命名分组（id 为空 = 新建） */
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string } | null>(null);

  /** 该分组是否已收起 */
  const isCollapsed = (id: string) => collapsed.includes(id);

  /** 展开 / 收起分组 */
  const toggleGroup = (id: string) => {
    onSaveCollapsed(isCollapsed(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id]);
  };

  /** 保存昵称（留空则恢复默认） */
  const saveRename = () => {
    if (renaming) onSetProfile(renaming.id, { name: renaming.name.trim() });
    setRenaming(null);
  };

  /** 保存分组（新建 / 重命名） */
  const saveGroup = () => {
    const name = (editingGroup?.name || '').trim();
    if (!editingGroup || !name) {
      setEditingGroup(null);
      return;
    }
    if (editingGroup.id) onSaveGroups(groups.map((g) => (g.id === editingGroup.id ? { ...g, name } : g)));
    else onSaveGroups([...groups, { id: `grp-${Date.now().toString(36)}`, name, accountIds: [] }]);
    setEditingGroup(null);
  };

  /** 把某个账号归到指定分组（groupId 为空 = 移出分组） */
  const assignGroup = (accountId: string, groupId: string) => {
    const next = groups.map((g) => ({ ...g, accountIds: g.accountIds.filter((id) => id !== accountId) }));
    if (groupId) {
      const i = next.findIndex((g) => g.id === groupId);
      if (i >= 0) next[i] = { ...next[i], accountIds: [...next[i].accountIds, accountId] };
    }
    onSaveGroups(next);
  };

  /** 新增账号：先选要接入哪套系统 */
  const addMenu = {
    items: [
      { key: 'kf', label: '客服登录' },
      { key: 'qywx', label: '企微客服登录' },
      { key: 'auth', label: '权限号登录' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'kf') onAddKf();
      else if (key === 'qywx') onAddQywx();
      else if (key === 'auth') onAddAuth();
    },
  };

  /** 单个账号条目 */
  const renderAccount = (a: Account, inGroup: boolean) => {
    const profile: AccountProfile = profiles[a.id] || {};
    const qywx = a.kind === 'qywx';
    const gmAuth = a.kind === 'gmAuth';
    /** 该账号当前所在分组（绑定游戏挂在分组上） */
    const group = groups.find((g) => g.accountIds.includes(a.id)) || null;
    const groupId = group?.id || '';
    /** 右键菜单：改头像 / 改昵称 / 归组 / 绑定游戏 */
    const profileMenu = {
      items: [
        { key: 'avatar', label: '上传头像', icon: <PictureOutlined /> },
        ...(profile.avatar ? [{ key: 'avatar-clear', label: '移除头像' }] : []),
        { key: 'rename', label: '修改昵称', icon: <EditOutlined /> },
        ...(profile.name ? [{ key: 'rename-clear', label: '恢复默认昵称' }] : []),
        {
          key: 'group',
          label: '加入分组',
          children: [
            ...groups.map((g) => ({ key: `g:${g.id}`, label: g.name })),
            ...(groupId ? [{ key: 'g:', label: '移出分组' }] : []),
          ],
        },
        { type: 'divider' as const },
        {
          key: 'game',
          label: group?.gameName ? `游戏：${group.gameName}（${group.gameId}）` : '绑定游戏',
          icon: <SettingOutlined />,
        },
      ],
      onClick: ({ key, domEvent }: { key: string; domEvent: { stopPropagation: () => void } }) => {
        domEvent.stopPropagation();
        if (key === 'avatar') onPickAvatar(a.id);
        else if (key === 'avatar-clear') onSetProfile(a.id, { avatar: '' });
        else if (key === 'rename') setRenaming({ id: a.id, name: profile.name || a.name || '' });
        else if (key === 'rename-clear') onSetProfile(a.id, { name: '' });
        else if (key === 'game') onBindAccountGame(a.id);
        else if (key.startsWith('g:')) assignGroup(a.id, key.slice(2));
      },
    };
    return (
      <Dropdown key={a.id} trigger={['contextMenu']} menu={profileMenu}>
        <div
          className={`account-item ${inGroup ? 'in-group' : ''} ${a.id === activeId ? 'active' : ''}`}
          title="右键可修改头像、昵称、加入分组或绑定游戏"
          onClick={() => onSelect(a.id)}
        >
          <Badge count={unread[a.id] || 0} size="small" offset={[-2, 2]}>
            <Avatar
              src={profile.avatar || undefined}
              style={{ background: qywx ? '#07c160' : gmAuth ? '#fa8c16' : '#1677ff', flex: '0 0 auto' }}
            >
              {(profile.name || a.name || a.account || '?').slice(0, 1)}
            </Avatar>
          </Badge>
          <div className="account-meta">
            <div className="account-name">
              {profile.name || a.name}
              {qywx && <span className="account-kind">企微</span>}
              {gmAuth && <span className="account-kind">权限</span>}
            </div>
            <div className="account-sub">
              {qywx
                ? `${a.serverUrl || ''} · ${a.account}`
                : gmAuth
                  ? `${a.account} · 权限号`
                  : `${a.account} · ID ${a.uid}`}
            </div>
          </div>
          <Tooltip
            title={
              qywx
                ? '重新登录（用保存的账号密码换新 token）'
                : gmAuth
                  ? '重新登录（用保存的账号密码换新凭据）'
                  : a.juheToken
                    ? '续期（重新换 token 上线）'
                    : '缺少 GM 凭据，请先执行「登录脚本」'
            }
          >
            <Button
              type="text"
              size="small"
              icon={<SyncOutlined />}
              disabled={adding}
              onClick={(e) => {
                e.stopPropagation();
                onRefresh(a.id);
              }}
            />
          </Tooltip>
          <Popconfirm title="删除该账号？" okText="删除" cancelText="取消" onConfirm={() => onRemove(a.id)}>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
          {!qywx && !gmAuth && (
            <Tooltip title={knowledge[a.id] ? `知识库：${knowledge[a.id]}` : '配置知识库文件夹'}>
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined style={knowledge[a.id] ? { color: '#52c41a' } : undefined} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onKnowledge(a.id);
                }}
              />
            </Tooltip>
          )}
        </div>
      </Dropdown>
    );
  };

  /** 未归到任何分组的账号 */
  const ungrouped = accounts.filter((a) => !groups.some((g) => g.accountIds.includes(a.id)));

  return (
    <div className="sider">
      <div className="sider-header">
        <Typography.Text strong>账号列表</Typography.Text>
        <Space size={4}>
          <Dropdown menu={addMenu} trigger={['click']} disabled={adding}>
            <Button type="primary" size="small" icon={<PlusOutlined />} loading={adding}>
              新增 <DownOutlined style={{ fontSize: 10 }} />
            </Button>
          </Dropdown>
          <Tooltip title="新建分组">
            <Button size="small" icon={<FolderOutlined />} onClick={() => setEditingGroup({ id: '', name: '' })} />
          </Tooltip>
        </Space>
      </div>
      <div className="sider-list">
        {accounts.length === 0 ? (
          <Empty
            style={{ marginTop: 48 }}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="还没有账号，点上面的「新增」登录"
          />
        ) : (
          <>
            {groups.map((g) => {
              const members = accounts.filter((a) => g.accountIds.includes(a.id));
              const folded = isCollapsed(g.id);
              return (
                <div key={g.id}>
                  <Dropdown
                    trigger={['contextMenu']}
                    menu={{
                      items: [
                        {
                          key: 'game',
                          label: g.gameName ? `游戏：${g.gameName}（${g.gameId}）` : '绑定游戏',
                          icon: <SettingOutlined />,
                        },
                        { key: 'rename', label: '重命名分组', icon: <EditOutlined /> },
                        { key: 'delete', label: '删除分组', danger: true, icon: <DeleteOutlined /> },
                      ],
                      onClick: ({ key, domEvent }: { key: string; domEvent: { stopPropagation: () => void } }) => {
                        domEvent.stopPropagation();
                        if (key === 'game') onBindGroupGame(g.id);
                        else if (key === 'rename') setEditingGroup({ id: g.id, name: g.name });
                        // 删除分组只是取消归组，账号本身不动
                        else onSaveGroups(groups.filter((x) => x.id !== g.id));
                      },
                    }}
                  >
                    <div
                      className="sider-group sider-group-row"
                      title="点击展开 / 收起，右键可重命名或删除分组"
                      onClick={() => toggleGroup(g.id)}
                    >
                      <span className="sider-group-title">
                        {folded ? <RightOutlined /> : <DownOutlined />}
                        <span>{g.name}</span>
                      </span>
                      <span className="sider-group-count">{members.length}</span>
                    </div>
                  </Dropdown>
                  {!folded && members.map((a) => renderAccount(a, true))}
                </div>
              );
            })}
            {groups.length > 0 && <div className="sider-group">未分组</div>}
            {ungrouped.map((a) => renderAccount(a, false))}
          </>
        )}
        {mapped.length > 0 && (
          <>
            <div className="sider-group">局域网客服</div>
            {mapped.map((m) => {
              const key = `${m.addr}|${m.accountId}`;
              return (
                <div
                  key={key}
                  className={`account-item ${key === activeMappedKey ? 'active' : ''}`}
                  onClick={() => onSelectMapped(m)}
                >
                  <Avatar style={{ background: '#722ed1', flex: '0 0 auto' }} icon={<ApiOutlined />} />
                  <div className="account-meta">
                    <div className="account-name">{m.name}</div>
                    <div className="account-sub">
                      {m.account} · 来自 {m.peerName}
                    </div>
                  </div>
                  <Popconfirm
                    title="取消映射？"
                    okText="取消映射"
                    cancelText="保留"
                    onConfirm={() => onRemoveMapped(m)}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                </div>
              );
            })}
          </>
        )}
      </div>
      <div className="sider-footer">
        <Button block icon={<SettingOutlined />} onClick={onOpenSettings}>
          设置
        </Button>
      </div>

      <Modal
        open={!!renaming}
        title="修改昵称"
        okText="保存"
        cancelText="取消"
        onCancel={() => setRenaming(null)}
        onOk={saveRename}
      >
        <Input
          value={renaming?.name || ''}
          placeholder="留空则用登录返回的名字"
          maxLength={24}
          onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
          onPressEnter={saveRename}
        />
      </Modal>

      <Modal
        open={!!editingGroup}
        title={editingGroup?.id ? '重命名分组' : '新建分组'}
        okText="保存"
        cancelText="取消"
        onCancel={() => setEditingGroup(null)}
        onOk={saveGroup}
      >
        <Input
          value={editingGroup?.name || ''}
          placeholder="分组名称，例如：传奇 / 新系统"
          maxLength={20}
          onChange={(e) => setEditingGroup((g) => (g ? { ...g, name: e.target.value } : g))}
          onPressEnter={saveGroup}
        />
      </Modal>
    </div>
  );
}
