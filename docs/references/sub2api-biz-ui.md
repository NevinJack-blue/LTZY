# Sub2API · 支付计费与前端

> 快照：`references/sub2api`。

## 一、支付体系

### 1. 九个支付类型，五个渠道实现

`alipay / wxpay / alipay_direct / wxpay_direct / stripe / card / link / easypay / airwallex`
复合类型归一：`card`/`link` → `stripe`，`*_direct` → `alipay`/`wxpay`。

| 渠道 | 下单 | 验签 | 查询/退款 |
|---|---|---|---|
| **EasyPay** | popup 拼 `submit.php` 跳转；否则 `mapi.php` 出码 | **MD5 + 参数白名单 + 商户号绑定 + 上游复查（四层）** | 全支持 |
| 支付宝 | wap / precreate / page.pay 三态回落 | SDK RSA2 验签 | 全支持 |
| 微信 APIv3 | JSAPI / Native / H5 | SDK `ParseNotifyRequest`，**刻意不支持平台证书模式** | 全支持 |
| Stripe | PaymentIntent + `Metadata.orderId` + 幂等键 `pi-<orderID>` | `ConstructEvent` | 全支持 |
| Airwallex | PaymentIntent + hosted checkout | **HMAC-SHA256 + 时间戳防重放** | 全支持 |

### 2. EasyPay 回调四层防御（最值得抄）

1. **签名算法**：剔除 `sign`/`sign_type` 与空值，按 key 字典序拼 `k=v&k2=v2`，末尾拼 `pkey`，MD5
2. **常量时间比较**：`hmac.Equal` 防时序侧信道
3. **参数白名单**：只允许 10 个字段，多余字段直接拒绝
   > 原因（注释）：「签名基串是不转义的拼接，若允许 `return_url` 等下单字段回传，攻击者可把**下单 URL 里内嵌的 `trade_status=TRADE_SUCCESS`** 重放为伪造支付成功通知」
4. **值内禁止分隔符**：除 `name` 外任何值含 `&` 或 `=` 即拒绝（保证一个值只对应签名字串的一个字段）
5. **商户号绑定**：`params["pid"]` 必须等于实例配置，**不依赖订单快照**
6. **上游复查**：履约前用本实例凭据回查上游订单，校验「已支付 + 金额容差 0.005 + trade_no 一致」

### 3. 渠道实例与负载均衡

- 实例模型：`provider_key / name / config(加密) / supported_types / payment_mode / limits / refund_enabled`
- 敏感字段在列表接口脱敏
- 选实例：`round-robin`（默认）/ `least-amount`（把 **PENDING 订单金额**也算进当日已用）
- 实例级限额：`InstanceLimits = {DailyLimit, SingleMin, SingleMax}`
- 币种：默认 CNY，按 ISO 维护最小单位与最大小数位（零/二/三套），全程 decimal，手续费按币种精度**向上取整**
- **可见支付方式**：`alipay`/`wxpay` 可被多实例同时支持，通过 `payment_visible_method_*_source` 指定对外展示哪个 provider

### 4. 订单状态机（以「租约 + CAS」为核心）

```
[创建] → PENDING ──┬── 确认已付 → PAID → RECHARGING → COMPLETED
                   ├── 取消 → CANCELLED（宽限期可被 webhook 拉回）
                   └── 超时 → EXPIRED（宽限期同上）
```

**下单阶段**：归一化支付方式 → 校验总开关 → 订单类型白名单（balance/subscription）→ 金额区间 + 取消频率限流 → 计算应付（手续费 + 赠送/折扣）→ 选实例 + 币种一致性 → 事务内：`MaxPendingOrders` + `DailyLimit` + 分配单号 + 落库 PENDING（默认 30 分钟过期）→ 调 provider 出码，失败即 FAILED

**支付确认**：三重校验（provider 归属一致 / 商户身份快照一致 / 金额在币种容差内）
`toPaid` 用**条件更新**实现并发安全：只允许 `PENDING`、或 `CANCELLED`、或 `EXPIRED` 且 **5 分钟宽限期内** → `PAID`；影响 0 行走幂等分支

