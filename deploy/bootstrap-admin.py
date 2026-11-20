#!/usr/bin/env python3
"""Rotate a fresh instance's default admin through the unpublished loopback API."""

import json
import os
import secrets
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def post(path, payload=None, headers=None):
    request = Request(
        'http://127.0.0.1:18111' + path,
        method='POST',
        headers={'Origin': 'https://builder.jjm.atmy.work', **(headers or {})},
    )
    if payload is not None:
        request.add_header('Content-Type', 'application/json')
        request.data = json.dumps(payload).encode()
    try:
        with urlopen(request, timeout=8) as response:
            data = response.read()
            return response.status, json.loads(data) if data else None, response.headers
    except HTTPError as response:
        return response.code, None, response.headers


def login(password):
    return post('/api/auth/login', {'username': 'admin', 'password': password})


def session_headers(data, headers):
    return {'Cookie': headers['Set-Cookie'].split(';', 1)[0], 'X-CSRF-Token': data['csrfToken']}


def main():
    os.umask(0o077)
    path = Path.home() / '.config/builder-service/initial-admin-password'
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.exists() or path.is_symlink():
        raise SystemExit('A bootstrap password file already exists; no credentials were changed.')
    status, user, headers = login('admin123456')
    if status != 200 or user['user']['role'] != 'admin':
        raise SystemExit(f'Initial admin login failed ({status}); no credentials were changed.')
    password = secrets.token_urlsafe(32)
    with path.open('x') as secret_file:
        secret_file.write(password + '\n')
        secret_file.flush()
        os.fsync(secret_file.fileno())
    status, _, _ = post(f"/api/users/{user['user']['id']}/password", {'password': password}, session_headers(user, headers))
    if status != 200:
        raise SystemExit(f'Password update failed ({status}); resolve before publishing the site.')
    rotated, user, headers = login(password)
    if rotated != 200 or post('/api/auth/logout', headers=session_headers(user, headers))[0] != 204:
        raise SystemExit('Could not verify the rotated administrator session.')
    if login('admin123456')[0] != 401:
        raise SystemExit('Could not verify rejection of the default password.')
    print(f'Admin password rotated; default rejected. Protected password file: {path}')


if __name__ == '__main__':
    main()
