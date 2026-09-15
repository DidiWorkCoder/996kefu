/**
 * 权限号 GM 只读查询的菜单声明（纯数据，不引 React / antd）。
 *
 * `GmWorkbench` 只负责按这里的声明渲染表单与结果表；新增一个菜单只要加一条数据。
 * 所有 `fn` 必须是 `src/main/gmQuery.ts` 白名单里的**只读**函数。
 */

/** 查询表单里的一个字段 */
export interface GmField {
  /** 请求参数名 */
  name: string;
  label: string;
  type: 'text' | 'number' | 'dateRange' | 'date' | 'select' | 'server' | 'serverMulti' | 'area' | 'item' | 'cond';
  required?: boolean;
  placeholder?: string;
  /** type=select / type=cond 时的静态选项（type=cond 时是运算符字典） */
  options?: { label: string; value: string | number }[];
  /**
   * 动态下拉的数据源：选项由接口返回，不在声明里硬编码。
   *   goodsAction / currencyAction → 物品 / 货币动作字典（两者不同，必须各自加载）；
   *   platform → 渠道分包列表。
   */
  optionsFrom?: 'goodsAction' | 'currencyAction' | 'platform';
  /** type=cond：写进 `conditions[].key` 的条件名（level / changeNum / currentNum） */
  condKey?: string;
  /** dateRange / date 提交时的格式：unixSec=秒级时间戳，dateTime=YYYY-MM-DD HH:mm:ss */
  fmt?: 'unixSec' | 'dateTime';
  /** type=dateRange 时的结束参数名（如 startTime → endTime） */
  endName?: string;
  /** 日期范围默认往前几天（默认 7） */
  days?: number;
  /** 该字段是 JSON（如自定义日志的 addCond） */
  json?: boolean;
  /** type=item 时用哪张对照表做名字 ↔ ID 互查 */
  itemKind?: 'item' | 'equip';
  /**
   * 该字段是 ad 域日志的**附加条件**：不进顶层参数，而是被组装进 `addcond` JSON。
   * 值为条件字段名（如 userid / schrname / smapid）。
   */
  condProp?: string;
  /** 组装 addcond 时写进 `label` 的中文名（不填用 label） */
  condLabel?: string;
}

export interface GmMenu {
  /** 唯一 key（左侧菜单 key） */
  key: string;
  title: string;
  group: string;
  /** gmQuery.ts 白名单里的函数名 */
  fn: string;
  fields: GmField[];
  /** 固定列；为空则按返回首行的字段动态生成 */
  columns?: { key: string; title: string }[];
  /** 固定附加参数（如新版日志的 kind） */
  fixed?: Record<string, unknown>;
  note?: string;
}

export const GM_GROUPS = ['玩家', '记录', '榜', '统计', '风控'] as const;

/** 记录列表默认从返回体的哪个字段取（自动探测） */
export const pickGmRows = (res: any): any[] => {
  if (Array.isArray(res)) return res;
  const r = res?.records ?? res?.lists ?? res?.list ?? res?.data;
  return Array.isArray(r) ? r : [];
};

/** 总条数 */
export const pickGmTotal = (res: any, fallback = 0): number => {
  if (Array.isArray(res)) return res.length;
  const t = res?.total ?? res?.count ?? res?.pageTotal;
  return Number(t) || fallback;
};

/**
 * 返回字段 → 中文表头。
 * 结果表的列是按返回体字段名动态生成的，直接显示 gameId / serverid 这类变量名没法看，
 * 这里统一做一层映射；映射不到的才回落到字段名本身。
 */
