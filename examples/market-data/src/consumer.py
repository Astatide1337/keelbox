#!/usr/bin/env python3
"""Consume quotes over HTTP and expose feed freshness separately from liveness."""

from __future__ import annotations

import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.request import urlopen


DEFAULT_POLL_INTERVAL = 0.25
DEFAULT_MAX_DATA_AGE = 3.0
EXPECTED_SYMBOL = "SYNTH-EDU"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


class QuoteMonitor:
    """Track sequence progress with a local monotonic clock, not wall-clock age."""

    def __init__(
        self,
        producer_url: str,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        max_data_age: float = DEFAULT_MAX_DATA_AGE,
        request_timeout: float = 1.0,
    ) -> None:
        if poll_interval <= 0 or max_data_age <= 0 or request_timeout <= 0:
            raise ValueError("poll interval, max age, and timeout must be positive")
        self.producer_url = producer_url
        self.poll_interval = poll_interval
        self.max_data_age = max_data_age
        self.request_timeout = request_timeout
        self._lock = threading.Lock()
        self._quote: dict[str, Any] | None = None
        self._last_advance_monotonic: float | None = None
        self._last_advance_utc: str | None = None
        self._protocol_error: str | None = None
        self._last_error: str | None = None

    def poll_once(self) -> None:
        try:
            with urlopen(self.producer_url, timeout=self.request_timeout) as response:
                if response.status != 200:
                    raise RuntimeError(f"producer returned HTTP {response.status}")
                payload = json.loads(response.read())
            self.observe(payload)
        except (OSError, TimeoutError, RuntimeError, ValueError) as error:
            with self._lock:
                self._last_error = str(error)[:180]

    def observe(self, quote: dict[str, Any]) -> None:
        error = self._validate_quote(quote)
        if error:
            with self._lock:
                self._protocol_error = error
                self._last_error = error
            return

        now = time.monotonic()
        with self._lock:
            previous = self._quote
            advances = previous is None or quote["feed_id"] != previous["feed_id"]
            if previous is not None and quote["feed_id"] == previous["feed_id"]:
                if quote["sequence"] > previous["sequence"]:
                    advances = True
                elif quote["sequence"] < previous["sequence"]:
                    message = (
                        f"sequence regressed from {previous['sequence']} "
                        f"to {quote['sequence']} in feed {quote['feed_id']}"
                    )
                    self._protocol_error = message
                    self._last_error = message
                    return
                elif quote != previous:
                    message = "quote payload changed without a sequence advance"
                    self._protocol_error = message
                    self._last_error = message
                    return

            if advances:
                self._quote = quote.copy()
                self._last_advance_monotonic = now
                self._last_advance_utc = utc_now()
                self._protocol_error = None
            self._last_error = None

    @staticmethod
    def _validate_quote(quote: Any) -> str | None:
        if not isinstance(quote, dict):
            return "quote response is not an object"
        if quote.get("symbol") != EXPECTED_SYMBOL:
            return "unexpected synthetic symbol"
        if not isinstance(quote.get("feed_id"), str) or not quote["feed_id"]:
            return "quote has no feed_id"
        sequence = quote.get("sequence")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            return "quote sequence must be a positive integer"
        price = quote.get("price")
        if not isinstance(price, (int, float)) or isinstance(price, bool):
            return "quote price must be numeric"
        if not math.isfinite(float(price)):
            return "quote price must be finite"
        if not isinstance(quote.get("generated_at_utc"), str):
            return "quote has no generated_at_utc value"
        return None

    def run(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set():
            self.poll_once()
            stop_event.wait(self.poll_interval)

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            quote = self._quote.copy() if self._quote else None
            last_advance = self._last_advance_monotonic
            last_advance_utc = self._last_advance_utc
            protocol_error = self._protocol_error
            last_error = self._last_error

        age = now - last_advance if last_advance is not None else None
        fresh = (
            quote is not None
            and age is not None
            and age <= self.max_data_age
            and protocol_error is None
        )
        if protocol_error:
            state = "protocol-error"
        elif quote is None:
            state = "waiting-for-first-quote"
        elif fresh:
            state = "fresh"
        else:
            state = "stale"

        return {
            "service": "market-consumer",
            "state": state,
            "fresh": fresh,
            "producer_url": self.producer_url,
            "poll_interval_seconds": self.poll_interval,
            "max_data_age_seconds": self.max_data_age,
            "feed_id": quote["feed_id"] if quote else None,
            "sequence": quote["sequence"] if quote else None,
            "price": quote["price"] if quote else None,
            "quote_generated_at_utc": quote["generated_at_utc"] if quote else None,
            "last_sequence_advance_observed_at_utc": last_advance_utc,
            "quote_age_seconds": round(age, 3) if age is not None else None,
            "observed_at_utc": utc_now(),
            "protocol_error": protocol_error,
            "last_fetch_error": last_error,
        }


def handler_for(monitor: QuoteMonitor) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "WaypointSyntheticConsumer/1.0"
        sys_version = ""

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path == "/livez":
                self._send_json(200, {"ok": True, "check": "process-serving"})
                return
            if self.path == "/metrics":
                self._send_json(200, monitor.snapshot())
                return
            if self.path == "/readyz":
                snapshot = monitor.snapshot()
                self._send_json(200 if snapshot["fresh"] else 503, snapshot)
                return
            self._send_json(404, {"ok": False, "reason": "not found"})

        def log_message(self, _format: str, *_args: Any) -> None:
            return

    return Handler


def make_server(
    monitor: QuoteMonitor, host: str = "0.0.0.0", port: int = 8081
) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), handler_for(monitor))
    server.daemon_threads = True
    return server


def main() -> None:
    producer_url = os.environ.get(
        "PRODUCER_URL", "http://market-producer:8080/quote"
    )
    poll_interval = float(
        os.environ.get("POLL_INTERVAL_SECONDS", str(DEFAULT_POLL_INTERVAL))
    )
    max_data_age = float(
        os.environ.get("MAX_DATA_AGE_SECONDS", str(DEFAULT_MAX_DATA_AGE))
    )
    monitor = QuoteMonitor(
        producer_url=producer_url,
        poll_interval=poll_interval,
        max_data_age=max_data_age,
    )
    stop_event = threading.Event()
    poller = threading.Thread(
        target=monitor.run, args=(stop_event,), name="quote-poller", daemon=True
    )
    poller.start()
    server = make_server(
        monitor,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8081")),
    )
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        stop_event.set()
        poller.join(timeout=2)
        server.server_close()


if __name__ == "__main__":
    main()
