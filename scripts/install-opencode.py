#!/usr/bin/env python3
"""Install this snapshot into the global OpenCode config, with file backups."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def expand(value, destination):
    if isinstance(value, str):
        return value.replace('__OPENCODE_CONFIG_DIR__', str(destination)).replace('__RUNTIME_ROOT__', str(ROOT))
    if isinstance(value, list):
        return [expand(item, destination) for item in value]
    if isinstance(value, dict):
        return {expand(key, destination): expand(item, destination) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=Path.home() / '.config/opencode')
    args = parser.parse_args()
    destination = args.destination.expanduser().resolve()
    source = ROOT / 'opencode'
    if destination == source or destination in source.parents or source in destination.parents:
        parser.error('destination must be outside the tracked opencode source directory')
    files = [p for p in sorted(source.rglob('*')) if p.is_file() and not any(part in {'node_modules', 'backups', '__pycache__'} for part in p.relative_to(source).parts)]
    payloads = []
    for p in files:
        data = p.read_bytes()
        if p.name == 'opencode.json':
            data = (json.dumps(expand(json.loads(data), destination), indent=2) + '\n').encode()
        elif p.name == 'AGENTS.md':
            data = expand(data.decode(), destination).encode()
        payloads.append((p, destination / p.relative_to(source), data))
    # Build the complete payload before any write or backup.
    destination.mkdir(parents=True, exist_ok=True)
    backup = destination / 'backups' / datetime.now().strftime('runtime-%Y%m%d-%H%M%S-%f')
    for p, target, _ in payloads:
        if target.is_file():
            saved = backup / p.relative_to(source)
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
    for p, target, data in payloads:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + '.', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
        temporary.chmod(0o600 if p.suffix == '.json' else 0o644)
        os.replace(temporary, target)
    print(f'Installed {len(payloads)} files into {destination}')
    if backup.exists():
        print(f'Backup: {backup}')


if __name__ == '__main__':
    main()
