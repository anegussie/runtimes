#!/usr/bin/env python3
"""Test the external option-14 launcher on macOS using a mock server and temporary config.

Run with OPTION14_LAUNCHER=/path/to/startllamacpp.sh python3 this_file.py.
"""

import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time
import unittest

LAUNCHER = os.environ.get("OPTION14_LAUNCHER", "/Users/mymac/startllamacpp.sh")


class Option14(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="option14-", dir="/private/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        tools = self.root / "bin"
        tools.mkdir()
        for name in ("curl", "lsof"):
            p = tools / name
            p.write_text("#!/bin/sh\nexit 1\n")
            p.chmod(0o755)
        self.mock = self.root / "server.py"
        self.mock.write_text("""#!/usr/bin/env python3
import json,os,signal,sys,time
from pathlib import Path
root=Path(os.environ['MOCK_ROOT'])
count=root/'attempts'
n=int(count.read_text())+1 if count.exists() else 1
count.write_text(str(n))
(root/'argv.json').write_text(json.dumps(sys.argv[1:]))
(root/'server.pid').write_text(str(os.getpid()))
mode=os.environ.get('MOCK_MODE','exit')
if mode=='memory':
 print('runtime bootstrap failed: not enough free memory to start',flush=True)
 sys.exit(1)
if mode=='error':
 print('Metal backend failed',flush=True)
 sys.exit(2)
if mode=='hold':
 def stop(*_):
  (root/'stopped').write_text('TERM received')
  print('Clean shutdown and cache flush',flush=True)
  sys.exit(0)
 signal.signal(signal.SIGTERM,stop)
 while True: time.sleep(.1)
print('Ready test server',flush=True)
""")
        self.mock.chmod(0o755)
        self.config = self.root / "opencode.json"
        self.config.write_text(
            json.dumps(
                {
                    "provider": {"local-llama": {"options": {}, "models": {}}},
                    "agent": {"general": {"model": "local-llama/old"}},
                }
            )
        )
        self.env = {
            **os.environ,
            "PATH": str(tools) + ":" + os.environ["PATH"],
            "SPLASH_BIN": str(self.mock),
            "MOCK_ROOT": str(self.root),
            "LLAMA_LOG_DIR": str(self.root / "logs"),
            "OPENCODE_CONFIG_PATH": str(self.config),
            "SPLASH_BONSAI_STARTUP_RETRY_DELAY": "1",
        }
        for name in list(self.env):
            if (
                name.startswith("SPLASH_BONSAI_")
                and name != "SPLASH_BONSAI_STARTUP_RETRY_DELAY"
            ):
                del self.env[name]

    def run_launcher(self, **overrides):
        return subprocess.run(
            ["bash", LAUNCHER, "--direct", "14"],
            env={**self.env, **overrides},
            capture_output=True,
            text=True,
            timeout=15,
        )

    def test_default_wiring(self):
        r = self.run_launcher()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        args = json.loads((self.root / "argv.json").read_text())
        self.assertIn("--persistent-cache", args)
        self.assertEqual(args[args.index("--max-context") + 1], "24K")
        self.assertEqual(args[args.index("--prefill-chunk-tokens") + 1], "512")
        self.assertEqual(args[args.index("--max-cache-disk") + 1], "8589934592")
        config = json.loads(self.config.read_text())
        self.assertEqual(
            config["provider"]["local-llama"]["models"]["bonsai-27b-splash"]["limit"],
            {"context": 22528, "output": 1024},
        )
        self.assertEqual(config["compaction"]["keep"]["tokens"], 1536)

    def test_smaller_context_auto_sync(self):
        r = self.run_launcher(SPLASH_BONSAI_MAX_CONTEXT="4K")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        config = json.loads(self.config.read_text())
        self.assertEqual(
            config["provider"]["local-llama"]["models"]["bonsai-27b-splash"]["limit"][
                "context"
            ],
            2048,
        )
        self.assertEqual(config["compaction"]["keep"]["tokens"], 512)

    def test_cache_opt_out(self):
        for overrides in (
            {"SPLASH_BONSAI_PERSISTENT_CACHE": "0"},
            {"SPLASH_BONSAI_MAX_CACHE_DISK": "0"},
        ):
            with self.subTest(overrides=overrides):
                r = self.run_launcher(**overrides)
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertNotIn(
                    "--persistent-cache",
                    json.loads((self.root / "argv.json").read_text()),
                )

    def test_bad_overrides_fail_before_mutation(self):
        before = self.config.read_bytes()
        for name, values in {
            "SPLASH_BONSAI_MAX_CONTEXT": [
                "25K",
                "18446744073709555712",
                "999999999999999999999999K",
            ],
            "SPLASH_BONSAI_OPENCODE_CONTEXT": [
                "24576",
                "012288",
                "18446744073709551618",
            ],
            "SPLASH_BONSAI_PREFILL_CHUNK_TOKENS": ["129", "18446744073709551744"],
            "SPLASH_BONSAI_STARTUP_MAX_RETRIES": ["4", "-1"],
            "SPLASH_BONSAI_PERSISTENT_CACHE": ["2"],
            "SPLASH_BONSAI_MAX_CACHE_DISK": ["9G", "-1", "8GB"],
        }.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    r = self.run_launcher(**{name: value})
                    self.assertNotEqual(r.returncode, 0)
                    self.assertEqual(self.config.read_bytes(), before)
                    self.assertFalse((self.root / "attempts").exists())

    def test_bounded_memory_retries(self):
        r = self.run_launcher(MOCK_MODE="memory")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual((self.root / "attempts").read_text(), "3")
        self.assertIn("stopped after 2 retries", r.stdout)

    def test_runtime_error_no_retry(self):
        r = self.run_launcher(MOCK_MODE="error")
        self.assertEqual(r.returncode, 2)
        self.assertEqual((self.root / "attempts").read_text(), "1")

    def test_term_reaches_server_and_drains_logs(self):
        with (self.root / "out").open("w") as out:
            p = subprocess.Popen(
                ["bash", LAUNCHER, "--direct", "14"],
                env={**self.env, "MOCK_MODE": "hold"},
                stdout=out,
                stderr=out,
            )
            try:
                deadline = time.monotonic() + 8
                while (
                    not (self.root / "server.pid").exists()
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.05)
                self.assertTrue((self.root / "server.pid").exists())
                time.sleep(0.2)
                p.send_signal(signal.SIGTERM)
                self.assertEqual(p.wait(timeout=8), 143)
            finally:
                if p.poll() is None:
                    p.kill()
                    p.wait()
        self.assertTrue((self.root / "stopped").exists())
        self.assertIn("Clean shutdown and cache flush", (self.root / "out").read_text())
        pid = int((self.root / "server.pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
