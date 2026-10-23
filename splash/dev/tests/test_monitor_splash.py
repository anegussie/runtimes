"""Exercise the installed monitor interface with deterministic OS/status fixtures."""

import json
import os
import shlex
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

MONITOR = Path(__file__).resolve().parents[3] / "scripts" / "monitorsplash.sh"


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "logs"
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "LLAMA_LOG_DIR": str(self.log),
            "SPLASH_MONITOR_QUIET": "1",
        }
        self.fixture = self.root / "status.json"
        self.status = {
            "ready": True,
            "instance": {"id": "run1", "pid": 42, "model": "model"},
            "identity": {"cache": {"build_id": "build1"}, "kv": {"format": "int8"}},
            "memory_plan": {"budget": {"configured_memory_limit_bytes": 8589934592}},
            "streamed_experts": {
                "slots": 3428,
                "experts": 10240,
                "prefill": {"read_bytes": 1048576, "hit_rate": 0.5},
                "decode": {"read_bytes": 2097152, "hit_rate": 0.8},
            },
            "disk": {"read_bytes": 0, "written_bytes": 0, "limit_bytes": 0},
            "transport": {"restarts": 0},
            "maximum_context_tokens": 24576,
            "prefill_chunk_tokens": 512,
            "verify_rows": {"automatic": True},
            "requests": {"completed": 1, "failed": 0, "cancelled": 0},
            "metrics": {
                "prefill_input_tokens": 100,
                "prefill_wall_ms": 100,
                "decode_output_tokens": 10,
                "decode_wall_ms": 100,
                "drafted_tokens": 20,
                "accepted_draft_tokens": 10,
                "ttft_ms": {"p50": 50, "p95": 100},
            },
            "memory_governor": {"denied_reservations": 0, "host_headroom_bytes": 100},
            "cache": {"resource_replay_tokens": 0},
        }
        self.fixture.write_text(json.dumps(self.status))
        self.command("curl", f"cat '{self.fixture}'\nprintf '\\n0.002'")
        self.command("sysctl", "printf 'used = 4000.00M'")
        self.command("ps", "printf '42 1 1000\\n43 42 2000\\n99 1 3000\\n'")
        self.command(
            "vm_stat",
            "printf 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPageins: 100.\\nPageouts: 20.\\nSwapins: 30.\\nSwapouts: 40.\\n'",
        )

    def command(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def run_monitor(self, *args):
        result = subprocess.run(
            ["bash", str(MONITOR), *args],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def snapshot(self):
        self.run_monitor("--snapshot")
        return json.loads(
            (self.log / "splash-status.jsonl").read_text().splitlines()[-1]
        )

    def summary_steps(self, steps):
        clock = self.root / "clock"
        self.command(
            "date",
            f'if [ "$1" = "+%s" ]; then cat {shlex.quote(str(clock))}; else /bin/date "$@"; fi',
        )
        code = MONITOR.read_text().split('\nmode="', 1)[0]
        for i, (timestamp, changes) in enumerate(steps):
            status = json.loads(json.dumps(self.status))
            for key, value in changes.items():
                status[key] = value
            fixture = self.root / f"step-{i}.json"
            fixture.write_text(json.dumps(status))
            code += (
                f"\nprintf '%s' {timestamp} > {shlex.quote(str(clock))}\n"
                f"cp {shlex.quote(str(fixture))} {shlex.quote(str(self.fixture))}\nrecord_once\n"
            )
        result = subprocess.run(
            ["bash", "-c", code],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def summaries(self):
        path = self.log / "splash-performance.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()]

    def test_five_minute_weighted_summaries_are_logged_in_quiet_mode(self):
        metrics = {
            **self.status["metrics"],
            "prefill_input_tokens": 60100,
            "prefill_wall_ms": 20100,
            "decode_output_tokens": 3010,
            "decode_wall_ms": 50100,
        }
        result = self.summary_steps(
            [
                (1000, {}),
                (1299, {"metrics": metrics}),
                (1300, {"metrics": metrics}),
                (1302, {"metrics": metrics}),
                (1600, {"metrics": metrics}),
            ]
        )
        self.assertEqual(result.stdout, "")
        rows = self.summaries()
        self.assertEqual(len(rows), 2)
        first, idle = rows
        self.assertEqual(first["interval_seconds"], 300)
        self.assertEqual(first["interval"]["pp_tokens_per_second"], 3000)
        self.assertEqual(first["interval"]["decode_tokens_per_second"], 60)
        self.assertAlmostEqual(
            first["lifetime"]["pp_tokens_per_second"], 60100 / 20.1, places=6
        )
        self.assertIsNone(idle["interval"]["pp_tokens_per_second"])
        self.assertIsNone(idle["interval"]["decode_tokens_per_second"])
        log = (self.log / "splash-latest.log").read_text()
        self.assertEqual(log.count("Performance 300s"), 2)
        self.assertEqual(log.count("===== [PERF] Performance"), 2)
        self.assertIn("PP=3000 tok/s TPS=60 tok/s", log)
        self.assertIn("PP=idle TPS=idle", log)
        self.assertIn("engine lifetime", log)

    def test_quiet_launcher_mirrors_one_summary_to_terminal_with_local_time(self):
        terminal = self.root / "terminal-output"
        self.env.update(SPLASH_MONITOR_TTY=str(terminal), TZ="America/Toronto")
        result = self.summary_steps([(1000, {}), (1300, {})])
        log = (self.log / "splash-latest.log").read_text()
        self.assertEqual(result.stdout, "")
        self.assertEqual(terminal.read_text(), log)
        self.assertEqual(log.count("[PERF]"), 1)
        self.assertIn("1969-12-31T19:21:40-0500", log)
        self.assertIn("interval average PP=idle", log)
        self.assertIn("engine lifetime average PP=1000 tok/s", log)

    def test_missing_terminal_does_not_interrupt_file_logging(self):
        self.env["SPLASH_MONITOR_TTY"] = str(self.root / "missing" / "terminal")
        self.summary_steps([(1000, {}), (1300, {})])
        self.assertEqual(len(self.summaries()), 1)
        self.assertIn("[PERF]", (self.log / "splash-latest.log").read_text())

    def test_summary_resets_on_engine_restart_and_ignores_stale_status(self):
        metrics = {
            **self.status["metrics"],
            "prefill_input_tokens": 10,
            "prefill_wall_ms": 10,
        }
        self.summary_steps(
            [
                (1000, {}),
                (1300, {"transport": {"restarts": 1}, "metrics": metrics}),
                (
                    1600,
                    {
                        "transport": {"restarts": 1, "status_stale": True},
                        "metrics": metrics,
                    },
                ),
                (1602, {"transport": {"restarts": 1}, "metrics": metrics}),
            ]
        )
        rows = self.summaries()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["restarts"], 1)
        self.assertEqual(rows[0]["interval_seconds"], 302)
        self.assertIsNone(rows[0]["interval"]["pp_tokens_per_second"])

    def test_summary_resets_for_counter_rollbacks_and_new_server_instances(self):
        metrics = {
            **self.status["metrics"],
            "prefill_input_tokens": 10,
            "prefill_wall_ms": 10,
        }
        instance = {**self.status["instance"], "id": "run2"}
        self.summary_steps(
            [
                (1000, {}),
                (1300, {"metrics": metrics}),
                (1600, {"metrics": metrics}),
                (1602, {"instance": instance, "metrics": metrics}),
                (1902, {"instance": instance, "metrics": metrics}),
            ]
        )
        rows = self.summaries()
        self.assertEqual([r["instance"] for r in rows], ["run1", "run2"])
        self.assertEqual([r["interval_seconds"] for r in rows], [300, 300])
        self.assertTrue(
            all(r["interval"]["pp_tokens_per_second"] is None for r in rows)
        )

    def test_expert_identity_process_memory_and_system_counters_survive_recording(self):
        first = self.snapshot()
        self.assertEqual(first["streamed_experts"], self.status["streamed_experts"])
        self.assertEqual(first["identity"], self.status["identity"])
        self.assertEqual(first["memory_plan"], self.status["memory_plan"])
        self.assertEqual(first["disk"]["limit_bytes"], 0)
        self.assertEqual(first["system_vm"]["page_size_bytes"], 16384)
        self.assertEqual(first["system_vm"]["swapouts"], 40)
        self.assertEqual(
            first["process_memory"]["processes"],
            [
                {"pid": 42, "ppid": 1, "rss_bytes": 1024000},
                {"pid": 43, "ppid": 42, "rss_bytes": 2048000},
            ],
        )
        self.assertIsNone(first["system_vm_delta"])
        first["ts"] = int(time.time()) - 2
        first["system_vm"]["swapouts"] = 35
        (self.log / "splash-status.jsonl").write_text(json.dumps(first) + "\n")
        second = self.snapshot()
        self.assertEqual(second["system_vm_delta"]["swapouts"], 5)
        report = self.run_monitor("--report", "1").stdout
        self.assertIn("SSD expert reads: prefill_MiB=0 decode_MiB=0", report)
        self.assertIn("swapouts=5", report)

    def test_missing_resources_are_unknown_and_counter_resets_are_not_zero_stalls(self):
        self.command("ps", "exit 1")
        self.command("vm_stat", "exit 1")
        first = self.snapshot()
        self.assertIsNone(first["process_memory"]["processes"])
        self.assertNotIn("swapouts", first["system_vm"])
        first["ts"] = int(time.time()) - 2
        first["system_vm"] = {"swapouts": 100}
        (self.log / "splash-status.jsonl").write_text(json.dumps(first) + "\n")
        self.command("vm_stat", "printf 'Swapouts: 2.\\n'")
        self.assertIsNone(self.snapshot()["system_vm_delta"]["swapouts"])

    def test_legacy_status_and_history_remain_readable(self):
        del self.status["streamed_experts"]
        del self.status["identity"]["kv"]
        self.fixture.write_text(json.dumps(self.status))
        first = self.snapshot()
        first["ts"] = int(time.time()) - 2
        (self.log / "splash-status.jsonl").write_text(json.dumps(first) + "\n")
        self.snapshot()
        self.assertIn("prefill_MiB=n/a", self.run_monitor("--report", "1").stdout)
