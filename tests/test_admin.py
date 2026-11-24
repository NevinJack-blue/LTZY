"""Exercise the local control plane over real TCP using a small gateway contract fixture."""
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from threading import Thread

import server


class FixtureGateway:
    @staticmethod
    def init(db):
        db.executescript('''CREATE TABLE IF NOT EXISTS balances(held INTEGER);
        INSERT INTO balances SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM balances);
        INSERT OR IGNORE INTO lane_settings VALUES('a',1),('b',1);''')

    @staticmethod
    def snapshot(db,public=False,user_id=None):
        result = {'models':[{'id':'local/test'}],'status':{}}
        if not public:
            if user_id:
                balance = db.execute('SELECT balance_micros FROM users WHERE id=?',(user_id,)).fetchone()[0]
            else:
                balance = db.execute('SELECT budget_micros FROM settings').fetchone()[0]
            held = db.execute('SELECT held FROM balances').fetchone()[0]
            result.update(requests=[{'id':'req'}],usage=[],budget={
                'limit':balance/1e6,'reserved':held/1e6,'spent':0,
                'remaining':(balance-held)/1e6},
                lanes=[dict(r,model='local/test') for r in db.execute('SELECT * FROM lane_settings')])
        return result

    @staticmethod
    def csv_rows(db,user_id=None):
        yield {'id':'req','model':'=formula','inputTokens':12}

    @staticmethod
    def reconcile(db,rid,inp,out):
        if rid != 'req' or db.execute('SELECT 1 FROM reconciliation_audit').fetchone():
            raise ValueError()


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.start()
        self.cookie = ''

    def start(self):
        self.srv = server.create_server(self.tmp.name,0,gateway_module=FixtureGateway)
        thread = Thread(target=self.srv.serve_forever,kwargs={'poll_interval':.01},daemon=True)
        thread.start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.srv.shutdown)

    def call(self,path,obj=None,**headers):
        with closing(HTTPConnection('127.0.0.1',self.srv.server_port,timeout=5)) as c:
            c.request('POST' if obj is not None else 'GET',path,json.dumps(obj) if obj is not None else None,
                      {'Cookie':self.cookie,'Content-Type':'application/json',**headers})
            r = c.getresponse()
            body = r.read()
            return r.status, json.loads(body) if 'json' in r.getheader('Content-Type') else body, r.headers

    def login(self):
        password = (Path(self.tmp.name)/'admin-password.txt').read_text().strip()
        code,_,h = self.call('/api/login',{'password':password})
        self.assertEqual(code,200)
        self.assertIn('SameSite=Strict',h['Set-Cookie'])
        self.assertIn('HttpOnly',h['Set-Cookie'])
        self.cookie = h['Set-Cookie'].split(';')[0]

    def test_single_process_recovery_lock(self):
        with self.assertRaises(RuntimeError):
            server.create_server(self.tmp.name,0,gateway_module=FixtureGateway)

    def test_auth_lifecycle_and_expiry(self):
        self.assertEqual(set(self.call('/api/public')[1]),{'models','status'})
        self.assertEqual(self.call('/api/workspace')[0],401)
        self.assertEqual(self.call('/api/usage.csv')[0],401)
        self.assertEqual(self.call('/api/login',{'password':'incorrect'})[0],401)
        self.login()
        self.assertEqual(self.call('/api/workspace')[0],200)
        self.assertEqual(self.call('/api/logout',{})[0],200)
        self.assertEqual(self.call('/api/workspace')[0],401)
        self.login()
        with closing(server.connect(self.srv.db_path)) as db:
            db.execute('UPDATE sessions SET expires=0')
        self.assertEqual(self.call('/api/workspace')[0],401)

    def test_restrict_host_origin_and_content_type(self):
        self.login()
        for headers in ({'Origin':'https://example.org'}, {'Sec-Fetch-Site':'cross-site'}, {'Host':'unrecognized.local'}):
            self.assertEqual(self.call('/api/admin/settings',{'registrationEnabled':True},**headers)[0],403)
        self.assertEqual(self.call('/api/admin/settings',{'registrationEnabled':True},**{'Content-Type':'text/plain'})[0],415)
        self.assertEqual(self.call('/.ltzy/admin-password.txt')[0],404)
        self.assertEqual(self.call('/../server.py')[0],404)

    def test_key_disclosure_revocation_and_persistence(self):
        self.login()
        code,created,_ = self.call('/api/keys',{'name':'Example','scope':'read'})
        self.assertEqual(code,200)
        raw = created['secret']
        self.assertEqual(created['key']['scope'],'read')
        kid = created['key']['id']
        with closing(server.connect(self.srv.db_path)) as db:
            row = db.execute('SELECT * FROM api_keys').fetchone()
            self.assertEqual(row['digest'],server.digest(raw))
            self.assertNotIn(raw,tuple(row))
        self.assertEqual(self.call('/api/keys/revoke',{'id':kid})[0],200)
        self.srv.shutdown()
        self.srv.server_close()
        self.start()
        self.login()
        keys = self.call('/api/workspace')[1]['keys']
        self.assertTrue(keys[0]['revoked'])
        self.assertNotIn(raw,json.dumps(keys))
        self.assertNotIn('digest',keys[0])

    def test_balance_update_reads_committed_state(self):
        self.login()
        with closing(server.connect(self.srv.db_path)) as db:
            uid, = db.execute("SELECT id FROM users WHERE email='admin@local'").fetchone()
        # Zeroing the balance must be rejected while an in-flight reservation holds funds.
        with closing(server.connect(self.srv.db_path)) as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('UPDATE users SET balance_micros=0 WHERE id=?',(uid,))
            db.commit()
        self.assertEqual(self.call('/api/admin/user',{'id':uid,'action':'balance','delta':-1})[0],409)
        self.assertEqual(self.call('/api/admin/user',{'id':uid,'action':'balance','delta':0.500001})[0],200)
        self.assertEqual(self.call('/api/workspace')[1]['me']['balance'],0.500001)
        for value in [True,0.0000001,'NaN']:
            self.assertEqual(self.call('/api/admin/user',{'id':uid,'action':'balance','delta':value})[0],400)

    def test_balance_adjustment_cannot_make_available_balance_negative(self):
        self.login()
        with closing(server.connect(self.srv.db_path)) as db:
            db.execute("INSERT INTO users VALUES('u1','user@test.dev','x','user','active',25000000,'2026-01-01')")
            db.execute("INSERT INTO receipts(id,createdAt,model,lane,keyId,status,settlement,inputTokens,outputTokens,cost,reserved,latencyMs,trace,price,user_id) "
                       "VALUES('r1','2026-01-01','local/test',NULL,'k1','success','settled',10,10,24000000,0,0,'[]','{}','u1')")
        self.assertEqual(self.call('/api/admin/user',{'id':'u1','action':'balance','delta':-2})[0],409)
        self.assertEqual(self.call('/api/admin/user',{'id':'u1','action':'balance','delta':-1})[0],200)

    def test_concurrent_lane_disable_preserves_last_lane(self):
        self.login()
        with ThreadPoolExecutor() as pool:
            result = list(pool.map(lambda lid:self.call('/api/lanes',{'id':lid,'enabled':False})[0],('a','b')))
        self.assertEqual(sorted(result),[200,409])
        self.assertEqual(sum(r['enabled'] for r in self.call('/api/workspace')[1]['lanes']),1)

    def test_csv_and_reconciliation_audit(self):
        self.login()
        req = {'id':'req','inputTokens':4,'outputTokens':2}
        self.assertEqual(self.call('/api/reconcile',req)[0],400)
        req['note']='Verified against supplier receipt'
        self.assertEqual(self.call('/api/reconcile',req)[0],200)
        self.assertEqual(self.call('/api/reconcile',req)[0],409)
        self.assertEqual(self.call('/api/workspace')[1]['requests'][0]['audit']['note'],req['note'])
        code,csv,h = self.call('/api/usage.csv')
        self.assertEqual(code,200)
        self.assertIn('attachment',h['Content-Disposition'])
        self.assertIn(b"'=formula",csv)


if __name__ == '__main__':
    unittest.main()
