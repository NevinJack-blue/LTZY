"""官网（public 侧）浏览器验收：29 项断言。

迁移自 .ltzy/public-v4-check.mjs，去掉对本机 oil-ui CDP helper 的依赖，
改为自起隔离实例 + Playwright(Edge)。断言口径与原脚本一致：
两主题 × 两视口 × 四页面无溢出、终端命令切换、手动 429 回退、
回执弹窗、模型筛选与详情、Python 流式示例、状态页真实刷新、lite 降级。

用法：
    python scripts/checks/public_checks.py [--port 18701] [--out DIR] [--headed]
"""

import argparse
import sys

from harness import Checks, LocalInstance, edge, quiet_intro

THEMES = ("light", "dark")
VIEWPORTS = ((1440, 1000), (390, 844))
PAGES = ("home", "models", "docs", "status")


def run(port, out_dir, headed):
    checks = Checks("public", out_dir)
    with LocalInstance(port) as inst, edge(headless=not headed) as page:
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(inst.base + "/#home")
        page.wait_for_selector(".pa-hero")
        quiet_intro(page)

        # 1) 两主题 × 两视口 × 四页面：无横向溢出 + 截图
        for theme in THEMES:
            page.evaluate("t => document.documentElement.dataset.theme = t", theme)
            for width, height in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                for name in PAGES:
                    page.evaluate("p => location.hash = p", name)
                    page.wait_for_selector(".pa-page-%s h1" % name)
                    page.wait_for_timeout(250)
                    layout = page.evaluate("""() => ({
                        view: document.body.dataset.view,
                        width: innerWidth,
                        scrollWidth: document.documentElement.scrollWidth,
                        build: document.querySelectorAll('[data-build]').length
                    })""")
                    checks.check(layout["scrollWidth"] <= width,
                                 "no overflow %s %s %s" % (name, width, theme))
                    checks.shot(page, "%s-%d-%s.png" % (name, width, theme))

        # 2) 终端命令切换 + 拓扑节点检查
        page.evaluate("() => location.hash = 'home'")
        page.wait_for_selector(".pa-run")
        page.click("[data-command=stream]")
        stream_ok = page.evaluate("""() => document.querySelector('.pa-terminal-code').textContent.includes('stream')
            && document.querySelector('.pa-transport').textContent.includes('event-stream')""")
        checks.check(stream_ok, "terminal stream command")

        page.click("[data-command=models]")
        checks.check(page.evaluate(
            "() => document.querySelector('.pa-terminal-code').textContent.includes('/v1/models')"),
            "terminal models command")

        page.click("[data-node=gateway]")
        checks.check(page.evaluate(
            "() => document.querySelector('.pa-node-spec').textContent.includes('预留预算')"),
            "topology gateway inspection")

        # 3) 手动 429 回退完整跑完
        page.evaluate("""() => {
            const modes = document.querySelectorAll('[data-mode]');
            modes[1].click();
            document.querySelector('.pa-run').click();
        }""")
        page.wait_for_timeout(2200)
        checks.check(page.evaluate(
            "() => document.querySelector('.pa-result').innerText.includes('回退完成')"),
            "manual 429 fallback completes")

        # 4) 回执弹窗字段
        page.click(".receipt")
        checks.check(page.evaluate("""() => document.querySelector('#sheet').open
            && document.querySelector('#sheet').innerText.includes('pricing_snapshot')"""),
            "receipt modal fields")
        page.evaluate("() => document.querySelector('#sheet').close()")

        # 5) 模型筛选空态与详情
        page.evaluate("() => location.hash = 'models'")
        page.wait_for_selector(".pa-model-card")
        page.wait_for_timeout(150)
        page.evaluate("""() => {
            const input = document.querySelector('.pa-catalog-filter input');
            input.value = 'no-such-model';
            input.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        checks.check(page.evaluate("() => !!document.querySelector('[data-reset]')"),
                     "model empty filter")
        page.click("[data-reset]")
        page.click("[data-detail]")
        checks.check(page.evaluate("""() => document.querySelector('#sheet').open
            && document.querySelector('#sheet').innerText.includes('local/echo')"""),
            "model detail real ID")
        page.evaluate("() => document.querySelector('#sheet').close()")

        # 6) 文档页 Python 流式示例
        page.evaluate("() => location.hash = 'docs'")
        page.wait_for_selector(".pa-codebox")
        page.click(".pa-lang button:last-child")
        page.click(".pa-stream-toggle input")
        checks.check(page.evaluate("""() => {
            const pre = document.querySelector('pre').textContent;
            return pre.includes('True') && pre.includes('for line in res');
        }"""), "Python streaming example")

        # 7) 状态页刷新命中真实 API
        page.evaluate("() => location.hash = 'status'")
        page.wait_for_selector("[data-refresh]")
        page.click("[data-refresh]")
        page.wait_for_selector(".pa-stats")
        checks.check(page.evaluate(
            "() => document.querySelector('.pa-stats').innerText.includes('累计请求')"),
            "status refresh actual API")

        # 8) 流畅模式降级：去阴影、无 SVG、无 backdrop-filter
        page.evaluate("() => { document.documentElement.dataset.quality = 'lite'; location.hash = 'home'; }")
        page.wait_for_selector(".pa-lab")
        page.wait_for_timeout(150)
        checks.check(page.evaluate(
            "() => getComputedStyle(document.querySelector('.pa-lab')).boxShadow === 'none'"),
            "lite mode removes terminal shadow")
        checks.check(page.evaluate("() => document.querySelectorAll('.pa svg').length === 0"),
                     "no complex public SVG")
        checks.check(page.evaluate(
            "() => getComputedStyle(document.querySelector('.pa-lab')).backdropFilter === 'none'"),
            "no terminal backdrop blur")

        checks.check(len(errors) == 0, "no JavaScript errors")
        if errors:
            checks.error("pageerror", errors)

    return checks.finish()


def main():
    parser = argparse.ArgumentParser(description="LTZY 官网验收")
    parser.add_argument("--port", type=int, default=18701)
    parser.add_argument("--out", default=None)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    return run(args.port, args.out, args.headed)


if __name__ == "__main__":
    sys.exit(main())
