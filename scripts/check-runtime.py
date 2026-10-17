#!/usr/bin/env python3
"""Validate the assembled repository without starting inference or downloading."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
if not (3, 12) <= sys.version_info[:2] < (3, 15):
    raise SystemExit('Use Python 3.12-3.14 for source validation.')
for p in [ROOT / 'startllamacpp.sh', *sorted((ROOT / 'scripts').glob('*.sh'))]:
    subprocess.run(['bash', '-n', str(p)], check=True)
for p in [ROOT / 'opencode/opencode.json', ROOT / 'opencode/cli.json', ROOT / 'opencode/package.json', ROOT / 'opencode/package-lock.json']:
    json.loads(p.read_text())
for p in [*ROOT.glob('scripts/*.py'), *ROOT.glob('splash/**/*.py')]:
    compile(p.read_bytes(), str(p), 'exec')
config = json.loads((ROOT / 'opencode/opencode.json').read_text())
for agent in config['agent'].values():
    prompt = agent.get('prompt', '')
    if prompt.startswith('{file:__OPENCODE_CONFIG_DIR__/'):
        relative = prompt.removeprefix('{file:__OPENCODE_CONFIG_DIR__/').removesuffix('}')
        assert (ROOT / 'opencode' / relative).is_file(), relative
with tempfile.TemporaryDirectory(prefix='runtime-config-check-') as temporary:
    destination = Path(temporary) / 'opencode'
    subprocess.run([sys.executable, str(ROOT / 'scripts/install-opencode.py'), '--destination', str(destination)], check=True)
    installed = json.loads((destination / 'opencode.json').read_text())
    assert '__OPENCODE_CONFIG_DIR__' not in json.dumps(installed)
    assert '__RUNTIME_ROOT__' not in json.dumps(installed)
    for agent in installed['agent'].values():
        if agent.get('prompt', '').startswith('{file:'):
            assert Path(agent['prompt'][6:-1]).is_file()
    subprocess.run([sys.executable, str(ROOT / 'scripts/install-opencode.py'), '--destination', str(destination)], check=True)
    assert list((destination / 'backups').glob('runtime-*/opencode.json'))
assert not (ROOT / 'splash/.git').exists()
assert not (ROOT / 'opencode/service.json').exists()
# Installed weights belong to the ignored model cache, not the source
# snapshot. Still reject tracked or otherwise unignored model artifacts.
model_artifacts = subprocess.check_output([
    'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    '--', '*.gguf', '*.safetensors',
], cwd=ROOT).split(b'\0')
assert not any(model_artifacts), 'Model artifacts must not enter the source snapshot'
for p in [ROOT / 'startllamacpp.sh', ROOT / 'scripts/watchllamacpp.sh', ROOT / 'scripts/monitorllamacpp.sh']:
    assert '/Users/mymac/' not in p.read_text(), p
subprocess.run(['bash', str(ROOT / 'startllamacpp.sh'), '--help'], check=True, stdout=subprocess.DEVNULL)
subprocess.run(['bash', str(ROOT / 'startllamacpp.sh'), '--list'], check=True, stdout=subprocess.DEVNULL)
print('Shell syntax, Python sources, config references, isolated install/backup, launcher inventory, and source layout verified.')