**履约租约（防重复到账核心）**：
- 先抢租约：条件更新 `PAID`/`FAILED`，或 `RECHARGING` 且超 5 分钟
- 完成后 `markCompleted` 再以 `status=RECHARGING AND updated_at=lease.version` 做 CAS
- **余额到账走「生成兑换码 → 核销」路径**，用兑换码状态做第二层幂等
- 超期支付只写 `PAYMENT_AFTER_EXPIRY` 审计，**不重复到账**

### 5. Token 级计费：链式叠乘

```
TotalCost = 输入 + 输出 + 缓存创建(5m/1h/30m/12h 分档) + 缓存读
          × service_tier 倍率
          × 长上下文倍率
          × 分组高峰倍率          ← 按请求时刻现算，不并入缓存
          × 渠道分时倍率
          × reasoning_effort 倍率
ActualCost = TotalCost × RateMultiplier      ← 真正扣费
```

**`rate_multiplier` 解析链**：
```
系统默认 → 分组默认 → 用户专属覆盖 → 高峰因子
```
- 用户专属倍率走独立缓存 + singleflight，miss 回源、出错**回落分组默认**
- `TotalCost` 保留原始价用于对账与**利润计算**
- **0 与负数的处理**：保存时强制 ≥0；读取时负数按 0（避免按 1x 误扣）；长上下文倍率未配置则按 **1 而非 0**（否则该分项变免费）

**账号侧倍率（成本口径，非售价）**：`Account.BillingRateMultiplier()`（nil→1.0，0 表示免费账号，负数按 1.0），账号配额消耗按 `TotalCost × AccountRateMultiplier`
分组可开启**利润控制**：只调度满足 `U ≤ D×(1−margin−buffer)` 的账号

### 6. 余额模式 vs 订阅模式

| 维度 | 余额模式 | 订阅模式 |
|---|---|---|
| 判定 | 分组 standard 或用户无有效订阅 | 分组订阅型 **且** 有有效订阅 |
| 准入 | 缓存余额 > 0 | 日/周/月剩余额度覆盖本次 |
| 扣费 | `user.balance -= ActualCost` | `subscription.usage += ActualCost` |
| user×platform 配额 | **生效** | **豁免** |
| 在途预占维度 | 余额 + API Key | 订阅 scope + API Key |

### 7. 在途额度预占（最精细的并发设计）

| 机制 | 实现 |
|---|---|
| 原子性 | `ReserveInflightBalance` 一次原子操作：清过期 → 若 `balance − Σ在途 < amount` 拒绝 → 登记 requestID |
| **引用计数生命周期** | 创建持 1 个 handler 引用 + 续期协程；计费任务 `Acquire()` 再取 1；任务扣减完才归还；handler 返回 `HandlerDone()` → **预占一直存在到「handler 结束 且 所有异步计费落地」**，消除「handler 已返回、扣费未落地」窗口 |
| 三维 scope | 余额 + 订阅 `subscription:<id>` + API Key `apikey:<id>`，共用同一 requestID |
| 默认 TTL | 15 分钟，续期周期 TTL/3 |
| fail-open | Redis 异常/估不出价 → 放行不预占；可配 `FailClosedOnUnpriced` 改为拒绝 |
| 估算口径 | 保守取高：token 类（输入估算 + 输出上限）、图片（取所有尺寸档最高单价）、多候选取**最高估算** |

> 这个引用计数设计是整套并发控制里最值得学的：它把「预占的生命周期」与「请求的生命周期」解耦，覆盖了异步计费落地的窗口。

### 8. API Key 体系

| 维度 | 实现 |
|---|---|
| 生成 | `prefix + hex(random 32)`，默认 `sk-`；管理员 `admin-` |
| 自定义 Key 校验 | 长度 ≥16，仅 `[A-Za-z0-9_-]` |
| 数量上限 | `MaxActivePerUser`（按未删计数） |
| 创建频率 | `MaxPerUserPerHour` 固定窗口 + Redis；**删除 Key 不返还次数**（阻断删建循环） |
| 自定义 Key 试错 | 每小时最多 20 次错误 |
| **限速窗口** | **5h / 1d / 7d 三档 USD 上限**，窗口过期自动归零 |
| IP 管控 | 白/黑名单，热路径用**预编译规则**避免重复解析 |