const COL_LABELS: Record<string, string> = {
  /* 游戏 / 区服 */
  id: 'ID',
  sort: '序号',
  indexNo: '序号',
  game: '游戏',
  gameId: '游戏ID',
  gameid: '游戏ID',
  gameName: '游戏名',
  /* 区服列统一渲染成「名称（ID）」，所以表头就用「区服」 */
  serverId: '区服',
  serverid: '区服',
  server_name: '区服',
  servername: '区服',
  areaname: '区服',
  serverName: '区服',
  serverType: '区服类型',
  mainServerId: '主服',
  mainServerName: '区服',
  areaId: '战区ID',
  area_id: '战区ID',
  areaName: '战区',
  area_name: '战区',
  packageId: '渠道包ID',
  channel: '渠道',
  nchannel: '频道ID',
  nchannelStr: '频道',
  showTime: '展示时间',

  /* 角色 / 账号 */
  roleId: '角色ID',
  roleName: '角色',
  schrname: '角色',
  tochrname: '对方角色',
  rname: '角色名',
  userName: '角色名',
  userID: '角色ID',
  userid: '账号/角色ID',
  account: '账号',
  saccount: '账号',
  accountId: '账号ID',
  userId: '账号ID',
  gmId: 'GM ID',
  gmAccount: 'GM 账号',
  jobName: '职业',
  level: '等级',
  nlevel: '等级',
  playerDisabled: '封禁状态',
  banStatus: '封禁状态',
  lastLoginTime: '最后登录',

  /* 时间 */
  createTime: '时间',
  dcreatetime: '时间',
  dcreatetimeStr: '时间',
  dcreateTime: '发送时间',
  dcreateTimeDesc: '发送时间',
  drecvTime: '领取时间',
  drecvTimeDesc: '领取时间',
  releaseTime: '解封时间',
  lineTime: '时间',

  /* 位置 / 动作 */
  map: '地图',
  /* ad 域返回的 smapid 本身就是「中文名(代号)」，直接当地图名显示 */
  smapid: '地图',
  userCoordinates: '玩家坐标',
  nrCoordinates: '目标坐标',
  nx: '坐标X',
  ny: '坐标Y',
  nrx: '目标X',
  nry: '目标Y',
  action: '动作',
  type: '类型',
  srelated: '关联角色',
  /* ad 域死亡日志的凶手列 */
  skillname: '凶手名字',
  nlevel2: '凶手等级',
  /* 登出日志 */
  onlinehm: '在线时长',
  /* 行为 / 自定义日志 */
  nactid: '行为',
  sparam1: '备注',

  /* 物品 / 货币 */
  itemIdx: '物品',
  itemId: '物品',
  itemName: '物品名称',
  itemUniqueId: '物品唯一ID',
  nitemidx: '物品ID',
  nmakeidx: '物品唯一ID',
  slotName: '备注',
  nnum: '数量',
  ntotal: '总数量',
  amount: '数量',
  currencyId: '货币',
  /* 货币 / 物品记录（新）的动作与数量条件 */
  actionName: '动作',
  associatedNr: '关联对象',
  label: '关联函数',
  snpcmsg: '备注',
  changeNum: '变化数量',
  currentNum: '当前数量',

  /* 玩家列表（新）扩展 */
  platformId: '渠道分包',
  platformName: '渠道分包',
  promoteUserId: '推广员账号',
  promoteAccount: '推广员账号',

  /* 聊天 / 邮件 */
  scontent: '聊天内容',
  sendName: '发件人',
  lable: '邮件标题',
  accessory: '附件',
  item: '附件物品',
  readFlag: '是否已读',
  readFlagDesc: '已读',
  recvFlag: '是否领取',
  recvFlagDesc: '已领取',
  memo: '内容',
  nlogid: '日志ID',

  /* 风控 / 统计 */
  sipaddr: 'IP',
  ip: 'IP',
  ipAddress: 'IP地址',
  loginIp: '登录IP',
  plugRisk: '外挂风险',
  banReasonType: '封禁原因',
  reason: '原因',
  /* 封禁日志（ad 域 /getBanLog） */
  banRoleId: '角色ID',
  banRoleName: '角色名',
  banAccountId: '账号ID',
  banTypeName: '封禁类型',
  untilDate: '解禁时间',
  operateName: '操作人',
  operateDate: '操作时间',
  deleted: '已删除',
  deletedDesc: '状态',
  status: '状态',
  operator: '操作人',
  gameList: '游戏列表',
  accountList: '账号列表',
  ipList: 'IP 列表',
  userCount: '用户数',
  payCount: '付费人数',
  rate: '占比',
  levelRate: '等级占比',
  payRate: '付费率',
  totalUserCount: '总用户数',

  /* 玩家列表 / 战力榜扩展字段 */
  rank: '排名',
  mainServer: '区服',
  adminServerName: '主服',
  originalServer: '原始区服',
  job: '职业ID',
  reLevel: '转生',
  rechargeAmount: '充值金额',
  rechargeCount: '充值次数',
  combatNum: '战力',
  guild: '公会',
  lastPayTime: '最后充值',
  registerTime: '注册时间',
  registryIp: '注册IP',
};

