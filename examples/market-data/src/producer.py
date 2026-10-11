#!/usr/bin/env python3
"""Generate a synthetic quote stream and expose a lab-only pause control."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


SYMBOL = "SYNTH-EDU"
DEFAULT_UPDATE_INTERVAL = 0.5


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


class QuoteFeed:
    """In-memory quote source. Restarting the process creates a new feed id."""

    def __init__(
        self,
        update_interval: float = DEFAULT_UPDATE_INTERVAL,
        symbol: str = SYMBOL,
    ) -> None:
        if update_interval <= 0:
            raise ValueError("update_interval must be positive")
        self.update_interval = update_interval
        self.symbol = symbol
        self.feed_id = str(uuid.uuid4())
        self._lock = threading.Lock()
        self._sequence = 0
        self._quote: dict[str, Any] | None = None
        self._paused = False

    def tick(self) -> dict[str, Any] | None:
        with self._lock:
            if self._paused:
                return self._quote.copy() if self._quote else None
            self._sequence += 1
            # Deliberately synthetic and deterministic. It is not a market price.
            price = round(100.0 + ((self._sequence % 25) * 0.07), 2)
            self._quote = {
                "symbol": self.symbol,
                "feed_id": self.feed_id,
                "sequence": self._sequence,
                "price": price,
                "generated_at_utc": utc_now(),
            }
            return self._quote.copy()

    def run(self, stop_event: threading.Event) -> None:
        self.tick()
        while not stop_event.wait(self.update_interval):
            self.tick()

    def pause(self) -> dict[str, Any] | None:
        with self._lock:
            self._paused = True
            return self._quote.copy() if self._quote else None

    def resume(self) -> dict[str, Any] | None:
        with self._lock:
            self._paused = False
            return self._quote.copy() if self._quote else None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "service": "market-producer",
                "paused": self._paused,
                "update_interval_seconds": self.update_interval,
                "quote": self._quote.copy() if self._quote else None,
            }

    def current_quote(self) -> dict[str, Any] | None:
        with self._lock:
            return self._quote.copy() if self._quote else None


class JsonHandler(BaseHTTPRequestHandler):
    server_version = "WaypointSyntheticFeed/1.0"
    sys_version = ""

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        # The scenario's explicit metrics endpoints carry the useful evidence.
        return


def handler_for(feed: QuoteFeed) -> type[BaseHTTPRequestHandler]:
    class DataHandler(JsonHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path == "/livez":
                self._send_json(200, {"ok": True, "check": "process-serving"})
                return
            if self.path == "/readyz":
                quote = feed.current_quote()
                if quote is None:
                    self._send_json(503, {"ok": False, "reason": "no quote yet"})
                else:
                    # Readiness means the quote API can answer. It does not assert
                    # that the source sequence is still advancing.
                    self._send_json(
                        200,
                        {
                            "ok": True,
                            "check": "quote-api-available",
                            "feed_id": quote["feed_id"],
                            "sequence": quote["sequence"],
                        },
                    )
                return
            if self.path == "/quote":
                quote = feed.current_quote()
                if quote is None:
                    self._send_json(503, {"ok": False, "reason": "no quote yet"})
                else:
                    self._send_json(200, quote)
                return
            if self.path == "/metrics":
                self._send_json(200, feed.snapshot())
                return
            self._send_json(404, {"ok": False, "reason": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            # The Service-facing quote listener never accepts feed controls.
            self._send_json(404, {"ok": False, "reason": "not found"})

    return DataHandler


def control_handler_for(feed: QuoteFeed) -> type[BaseHTTPRequestHandler]:
    class ControlHandler(JsonHandler):
        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self._send_json(404, {"ok": False, "reason": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            if self.path == "/lab/pause":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "action": "pause",
                        "quote": feed.pause(),
                    },
                )
                return
            if self.path == "/lab/resume":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "action": "resume",
                        "quote": feed.resume(),
                    },
                )
                return
            self._send_json(404, {"ok": False, "reason": "not found"})

    return ControlHandler


def make_server(
    feed: QuoteFeed, host: str = "0.0.0.0", port: int = 8080
) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), handler_for(feed))
    server.daemon_threads = True
    return server


def make_control_server(feed: QuoteFeed, port: int = 8081) -> ThreadingHTTPServer:
    """Serve fault controls only within the producer Pod's network namespace."""
    server = ThreadingHTTPServer(("127.0.0.1", port), control_handler_for(feed))
    server.daemon_threads = True
    return server


def main() -> None:
    update_interval = float(
        os.environ.get("UPDATE_INTERVAL_SECONDS", str(DEFAULT_UPDATE_INTERVAL))
    )
    feed = QuoteFeed(
        update_interval=update_interval,
        symbol=os.environ.get("QUOTE_SYMBOL", SYMBOL),
    )
    stop_event = threading.Event()
    updater = threading.Thread(
        target=feed.run, args=(stop_event,), name="quote-updater", daemon=True
    )
    server = make_server(
        feed,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8080")),
    )
    control_server = make_control_server(
        feed, port=int(os.environ.get("CONTROL_PORT", "8081"))
    )
    updater.start()
    control_thread = threading.Thread(
        target=control_server.serve_forever,
        kwargs={"poll_interval": 0.25},
        name="quote-control",
        daemon=True,
    )
    control_thread.start()
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        stop_event.set()
        updater.join(timeout=2)
        control_server.shutdown()
        control_thread.join(timeout=2)
        control_server.server_close()
        server.server_close()


if __name__ == "__main__":
    main()
