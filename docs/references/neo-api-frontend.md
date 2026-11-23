# New API · 前端 UI 架构

> 快照：`references/neo-api/web`。React 19 + TanStack Router（文件路由）+ Base UI + Tailwind 4 + Rsbuild。

## 1. 技术栈

| 类别 | 选型 |
|---|---|
| 框架 | React 19.2 + TypeScript（纯函数组件） |
| 构建 | Rsbuild 2 + Rspack，`@ → src` 别名 |
| 路由 | **TanStack Router 1.170 文件式路由**，自动生成 `routeTree.gen.ts`，生产按路由拆包 |
| 数据 | **TanStack Query 5** + axios |
| 组件库 | **Base UI**（`@base-ui/react`）底层 + 本地 shadcn 风格封装（`components/ui/` 61 个） |
| 样式 | **Tailwind 4**（CSS 变量 + oklch），`cn()` = clsx + tailwind-merge |
| 图标 | Hugeicons（主）+ lobehub/icons（厂商）+ lucide |
| 状态 | **Zustand**（auth / notification / system-config / plugin-site / pricing） |
| 表格 | TanStack Table 8 + TanStack Virtual，自建 `components/data-table/` 体系 |
| 图表 | @visactor/react-vchart（业务）+ recharts |
| 表单 | React Hook Form + Zod + resolvers |
| i18n | i18next，**7 语言**（en/zhCN/zhTW/fr/ru/ja/vi），扁平 JSON 键=英文原文 |
| 主题 | 自研 ThemeProvider + **10 套色板** |
| 高亮 | shiki + codemirror + lezer |
| 动效 | motion + tw-animate-css |
| 其他 | sonner/vaul/cmdk/input-otp/dayjs/dompurify/marked/katex/qrcode/sse.js/`ai@7` |
| 包管理 | **Bun 1.4.4** |

## 2. 目录结构

```
src/
├── main.tsx                # QueryClient → ThemeProvider → FontProvider → DirectionProvider → Router
├── routes/                 # 唯一路由来源（无 App.jsx/router.ts）
├── features/               # 26 个业务域，含 index.tsx / api.ts / types.ts / constants.ts / components/ / hooks/ / lib/
├── components/
│   ├── ui/                 # 61 个基础控件
│   ├── layout/             # 布局骨架（sidebar/header/section-page-layout）
│   ├── data-table/         # 通用表格体系（core/layout/toolbar/static/hooks）
│   ├── ai-elements/        # 40+ 对话/内容渲染组件
│   ├── json-code-editor/
│   └── config-drawer / command-menu / confirm-dialog / permission-matrix / quota-details-popover / turnstile
├── context/                # theme / theme-customization / font / direction / layout / search
├── hooks/ stores/ lib/ i18n/ styles/
```

## 3. 路由守卫（四层叠加）

约定：`_authenticated/` 前缀不→URL 但包登录守卫；`(auth)`/`(errors)` 分组不→URL；`$param` 动态段。

| 层 | 行为 |
|---|---|
| 根守卫 | legacy 重定向、未初始化强制 `/setup`、并发 `bootstrapAuthentication()` |
| 登录守卫 | `resolveAuthentication()` 回源校验，无态 → `/sign-in?redirect=` |
| 角色守卫 | `role < ADMIN` → `/403`；`role !== SUPER_ADMIN` → `/403` |
| 模块开关守卫 | `HeaderNavModules` 控制 pricing/rankings 可见性与 requireAuth |

**搜索参数一律 Zod 校验 + `.catch()` 兜底**，列表页状态全在 URL。

## 4. 页面清单（70+ 路由）

### 公共站
`/` 首页（可配 HTML/Markdown/iframe）· `/pricing` 模型广场 · `/pricing/:modelId` 详情 · `/rankings` 排行榜 · `/about` · `/privacy-policy` · `/user-agreement` · `/setup` 初始化向导 · `/401 /403 /404 /500 /503` · `/oauth/:provider` 回调

### 认证
`/sign-in` · `/sign-up`（Turnstile）· `/register`（别名）· `/otp` 二次验证 · `/forgot-password` · `/reset` · `/oauth` 微信落地

