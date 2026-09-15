<div align="center">

# 996 客服管理器

**面向 996 游戏平台客服的 Windows 桌面工作台**

多账号会话聚合 · 企业微信客服 · 权限号 GM 只读查询 · AI 辅助回复

[![Version](https://img.shields.io/badge/version-0.6.3-blue)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white)](#环境要求)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-ISC-green)](package.json)

</div>

---

## 简介

**996 客服管理器**把客服日常要用的几个后台塞进了同一个窗口：多个 996 客服号同时在线、企业微信客服会话、权限号 GM 查询、AI 与关键词辅助回复、快捷短语、局域网互通。省掉来回切浏览器标签页的功夫，回复快一点，漏单少一点。

> **安全红线**：GM 相关能力**全部只读**。所有查询都经过主进程白名单（`src/main/gmQuery.ts`）转发，程序不提供、也不会调用任何对玩家产生实际影响的写操作接口。

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| **多账号工作台** | 一台机器同时挂多个 996 客服号，左侧账号栏随时切换，支持账号分组归类 |
| **会话列表** | 按 客服号 / 状态 / 未读 筛选，支持置顶、折叠分组、批量已读 |
| **聊天面板** | 文字、表情、图片、文件收发，撤回、转写、查看访客资料与历史记录 |
| **企业微信客服** | 企微会话与消息独立工作台，支持回复、上传、已读、置顶、转写、快捷回复管理 |
| **权限号 GM 查询** | 玩家列表、用户信息、物品/货币记录、聊天日志、自定义日志、反外挂日志、角色删除日志、实时邮件、黑名单、战力榜、等级/首充/在线时长分布、敏感词检测（**全部只读**） |
| **AI 辅助回复** | 兼容 OpenAI Chat Completions / OpenAI Responses / Anthropic 三种协议，接口地址与密钥自填，可挂自有知识库 |
| **关键词推荐** | 命中关键词时自动推荐话术，关键词与回复内容可在界面维护 |
| **快捷短语** | 按客服号维护常用话术，一键发送 |
| **每日自动学习** | 定时从会话中整理知识，沉淀到本地知识库，持续提升 AI 回复质量 |
| **物品 / 装备对照表** | 导入 Excel 表格，回答玩家时直接按 ID 反查物品名 |
| **来信息提醒** | 系统通知 / 弹窗 / 两者都要，可配置，避免错过访客消息 |
| **局域网互通** | 多台电脑之间共享会话快照、映射客服号、协作回复，支持自动发现或手动添加节点 |
| **掉线自愈** | 掉线自动续期；企微与权限号支持掉线自动重新登录（开关在设置里） |

---

## 三种登录方式

| 登录方式 | 账号类型 | 说明 |
| --- | --- | --- |
| **996 客服号** | `kf996` | 官方客服工作台账号，支持账号密码登录 |
| **企业微信客服** | `qywx` | 企微客服账号，会话走企微通道 |
| **权限号（GM）** | `gmAuth` | GM 后台权限号，用于只读查询；设备凭证可复用浏览器本地存储中的 `deviceid`，免验证码登录 |

账号密码登录默认使用免验证码模式：程序从本机已安装的 **Edge / Chrome / Firefox / QQ 浏览器 / 夸克** 的用户数据目录里读取 `https://gm.tj.996sdk.com/` 站点的本地存储，自动取出 `deviceid:<账号>`，无需手抄设备 ID。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 44 |
| 构建 | electron-vite 5 + Vite 7 |
| 界面 | React 19 + Ant Design 6 |
| 语言 | TypeScript 7 |
| 打包 | electron-builder 26（Windows NSIS 安装包） |
| 其他 | xlsx（物品表解析）、playwright-core（浏览器用户数据读取） |

---

## 环境要求

- **系统**：Windows 10 / 11（x64）
- **Node.js**：20.19+ 或 22.12+
- **npm**：随 Node.js 安装即可

---

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/DidiWorkCoder/996kefu.git
cd 996kefu

# 2. 安装依赖
npm install

# 3. 开发模式（热更新）
npm run dev
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动开发模式，改代码即时热更新 |
| `npm run build` | 只编译，产物在 `out/`，不打安装包 |
| `npm run pack` | 编译 + 打 Windows 安装包，产物在 `dist/` |
| `npm run preview` | 以生产产物预览运行 |

Windows 下也可以直接双击 `pack.cmd`，它会先清理中断的 electron-builder 进程与临时下载残留，再执行打包，最后列出生成的安装包路径。

打包完成后，安装包位于：

```
dist\996kefu-0.6.3-setup.exe
```

---

## 自动打包（GitHub Actions）

仓库内置工作流 [`.github/workflows/pack.yml`](.github/workflows/pack.yml)，在 GitHub 的云端 Windows 机器上自动出安装包，本机不用装任何环境。

**触发方式**

| 触发 | 结果 |
| --- | --- |
| 推送到 `master` / `main` 分支 | 打包并上传为构建产物（Artifact） |
| 提交 Pull Request | 打包并上传为构建产物（Artifact） |
| 手动触发（Actions → 选择工作流 → Run workflow） | 打包并上传为构建产物（Artifact） |
| 推送 `v*` 标签（如 `v0.6.3`） | 打包 + 自动创建 Release 并挂上安装包 |

**取产物**

- 构建产物：仓库 **Actions** → 选择对应运行记录 → 页面底部 **Artifacts** 下载
- 正式发版：**Releases** 页面直接下载 `996kefu-<版本号>-setup.exe`

**发版流程示例**

```bash
# 修改 package.json 里的 version 后
git add .
git commit -m "release: v0.6.4"
git tag v0.6.4
git push origin master --tags
```

工作流跑完，Release 里就会出现安装包。

> 如果云端下载 Electron / electron-builder 二进制较慢，可以在工作流里加环境变量切换镜像：
>
> ```yaml
> env:
>   ELECTRON_MIRROR: https://npmmirror.com/mirrors/electron/
>   ELECTRON_BUILDER_BINARIES_MIRROR: https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

---

## 目录结构

```
996kefu/
├─ .github/workflows/pack.yml   # 自动打包工作流
├─ resources/                   # 图标等静态资源
├─ src/
│  ├─ main/                     # 主进程
│  │  ├─ index.ts               # 入口 + 全部 IPC 注册
│  │  ├─ api.ts / qywx.ts       # 996 客服 / 企微 接口
│  │  ├─ gmQuery.ts             # GM 只读查询白名单（安全红线所在）
│  │  ├─ browserDevice.ts       # 读取浏览器本地存储中的设备 ID
│  │  ├─ settings.ts / store.ts # 配置与本地数据
│  │  ├─ ai.ts / learn.ts       # AI 回复 / 每日自动学习
│  │  ├─ lan.ts / ws.ts / wsServer.ts  # 局域网互通
│  │  └─ xls.ts                 # Excel 物品表解析
│  ├─ preload/index.ts          # 预加载脚本（IPC 桥）
│  └─ renderer/                 # 渲染进程（React + Ant Design）
│     └─ src/
│        ├─ App.tsx             # 主界面与标签页
│        ├─ gmMenus.ts          # GM 菜单定义
│        └─ components/         # 各功能面板
├─ electron.vite.config.mjs
├─ pack.cmd                     # 本机一键打包
└─ package.json
```

---

## 数据与隐私

- 账号、配置、会话快照、知识库等数据**全部保存在本机**（Electron 用户数据目录），不经过任何第三方服务器。
- AI 功能需要你自填接口地址与密钥，请求直接发往你配置的服务；不配置就不启用。
- 请勿把包含真实账号、令牌、设备 ID 的文件（如抓包产物、日志）提交到仓库，`.gitignore` 已对常见目录做忽略，但仍需自行确认。

---

## 常见问题

**Q：打包时卡在下载 Electron / winCodeSign？**
网络问题。可设置镜像后重试：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run pack
```

**Q：打包报文件被占用？**
安装包正在运行。先完全退出「996客服管理器」再打包；`pack.cmd` 会自动清理残留进程。

**Q：首次安装被 Windows SmartScreen 拦截？**
安装包未做代码签名，选择「更多信息 → 仍要运行」即可。

**Q：GM 查询能改玩家数据吗？**
不能，也不打算做。所有 GM 调用都走只读白名单，白名单外的接口一律拒绝。

---

## 免责声明

本项目仅供学习交流与内部客服效率工具使用。使用者需自行确保对相关账号与数据拥有合法授权，并遵守平台服务条款。因使用本项目产生的任何后果由使用者自行承担。

## 许可协议

本项目基于 **ISC** 协议开源，详见 [package.json](package.json)。