/** 取返回字段的中文表头（先精确匹配，再忽略大小写匹配） */
export const colTitle = (key: string): string => COL_LABELS[key] ?? COL_LABELS[key.toLowerCase()] ?? key;

/** ad 域日志的一个「附加条件」字段，提交时会被组装进 addcond JSON */
const condField = (prop: string, label: string, placeholder?: string): GmField => ({
  name: `cond_${prop}`,
  label,
  type: 'text',
  placeholder: placeholder ?? `${label}（可空）`,
  condProp: prop,
  condLabel: label,
});

const LOG_AREA: GmField = { name: 'areaId', label: '主区', type: 'area' };
const LOG_TIME: GmField = { name: 'startDate', label: '开始时间', type: 'dateRange', endName: 'endDate', fmt: 'dateTime', days: 7 };

/** 货币 / 物品记录的「数量条件」运算符（官方字典 ne） */
const COND_OPS = [
  { label: '等于', value: '=' },
  { label: '大于', value: '>' },
  { label: '小于', value: '<' },
  { label: '大于等于', value: '>=' },
  { label: '小于等于', value: '<=' },
];

/**
 * 货币 / 物品记录的数量条件：条件名固定（角色等级 / 变化数量 / 当前数量），
 * 每项是「运算符下拉 + 数值输入」，提交时组装进 `conditions: [{key,value,condition}]`。
 */
const condNum = (key: 'level' | 'changeNum' | 'currentNum', label: string): GmField => ({
  name: `cond_${key}`,
  label,
  type: 'cond',
  condKey: key,
  options: COND_OPS,
});

/**
 * 新版日志（ad 域）的表单字段：**每种 kind 的过滤参数都不一样**。
 *
 * 照官方前端真实报文对齐——传错字段名（例如把角色 ID 放顶层 userid）会被服务端「相与」成空结果，
 * 这正是「指定 ID 就查不到、不指定反而有数据」的原因：
 *   Death / Login / Logout：顶层不带过滤，条件全走 addcond（JSON 字符串）；
 *   Upgrade / Action：角色过滤走顶层 roleId / roleName（另有 level / actionId）；
 *   Ban：顶层 serverId / roleName / accountId，且区服为空时传 null。
 */
const newLogFields = (kind: string): GmField[] => {
  switch (kind) {
    /* 死亡日志：官方 addcondNameList = userid(受害者ID) / schrname(受害者角色名) / nlevel(受害者等级)
       / smapid(地图) / skillname(凶手名字) / nlevel2(凶手等级) */
    case 'Death':
      return [
        LOG_AREA,
        condField('userid', '受害者ID', '受害者角色 ID（可空）'),
        condField('schrname', '受害者角色名'),
        condField('nlevel', '受害者等级'),
        condField('smapid', '地图'),
        condField('skillname', '凶手名字'),
        condField('nlevel2', '凶手等级'),
        LOG_TIME,
      ];
    /* 登录 / 登出：userid / schrname / sipaddr / smapid */
    case 'Login':
    case 'Logout':
      return [
        LOG_AREA,
        condField('userid', '角色ID'),
        condField('schrname', '角色名称'),
        condField('sipaddr', 'IP地址'),
        condField('smapid', '地图名'),
        LOG_TIME,
      ];
    /* 升级日志：顶层 roleId / roleName / level / type */
    case 'Upgrade':
      return [
        LOG_AREA,
        { name: 'roleId', label: '角色ID', type: 'text', placeholder: '角色 ID（可空）' },
        { name: 'roleName', label: '角色名', type: 'text' },
        { name: 'level', label: '等级', type: 'text' },
        LOG_TIME,
      ];
    /* 行为日志：顶层 actionId / roleId / roleName */
    case 'Action':
      return [
        LOG_AREA,
        { name: 'roleId', label: '角色ID', type: 'text', placeholder: '角色 ID（可空）' },
        { name: 'roleName', label: '角色名', type: 'text' },
        { name: 'actionId', label: '行为ID', type: 'text' },
        LOG_TIME,
      ];
    /* 封禁日志：顶层 serverId / roleName / accountId（不带主区） */
    case 'Ban':
      return [SERVER(), { name: 'roleName', label: '角色名', type: 'text' }, { name: 'accountId', label: '账号ID', type: 'text' }, LOG_TIME];
    default:
      return [LOG_AREA, condField('userid', '角色ID'), LOG_TIME];
  }
};

