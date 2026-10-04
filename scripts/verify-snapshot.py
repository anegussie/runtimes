#!/usr/bin/env python3
"""Verify imported-file hashes recorded for the initial snapshot."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'provenance/imports.json').read_text())
for entry in manifest['imports']:
    path = root / entry['path']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['repository_sha256'], entry['path']
print(f"Verified {len(manifest['imports'])} imported snapshot files.")
