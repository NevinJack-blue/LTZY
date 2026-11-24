"""Real HTTP integration of the shipped control plane and gateway, with isolated data.

No provider credentials/network are needed: local/echo is the explicitly labelled
built-in test adapter. HTTPS provider transport has separate test_gateway coverage.
"""
import csv
import io
import json
import math
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

import gateway
import server


class FullstackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ltzy-fullstack-')
        self.addCleanup(self.temp.cleanup)
        # Never inherit a developer's configured upstream or contact real providers.
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('LTZY_UPSTREAMS', None)
        lanes = patch.object(gateway, 'LANES', ())
        lanes.start()
        self.addCleanup(lanes.stop)
        self.cookie = ''
        self.start()
        self.addCleanup(self.stop)

    def start(self):
        self.srv = server.create_server(self.temp.name, 0)
        self.thread = threading.Thread(target=self.srv.serve_forever,
                                       kwargs={'poll_interval': .01}, daemon=True)
        self.thread.start()

    def stop(self):
        if self.srv is not None:
            self.srv.shutdown()
            self.srv.server_close()
            self.thread.join(timeout=5)
            self.srv = None

    def request(self, path, body=None, token=None, headers=None, cookie=None):
        h = {'Content-Type': 'application/json',
             'Cookie': self.cookie if cookie is None else cookie}
        if token is not None:
            h['Authorization'] = 'Bearer ' + token
        h.update(headers or {})
        with closing(HTTPConnection('127.0.0.1', self.srv.server_port, timeout=5)) as c:
            c.request('GET' if body is None else 'POST', path,
                      None if body is None else json.dumps(body), h)
            response = c.getresponse()
            data = response.read()
            parsed = json.loads(data) if 'json' in response.getheader('Content-Type', '') else data
            return response.status, parsed, response.headers

    def login(self):
        password = (Path(self.temp.name) / 'admin-password.txt').read_text().strip()
        code, _, headers = self.request('/api/login', {'password': password})
        self.assertEqual(code, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        self.cookie = headers['Set-Cookie'].split(';')[0]

    def key(self, scope='chat'):
        code, created, _ = self.request('/api/keys', {'name': 'Integration key', 'scope': scope})
        self.assertEqual(code, 200)
        self.assertEqual(created['key']['scope'], scope)
        return created['secret'], created['key']['id']

    def chat(self, token, **changes):
        body = dict(model='local/echo', messages=[dict(role='user', content='private integration prompt')],
                    max_tokens=32)
        body.update(changes)
        return self.request('/v1/chat/completions', body, token=token)

    def admin_uid(self):
        with closing(server.connect(self.srv.db_path)) as db:
            return db.execute("SELECT id FROM users WHERE email='admin@local'").fetchone()[0]

    def workspace(self, receipt_count=None):
        # HTTP response bytes can arrive just before the handler's settlement commit.
        for _ in range(50):
            code, view, _ = self.request('/api/workspace')
            self.assertEqual(code, 200)
            if receipt_count is None or (len(view['requests']) == receipt_count and
                                        all(r['status'] != 'running' for r in view['requests'])):
                return view
        self.fail('HTTP receipts did not settle after repeated workspace reads')

    def test_auth_scopes_and_security_boundaries(self):
        for path in ('/api/workspace', '/api/usage.csv', '/v1/models'):
            self.assertEqual(self.request(path)[0], 401)
        self.assertEqual(self.request('/api/login', {'password': 'not-the-password'})[0], 401)
        self.login()
        read, _ = self.key('read')
        chat, _ = self.key()
        self.assertEqual(self.request('/v1/models', token=read)[0], 200)
        self.assertEqual(self.chat(read)[0], 403)
        self.assertEqual(self.request('/api/workspace', token=chat, cookie='')[0], 401)
        self.assertEqual(self.chat('invalid-test-key')[0], 401)
        for extra in ({'Origin': 'https://attacker.invalid'}, {'Sec-Fetch-Site': 'cross-site'},
                      {'Host': 'attacker.invalid'}):
            self.assertEqual(self.request('/api/admin/settings', {'registrationEnabled': True}, headers=extra)[0], 403)
        for path in ('/server.py', '/gateway.py', '/.ltzy/admin-password.txt',
                     '/%2e%2e/server.py', '/%5cserver.py'):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.request('/api/logout', {})[0], 200)
        self.assertEqual(self.request('/api/workspace')[0], 401)
        # Admin logout must not silently revoke independent bearer credentials.
        self.assertEqual(self.request('/v1/models', token=chat)[0], 200)

    def test_ordinary_sse_receipts_csv_revocation_and_restart(self):
        self.login()
        token, kid = self.key()
        code, ordinary, headers = self.chat(token)
        self.assertEqual(code, 200)
        self.assertEqual(ordinary['object'], 'chat.completion')
        self.assertEqual(ordinary['choices'][0]['message']['content'], ('Local test: ' + 'private integration prompt')[:32])
        first_id = headers['X-Request-Id']
        code, wire, headers = self.chat(token, stream=True, stream_options={'include_usage': True})
        self.assertEqual(code, 200)
        self.assertIn('text/event-stream', headers['Content-Type'])
        events = [line[6:] for line in wire.decode().splitlines() if line.startswith('data: ')]
        self.assertEqual(events[-1], '[DONE]')
        chunks = [json.loads(event) for event in events[:-1]]
        content = ''.join(choice.get('delta', {}).get('content', '')
                          for chunk in chunks for choice in chunk['choices'])
        self.assertEqual(content, ordinary['choices'][0]['message']['content'])
        self.assertEqual(chunks[-1]['usage'], ordinary['usage'])
        view = self.workspace(2)
        receipts = {r['id']: r for r in view['requests']}
        self.assertEqual(set(receipts), {first_id, headers['X-Request-Id']})
        expected_cost = math.ceil(ordinary['usage']['prompt_tokens'] * .5 +
                                  ordinary['usage']['completion_tokens'] * 1.5) / 1e6
        for receipt in receipts.values():
            self.assertEqual(receipt['keyId'], kid)
            self.assertEqual(receipt['status'], 'success')
            self.assertEqual(receipt['settlement'], 'settled')
            self.assertEqual(receipt['price']['version'], 'test-v1')
            self.assertEqual(receipt['cost'], expected_cost)
        self.assertEqual(view['budget']['spent'], expected_cost * 2)
        self.assertEqual(view['budget']['reserved'], 0)
        self.assertEqual(view['usage'][0]['requests'], 2)
        code, raw_csv, _ = self.request('/api/usage.csv')
        self.assertEqual(code, 200)
        rows = list(csv.DictReader(io.StringIO(raw_csv.decode('utf-8-sig'))))
        self.assertEqual({row['id'] for row in rows}, set(receipts))
        self.assertTrue(all(row['settlement'] == 'settled' for row in rows))
        public = self.request('/api/public')[1]
        self.assertEqual(set(public), {'models', 'status'})
        self.assertEqual(public['status']['successful'], 2)
        metrics = public['models'][0]['metrics']
        self.assertEqual(metrics['requests'], 2)
        self.assertEqual(metrics['successRate'], 100)
        self.assertIsNotNone(metrics['averageLatencyMs'])
        safe = json.dumps([view, public]) + raw_csv.decode('utf-8-sig')
        self.assertFalse(any(value in safe for value in
                             (token, self.cookie.split('=', 1)[1], 'private integration prompt', 'Local test:')))
        self.assertEqual(self.request('/api/keys/revoke', {'id': kid})[0], 200)
        self.assertEqual(self.chat(token)[0], 401)
        self.stop()
        self.start()
        self.login()
        restored = self.workspace(2)
        self.assertEqual(restored['budget'], view['budget'])
        self.assertTrue(restored['keys'][0]['revoked'])
        self.assertEqual(self.request('/v1/models', token=token)[0], 401)
        self.assertEqual({r['id'] for r in restored['requests']}, set(receipts))

    def test_budget_admission_and_no_receipt_for_rejected_calls(self):
        self.login()
        token, _ = self.key()
        uid = self.admin_uid()
        self.assertEqual(self.request('/api/admin/user', {'id': uid, 'action': 'balance', 'delta': -25})[0], 200)
        self.assertEqual(self.chat(token)[0], 402)
        self.assertEqual(self.workspace(0)['requests'], [])
        self.assertEqual(self.request('/api/admin/user', {'id': uid, 'action': 'balance', 'delta': .001})[0], 200)
        self.assertEqual(self.chat(token)[0], 200)
        view = self.workspace(1)
        self.assertGreater(view['budget']['spent'], 0)
        self.assertEqual(self.request('/api/admin/user', {'id': uid, 'action': 'balance', 'delta': -.002})[0], 409)
        self.assertEqual(self.request('/api/admin/user', {'id': uid, 'action': 'balance', 'delta': .0000001})[0], 400)
        self.assertEqual(self.chat(token, max_tokens=True)[0], 400)
        self.assertEqual(self.chat(token, model='unknown/model')[0], 404)
        self.assertEqual(len(self.workspace()['requests']), 1)

    def test_gateway_rejects_conflicting_content_lengths(self):
        """Ambiguous request framing must fail before billing or upstream dispatch."""
        self.login()
        token, _ = self.key()
        body = json.dumps(dict(model='local/echo', messages=[dict(role='user', content='probe')],
                               max_tokens=16)).encode()
        variants = [
            [('Content-Length', str(len(body))), ('Content-Length', '0')],
            [('Content-Length', str(len(body))), ('Content-Length', str(len(body)))],
            [('Content-Length', '-1')],
            [('Content-Length', '+1')],
            [('Content-Length', '\xb2')],
            [('Content-Length', str(len(body))), ('Transfer-Encoding', 'chunked')],
            [],
        ]
        for framing in variants:
            with self.subTest(framing=framing):
                with closing(HTTPConnection('127.0.0.1', self.srv.server_port, timeout=5)) as c:
                    c.putrequest('POST', '/v1/chat/completions')
                    c.putheader('Authorization', 'Bearer ' + token)
                    c.putheader('Content-Type', 'application/json')
                    for name, value in framing:
                        c.putheader(name, value)
                    c.endheaders(body)
                    response = c.getresponse()
                    response.read()
                    self.assertEqual(response.status, 400)
        self.assertEqual(self.workspace(0)['requests'], [])

    def test_http_concurrent_budget_reservation(self):
        self.login()
        token, _ = self.key()
        # Prompt has 27 Unicode-character units; output is capped at 32.
        amount = gateway.micros(gateway.price_of(gateway.LANES[0]),
                                len('private integration prompt') + 1, 32)
        uid = self.admin_uid()
        self.assertEqual(self.request('/api/admin/user', {'id': uid, 'action': 'balance',
                                                          'delta': amount / 1e6 - 25})[0], 200)
        entered, release = threading.Event(), threading.Event()
        real_upstream = gateway.upstream

        def delayed(*args):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('Test reservation barrier timed out')
            yield from real_upstream(*args)

        with patch.object(gateway, 'upstream', delayed), ThreadPoolExecutor(1) as pool:
            first = pool.submit(self.chat, token)
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.workspace()['budget']['reserved'], amount / 1e6)
                self.assertEqual(self.chat(token)[0], 402)
            finally:
                release.set()
            self.assertEqual(first.result(timeout=5)[0], 200)
        self.assertEqual(self.workspace(1)['budget']['remaining'], 0)


if __name__ == '__main__':
    unittest.main()