const newLogMenu = (key: string, title: string, kind: string, group = '记录', note?: string): GmMenu => ({
  key,
  title,
  group,
  fn: 'gmPlayerLog',
  fixed: { kind },
  fields: newLogFields(kind),
  note: note || '新版日志（ad 域），必须带时间范围；角色 ID / 账号等条件按官方规则组装过滤',
});

const TIME_RANGE = (name = 'startTime', endName = 'endTime'): GmField => ({
  name,
  label: '时间范围',
  type: 'dateRange',
  endName,
  fmt: 'unixSec',
  days: 7,
});

const SERVER = (required = false): GmField => ({
  name: 'serverId',
  label: '区服',
  type: 'server',
  required,
  placeholder: '选区服',
});

/** 24 个「玩家管理」菜单 */
export const GM_MENUS: GmMenu[] = [
  /* ---- 玩家 ---- */
  {
    key: 'playerList',
    title: '玩家列表（新）',
    group: '玩家',
    fn: 'gmPlayerPage',
    fields: [
      SERVER(true),
      { name: 'roleName', label: '角色名', type: 'text', placeholder: '请输入角色名' },
      { name: 'roleId', label: '角色ID', type: 'text', placeholder: '请输入角色ID' },
      { name: 'account', label: '玩家账号', type: 'text', placeholder: '请输入玩家账号' },
      { name: 'accountId', label: '账号唯一ID', type: 'text', placeholder: '请输入账号唯一ID' },
      { name: 'platformId', label: '渠道分包', type: 'select', optionsFrom: 'platform', placeholder: '请选择渠道分包' },
      { name: 'reLevel', label: '转生值', type: 'text', placeholder: '请输入转生值' },
      {
        name: 'deleted',
        label: '删除状态',
        type: 'select',
        placeholder: '请选择删除状态',
        options: [
          { label: '正常', value: 0 },
          { label: '删除', value: 1 },
        ],
      },
      {
        name: 'job',
        label: '职业',
        type: 'select',
        placeholder: '请选择职业',
        options: [
          { label: '战士', value: 0 },
          { label: '法师', value: 1 },
          { label: '道士', value: 2 },
        ],
      },
      {
        name: 'banStatus',
        label: '封禁状态',
        type: 'select',
        placeholder: '请选择封禁状态',
        options: [
          { label: '正常', value: 0 },
          { label: '封停角色', value: 1 },
          { label: '封停聊天', value: 2 },
          { label: '封停账号', value: 3 },
          { label: '封停IP', value: 4 },
        ],
      },
      { name: 'promoteUserId', label: '推广员账号', type: 'text', placeholder: '请输入推广员账号' },
      { name: 'startTime', label: '开始时间', type: 'dateRange', endName: 'endTime', fmt: 'dateTime', days: 7 },
    ],
    note: '区服必填；渠道分包为接口动态字典',
  },
  {
    key: 'userQuery',
    title: '用户信息查询',
    group: '玩家',
    fn: 'gmUserQueryPage',
    fields: [
      { name: 'account', label: '账号', type: 'text', placeholder: '账号（跨区服）' },
      { name: 'roleName', label: '角色名', type: 'text' },
      { name: 'roleId', label: '角色ID', type: 'text' },
    ],
    note: '账号维度查角色，可以跨区服',
  },
  newLogMenu('deathLogNew', '死亡日志(新)', 'Death', '玩家'),
  newLogMenu('loginLogNew', '登录日志(新)', 'Login', '玩家'),

  /* ---- 记录 ---- */
  {
    key: 'itemLog',
    title: '物品记录（新）',
    group: '记录',
    fn: 'gmItemLog',
    fixed: { serverType: 'main' },
    fields: [
      SERVER(),
      TIME_RANGE(),
      { name: 'roleId', label: '角色ID', type: 'text', placeholder: '请输入角色ID' },
      { name: 'roleName', label: '角色名', type: 'text', placeholder: '请输入角色名' },
      { name: 'map', label: '地图', type: 'text', placeholder: '请输入地图' },
      { name: 'actionName', label: '动作', type: 'select', optionsFrom: 'goodsAction', placeholder: '请选择动作' },
      { name: 'associatedNr', label: '关联对象', type: 'text', placeholder: '请输入关联对象' },
      { name: 'label', label: '关联函数', type: 'text', placeholder: '请输入关联函数' },
      { name: 'itemIdx', label: '物品ID', type: 'item', itemKind: 'item', placeholder: '请输入物品ID' },
      { name: 'itemUniqueId', label: '物品唯一ID', type: 'text', placeholder: '请输入物品唯一ID' },
      condNum('level', '角色等级'),
      condNum('changeNum', '变化数量'),
      condNum('currentNum', '当前数量'),
      { name: 'snpcmsg', label: '备注', type: 'text', placeholder: '请输入备注' },
    ],
    note: '必须带时间范围（秒级时间戳）；物品ID 支持按名字搜（需先在「物品表配置」里指定对照表）；动作为接口动态字典（可在框里输入关键词过滤）',
  },
  {
    key: 'currencyLog',
    title: '货币记录（新）',
    group: '记录',
    fn: 'gmCurrencyLog',
    fixed: { serverType: 'mix' },
    fields: [
      SERVER(),
      TIME_RANGE(),
      { name: 'roleId', label: '角色ID', type: 'text', placeholder: '请输入角色ID' },
      { name: 'roleName', label: '角色名', type: 'text', placeholder: '请输入角色名' },
      { name: 'map', label: '地图', type: 'text', placeholder: '请输入地图' },
      { name: 'actionName', label: '动作', type: 'select', optionsFrom: 'currencyAction', placeholder: '请选择动作' },
      { name: 'associatedNr', label: '关联对象', type: 'text', placeholder: '请输入关联对象' },
      { name: 'label', label: '关联函数', type: 'text', placeholder: '请输入关联函数' },
      { name: 'currencyId', label: '货币ID', type: 'text', placeholder: '请输入货币ID' },
      condNum('level', '角色等级'),
      condNum('changeNum', '变化数量'),
      condNum('currentNum', '当前数量'),
      { name: 'snpcmsg', label: '备注', type: 'text', placeholder: '请输入备注' },
    ],
    note: '必须带时间范围（秒级时间戳）；动作为接口动态字典，货币与物品的动作表不同',
  },
  newLogMenu('deathLog', '死亡日志', 'Death'),
  newLogMenu('loginLog', '登录日志', 'Login'),
  newLogMenu('logoutLog', '玩家登出日志', 'Logout'),
  newLogMenu('upgradeLog', '玩家升级日志', 'Upgrade'),
  newLogMenu('actionLog', '玩家行为日志', 'Action'),
  newLogMenu('banLog', '玩家封禁日志', 'Ban'),
  {
    key: 'chatLog',
    title: '玩家聊天日志',
    group: '记录',
    fn: 'gmChatLogPage',
    fields: [SERVER(), { name: 'roleId', label: '角色ID', type: 'text' }, { name: 'roleName', label: '角色名', type: 'text' }, TIME_RANGE()],
  },
  {
    key: 'customLog',
    title: '自定义日志',
    group: '记录',
    fn: 'gmCustomLogPage',
    fields: [SERVER(), { name: 'roleId', label: '角色ID', type: 'text' }, { name: 'addCond', label: '附加条件', type: 'text', json: true, placeholder: 'JSON 数组，可空，例如 []' }],
  },
  newLogMenu('customLogNew', '自定义日志(新)', 'Action', '记录', '走新版日志入口，按行为日志查'),
  {
    key: 'yidunLog',
    title: '996 反外挂日志',
    group: '记录',
    fn: 'gmYidunBanPage',
    fields: [SERVER(), { name: 'account', label: '账号', type: 'text' }],
  },
  {
    key: 'roleDelLog',
    title: '角色删除日志',
    group: '记录',
    fn: 'gmRolePageLog',
    fields: [SERVER(), { name: 'roleId', label: '角色ID', type: 'text' }, { name: 'roleName', label: '角色名', type: 'text' }],
  },
  {
    key: 'mailLog',
    title: '实时邮件',
    group: '记录',
    fn: 'gmMailLogPage',
    fields: [
      SERVER(),
      // 发送时间要 unix 秒：实测传字符串会返回 code 500「参数类型错误」
      { name: 'startSendTime', label: '开始日期', type: 'dateRange', endName: 'endSendTime', fmt: 'unixSec', days: 7 },
      { name: 'sendUserName', label: '发送者名称', type: 'text', placeholder: '请输入发送者名称' },
      { name: 'receiveUserName', label: '接收者名称', type: 'text', placeholder: '请输入接收者名称' },
      { name: 'emailTitle', label: '邮件标题', type: 'text', placeholder: '请输入邮件标题' },
      { name: 'roleId', label: '接收者角色ID', type: 'text', placeholder: '请输入接收者角色ID' },
    ],
  },
  {
    key: 'blackList',
    title: '玩家黑名单',
    group: '记录',
    fn: 'gmBlackPageList',
    fields: [],
    note: '直接点「查询」看第一页',
  },

  /* ---- 榜 ---- */
  {
    key: 'rank',
    title: '玩家战力榜',
    group: '榜',
    fn: 'gmPlayerRankPage',
    fields: [{ name: 'serverIds', label: '区服（可多选）', type: 'serverMulti', required: true, placeholder: '选一个或多个区服' }],
    // 接口返回 20 多个字段（含 mainServer / originalServer 这类对象，铺出来又宽又乱），只留关键列
    columns: [
      { key: 'rank', title: '排名' },
      { key: 'account', title: '账号' },
      { key: 'accountId', title: '账号ID' },
      { key: 'roleId', title: '角色ID' },
      { key: 'roleName', title: '角色' },
      { key: 'jobName', title: '职业' },
      { key: 'level', title: '等级' },
      { key: 'reLevel', title: '转生' },
      { key: 'combatNum', title: '战力' },
      { key: 'guild', title: '公会' },
      { key: 'rechargeAmount', title: '充值金额' },
      { key: 'rechargeCount', title: '充值次数' },
      // mainServer 是对象 {"id":10001,"name":"一区",…}，渲染成「一区（10001）」
      { key: 'mainServer', title: '区服' },
      { key: 'lastPayTime', title: '最后充值' },
      { key: 'lastLoginTime', title: '最后登录' },
      { key: 'registerTime', title: '注册时间' },
      { key: 'registryIp', title: '注册IP' },
    ],
  },

  /* ---- 统计 ---- */
  {
    key: 'levelDist',
    title: '等级分布日志',
    group: '统计',
    fn: 'gmRoleLevelStatistics',
    fields: [SERVER(), { name: 'queryTime', label: '统计时间', type: 'date', fmt: 'unixSec', required: true }],
  },
  {
    key: 'firstPayDist',
    title: '首充等级分布日志',
    group: '统计',
    fn: 'gmRoleLevelFirstPayStatistics',
    fields: [SERVER(), { name: 'queryTime', label: '统计时间', type: 'date', fmt: 'unixSec', required: true }],
  },
  {
    key: 'lineTimeDist',
    title: '在线时长分布日志',
    group: '统计',
    fn: 'gmRoleLineTimeStatistics',
    fields: [SERVER(), { name: 'queryTime', label: '统计时间', type: 'date', fmt: 'unixSec', required: true }],
  },

  /* ---- 风控 ---- */
  {
    key: 'sensitive',
    title: '敏感词检测',
    group: '风控',
    fn: 'gmSensitiveWordPage',
    fields: [SERVER(), { name: 'roleId', label: '角色ID', type: 'text' }, { name: 'roleName', label: '角色名', type: 'text' }, { name: 'account', label: '账号', type: 'text' }],
  },
];