### 后台
| 路由 | 用途 | 权限 |
|---|---|---|
| `/dashboard/overview` | 7 统计卡 + 性能概览 + 分布图 | 登录 |
| `/dashboard/models` | 模型维度时序图 + 粒度切换 | 登录 |
| `/dashboard/flow` | 节点-边拓扑图 | 登录 |
| `/dashboard/users` | 用户维度图表 | ADMIN+ |
| `/playground` | 聊天调试台（流式/停止/重生成/编辑） | 登录 + 模块开关 |
| `/chat/:chatId` · `/chat2link` | 外部聊天预设承载/跳转 | 登录 |
| `/keys` | 令牌表 + 创建抽屉 + 批量删除 + 分组/额度/模型/IP 限制 | 登录 |
| `/usage-logs/{common,drawing,task,audit}` | 调用/绘图/任务/审计日志 | 登录；audit ADMIN+ |
| `/wallet` | 余额卡 + 充值（易支付/Stripe/Creem/Waffo）+ 兑换码 + 订阅 + 邀请返利 | 登录 |
| `/profile` | 资料/语言/签到日历/侧栏模块自选 | 登录 |
| `/security` | 改密/绑定/会话/PAT/Passkey/2FA/注销 | 登录 |
| `/channels` | **渠道管理**（最复杂） | ADMIN+ |
| `/models/{metadata,vendors,deployments}` | 模型/厂商/部署 | ADMIN+ |
| `/users` | **用户管理** + 权限矩阵 | ADMIN+ |
| `/redemption-codes` · `/subscriptions` | 兑换码/订阅 | ADMIN+ |
| `/system-info` · `/task-plugins` · `/request-processing` | 系统信息/插件/请求链 | SUPER_ADMIN |

### 系统设置子工作区 `/system-settings/*`（39 个 section，SUPER_ADMIN）
侧边栏切换为子工作区视图 + 返回按钮。

- **site**：系统信息 / 公告 / 顶部导航 / 侧栏模块
- **auth**：基础认证（注册开关、邮箱验证、域名白名单）/ OAuth（GitHub/Discord/OIDC/Telegram/LinuxDO/微信）/ Passkey / Turnstile / 自定义 OAuth
- **billing**：额度 / 货币汇率 / **模型定价**（4 Tab：模型价/未定价/工具价/上游同步）/ 分组定价 / 支付网关 / 签到
- **models**：全局模型配置 / Gemini / Claude / Grok / 模型部署
- **request-policies**：会话与重试 / 渠道健康
- **security**：限流 / SSRF 防护 / 令牌上限
- **content**：数据看板 / 公告 / API 地址 / FAQ / Uptime Kuma / 聊天预设 / 绘图
- **operations**：系统行为 / 性能指标 / 邮件通知 / Worker 代理 / 日志维护 / 性能 / 系统维护

## 5. 布局与导航

### 四层布局
公共站 `PublicLayout` · 认证页 `AuthLayout`（分屏）· 后台 `AuthenticatedLayout` · 系统设置（同一布局换侧栏）

**`SectionPageLayout`** 是后台页骨架：**Title / Actions / Content / Breadcrumb 四槽 + footer portal**，用 `Children.forEach` 按子组件类型取槽。`fixedContent` 决定内部滚动。

### 侧边栏（Vercel/Cloudflare 式 drill-in）
- 根导航 4 组：**Chat / General / Personal / Admin**
- 进入 `/system-settings/*` 侧栏整体替换为 System Administration + 返回按钮，motion 滑入
- 移动端 MobileDrawer（spring）

### 权限控制菜单（三层叠加）
1. **角色**：`GUEST 0 / USER 1 / ADMIN 10 / SUPER_ADMIN 100`，过滤 `requiredRole`
2. **管理员开关**：`status.SidebarModulesAdmin` JSON 两级开关（分区.enabled + 模块）
3. **用户偏好**：`auth.user.sidebar_modules` 只能进一步收窄

> 路由守卫独立兜底 —— **菜单隐藏绝不代替路由守卫**。

细粒度权限矩阵：资源 `audit/channel/task_plugin` × 动作 `read/operate/write/sensitive_write/secret_view/bind`，目录由后端 `GET /api/authz/catalog` 下发。

## 6. 关键页面组成

**渠道管理 `/channels`**：表格列含拖拽优先级、权重、已用-剩余、响应时间、最后测试。抽屉 `channel-mutate-drawer.tsx`（5255 行）分 6 section：基础/认证/模型/API访问/高级/插件。含参数覆盖编辑器（3165 行）。

