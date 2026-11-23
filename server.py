"""Local LTZY control plane. Use a private data directory on a loopback interface."""
import argparse
import csv
import hashlib
import io
import json
import mimetypes
import os
import secrets
import sqlite3
import time
from collections import deque
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import unquote, urlsplit

WEB = Path(__file__).resolve().parent / 'web'
TTL = 12 * 3600
COOKIE = 'ltzy_session'
SCHEMA = '''
CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
 digest TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), budget_micros INTEGER NOT NULL);
INSERT OR IGNORE INTO settings VALUES(1,25000000);
CREATE TABLE IF NOT EXISTS lane_settings(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reconciliation_audit(receipt_id TEXT PRIMARY KEY, note TEXT NOT NULL, at TEXT NOT NULL,
 input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
'''


class Problem(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def connect(path):
    db = sqlite3.connect(path, timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def key_view(row):
    return {**{k: row[k] for k in ('id','name','prefix','created_at','scope')}, 'revoked': bool(row['revoked'])}


def text(obj, key, size):
    val = obj.get(key)
    if not isinstance(val, str) or not val.strip() or len(val) > size or not val.isprintable():
        raise Problem(400, 'Invalid ' + key)
    return val.strip()


def micros(value):
    try:
        val = Decimal(str(value))
        if not val.is_finite() or not 0 <= val <= 1000000000 or val.as_tuple().exponent < -6:
            raise ValueError()
        return int(val * 1000000)
    except (ValueError, InvalidOperation):
        raise Problem(400, 'Budget must be a USD amount with at most six decimal places')


def bootstrap_password(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(secrets.token_urlsafe(32) + '\n')
    password = path.read_text(encoding='utf-8').strip()
    if not password:
        raise ValueError('Empty admin password file')
    return digest(password)


class Handler(BaseHTTPRequestHandler):
    timeout = 20
    server_version = 'LTZY'
    sys_version = ''

    def log_message(self, *args):
        pass  # Paths, request headers, payloads and credentials must never be logged.

    def reply(self, code, data, typ='application/json; charset=utf-8', headers=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=True, allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', typ)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        for k,v in (headers or {}).items():
            self.send_header(k,v)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        if self.headers.get_content_type() != 'application/json':
            raise Problem(415, 'Send application/json')
        lengths = self.headers.get_all('Content-Length', [])
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit() or self.headers.get('Transfer-Encoding'):
            raise Problem(400, 'Invalid content length')
        if len(lengths[0]) > 8 or int(lengths[0]) > 16384:
            raise Problem(413, 'Request is too large')
        try:
            data = json.loads(self.rfile.read(int(lengths[0])).decode('utf-8'), parse_float=Decimal)
            if not isinstance(data, dict):
                raise ValueError()
        except (ValueError, UnicodeError, RecursionError):
            raise Problem(400, 'Expected a JSON object')
        return data

    def session(self):
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get('Cookie',''))
            return digest(jar[COOKIE].value)
        except (KeyError,CookieError):
            return ''

    def run(self):
        try:
            host = self.headers.get('Host','').lower()
            if self.headers.get_all('Host') != [self.headers.get('Host')] or host not in self.server.hosts:
                raise Problem(403, 'Unrecognized local host')
            if self.headers.get('Sec-Fetch-Site') == 'cross-site' or any(o != 'http://' + host for o in self.headers.get_all('Origin', [])):
                raise Problem(403, 'Cross-origin requests are not allowed')
            path = urlsplit(self.path).path
            if path.startswith('/v1/'):
                self.server.gateway.dispatch(self, self.server.db_path)
                return
            if path.startswith('/api/'):
                with closing(connect(self.server.db_path)) as db:
                    result, headers = self.api(db,path)
                    db.commit()  # Commit before disclosing any key or session.
                if isinstance(result,bytes):
                    self.reply(200,result,'text/csv; charset=utf-8',headers)
                else:
                    self.reply(200,result,headers=headers)
            elif self.command == 'GET':
                rel = unquote(path).lstrip('/') or 'index.html'
                if '\\' in rel or ':' in rel or '\x00' in rel or any(p.startswith('.') for p in rel.split('/')):
                    raise Problem(404,'Not found')
                target = (WEB / rel).resolve()
                if WEB not in target.parents or not target.is_file():
                    raise Problem(404,'Not found')
                typ = {'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'}.get(target.suffix) or mimetypes.guess_type(target.name)[0]
                self.reply(200,target.read_bytes(),typ or 'application/octet-stream')
            else:
                raise Problem(404,'Not found')
        except Problem as e:
            self.reply(e.code, {'error':{'message':str(e)}})
        except (TimeoutError,ConnectionError):
            self.close_connection = True
        except Exception:
            self.reply(500, {'error':{'message':'Internal service error'}})

    do_GET = do_POST = run

    def api(self,db,path):
        gw = self.server.gateway
        post = self.command == 'POST'
        obj = self.body() if post else {}
        sid = self.session()
        headers = {}
        db.execute('BEGIN IMMEDIATE' if post else 'BEGIN')
        if path == '/api/public' and not post:
            return gw.snapshot(db,public=True), headers
        if path == '/api/login' and post:
            with self.server.login_lock:
                failures = self.server.failures
                now = time.monotonic()
                while failures and now - failures[0] > 60:
                    failures.popleft()
                if len(failures) >= 10:
                    raise Problem(429,'Too many login attempts; retry in one minute')
                password = obj.get('password')
                if not isinstance(password,str) or not secrets.compare_digest(digest(password),self.server.password_digest):
                    failures.append(now)
                    raise Problem(401,'Invalid password')
                failures.clear()
            token = secrets.token_urlsafe(32)
            db.execute('DELETE FROM sessions WHERE expires<=? OR digest=?',(time.time(),sid))
            db.execute('INSERT INTO sessions VALUES(?,?)',(digest(token),int(time.time())+TTL))
            headers['Set-Cookie'] = f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={TTL}'
            return {'ok':True},headers
        if not db.execute('SELECT 1 FROM sessions WHERE digest=? AND expires>?',(sid,time.time())).fetchone():
            raise Problem(401,'Administrator login required')
        if post and path == '/api/logout':
            db.execute('DELETE FROM sessions WHERE digest=?',(sid,))
            headers['Set-Cookie'] = f'{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
        elif not post and path == '/api/workspace':
            view = gw.snapshot(db)
            for receipt in view['requests']:
                row = db.execute('SELECT note,at,input_tokens AS inputTokens,output_tokens AS outputTokens FROM reconciliation_audit WHERE receipt_id=?',(receipt['id'],)).fetchone()
                if row:
                    receipt['audit'] = dict(row)
            view['keys'] = [key_view(r) for r in db.execute('SELECT * FROM api_keys ORDER BY created_at DESC')]
            return view,headers
        elif not post and path == '/api/usage.csv':
            headers['Content-Disposition'] = 'attachment; filename="ltzy-usage.csv"'
            return export_csv(gw.csv_rows(db)),headers
        elif post and path == '/api/keys':
            name = text(obj,'name',80)
            raw = 'ltzy_' + secrets.token_urlsafe(32)
            kid = 'key_' + secrets.token_hex(10)
            scope = obj.get('scope','chat')
            if scope not in ('chat','read'):
                raise Problem(400,'Invalid scope')
            db.execute('INSERT INTO api_keys VALUES(?,?,?,?,?,0,?)',(kid,name,raw[:12],digest(raw),datetime.now(timezone.utc).isoformat(),scope))
            row = db.execute('SELECT * FROM api_keys WHERE id=?',(kid,)).fetchone()
            return {'secret':raw,'key':key_view(row)},headers
        elif post and path == '/api/keys/revoke':
            if not db.execute('UPDATE api_keys SET revoked=1 WHERE id=?',(text(obj,'id',120),)).rowcount:
                raise Problem(404,'Unknown key')
        elif post and path == '/api/budget':
            limit = micros(obj.get('limit'))
            budget = gw.snapshot(db)['budget']
            if limit < micros(budget['spent']) + micros(budget['reserved']):
                raise Problem(409,'Budget cannot be lower than spent plus reserved')
            db.execute('UPDATE settings SET budget_micros=? WHERE id=1',(limit,))
        elif post and path == '/api/reconcile':
            rid = text(obj,'id',120)
            note = text(obj,'note',240)
            counts = [obj.get(k) for k in ('inputTokens','outputTokens')]
            if any(type(n) is not int or not 0 <= n <= 2147483647 for n in counts):
                raise Problem(400,'Expected nonnegative integer token counts')
            try:
                gw.reconcile(db,rid,*counts)
                db.execute('INSERT INTO reconciliation_audit VALUES(?,?,?,?,?)', (rid,note,datetime.now(timezone.utc).isoformat(),*counts))
            except ValueError:
                raise Problem(409,'Receipt is not pending or usage cannot be reconciled')
        elif post and path == '/api/lanes':
            lid = text(obj,'id',120)
            enabled = obj.get('enabled')
            if not isinstance(enabled,bool):
                raise Problem(400,'Expected boolean enabled')
            lanes = gw.snapshot(db)['lanes']
            lane = next((l for l in lanes if l['id']==lid),None)
            if lane is None:
                raise Problem(404,'Unknown lane')
            if not enabled and lane['enabled'] and not any(l['id']!=lid and l['model']==lane['model'] and l['enabled'] for l in lanes):
                raise Problem(409,'Cannot disable the last enabled lane for this model')
            db.execute('INSERT INTO lane_settings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled',(lid,enabled))
        else:
            raise Problem(404,'Not found')
        return {'ok':True},headers


def export_csv(rows):
    out = io.StringIO(newline='')
    fields = ['id','createdAt','model','keyId','lane','status','settlement','inputTokens','outputTokens','cost','reserved','latencyMs','price_input','price_output','price_version','price_currency']
    writer = csv.writer(out)
    writer.writerow(fields)
    for row in rows:
        values = [row.get(f,'') for f in fields]
        writer.writerow(["'"+v if isinstance(v,str) and v.startswith(('=','+','-','@','\t','\r','\n')) else v for v in values])
    return out.getvalue().encode('utf-8-sig')


class LocalServer(ThreadingHTTPServer):
    def server_close(self):
        super().server_close()
        if getattr(self,'instance_lock',None):
            self.instance_lock.close()


def lock_directory(root):
    # Startup recovery must not classify another live process's requests as interrupted.
    lock = open(root/'instance.lock','a+b')
    try:
        if os.name == 'nt':
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        lock.close()
        raise RuntimeError('Data directory is locked by another process') from e
    return lock


def create_server(data_dir='.ltzy', port=8000, host='127.0.0.1', gateway_module=None):
    if host not in ('localhost','127.0.0.1'):
        raise ValueError('Local service must bind to localhost or 127.0.0.1')
    if gateway_module is None:
        import gateway as gateway_module
    root = Path(data_dir).resolve()
    if root == WEB or WEB in root.parents:
        raise ValueError('Data directory must not be served as static files')
    root.mkdir(exist_ok=True,parents=True,mode=0o700)
    instance_lock = lock_directory(root)
    try:
        password_digest = bootstrap_password(root/'admin-password.txt')
        db_path = root/'ltzy.sqlite3'
        with closing(connect(db_path)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript(SCHEMA)
            if 'scope' not in {r['name'] for r in db.execute('PRAGMA table_info(api_keys)')}:
                db.execute("ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat' CHECK(scope IN ('read','chat'))")
            gateway_module.init(db)
            db.commit()
        srv = LocalServer((host,port),Handler)
    except BaseException:
        instance_lock.close()
        raise
    srv.instance_lock = instance_lock
    srv.gateway = gateway_module
    srv.db_path = db_path
    srv.password_digest = password_digest
    srv.login_lock = Lock()
    srv.failures = deque()
    srv.hosts = {f'{h}:{srv.server_port}' for h in ('127.0.0.1','localhost')}
    if srv.server_port == 80:
        srv.hosts.update(('127.0.0.1','localhost'))
    return srv


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--host', default='127.0.0.1', choices=('127.0.0.1','localhost'))
    parser.add_argument('--data-dir', default='.ltzy')
    args = parser.parse_args()
    with create_server(args.data_dir,args.port,args.host) as srv:
        print(f'LTZY: http://{args.host}:{srv.server_port}/  |  Admin password file: {Path(args.data_dir)/"admin-password.txt"}',flush=True)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
