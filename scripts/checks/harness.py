"""LTZY 浏览器验收脚本的公共框架。

设计目标：一条命令自起隔离实例 + 隔离数据目录，跑完整断言，退出后清理，
不依赖正在运行的服务，也不写入用户的 .ltzy 账本。断言标签用英文短句，
避免 Windows 控制台 GBK 显示乱码；报告写入 UTF-8 JSON。
"""

import contextlib
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SERVER = ROOT / "server.py"


def port_free(port):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
        except OSError:
            return False
        return True


def wait_http(url, timeout=25.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.1)
    return False


class LocalInstance:
    """启动一个仅供验收使用的 server.py 实例。"""

    def __init__(self, port=18701, data_dir=None):
        self.port = port
        self.dir = pathlib.Path(data_dir) if data_dir else None
        self.proc = None

    @property
    def base(self):
        return "http://127.0.0.1:%d" % self.port

    def start(self):
        if not port_free(self.port):
            raise RuntimeError("port %d is already in use" % self.port)
        if self.dir is None:
            self.dir = pathlib.Path(tempfile.mkdtemp(prefix="ltzy-check-"))
        self.dir.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER), "--port", str(self.port), "--data-dir", str(self.dir)],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not wait_http(self.base + "/"):
            self.stop()
            raise RuntimeError("instance on port %d did not become ready" % self.port)
        return self

    @property
    def password(self):
        path = self.dir / "admin-password.txt"
        for _ in range(50):
            if path.is_file() and path.read_text(encoding="utf-8").strip():
                return path.read_text(encoding="utf-8").strip()
            time.sleep(0.1)
        raise RuntimeError("admin password was not generated in %s" % self.dir)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        self.proc = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False


class Checks:
    """收集断言结果，一次跑完再汇总，避免首个失败就中断。"""

    def __init__(self, name, out_dir=None):
        self.name = name
        self.out = pathlib.Path(out_dir) if out_dir else ROOT / ".ltzy" / "checks" / name
        self.out.mkdir(parents=True, exist_ok=True)
        self.report = {"name": name, "passed": [], "failed": [], "errors": [], "screenshots": []}

    def check(self, ok, label):
        (self.report["passed"] if ok else self.report["failed"]).append(label)

    def error(self, label, detail=""):
        self.report["errors"].append({"label": label, "detail": str(detail)[:400]})

    def shot(self, page, filename):
        path = self.out / filename
        page.screenshot(path=str(path))
        self.report["screenshots"].append(filename)
        return path

    def finish(self):
        total = len(self.report["passed"]) + len(self.report["failed"])
        self.report["total"] = total
        path = self.out / "report.json"
        path.write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[%s] %d/%d checks passed, %d errors -> %s"
              % (self.name, len(self.report["passed"]), total, len(self.report["errors"]), path))
        for label in self.report["failed"]:
            print("  FAILED:", label)
        for item in self.report["errors"]:
            print("  ERROR:", item["label"], item["detail"][:200])
        return 1 if self.report["failed"] or self.report["errors"] else 0


@contextlib.contextmanager
def edge(headless=True, width=1440, height=900):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=headless)
        page = browser.new_page(viewport={"width": width, "height": height})
        try:
            yield page
        finally:
            browser.close()


def quiet_intro(page):
    """关闭入场动效，让断言只测界面本身。"""
    page.evaluate("""() => {
        localStorage.setItem('ltzy-reduced-motion','true');
        document.documentElement.classList.add('motion-quiet');
    }""")
