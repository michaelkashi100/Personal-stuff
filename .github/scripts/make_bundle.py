#!/usr/bin/env python3
"""Writes bundle.json for a staged copy of the web app: every file with its SHA-256 and size, plus a build time.

The Android app downloads exactly the files listed here, checks each hash, and only then swaps them in, so a broken or
partial download can never replace a working app. A bigger `built` means newer.

usage: make_bundle.py <folder> [built-epoch-seconds]
"""
import hashlib
import json
import os
import sys
import time

root = sys.argv[1]
built = int(sys.argv[2]) if len(sys.argv) > 2 else int(time.time())
skip = {'sw.js', 'bundle.json'}          # the service worker is for browsers; the app updates through this file

files = []
for base, dirs, names in os.walk(root):
    dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
    for name in sorted(names):
        if name.startswith('.'):
            continue
        full = os.path.join(base, name)
        rel = os.path.relpath(full, root).replace(os.sep, '/')
        if rel in skip:
            continue
        with open(full, 'rb') as f:
            data = f.read()
        files.append({'path': rel, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})

files.sort(key=lambda f: f['path'])
assert any(f['path'] == 'index.html' for f in files), 'index.html missing from ' + root
with open(os.path.join(root, 'bundle.json'), 'w') as out:
    json.dump({'version': os.environ.get('GITHUB_SHA', '')[:7], 'built': built, 'files': files}, out, indent=1)
print('bundle.json:', len(files), 'files, built', built)
