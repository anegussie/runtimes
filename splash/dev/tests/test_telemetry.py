import json
import os
import tempfile
import time
import unittest
from pathlib import Path
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
                    chat_body(reasoning_effort="none"),
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
                self.assertFalse(end["thinking"])
                self.assertEqual(end["reasoning_tokens"], 0)
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
    def test_bad_identifiers_are_rejected_and_logging_failure_does_not_raise(self):
        self.assertEqual(
            telemetry.correlation({"x-opencode-request-id": "unsafe secret / path"}), {}
        )
        before = telemetry.health()["write_failures"]
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {"SPLASH_TELEMETRY_PATH": directory}):
                telemetry.emit({"event": "test"})
        self.assertEqual(telemetry.health()["write_failures"], before + 1)
