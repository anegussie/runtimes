import json
import math
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from dev.tests import test_server as fixtures

FakeRuntime = fixtures.FakeRuntime


class HarnessTestCase(unittest.TestCase):
    setUp = fixtures.ServerTest.setUp
    tearDown = fixtures.ServerTest.tearDown
    harness = fixtures.ServerTest.harness


chat_body = fixtures.ServerTest.body
from server import telemetry


class TelemetryTests(HarnessTestCase):
    def test_correlated_native_lifecycle_is_precise_and_payload_free(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": str(path)}):
                harness = self.harness(FakeRuntime())
                status, _, _ = harness.request(
                    "POST",
                    "/v1/chat/completions",
                    chat_body(
                        reasoning_effort="none", temperature=0.25, top_p=0.8, seed=42
                    ),
                    headers={
                        "Content-Type": "application/json",
                        "x-opencode-request-id": "trace-123",
                        "x-opencode-session-id": "session-123",
                        "Authorization": "PRIVATE_AUTH",
                    },
                )
                self.assertEqual(status, 200)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    records = [
                        json.loads(line) for line in path.read_text().splitlines()
                    ]
                    if any(r["event"] == "request_end" for r in records):
                        break
                    time.sleep(0.01)
                kinds = {r["event"] for r in records}
                self.assertTrue(
                    {
                        "http_request_ingress",
                        "request_prepared",
                        "request_queue_enter",
                        "request_queue_leave",
                        "request_native_start",
                        "request_first_token",
                        "request_end",
                    }
                    <= kinds
                )
                jobs = [r for r in records if "request_id" in r]
                self.assertEqual(len({r["request_id"] for r in jobs}), 1)
                for r in records:
                    self.assertEqual(r["correlation"]["request_id"], "trace-123")
                    self.assertEqual(r["correlation"]["session_id"], "session-123")
                    self.assertEqual(r["schemaVersion"], 2)
                    self.assertTrue(int(r["monotonicNs"]) > 0)
                end = next(r for r in records if r["event"] == "request_end")
                self.assertIsNone(end["reasoning_effort_effective"])
                self.assertEqual(end["reasoning_tokens"], 0)
                self.assertEqual(end["sampling"]["temperature"], 0.25)
                self.assertEqual(end["sampling"]["top_p"], 0.8)
                self.assertEqual(end["seed"], 42)
                self.assertIn("request_latency", end["metrics"])
                self.assertIsNone(end["gpu_kernel_ms"])
                self.assertNotIn("PRIVATE_AUTH", path.read_text())
                self.assertNotIn("hello", path.read_text())

    def test_invalid_request_errors_are_correlated_without_body_or_query(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": str(path)}):
                harness = self.harness(FakeRuntime())
                status, _, _ = harness.request(
                    "POST",
                    "/missing?token=PRIVATE_QUERY",
                    {"secret": "PRIVATE_BODY"},
                    headers={
                        "Content-Type": "application/json",
                        "x-opencode-request-id": "trace-error",
                    },
                )
                self.assertEqual(status, 404)
                records = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertTrue(
                    any(r["event"] == "http_request_error" for r in records)
                )
                self.assertNotIn("PRIVATE_", path.read_text())


class WriterTests(unittest.TestCase):
    def test_manifest_records_identity_options_and_digests_without_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "events.jsonl"
            assembly = {
                "model": "owner/model",
                "family": "qwen",
                "target_format": "gguf",
                "sources": {"target": {"repo": "owner/model", "revision": "abc"}},
                "files": {
                    "target/model.gguf": {
                        "path": "/model.gguf",
                        "bytes": 1234,
                        "digest": "abc123",
                        "extra": "PRIVATE_FILE_METADATA",
                    }
                },
            }
            (root / "model.json").write_text(json.dumps(assembly))
            args = SimpleNamespace(
                model="owner/model",
                max_context=24576,
                kv_format="int8",
                state_format="bf16",
                max_memory=8 * 1024**3,
                api_key="PRIVATE_AUTH",
                thinking_end_text="PRIVATE_TEXT",
                idle_release=math.inf,
            )
            snapshot = {
                "identity": {"cache": {"build_id": "build1"}},
                "memory_plan": {"device": {"device_name": "Apple M5"}},
                "requests": {"completed": 0},
            }
            with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": str(path)}):
                telemetry.run_manifest(
                    args,
                    root,
                    ["splash", "serve-native", str(root)],
                    lambda: snapshot,
                    "instance1",
                )
            record = json.loads(path.read_text())
            self.assertEqual(record["event"], "run_manifest")
            self.assertEqual(record["instance_id"], "instance1")
            self.assertEqual(record["launch_options"]["max_context"], 24576)
            self.assertEqual(record["launch_options"]["state_format"], "bf16")
            self.assertEqual(record["launch_options"]["idle_release"], "off")
            self.assertEqual(
                record["assembly"]["files"]["target/model.gguf"]["digest"], "abc123"
            )
            self.assertEqual(
                record["initial_status"],
                {key: snapshot.get(key) for key in record["initial_status"]},
            )
            self.assertIn("backend.py", record["server_source_sha256"])
            self.assertEqual(len(record["assembly_record_sha256"]), 64)
            self.assertNotIn("PRIVATE_", path.read_text())

    def test_manifest_disabled_does_no_work_and_missing_metadata_is_explicit(self):
        with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": ""}):
            telemetry.run_manifest(None, None, None, None, None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": str(path)}):
                telemetry.run_manifest(
                    SimpleNamespace(), directory, [], lambda: {}, "run"
                )
            self.assertEqual(
                json.loads(path.read_text())["assembly_unavailable"],
                "FileNotFoundError",
            )

    def test_bad_identifiers_are_rejected_and_logging_failure_does_not_raise(self):
        self.assertEqual(
            telemetry.correlation({"x-opencode-request-id": "unsafe secret / path"}), {}
        )
        before = telemetry.health()["write_failures"]
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": directory}):
                telemetry.emit({"event": "test"})
        self.assertEqual(telemetry.health()["write_failures"], before + 1)
