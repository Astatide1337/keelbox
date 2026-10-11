#!/usr/bin/env python3
"""CPU-only integration check for the two HTTP components."""

from __future__ import annotations

import json
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


SCENARIO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCENARIO_ROOT / "src"))
sys.path.insert(0, str(SCENARIO_ROOT / "tools"))

import consumer  # noqa: E402
import measure_detection  # noqa: E402
import producer  # noqa: E402


def request_json(url: str, method: str = "GET") -> tuple[int, dict]:
    request = Request(url, data=b"" if method == "POST" else None, method=method)
    try:
        response = urlopen(request, timeout=1)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read())


class MarketDataLocalTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stop_event = threading.Event()
        self.feed = producer.QuoteFeed(update_interval=0.04)
        self.producer_thread = threading.Thread(
            target=self.feed.run, args=(self.stop_event,), daemon=True
        )
        self.producer_thread.start()
        self.producer_server = producer.make_server(
            self.feed, host="127.0.0.1", port=0
        )
        self.producer_server_thread = threading.Thread(
            target=self.producer_server.serve_forever, daemon=True
        )
        self.producer_server_thread.start()
        self.producer_control_server = producer.make_control_server(
            self.feed, port=0
        )
        self.producer_control_server_thread = threading.Thread(
            target=self.producer_control_server.serve_forever, daemon=True
        )
        self.producer_control_server_thread.start()

        self.monitor = consumer.QuoteMonitor(
            producer_url=f"http://127.0.0.1:{self.producer_server.server_port}/quote",
            poll_interval=0.02,
            max_data_age=0.18,
            request_timeout=0.5,
        )
        self.consumer_server = consumer.make_server(
            self.monitor, host="127.0.0.1", port=0
        )
        self.consumer_server_thread = threading.Thread(
            target=self.consumer_server.serve_forever, daemon=True
        )
        self.consumer_server_thread.start()
        self.consumer_thread = threading.Thread(
            target=self.monitor.run, args=(self.stop_event,), daemon=True
        )
        self.consumer_thread.start()
        self.producer_url = f"http://127.0.0.1:{self.producer_server.server_port}"
        self.producer_control_url = (
            f"http://127.0.0.1:{self.producer_control_server.server_port}"
        )
        self.consumer_url = f"http://127.0.0.1:{self.consumer_server.server_port}"

    def tearDown(self) -> None:
        self.stop_event.set()
        self.producer_server.shutdown()
        self.producer_control_server.shutdown()
        self.consumer_server.shutdown()
        self.producer_server.server_close()
        self.producer_control_server.server_close()
        self.consumer_server.server_close()
        self.producer_thread.join(timeout=1)
        self.consumer_thread.join(timeout=1)

    def wait_for(self, predicate, timeout: float = 2.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.01)
        self.fail("condition did not become true before timeout")

    def metrics_if(self, predicate):
        metrics = self.monitor.snapshot()
        return metrics if predicate(metrics) else None

    def test_services_exchange_quotes_staleness_and_recovery(self) -> None:
        fresh = self.wait_for(
            lambda: self.metrics_if(lambda metrics: metrics["fresh"])
        )
        self.assertEqual(fresh["service"], "market-consumer")
        self.assertLessEqual(fresh["quote_age_seconds"], 0.18)

        producer_status, producer_ready = request_json(
            f"{self.producer_url}/readyz"
        )
        consumer_status, consumer_ready = request_json(
            f"{self.consumer_url}/readyz"
        )
        self.assertEqual(producer_status, 200)
        self.assertEqual(consumer_status, 200)
        self.assertTrue(producer_ready["ok"])
        self.assertTrue(consumer_ready["fresh"])
        self.assertEqual(self.producer_control_server.server_address[0], "127.0.0.1")

        # The Service-facing data listener cannot change producer state.
        data_port_pause_status, _ = request_json(
            f"{self.producer_url}/lab/pause", method="POST"
        )
        self.assertEqual(data_port_pause_status, 404)
        self.assertFalse(self.feed.snapshot()["paused"])

        # This POST is the supported, repeatable fault primitive. No shell or
        # process execution is involved; the control listener is Pod-loopback-only.
        pause_status, paused = request_json(
            f"{self.producer_control_url}/lab/pause", method="POST"
        )
        self.assertEqual(pause_status, 200)
        frozen = paused["quote"]
        self.assertIsNotNone(frozen)

        stale = self.wait_for(
            lambda: self.metrics_if(lambda metrics: metrics["state"] == "stale")
        )
        measured_stale, _ = measure_detection.wait_for_stale(
            self.consumer_url,
            frozen,
            timeout=1.0,
            poll_interval=0.01,
        )
        self.assertEqual(measured_stale["sequence"], frozen["sequence"])
        with self.assertRaisesRegex(RuntimeError, "frozen quote"):
            measure_detection.wait_for_stale(
                self.consumer_url,
                dict(frozen, sequence=frozen["sequence"] + 1),
                timeout=1.0,
                poll_interval=0.01,
            )
        self.assertEqual(stale["feed_id"], frozen["feed_id"])
        self.assertEqual(stale["sequence"], frozen["sequence"])
        self.assertGreaterEqual(stale["quote_age_seconds"], 0.18)
        self.assertFalse(stale["fresh"])

        # Feed freshness affects application readiness; the serving process and
        # producer API are still live. This is the lab's central invariant.
        producer_ready_status, _ = request_json(f"{self.producer_url}/readyz")
        consumer_ready_status, consumer_status_payload = request_json(
            f"{self.consumer_url}/readyz"
        )
        consumer_live_status, _ = request_json(f"{self.consumer_url}/livez")
        self.assertEqual(producer_ready_status, 200)
        self.assertEqual(consumer_ready_status, 503)
        self.assertFalse(consumer_status_payload["fresh"])
        self.assertEqual(consumer_live_status, 200)
        self.assertTrue(self.consumer_thread.is_alive())

        resume_status, _ = request_json(
            f"{self.producer_control_url}/lab/resume", method="POST"
        )
        self.assertEqual(resume_status, 200)
        recovered = self.wait_for(
            lambda: self.metrics_if(
                lambda metrics: metrics["fresh"]
                and metrics["feed_id"] == frozen["feed_id"]
                and metrics["sequence"] > frozen["sequence"]
            )
        )
        self.assertTrue(recovered["fresh"])
        self.assertEqual(
            request_json(f"{self.consumer_url}/livez")[0], 200
        )

    def test_sequence_regression_breaks_freshness_invariant(self) -> None:
        monitor = consumer.QuoteMonitor(
            producer_url="http://unused.invalid/quote",
            poll_interval=0.1,
            max_data_age=10,
        )
        quote = {
            "symbol": "SYNTH-EDU",
            "feed_id": "test-feed",
            "sequence": 8,
            "price": 100.07,
            "generated_at_utc": "2026-01-01T00:00:00.000Z",
        }
        monitor.observe(quote)
        self.assertTrue(monitor.snapshot()["fresh"])

        regressed = dict(quote, sequence=7)
        monitor.observe(regressed)
        snapshot = monitor.snapshot()
        self.assertEqual(snapshot["state"], "protocol-error")
        self.assertFalse(snapshot["fresh"])
        self.assertIn("sequence regressed", snapshot["protocol_error"])

    def test_measurement_helper_accepts_only_loopback_origins(self) -> None:
        for url in (
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://[::1]:8080",
        ):
            with self.subTest(url=url):
                measure_detection.validate_loopback_url(url, "url")
        for url in (
            "https://127.0.0.1:8080",
            "http://example.com:8080",
            "http://user@localhost:8080",
            "http://localhost:8080/api?token=secret",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                measure_detection.validate_loopback_url(url, "url")

    def test_measurement_helper_resumes_after_ambiguous_pause_response(self) -> None:
        self.wait_for(lambda: self.metrics_if(lambda metrics: metrics["fresh"]))
        original_request_json = measure_detection.request_json

        def lose_pause_response(
            base_url: str,
            path: str,
            method: str = "GET",
            timeout: float = 2.0,
        ):
            result = original_request_json(base_url, path, method, timeout)
            if path == "/lab/pause" and method == "POST":
                self.assertEqual(result[0], 200)
                raise RuntimeError("simulated response loss after pause was applied")
            return result

        arguments = [
            "measure_detection.py",
            "--producer-url",
            self.producer_url,
            "--control-url",
            self.producer_control_url,
            "--consumer-url",
            self.consumer_url,
            "--trials",
            "1",
            "--poll-interval",
            "0.01",
            "--timeout",
            "1",
            "--workload-mode",
            "local",
        ]
        with (
            patch.object(measure_detection.sys, "argv", arguments),
            patch.object(measure_detection, "request_json", side_effect=lose_pause_response),
            self.assertRaisesRegex(
                RuntimeError, "simulated response loss after pause was applied"
            ),
        ):
            measure_detection.main()

        self.assertFalse(self.feed.snapshot()["paused"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
