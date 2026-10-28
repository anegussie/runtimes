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
                name.startswith(("SPLASH_BONSAI_", "SPLASH_QWEN36_"))
                and name != "SPLASH_BONSAI_STARTUP_RETRY_DELAY"
            ):
                del self.env[name]

    def run_launcher(self, choice="14", **overrides):
        return subprocess.run(
            ["bash", LAUNCHER, "--direct", choice],
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
        self.assertIn("--language-only", args)
        self.assertNotIn("--max-image-pixels", args)
        self.assertEqual(args[args.index("--max-context") + 1], "24K")
        self.assertEqual(args[args.index("--prefill-chunk-tokens") + 1], "512")
        self.assertEqual(args[args.index("--max-cache-disk") + 1], "8589934592")
        config = json.loads(self.config.read_text())
        self.assertEqual(
            config["provider"]["local-llama"]["models"]["bonsai-27b-splash"]["limit"],
            {"context": 22528, "output": 4096},
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


    def test_option19_iq3_profile_is_independent_of_option18(self):
        r = self.run_launcher(
            "19",
            SPLASH_QWEN36_MAX_CONTEXT="invalid",
            SPLASH_QWEN36_MAX_TOKENS="invalid",
            SPLASH_QWEN36_PERSISTENT_CACHE="0",
            SPLASH_QWEN36_CACHE_DIR=str(self.root / "option18-cache"),
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        args = json.loads((self.root / "argv.json").read_text())
        for flag, value in {
            "--model": "unsloth/Qwen3.6-35B-A3B-GGUF:UD-IQ3_XXS",
            "--served-model-name": "qwen3.6-35b-a3b-iq3-xxs-splash",
            "--max-context": "80K",
            "--max-image-pixels": "1048576",
            "--expert-memory": "auto",
            "--max-memory": "8G",
            "--kv-format": "int8",
            "--state-format": "bf16",
            "--max-active-requests": "1",
            "--prefill-chunk-tokens": "512",
            "--max-cache-disk": "2147483648",
            "--default-reasoning-effort": "none",
            "--cache-dir": str(
                pathlib.Path.home() / "Library/Caches/Splash/qwen36-option19-iq3-xxs"
            ),
        }.items():
            self.assertEqual(args[args.index(flag) + 1], value, flag)
        self.assertIn("--persistent-cache", args)
        self.assertNotIn("--language-only", args)
        config = json.loads(self.config.read_text())
        self.assertEqual(config["model"], "local-llama/qwen3.6-35b-a3b-iq3-xxs-splash")
        self.assertEqual(
            config["provider"]["local-llama"]["models"][
                "qwen3.6-35b-a3b-iq3-xxs-splash"
            ]["limit"],
            {"context": 79872, "output": 4096},
        )
        self.assertEqual(config["compaction"]["buffer"], 4096)
        model = config["provider"]["local-llama"]["models"]["qwen3.6-35b-a3b-iq3-xxs-splash"]
        self.assertTrue(model["attachment"])
        self.assertEqual(model["modalities"], {"input": ["text", "image"], "output": ["text"]})
        self.assertIn("Vision enabled:", r.stdout)
        self.assertTrue(
            (self.root / "logs/qwen3.6-35b-a3b-iq3-xxs-splash-latest.log").is_symlink()
        )

    def test_option19_interactive_selection_and_overrides(self):
        r = subprocess.run(
            ["bash", LAUNCHER],
            input="19\n",
            env={
                **self.env,
                "SPLASH_QWEN36_IQ3_MAX_CONTEXT": "16K",
                "SPLASH_QWEN36_IQ3_OPENCODE_CONTEXT": "12288",
                "SPLASH_QWEN36_IQ3_MAX_TOKENS": "3072",
                "SPLASH_QWEN36_IQ3_MAX_CACHE_DISK": "0",
            },
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("19) Qwen3.6 35B A3B UD-IQ3_XXS", r.stdout)
        args = json.loads((self.root / "argv.json").read_text())
        self.assertEqual(args[args.index("--max-context") + 1], "16K")
        self.assertNotIn("--persistent-cache", args)
        self.assertNotIn("--cache-dir", args)
        config = json.loads(self.config.read_text())
        self.assertEqual(
            config["provider"]["local-llama"]["models"][
                "qwen3.6-35b-a3b-iq3-xxs-splash"
            ]["limit"],
            {"context": 12288, "output": 3072},
        )

    def test_option19_invalid_settings_do_not_mutate_config(self):
        before = self.config.read_bytes()
        for overrides in (
            {"SPLASH_QWEN36_IQ3_MAX_CONTEXT": "81K"},
            {"SPLASH_QWEN36_IQ3_OPENCODE_CONTEXT": "79873"},
            {"SPLASH_QWEN36_IQ3_MAX_TOKENS": "79872"},
            {"SPLASH_QWEN36_IQ3_MAX_CACHE_DISK": "9G"},
            {"SPLASH_QWEN36_IQ3_PERSISTENT_CACHE": "2"},
        ):
            with self.subTest(overrides=overrides):
                r = self.run_launcher("19", **overrides)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(self.config.read_bytes(), before)
                self.assertFalse((self.root / "attempts").exists())

    def test_option19_iq3_persistence_across_repeated_launches(self):
        alias = "qwen3.6-35b-a3b-iq3-xxs-splash"
        config = json.loads(self.config.read_text())
        config["provider"]["local-llama"]["models"][alias] = {
            "name": "Existing IQ3",
            "limit": {"context": 22528, "output": 4096},
            "variants": {
                "bounded-compaction": {"max_tokens": 2048},
                "custom": {"max_tokens": 128},
            },
            "options": {"top_k": 19},
        }
        config["agent"]["context_worker"] = {
            "model": "local-llama/old", "temperature": 0.37,
        }
        self.config.write_text(json.dumps(config))
        previous = None
        for _ in range(2):
            result = self.run_launcher("19")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            config = json.loads(self.config.read_text())
            model = config["provider"]["local-llama"]["models"][alias]
            self.assertIn("bounded-compaction", model.get("variants", {}))
            self.assertEqual(model["variants"]["custom"], {"max_tokens": 128})
            self.assertEqual(model["options"], {"top_k": 19})
            self.assertEqual(model["limit"], {"context": 79872, "output": 4096})
            self.assertEqual(config["compaction"]["buffer"], 4096)
            self.assertEqual(config["agent"]["context_worker"]["temperature"], 0.37)
            bounded = model["variants"]["bounded-compaction"]
            self.assertEqual(bounded["max_tokens"], 2048)
            self.assertEqual(bounded["reasoning_effort"], "none")
            self.assertFalse(bounded["chat_template_kwargs"]["enable_thinking"])
            if previous is not None:
                self.assertEqual(config, previous)
            previous = config

    def test_option19_iq3_smaller_output_overrides_and_small_context(self):
        alias = "qwen3.6-35b-a3b-iq3-xxs-splash"
        for output in (512, 1024, 3072):
            with self.subTest(output=output):
                result = self.run_launcher("19", SPLASH_QWEN36_IQ3_MAX_TOKENS=str(output))
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                config = json.loads(self.config.read_text())
                model = config["provider"]["local-llama"]["models"][alias]
                self.assertEqual(model["limit"]["output"], output)
                self.assertEqual(config["compaction"]["buffer"], output)
                self.assertEqual(model["variants"]["bounded-compaction"]["max_tokens"], min(2048, output))
        result = self.run_launcher("19", SPLASH_QWEN36_IQ3_MAX_CONTEXT="4K")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        config = json.loads(self.config.read_text())
        model = config["provider"]["local-llama"]["models"][alias]
        self.assertEqual(model["limit"], {"context": 2048, "output": 1024})
        self.assertEqual(config["compaction"]["buffer"], 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)
