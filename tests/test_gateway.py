from email.message import Message
import hashlib
import io
import json
import os
import shutil
import sqlite3
import ssl
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import gateway as g


class Request:
    def __init__(self,p,key):
        data=g.encode(p)
        self.command='POST' if p else 'GET'
        self.path='/v1/chat/completions' if p else '/v1/models'
        self.headers=Message()
        self.headers['Authorization']='Bearer '+key
        self.headers['Content-Length']=str(len(data))
        self.rfile,self.wfile=io.BytesIO(data),io.BytesIO()
        self.response_headers={}
        self.status=None

    def send_response(self,status):
        assert self.status is None, 'second HTTP response'
        self.status=status

    def send_header(self,k,v):
        self.response_headers[k]=v

    def end_headers(self):
        pass


class GatewayTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/'project.sqlite'
        self.db=sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.row_factory=sqlite3.Row
        self.db.executescript('''CREATE TABLE settings(id,budget_micros); INSERT INTO settings VALUES(1,25000000);
            CREATE TABLE api_keys(id,digest,revoked,scope); CREATE TABLE lane_settings(id,enabled);''')
        self.db.execute('INSERT INTO api_keys VALUES(?,?,0,?)',('key_1',hashlib.sha256(b'client-test').hexdigest(),'chat'))
        env=patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('LTZY_UPSTREAMS',None)
        lanes=patch.object(g,'LANES',())
        lanes.start()
        self.addCleanup(lanes.stop)
        g.init(self.db)
        self.p=dict(model='local/echo',messages=[dict(role='user',content='sensitive prompt')],max_tokens=20)

    def call(self,p=None,key='client-test'):
        h=Request(p,key)
        g.dispatch(h,self.path)
        return h

    def snapshot(self):
        return g.snapshot(self.db)

    def test_auth_scope_and_revocation(self):
        self.assertEqual(self.call(key='wrong').status,401)
        with self.db:
            self.db.execute("UPDATE api_keys SET scope='read'")
        self.assertEqual(json.loads(self.call().wfile.getvalue())['data'][0]['id'],'local/echo')
        self.assertEqual(self.call(self.p).status,403)
        with self.db:
            self.db.execute('UPDATE api_keys SET revoked=1')
        self.assertEqual(self.call().status,401)
        self.assertFalse(self.snapshot()['requests'])

    def test_bill_privacy_restart(self):
        r=self.call(self.p)
        bill=self.snapshot()['requests'][0]
        self.assertEqual(bill['id'],r.response_headers['X-Request-Id'])
        self.assertEqual(bill['inputTokens'],17)
        self.assertEqual(bill['outputTokens'],20)
        self.assertEqual(bill['cost'],39/1e6)
        self.assertEqual(bill['price']['version'],'test-v1')
        self.assertEqual(bill['settlement'],'settled')
        logs=json.dumps([self.snapshot(),list(g.csv_rows(self.db))])
        for private in ('sensitive prompt','client-test','Local test:'):
            self.assertNotIn(private,logs)
        g.init(self.db)
        self.assertEqual(self.snapshot()['budget']['spent'],39/1e6)

    def test_stream(self):
        h=self.call(dict(self.p,stream=True,stream_options={'include_usage':True}))
        self.assertEqual(h.response_headers['Content-Type'],'text/event-stream')
        lines=h.wfile.getvalue().splitlines()
        self.assertIn(b'data: [DONE]',lines)
        chunks=[json.loads(x[6:]) for x in lines if x.startswith(b'data: {')]
        self.assertEqual(chunks[-1]['usage']['completion_tokens'],20)

    def test_concurrent_admission(self):
        with self.db:
            self.db.execute('UPDATE settings SET budget_micros=39')
        entered,release=threading.Event(),threading.Event()
        def slow(*args):
            entered.set()
            assert release.wait(5)
            yield from g.local(*args)
        with patch.object(g,'upstream',slow),ThreadPoolExecutor(1) as pool:
            first=pool.submit(self.call,self.p)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.snapshot()['budget']['reserved'],39/1e6)
                self.assertEqual(self.call(self.p).status,402)
            finally:
                release.set()
            self.assertEqual(first.result().status,200)

    def test_reconcile_without_double_charge(self):
        with patch.object(g,'upstream',lambda *args: (obj for obj in [dict(choices=[{'message':{'content':'ok'}}])])):
            self.assertEqual(self.call(self.p).status,200)
        r=self.snapshot()['requests'][0]
        self.assertEqual(r['settlement'],'pending')
        self.assertIsNone(r['cost'])
        self.assertGreater(r['reserved'],0)
        with patch.object(g,'LANES',()), self.db:
            self.db.execute('BEGIN IMMEDIATE')
            g.reconcile(self.db,r['id'],5,4)
            with self.assertRaises(ValueError):
                g.reconcile(self.db,r['id'],5,4)
        self.assertEqual(self.snapshot()['budget']['spent'],9/1e6)
        self.assertEqual(self.snapshot()['budget']['reserved'],0)

    def test_pending_queue_survives_receipt_window(self):
        with self.db:
            self.db.executemany("INSERT INTO receipts(id,createdAt,model,keyId,status,settlement,reserved,trace,price) VALUES(?,'now','local/echo','key_1','success','pending',1,'[]',?)", [(str(i),json.dumps(g.price_of(g.LANES[0]))) for i in range(201)])
        s=self.snapshot()
        self.assertEqual(len(s['requests']),200)
        self.assertEqual(len(s['pending']),201)
        self.assertEqual(s['pending'][0]['id'],'0')
        self.assertNotIn('pending',g.snapshot(self.db,public=True))

    def test_malformed_disabled(self):
        for change in ({'messages':[]},{'stream':'yes'},{'tools':[]},{'max_tokens':True}):
            self.assertEqual(self.call(dict(self.p,**change)).status,400)
        self.assertEqual(self.call(dict(self.p,model='unknown')).status,404)
        with self.db:
            self.db.execute("INSERT INTO lane_settings VALUES('local-test',0)")
        self.assertEqual(self.call(self.p).status,503)
        self.assertEqual(json.loads(self.call().wfile.getvalue())['data'],[])

    def test_real_https_routing(self):
        # Temporary, trusted loopback certificate; no external inference or saved credentials.
        openssl=shutil.which('openssl')
        if not openssl and Path('C:/Program Files/Git/usr/bin/openssl.exe').is_file():
            openssl='C:/Program Files/Git/usr/bin/openssl.exe'
        if not openssl:
            self.skipTest('OpenSSL executable needed only to mint ephemeral test certificate')
        cert,key=self.path.with_suffix('.crt'),self.path.with_suffix('.key')
        subprocess.run([openssl,'req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
                        '-addext','subjectAltName=DNS:localhost','-out',str(cert),'-keyout',str(key)],
                       check=True,capture_output=True)
        calls=[]
        class Provider(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((self.path,self.headers['Authorization'],body))
                if self.path.startswith('/a') and not body['stream']:
                    self.send_response(429)
                    self.end_headers()
                    self.wfile.write(b'private provider diagnostic')
                elif not body['stream']:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(g.encode(dict(model='up',choices=[{'message':{'content':'via TLS'}}],
                                               usage={'prompt_tokens':2,'completion_tokens':3})))
                else:
                    self.send_response(200)
                    self.send_header('Content-Type','text/event-stream')
                    self.end_headers()
                    self.wfile.write(b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
        server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
        ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert,key)
        server.socket=ctx.wrap_socket(server.socket,server_side=True)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        os.environ.update(SSL_CERT_FILE=str(cert),TEST_PROVIDER_KEY='provider-test')
        lanes=[dict(id=x,model='team/chat',upstream_model='private-up',input_price=price,
                    output_price=price,price_version='v1',context=2048,api_key_env='TEST_PROVIDER_KEY',
                    base_url=f'https://localhost:{server.server_port}/{x}/v1') for x,price in [('a',1),('b',2)]]
        os.environ['LTZY_UPSTREAMS']=json.dumps(lanes)
        g.init(self.db)
        p=dict(self.p,model='team/chat')
        self.assertEqual(self.call(self.p).status,404)
        r=self.call(p)
        self.assertEqual(r.status,200,r.wfile.getvalue())
        self.assertEqual([x[0] for x in calls],['/a/v1/chat/completions','/b/v1/chat/completions'])
        self.assertEqual(calls[-1][1],'Bearer provider-test')
        self.assertEqual(calls[-1][2]['model'],'private-up')
        self.assertEqual(self.snapshot()['budget']['spent'],10/1e6)
        self.assertEqual(self.snapshot()['requests'][0]['lane'],'b')
        r=self.call(dict(p,stream=True))
        self.assertEqual(r.status,200,r.wfile.getvalue())
        self.assertEqual(len(calls),3)  # Never replay after output begins.
        self.assertIn(b'stream_interrupted',r.wfile.getvalue())
        self.assertNotIn(b'[DONE]',r.wfile.getvalue())
        self.assertEqual(self.snapshot()['requests'][0]['settlement'],'pending')
        self.assertNotIn('provider-test',json.dumps(self.snapshot()))

