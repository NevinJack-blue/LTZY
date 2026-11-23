# LTZY · v4 视觉与交互规范

本轮在 v3「Liquid Signal Studio」基础上完成两件事：官网与工作台统一支持**亮 / 暗双主题**（默认亮色），并把入场动效从全屏 Canvas 重写为 **DOM + WAAPI 编排**。本文记录 v4 的现状口径；v3 的构图与动效分镜仍然有效，冲突处以本文为准。

## 主题

- 默认亮色：冰蓝、银白、青色反光；暗色：深海蓝底、金属高光降档。`preferences.js` 在 CSS 加载前同步写入 `html[data-theme]`，已保存夜间偏好时不闪白。
- 自动模式下依据 `saveData`、`deviceMemory`、`hardwareConcurrency` 保守降级到流畅模式；用户可选完整画质 / 流畅 / 自动，选择持久保存。
- 「减少动态效果」独立于主题与画质，尊重系统 `prefers-reduced-motion`；切换与路由卸载均清理自身动画。
- 关键变量由 `base.css` 提供，`shell-theme.css` 覆盖导航壳层；两主题的验证口径见「验收」一节。

## 动效（motion.js v4）

- 渲染器 `dom-sequential`：测量真实页面边界生成取景框（`.ltzy-box`）、逐字打字层（`.ltzy-type`）、连接线与四团队协作光标；Canvas 像素恒为 0。
- 时间表：intro 总长约 5.4s，replay 7.5s，阶段 LAYOUT → TYPE → ROUTE → BUILD 错峰启动；切页路由动效约 0.6s。
- 光标数量：完整画质 20，流畅模式 14；帧时采样超阈值自动降级（`sampled-frame-time`）。
- 叠层非阻塞：`inert` 恒为 false，pointer-events none；Esc、点击、滚动、页面隐藏、画质切换均可即时退出并清理。
- 统计由 `window.__ltzyMotionStats` 暴露（版本、模式、阶段、帧时、结束原因），验收直接读取，不靠目测。

## 实测口径（2026-11-23）

默认入场约 1202–1224ms，重播约 2501ms（新表 7.5s 含尾声淡出），路由约 360ms。390px DPR3、4 倍 CPU 节流平均 RAF 间隔约 17ms；桌面 1 倍约 32ms、6 倍约 48ms，触发低帧自动降级。RAF 间隔不是 GPU 呈现 FPS，移动数据来自 CDP 仿真而非真机。

## 验收

浏览器断言已入库为可复跑脚本（自起隔离实例，不依赖正在运行的服务，不写用户账本）：

```shell
python scripts/checks/public_checks.py   # 官网 29 项
python scripts/checks/desk_checks.py    # 工作台 42 项
```

覆盖：两主题 × 两视口 × 全部页面无横向溢出、终端命令切换、手动 429 回退、回执弹窗字段、模型筛选与详情、Python 流式示例、状态页真实刷新、流畅模式去模糊、密钥一次性展示与撤销、local/echo 真实调用、只读权限分叉、预算取消不落库、对账比较、CSV 导出。报告与截图写入 `.ltzy/checks/<name>/`（不入库）。

后端回归仍以 `python -m unittest discover -s tests` 为准（20 项）。
