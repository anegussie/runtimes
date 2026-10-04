"""Single-flight request admission: FIFO, release, cancellation and shutdown."""

import threading
import time
import unittest

from dev.tests.engine.test_native_backend import (
    FakeRuntime,
    FakeTokenizer,
    make_job,
    success_result,
)
from server.backend import NativeBackend
from server.errors import APIError


class NativeFifoTests(unittest.TestCase):
    def setUp(self):
        self.runtime = FakeRuntime()
        self.backend = NativeBackend(
            self.runtime, FakeTokenizer(), max_active_requests=1
        )
        self.addCleanup(self.backend.close)

    def wait(self, predicate):
        end = time.monotonic() + 2
        while not predicate() and time.monotonic() < end:
            time.sleep(0.005)
        self.assertTrue(predicate())

    def queued(self, job):
        thread = threading.Thread(target=self.backend.submit, args=(job,), daemon=True)
        thread.start()
        self.wait(lambda: job.request_id in self.backend.submission_queue)
        return thread

    def finish(self, call):
        call.complete(result=success_result(call))

    def test_fifo_one_native_call_at_a_time(self):
        self.backend.submit(make_job(1))
        second, third = make_job(2), make_job(3)
        t2 = self.queued(second)
        t3 = self.queued(third)
        self.assertEqual(len(self.runtime.calls), 1)
        self.assertEqual(self.backend.status()["transport"]["frontend_waiting"], 2)
        self.finish(self.runtime.calls[0])
        self.wait(lambda: len(self.runtime.calls) == 2)
        self.assertEqual(list(self.backend.active), [2])
        self.finish(self.runtime.calls[1])
        self.wait(lambda: len(self.runtime.calls) == 3)
        self.assertEqual(list(self.backend.active), [3])
        self.finish(self.runtime.calls[2])
        t2.join(1)
        t3.join(1)
        self.assertFalse(t2.is_alive() or t3.is_alive())
        self.assertGreater(second.frontend_queue_ms, 0)

    def test_cancelled_waiter_never_reaches_engine(self):
        self.backend.submit(make_job(1))
        second = make_job(2)
        thread = self.queued(second)
        self.backend.cancel(second)
        thread.join(1)
        self.assertFalse(thread.is_alive())
        kind, error = second.events.get(timeout=1)
        self.assertEqual((kind, error.code), ("error", "request_cancelled"))
        self.assertEqual(len(self.runtime.calls), 1)

    def test_deadline_is_not_reset_while_queued(self):
        self.backend.submit(make_job(1))
        second = make_job(2)
        second.deadline = time.monotonic() + 0.1
        thread = self.queued(second)
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(second.events.get(timeout=1)[1].code, "request_timeout")
        self.assertEqual(len(self.runtime.calls), 1)

    def test_shutdown_wakes_waiters(self):
        self.backend.submit(make_job(1))
        second = make_job(2)
        thread = self.queued(second)
        self.backend.close()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(second.events.get(timeout=1)[1].code, "server_shutdown")

    def test_disconnected_waiter_never_reaches_engine(self):
        self.backend.submit(make_job(1))
        second = make_job(2)
        disconnected = threading.Event()
        polls = []

        def poll():
            polls.append(1)
            if disconnected.is_set():
                raise APIError(499, "disconnected", "request_cancelled")

        second.queue_poll = poll
        thread = self.queued(second)
        disconnected.set()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(polls)
        self.assertEqual(second.events.get(timeout=1)[1].code, "request_cancelled")
        self.assertEqual(len(self.runtime.calls), 1)

    def test_queue_poll_does_not_hold_transport_lock(self):
        self.backend.submit(make_job(1))
        checked = []
        second = make_job(2)

        def poll():
            acquired = []

            def check():
                with self.backend.lock:
                    acquired.append(True)

            worker = threading.Thread(target=check)
            worker.start()
            worker.join(0.5)
            checked.append(bool(acquired))

        second.queue_poll = poll
        thread = self.queued(second)
        self.wait(lambda: bool(checked))
        self.finish(self.runtime.calls[0])
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(all(checked))
        self.assertIsNone(second.queue_poll)

    def test_immediate_admission_does_not_poll_http_queue(self):
        job = make_job(1)
        polls = []
        job.queue_poll = lambda: polls.append(True)
        self.backend.submit(job)
        self.assertEqual(polls, [])
        self.assertIsNone(job.queue_poll)

    def test_default_preserves_concurrent_submission(self):
        backend = NativeBackend(FakeRuntime(), FakeTokenizer())
        try:
            backend.submit(make_job(1))
            backend.submit(make_job(2))
            self.assertEqual(len(backend.runtime.calls), 2)
        finally:
            backend.close()