**令牌 `/keys`**：列表 key 掩码 + 复制；主按钮区有 API 地址 popover + 创建。抽屉含自动分组顺序编辑器、CIDR 白名单。

**钱包 `/wallet`**：三块卡（余额统计 → 充值表单/订阅套餐 → 邀请返利），支付链路统一 `dispatchSelectedPayment()`。

**模型定价**：`RatioSettingsCard` 4 Tab，支持按模型名**拖选批量高亮编辑**、表达式差异高亮。

## 7. 设计系统

- `theme.css` 用 `@theme inline` 把 `--background/--primary/--chart-1..5/--sidebar-*` 映射为 `--color-*`
- **圆角倍数关系**：`--radius-sm = radius*0.6` … `--radius-4xl = radius*2.6`，换档位等比缩放所有控件
- 暗色：`@custom-variant dark (&:is(.dark *))`
- **防闪白**：`index.html` 内联脚本在首屏前读 localStorage 加 `html.light/.dark`
- **10 套色板**（Default/Anthropic/Simple Large-font/Underground/Rose Garden/Lake View/Sunset Glow/Forest Whisper/Ocean Breeze/Lavender Dream）
- 实现：全部写 `<body data-theme-preset / data-theme-font / data-theme-radius / data-theme-scale / data-theme-content-layout>`，由 `theme-presets.css` 属性选择器覆盖变量

## 8. 前后端契约

1. **统一 axios**：同源 `baseURL:''`，`withCredentials:true`
2. **GET 自动去重**：`sessionSID + url + params` 合并并发 GET
3. **认证**：注入 `Bearer`；401 自动 refresh 并重放一次；敏感操作可用 `singleUseAuthorization` + `X-Security-Proof`
4. **响应契约**：`{ success, message, data }`；`requireServerSuccess()` 抛 `ServerError`
5. **分层**：每 feature 自带 `api.ts`，只拼 URL，不写 UI
6. **服务端下发全站状态**：`GET /api/status` 一次拉齐 `system_name/logo/HeaderNavModules/SidebarModulesAdmin/price/payment/checkin`，**前端预取共享缓存**

> **关键事实**：顶栏/侧栏可见性主要由后端 `/api/status` 两个 JSON 字段驱动（`HeaderNavModules`、`SidebarModulesAdmin`）。复刻时这两块配置契约必须一并实现。

## 9. 复刻骨架（七步）

1. `SectionPageLayout` 四槽 → 所有列表页
2. `DataTablePage`（工具栏 + 桌面表格 + 移动卡片 + 批量栏 + 分页）→ 所有 CRUD 页
3. `Provider` + `*-dialogs.tsx` + `*-primary-buttons.tsx` 三件套固定
4. `routes/**` 只做「守卫 + validateSearch + 指向 feature」，实现全在 `features/<domain>/index.tsx`
5. 列表页 URL 即状态，Zod `.catch()` 兜底
6. 主题全走 CSS 变量 + `data-theme-*` 属性，首屏内联脚本预置
7. i18n 键=英文原文，7 份扁平 JSON

## 10. 对 LTZY 的启示

LTZY 前端是**原生 JS（无框架、无构建）**，1630 行 JS + 1150 行 CSS。

**保持现状的理由**：零依赖是本项目卖点之一（README 明确「不需要 npm」），引入 React 会破坏这个承诺。

**可借用的设计思想（不引入依赖）**：
1. **`SectionPageLayout` 四槽结构** → LTZY 的 `section()` helper 已接近，可强化为显式槽位
2. **列表页 URL 即状态** → LTZY 日志页已有 `#logs?id=` 深链，可推广到筛选条件
3. **主题走 CSS 变量 + data 属性** → LTZY 已有 `data-theme`，可加 `data-quality` 已实现
4. **侧栏模块开关由后端下发** → 便于运营控制菜单，LTZY 可按角色下发
5. **统一响应契约 `{success,message,data}`** → LTZY 用 `{error:{message}}`，可保持但需一致
6. **GET 去重 / 401 自动刷新重放** → LTZY 的 `api()` 已集中，可加这两条

**明显差距（值得补的）**：
- 无数据表格体系（LTZY 用字符串拼 HTML）
- 无权限矩阵（LTZY 两角色硬判断）
- 无 i18n（仅中文）
- 无主题定制（仅亮/暗两档）
