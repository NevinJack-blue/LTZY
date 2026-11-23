# 对标分析：Neo API / Sub2API

> 两份开源网关的完整源码解析，作为 LTZY 功能规划与实现的参考基线。
> 分析日期：2026-11-24。

## 要点先看

- **[ROADMAP.md](ROADMAP.md)** —— 能力矩阵、差距清单、分阶段路线图、立即可做的三件事
- 一句话结论：不在「上游数量」和「集群规模」上追，在「零依赖可审计」「请求级成本透明」「账单可复算」上做到极致

## 两个对标项目

| 项目 | 定位 | 规模 | 贡献的视角 |
|---|---|---|---|
| **New API** | 通用模型网关：多渠道、多协议、完整计费与运营 | 28.7 万行 Go，1135 文件 | 「网关能力全景图」与成熟计费/渠道/权限体系 |
| **Sub2API** | 订阅账号转 API 的拼车平台：账号池、粘性会话、Token 计费 | 111 万行 Go，3317 文件 | 「账号资产化」与「订阅共享经济模型」 |

```
New API  = 「广度」：上游多、协议多、页面多、配置多
Sub2API  = 「深度」：账号资产化、调度智能化、成本精细化
LTZY     = 「轻」：零依赖、单文件、可审计、数据不出本机
```

## 报告索引

### New API（5 篇）

| 报告 | 主题 | 核心发现 |
|---|---|---|
| [neo-api-routes-auth.md](neo-api-routes-auth.md) | 路由、中间件、鉴权、权限、多租户 | **PAT scope fail-closed**：新增路由忘声明 scope 即 403 并打错误日志；**按用途派生密钥**；step-up 一次性 proof 绑 scope+context |
| [neo-api-data-model.md](neo-api-data-model.md) | 38 张表、abilities 物化、计费公式 | **abilities 物化表**把路由查询从 `LIKE` 变成索引；**FundingSource 接口**把钱包/订阅差异关进 4 个方法 |
| [neo-api-relay.md](neo-api-relay.md) | 多协议转发、40 个适配器、协议转换 | **relaykit 注册表**把 N×N 降到 O(N)；「工具提取→主体转换→工具回填」三段式；**28 份黄金快照** |
| [neo-api-frontend.md](neo-api-frontend.md) | 前端架构、70+ 页面清单、设计系统 | `SectionPageLayout` 四槽 + `DataTablePage` 两件套套出所有页；**菜单可见性由后端两个 JSON 字段驱动** |
| [neo-api-business.md](neo-api-business.md) | 计费、支付、兑换、渠道运营、用户运营 | **表达式定价**「One expression, one truth」；**日志三级可见性**从写入侧隔离；渠道**被动恢复模式**只恢复不禁用 |

### Sub2API（4 篇）

| 报告 | 主题 | 核心发现 |
|---|---|---|
| [sub2api-account-pool.md](sub2api-account-pool.md) | 账号池、OAuth 刷新、调度器、并发、粘性 | **`invalid_grant` 竞争恢复**（重读 DB 比较 refresh_token）；**失败作用域模型**防雪崩；**ZSET+Lua 并发槽位**；**use-it-or-lose-it** |
| [sub2api-protocol.md](sub2api-protocol.md) | 4×4 协议转换、流式、原生客户端兼容 | **工具名后到时的延迟公告**；**Responses 流事件手工 Marshal**（omitempty 会丢必填零值）；**HTTP/2 PING 让死连接 15s 内发现** |
| [sub2api-biz-ui.md](sub2api-biz-ui.md) | 5 家支付渠道、订单状态机、Token 计费、前端 | **EasyPay 四层防御**（白名单+分隔符+pid+上游复查）；**履约租约 + CAS**；**在途预占的引用计数生命周期** |
| [sub2api-arch.md](sub2api-arch.md) | Ent 数据模型、分层、配置、集群、部署 | **schema 双源风险**（Ent 只覆盖 39 张，80+ 张靠 SQL）；**settings 无跨实例广播**；调度用 outbox 而非 leader lock |

## 对 LTZY 最有价值的 10 个机制

按「可立即用」到「中期考虑」排序：

| # | 机制 | 出处 | 价值 |
|---|---|---|---|
| 1 | **易支付回调四层防御** | Sub2API | 参数白名单 + 值内禁分隔符 + pid 绑定 + 金额容差。**半天可落地，堵住真实风险面** |
| 2 | **失败作用域模型** | Sub2API | 区分「线路/上游/请求」问题，避免误判重试与雪崩 |
| 3 | **成本/售价双轨 + 请求级毛利** | Sub2API 三口径（New API 明文承认缺这块） | **两家都没做好的差异化卖点** |
| 4 | **会话版本栅栏** | New API `auth_version` | 改密即踢端，无需遍历会话 |
| 5 | **PAT scope fail-closed** | New API | 忘声明即拒绝并报警，而非默默放行 |
| 6 | **可诊断的失败理由** | Sub2API | 「无可用线路」返回具体原因而非笼统 503 |
| 7 | **多形状错误体容错解析** | New API `GeneralErrorResponse` | 8 种形状优先级取值，直接减少接入摩擦 |
| 8 | **日志三级可见性** | New API `LogOther` | 从**写入侧**隔离字段，比读取侧过滤安全 |
| 9 | **价格版本历史 + 按历史价复算** | 两家都缺 | LTZY 定位「账本」应做到 |
| 10 | **转换损耗诊断** | New API | 记录丢了哪些字段，而非静默丢弃 |

## 明确不照搬的

| 项 | 理由 |
|---|---|
| 40 个上游适配器 | 数年积累且需真实联调；LTZY 只做 5-8 家主流 |
| 多实例集群（outbox/leader lock） | 单机产品无此需求，硬做只增故障面 |
| 账号池拼车 | 涉及 OAuth 逆向、指纹伪装、订阅条款风险 |
| 1.5 万行调度器 | LTZY 账号规模不需要 |
| React/Vue 前端 | 会破坏「零依赖」承诺 |
| 表达式定价引擎 | LTZY 模型少，固定单价够用 |

## 许可提醒

- **New API 是 AGPL-3.0**（含附加条款）。可学架构与交互设计，**不可复制代码**。复用需先做许可审查并接受 AGPL 传染。
- **Sub2API** 见其 `LICENSE`，需单独核对。
- **LTZY 当前无 LICENSE 文件** —— 发布协作前应先确定许可。

## 代码位置

- New API：`references/neo-api/`
- Sub2API：`references/sub2api/`

两者均未纳入版本库（见 `.gitignore`）。
