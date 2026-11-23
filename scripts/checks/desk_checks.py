"""工作台（desk 侧）浏览器验收。

迁移自 .ltzy/desk-v4-check.mjs：登录、密钥一次性展示、真实 local/echo 调用、
只读权限分叉、两主题 × 两视口 × 五页面无溢出、日志筛选、预算取消与确认、
对账比较、CSV 导出、撤销密钥、终端快照、流畅模式去模糊。

用法：
    python scripts/checks/desk_checks.py [--port 18702] [--out DIR] [--headed]
"""

import argparse
import sys

from harness import Checks, LocalInstance, edge, quiet_intro

THEMES = ("light", "dark")
VIEWPORTS = ((1440, 1000), (390, 844))
PAGES = ("console", "keys", "logs", "usage", "ops")


def run(port, out_dir, headed):
    checks = Checks("desk", out_dir)
    with LocalInstance(port) as inst, edge(headless=not headed) as page:
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(inst.base + "/#console")
        page.wait_for_selector("#admin-pass")
        quiet_intro(page)
        page.fill("#admin-pass", inst.password)
        page.evaluate("() => document.querySelector('.gate form').requestSubmit()")
        page.wait_for_selector(".dk-main")
        checks.check(True, "authenticated console entry")

        # 1) 创建 chat 密钥：一次性明文展示，关闭后从 DOM 消失
        page.evaluate("() => location.hash = 'keys'")
        page.wait_for_selector('.dk-main[data-page="keys"]')
        page.fill("#dk-name", "Console visual verification")
        page.select_option("#dk-scope", "chat")
        page.evaluate("() => document.querySelector('[data-form=create]').requestSubmit()")
        page.wait_for_selector(".dk-secret code")
        secret = page.evaluate("() => document.querySelector('.dk-secret code').textContent")
        checks.check(secret.startswith("ltzy_"), "one-time secret created")
        page.evaluate("() => document.querySelector('#sheet').close()")
        page.wait_for_selector("[data-revoke]")
        checks.check(not page.evaluate(
            "() => document.body.innerText.includes(%s)" % repr(secret)),
            "secret removed after closing")

        # 2) 用该密钥真实调用 local/echo
        request = page.evaluate("""async () => {
            const r = await fetch('/v1/chat/completions', {method: 'POST',
                headers: {'Content-Type': 'application/json',
                          Authorization: %s},
                body: JSON.stringify({model: 'local/echo',
                    messages: [{role: 'user', content: 'Console verification'}],
                    max_tokens: 24})});
            return {status: r.status, body: await r.json()};
        }""" % repr("Bearer " + secret))
        checks.check(request["status"] == 200, "actual local-test completion")
        page.wait_for_timeout(250)

        # 3) 只读密钥：models 允许、chat 拒绝
        page.fill("#dk-name", "Read-only verification")
        page.select_option("#dk-scope", "read")
        page.evaluate("() => document.querySelector('[data-form=create]').requestSubmit()")
        page.wait_for_selector(".dk-secret code")
        read_secret = page.evaluate("() => document.querySelector('.dk-secret code').textContent")
        read_status = page.evaluate("""async () => {
            const h = {Authorization: %s};
            const m = await fetch('/v1/models', {headers: h});
            const r = await fetch('/v1/chat/completions', {method: 'POST',
                headers: {...h, 'Content-Type': 'application/json'},
                body: JSON.stringify({model: 'local/echo',
                    messages: [{role: 'user', content: 'scope test'}]})});
            return [m.status, r.status];
        }""" % repr("Bearer " + read_secret))
        checks.check(read_status[0] == 200 and read_status[1] == 403,
                     "read scope permits models and rejects chat")
        page.evaluate("() => document.querySelector('#sheet').close()")

        # 4) 两主题 × 两视口 × 五页面：无溢出 + 截图
        for theme in THEMES:
            page.evaluate("t => document.documentElement.dataset.theme = t", theme)
            for width, height in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                for name in PAGES:
                    page.evaluate("p => location.hash = p", name)
                    page.wait_for_selector('.dk-main[data-page="%s"]' % name)
                    page.wait_for_timeout(150)
                    layout = page.evaluate("""() => ({
                        scroll: document.documentElement.scrollWidth,
                        h1: document.querySelector('.dk h1').textContent,
                        build: document.querySelectorAll('.dk [data-build]').length
                    })""")
                    checks.check(layout["scroll"] <= width,
                                 "no overflow %s %s %s" % (name, width, theme))
                    checks.shot(page, "%s-%s-%d.png" % (name, theme, width))

        # 5) 日志页：真实轨迹、筛选空态、重置恢复、模型与状态筛选
        page.evaluate("() => location.hash = 'logs'")
        page.wait_for_selector('.dk-main[data-page="logs"]')
        checks.check(page.evaluate("() => !!document.querySelector('.dk-trace li')"),
                     "receipt actual routing trace")
        page.evaluate("""() => {
            const q = document.querySelector('[name=query]');
            q.value = 'not-a-request';
            q.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        checks.check(page.evaluate(
            "() => document.querySelector('[data-results]').textContent.includes('没有匹配')"),
            "log filter empty state")
        page.evaluate("() => document.querySelector('[data-form=filters]').reset()")
        page.wait_for_timeout(80)
        checks.check(page.evaluate(
            "() => !!document.querySelector('[data-results] [data-receipt]')"),
            "filter reset restores actual receipt")
        page.evaluate("""() => {
            const m = document.querySelector('[name=model]');
            m.value = 'local/echo';
            m.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        checks.check(page.evaluate(
            "() => !!document.querySelector('[data-results] [data-receipt]')"),
            "model filter returns actual receipt")
        page.evaluate("""() => {
            const s = document.querySelector('[name=status]');
            s.value = 'failed';
            s.dispatchEvent(new Event('input', {bubbles: true}));
        }""")
        checks.check(page.evaluate(
            "() => document.querySelector('[data-results]').textContent.includes('没有匹配')"),
            "status filter separates failed requests")

        # 6) 用量页：预算修改取消不落库，确认后持久
        page.evaluate("() => location.hash = 'usage'")
        page.wait_for_selector('.dk-main[data-page="usage"]')
        page.evaluate("""() => {
            document.querySelector('#dk-limit').value = '90';
            document.querySelector('[data-form=budget]').requestSubmit();
        }""")
        page.wait_for_selector("[data-no]")
        page.click("[data-no]")
        checks.check(not page.evaluate("() => !!document.querySelector('[data-yes]')"),
                     "budget cancel clears pending mutation")
        checks.check(page.evaluate("""async () =>
            (await (await fetch('/api/workspace')).json()).budget.limit !== 90"""),
            "cancel does not mutate server budget")
        page.click("[data-refresh]")
        page.wait_for_timeout(150)
        checks.check(page.evaluate("() => !!document.querySelector('#dk-limit')"),
                     "manual refresh reloads budget controls")
        page.evaluate("""() => {
            document.querySelector('#dk-limit').value = '120';
            document.querySelector('[data-form=budget]').requestSubmit();
        }""")
        page.wait_for_selector("[data-yes]")
        page.click("[data-yes]")
        page.wait_for_timeout(200)
        checks.check(page.evaluate(
            "() => document.querySelector('#dk-limit').value === '120'"),
            "budget confirmed persisted")

        # 7) 对账页：比较输出 + CSV 导出
        page.evaluate("() => location.hash = 'ops'")
        page.wait_for_selector('.dk-main[data-page="ops"]')
        page.evaluate("""() => {
            document.querySelector('#dk-reference').value = '0';
            document.querySelector('[data-form=compare]').requestSubmit();
        }""")
        checks.check(page.evaluate("() => !!document.querySelector('output').textContent"),
                     "reconciliation comparison output")
        csv = page.evaluate("""async () => {
            const r = await fetch('/api/usage.csv');
            return {status: r.status, text: await r.text()};
        }""")
        checks.check(csv["status"] == 200, "CSV export authenticated")

        # 8) 撤销密钥并验证 401
        page.evaluate("() => location.hash = 'keys'")
        page.wait_for_selector('.dk-main[data-page="keys"]')
        page.evaluate("""() => Array.from(document.querySelectorAll('.dk-table tr'))
            .find(r => r.textContent.includes('Console visual verification')
                       && r.querySelector('[data-revoke]'))
            .querySelector('[data-revoke]').click()""")
        page.wait_for_selector("[data-yes]")
        page.click("[data-yes]")
        page.wait_for_timeout(200)
        checks.check(page.evaluate(
            "() => document.querySelector('.dk-key-layout').textContent.includes('已撤销')"),
            "key revoke persisted")
        denied = page.evaluate("""async () =>
            (await fetch('/v1/models', {headers: {Authorization: %s}})).status"""
            % repr("Bearer " + secret))
        checks.check(denied == 401, "revoked key denied")

        # 9) 终端快照来自真实账本
        page.evaluate("() => location.hash = 'console'")
        page.wait_for_selector('.dk-main[data-page="console"]')
        page.evaluate("() => document.querySelector('.dk-terminal').open = true")
        page.click("[data-snapshot=routes]")
        checks.check(page.evaluate(
            "() => document.querySelector('[data-terminal-output]').textContent.includes('local-test')"),
            "terminal route snapshot from actual workspace")
        page.click("[data-snapshot=receipt]")
        checks.check(page.evaluate(
            "() => document.querySelector('[data-terminal-output]').textContent.includes('settled')"),
            "terminal receipt snapshot from actual requests")

        # 10) 流畅模式去侧栏模糊
        page.evaluate("() => document.documentElement.dataset.quality = 'lite'")
        page.wait_for_timeout(120)
        checks.check(page.evaluate(
            "() => getComputedStyle(document.querySelector('.dk-side')).backdropFilter === 'none'"),
            "lite mode disables sidebar blur")

        checks.check(len(errors) == 0, "no JavaScript errors")
        if errors:
            checks.error("pageerror", errors)

    return checks.finish()


def main():
    parser = argparse.ArgumentParser(description="LTZY 工作台验收")
    parser.add_argument("--port", type=int, default=18702)
    parser.add_argument("--out", default=None)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    return run(args.port, args.out, args.headed)


if __name__ == "__main__":
    sys.exit(main())