**用户 × 平台配额**：按 `user × platform` 维护日/周/月三档 USD 限额；用量写 Redis，由 flusher 批量落库。**仅余额模式生效**。

### 9. 邀请/兑换码/优惠码

**邀请返利**：
- 返利 = 充值金额 × 有效返利率%（默认 20%，范围 0–100，支持用户专属覆盖）
- 护栏：返利有效期、冻结期（最大 720h）、单被邀请人累计上限、被邀请人数上限 100
- 入账走**幂等审计占位**，避免 webhook 重放重复返利

**兑换码**：类型 `balance / concurrency / subscription / invitation`；核销用 **Redis 锁防并发双花** + 试错限流
> 支付履约**复用兑换码作为到账载体** —— 一套核销逻辑服务两个场景

## 二、前端

### 1. 技术栈

Vue 3.5 + `<script setup>` + TS 5.6 · vue-router 4（全懒加载）· Pinia 2 · **无第三方 UI 库**（Tailwind 3.4 + 自建 `components/common`：DataTable/Modal/Toggle/ConfirmDialog 等）· Vite 5 · chart.js · vue-i18n（zh/en 全量对照 + key 完整性测试）· @tanstack/vue-virtual（大表格虚拟滚动）· xlsx · qrcode · dompurify+marked · driver.js · stripe-js · airwallex SDK

### 2. 页面清单（约 60 个路由）

**公开（18）**：`/setup` 向导 · `/home` 首页 · `/login` · `/register` · `/email-verify` · `/forgot-password` · `/reset-password` · **`/key-usage` 匿名查 Key 用量** · `/legal/:id` · `/model-plaza`（受双开关）· 6 个 OAuth 回调 · `/payment/result` 等 4 个支付落地页

**用户端（20）**：
| 路由 | 功能 |
|---|---|
| `/dashboard` | 余额 + 平台配额 + 趋势图 + 近期记录 |
| `/keys` | **Key 管理**：分组行内切换、三档限速、IP 黑白名单、导入 CC Switch |
| `/usage` | 用量明细 + 筛选 + 导出 |
| `/redeem` `/affiliate` | 兑换 / 邀请分销 |
| `/purchase` | **充值/购买订阅**：快捷金额 + 赠送档位 + 费用明细（原价/折扣/手续费/实付/赠送）+ 支付面板 |
| `/orders` `/subscriptions` | 订单 / 我的订阅 |
| `/monitor` | 渠道状态（v1/v2 切换） |
| `/profile` `/settings/mcp` `/available-channels` | 资料 / MCP / 可用渠道 |

**管理端（24）**：
| 路由 | 功能 |
|---|---|
| `/admin/dashboard` | Key/账号/用户数、今日请求、**实际/账号/标准三口径成本**、Top12 |
| `/admin/ops` | **运维监控**：错误趋势/延迟/吞吐/切换率/并发/告警规则 |
| `/admin/users` | 用户：余额/并发/角色/订阅/平台配额/返利率/封禁 |
| `/admin/groups` | **分组**：倍率、高峰倍率、订阅额度、模型白名单、显式定价、模型路由、利润控制 |
| `/admin/channels/pricing` | 渠道定价：价卡覆盖、分时倍率、区间价、按次价 |
| `/admin/channels/monitor` | 渠道监控 v2/v1 |
| `/admin/accounts` | **账号管理**（2645 行，最复杂） |
| `/admin/settings` | 系统设置（**55 万字符巨型单页**） |
| `/admin/orders/*` | 支付看板 / 订单（重试履约、发起退款）/ 套餐 |
| 其余 | 插件/公告/代理/兑换码/优惠码/风控/Prompt 审计/全站用量/返利三页 |

### 3. 权限四层收敛（`router/index.ts:805-1003`）

1. `requiresAuth`：未登录 → `/login?redirect=`
2. `requiresAdmin`：非管理员 → `/dashboard`；管理员首次进入触发合规确认拉取
3. **功能开关**：仅在设置**成功加载且显式为 false** 时拦截，**加载失败视为未知（放行）**
4. 简易模式屏蔽 4 个路由；Backend 模式下非管理员仅白名单
5. 侧边栏二级过滤：`featureFlag` + `hideInSimpleMode`

