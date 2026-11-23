"""Rainbow ePay (standard alipay/epay protocol) client: V1 submit.php and V2 mapi.php.

Signature: sort parameters by ASCII key, skip empty values, join as k=v&,
append the merchant key, MD5 hex. Applies to both versions.
"""
import hashlib
import hmac
import json
import re
import urllib.parse
import urllib.request


def sign(params, key):
    items = sorted((k, v) for k, v in params.items()
                   if k not in ('sign', 'sign_type') and v not in ('', None))
    query = '&'.join(f'{k}={v}' for k, v in items) + key
    return hashlib.md5(query.encode('utf-8')).hexdigest()


def verify(params, key):
    if not key or not params.get('sign'):
        return False
    return hmac.compare_digest(sign(params, key), str(params['sign']))


def safe_host(value):
    host = value.strip()
    return bool(re.fullmatch(r'[A-Za-z0-9.\-]{1,253}(:\d{1,5})?', host))


def pay_params(cfg, out_trade_no, name, money, notify_url, return_url, pay_type):
    return {
        'pid': cfg['epay_pid'],
        'type': pay_type,
        'out_trade_no': out_trade_no,
        'notify_url': notify_url,
        'return_url': return_url,
        'name': name,
        'money': money,
    }


def v1_payurl(cfg, params):
    payload = {**params, 'sign': sign(params, cfg['epay_key']), 'sign_type': 'MD5'}
    return cfg['epay_url'].rstrip('/') + '/submit.php?' + urllib.parse.urlencode(payload)


def v2_order(cfg, params):
    payload = {**params, 'sign': sign(params, cfg['epay_key']), 'sign_type': 'MD5'}
    url = cfg['epay_url'].rstrip('/') + '/mapi.php'
    request = urllib.request.Request(url, data=urllib.parse.urlencode(payload).encode(),
                                     headers={'User-Agent': 'LTZY'})
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read(65536))
    if not isinstance(body, dict) or body.get('code') != 1:
        raise RuntimeError('epay rejected the order: %s' % (body.get('msg') if isinstance(body, dict) else body))
    return body