### 4. 账号管理页（全后台最复杂）

- `DataTable` 服务端排序 + **虚拟滚动**（阈值 50 行，估算行高 156）+ 自动刷新 5/10/15/30s
- **20 列**：name/id/platform_type/capacity/status/schedulable/today_stats/groups/usage/proxy/priority/**scheduler_score**/rate_multiplier/**upstream_billing_rate**/last_used_at/expires_at/notes/actions
- **9 类健康状态**：`rate_limited`（含恢复倒计时）· `overloaded` · 临时停调 · `credits_exhausted` · 按模型维度限流 · `quota_exceeded` · `paused` · `error`
- **按平台差异化额度窗口**：Anthropic 5h/7d、Codex 5h/7d、Gemini 3 Pro/Flash/Image、Antigravity 按模型族、Grok 免费 24h/预付/月度、国产余额与 Coding Plan
- 数据来源区分 `passiveSampled`（响应头被动采样）/ `activeQuery`（主动查询）；**查询失败展示缓存值并标注时间**
- 单条 + 批量一键重置、导入导出、上游倍率探测

### 5. 三处看板

1. `/admin/dashboard`：**实际 / 账号 / 标准三口径成本对比**
2. `/admin/ops`：17 个组件，错误/延迟/吞吐/切换率/并发/告警
3. `/admin/orders/dashboard`：支付方式分布与 Top 用户

## 三、对 LTZY 的启示

### 支付部分（与 LTZY 直接相关）

LTZY 已有易支付 V1/V2 + `pay.verify` + `handle_pay_notify`。对比后需要加固的点：

| 缺口 | Sub2API 做法 | LTZY 建议 |
|---|---|---|
| **参数白名单** | 只允许 10 个字段，多余拒绝 | **必加**。LTZY 当前 `param` 接收全部 query 参数参与验签 |
| **值内禁止分隔符** | 除 `name` 外含 `&`/`=` 即拒绝 | **必加**。防「值污染签名字串」攻击 |
| **常量时间比较** | `hmac.Equal` | LTZY 已用 `hmac.compare_digest` ✓ |
| **商户号绑定** | `pid` 必须等于配置，不依赖快照 | LTZY 应校验 |
| **上游复查** | 履约前回查上游订单（金额容差 + trade_no） | 可选（需额外 API 调用），但**金额容差校验必做** |
| **订单状态机** | 7 状态 + 租约 CAS + 宽限期 | LTZY 只有 `pending/paid`，需扩展到含 `cancelled/expired/refunding` |
| **履约租约** | 条件更新抢 5 分钟租约 + `updated_at` CAS | **必加**。LTZY 当前靠 `WHERE status='pending'` 单条 UPDATE 已部分实现幂等 |
| **兑换码复用** | 支付履约走「生成兑换码→核销」做第二层幂等 | LTZY 可直接用 `recharges` 状态机 |

### 计费部分

**LTZY 可立即借鉴**：
1. **`TotalCost` 与 `ActualCost` 分离**：原始价保留用于对账/利润，`ActualCost` 才扣费。LTZY 现在只有一个 `cost`
2. **三口径成本**：实际（用户付）/ 账号（上游成本）/ 标准（目录价）—— 这直接支撑「利润看板」这个 Neo API 的空位
3. **负数倍率按 0 处理、未配置倍率按 1** —— 两条防「误扣/免费」的具体规则
4. **多时间窗限额**：5h/1d/7d 三档，比单一预算更细

**在途预占**：LTZY 已有 `reserved` 字段（预扣-结算），但**无引用计数机制**。若未来有异步计费，需要引入。

### 前端部分

**LTZY 是原生 JS，不引入 Vue**。可借鉴：
1. **「显式 false 才拦截，加载失败放行」** 的开关判断哲学 —— 避免配置服务抖动导致全站不可用
2. **虚拟滚动**（LTZY 日志 200 条目前够用）
3. **`/key-usage` 匿名查询** —— 用户不登录也能查自己 Key 的用量，体验很好
4. **账号状态指示器含恢复倒计时** —— 比单纯「限流中」有用得多
