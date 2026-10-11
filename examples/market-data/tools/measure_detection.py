#!/usr/bin/env python3
"""Measure client-observed stale-feed detection through HTTP endpoints."""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import sys
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


SCRIPT_VERSION = "1.0"
IMAGE = "python:3.12.15-slim-trixie"
DECLARED_PER_POD_RESOURCES = {
    "requests": {"cpu": "10m", "memory": "48Mi"},
    "limits": {"cpu": "100m", "memory": "96Mi"},
}


def request_json(
    base_url: str, path: str, method: str = "GET", timeout: float = 2.0
) -> tuple[int, dict[str, Any]]:
    url = base_url.rstrip("/") + path
    request = Request(url, data=b"" if method == "POST" else None, method=method)
    try:
        response = urlopen(request, timeout=timeout)
    except HTTPError as error:
        response = error
    except (OSError, TimeoutError) as error:
        raise RuntimeError(f"request to {url} failed: {error}") from error
    with response:
        try:
            payload = json.loads(response.read())
        except json.JSONDecodeError as error:
            raise RuntimeError(f"{url} did not return JSON") from error
        if not isinstance(payload, dict):
            raise RuntimeError(f"{url} did not return a JSON object")
        return response.status, payload


def validate_loopback_url(value: str, label: str) -> None:
    try:
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError as error:
        raise ValueError(f"{label} must be a valid loopback URL: {error}") from error
    if (
        parsed.scheme != "http"
        or parsed.hostname is None
        or parsed.hostname.lower() not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            f"{label} must be a local HTTP origin (127.0.0.1, localhost, or ::1); "
            "the helper sends lab pause/resume requests and will not target remote hosts"
        )


def wait_until(
    description: str,
    timeout: float,
    poll_interval: float,
    probe: Callable[[], Any],
    predicate: Callable[[Any], bool],
) -> Any:
    deadline = time.monotonic() + timeout
    last_value: Any = None
    while time.monotonic() < deadline:
        last_value = probe()
        if predicate(last_value):
            return last_value
        time.sleep(poll_interval)
    raise TimeoutError(f"timed out waiting for {description}; last value={last_value!r}")


def wait_for_advancing_quote(
    producer_url: str,
    consumer_url: str,
    timeout: float,
    poll_interval: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    def read_pair() -> tuple[dict[str, Any], dict[str, Any]]:
        producer_status, producer_metrics = request_json(producer_url, "/metrics")
        consumer_status, consumer_metrics = request_json(consumer_url, "/metrics")
        if producer_status != 200 or consumer_status != 200:
            raise RuntimeError("metrics endpoints must return HTTP 200")
        return producer_metrics, consumer_metrics

    def matches(pair: tuple[dict[str, Any], dict[str, Any]]) -> bool:
        producer_metrics, consumer_metrics = pair
        quote = producer_metrics.get("quote") or {}
        return (
            consumer_metrics.get("fresh") is True
            and quote.get("feed_id") == consumer_metrics.get("feed_id")
            and quote.get("sequence") == consumer_metrics.get("sequence")
        )

    pair = wait_until(
        "consumer to observe the current advancing producer quote",
        timeout,
        poll_interval,
        read_pair,
        matches,
    )
    producer_metrics, consumer_metrics = pair
    frozen_candidate = producer_metrics.get("quote") or {}
    old_sequence = consumer_metrics.get("sequence")

    def read_advanced_pair() -> tuple[dict[str, Any], dict[str, Any]]:
        return read_pair()

    def advanced(pair_value: tuple[dict[str, Any], dict[str, Any]]) -> bool:
        producer_value, consumer_value = pair_value
        quote = producer_value.get("quote") or {}
        return (
            consumer_value.get("fresh") is True
            and quote.get("feed_id") == consumer_value.get("feed_id")
            and quote.get("sequence") == consumer_value.get("sequence")
            and (
                quote.get("feed_id") != frozen_candidate.get("feed_id")
                or quote.get("sequence", 0) > old_sequence
            )
        )

    return wait_until(
        "a newer sequence than the baseline",
        timeout,
        poll_interval,
        read_advanced_pair,
        advanced,
    )


def wait_for_frozen_quote(
    consumer_url: str,
    frozen: dict[str, Any],
    timeout: float,
    poll_interval: float,
) -> tuple[dict[str, Any], float]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        _, metrics = request_json(consumer_url, "/metrics")
        matches = (
            metrics.get("feed_id") == frozen.get("feed_id")
            and metrics.get("sequence") == frozen.get("sequence")
        )
        if matches and metrics.get("fresh"):
            return metrics, time.monotonic()
        if matches and not metrics.get("fresh"):
            raise RuntimeError(
                "consumer became stale before the helper observed the frozen quote; "
                "reduce client polling delay or increase the configured freshness window"
            )
        time.sleep(poll_interval)
    raise TimeoutError("consumer did not observe the producer's frozen quote")


def wait_for_stale(
    consumer_url: str,
    frozen: dict[str, Any],
    timeout: float,
    poll_interval: float,
) -> tuple[dict[str, Any], float]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, metrics = request_json(consumer_url, "/metrics")
        if status != 200:
            raise RuntimeError("consumer metrics endpoint stopped returning HTTP 200")
        if not metrics.get("fresh"):
            if (
                metrics.get("state") != "stale"
                or metrics.get("feed_id") != frozen.get("feed_id")
                or metrics.get("sequence") != frozen.get("sequence")
            ):
                raise RuntimeError(
                    "consumer lost freshness for a reason other than the frozen quote "
                    f"(state={metrics.get('state')!r}, feed_id={metrics.get('feed_id')!r}, "
                    f"sequence={metrics.get('sequence')!r})"
                )
            return metrics, time.monotonic()
        time.sleep(poll_interval)
    raise TimeoutError("consumer did not report stale data before timeout")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Pause and resume the synthetic producer, then report observed consumer "
            "freshness-detection timings. All URLs must be loopback port-forwards or local test servers."
        )
    )
    parser.add_argument(
        "--producer-url",
        required=True,
        help="local base URL, for example http://127.0.0.1:18080",
    )
    parser.add_argument(
        "--control-url",
        required=True,
        help="local base URL for the Pod-loopback control listener, for example http://127.0.0.1:18082",
    )
    parser.add_argument(
        "--consumer-url",
        required=True,
        help="local base URL, for example http://127.0.0.1:18081",
    )
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--poll-interval", type=float, default=0.1)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument(
        "--environment-note",
        default="",
        help="optional cluster/runtime details to preserve with this measurement",
    )
    parser.add_argument(
        "--workload-mode",
        choices=("kubernetes-port-forward", "local"),
        default="kubernetes-port-forward",
        help="declare whether endpoints are port-forwards or local test servers",
    )
    args = parser.parse_args()
    if args.trials < 1 or args.poll_interval <= 0 or args.timeout <= 0:
        parser.error("trials, poll interval, and timeout must be positive")
    try:
        validate_loopback_url(args.producer_url, "--producer-url")
        validate_loopback_url(args.control_url, "--control-url")
        validate_loopback_url(args.consumer_url, "--consumer-url")
    except ValueError as error:
        parser.error(str(error))

    trials: list[dict[str, Any]] = []
    should_resume = False
    initial_producer = request_json(args.producer_url, "/metrics")[1]
    initial_consumer = request_json(args.consumer_url, "/metrics")[1]
    if not initial_consumer.get("fresh"):
        raise SystemExit("consumer is not fresh before measurement; wait for baseline first")

    try:
        for trial_number in range(1, args.trials + 1):
            wait_for_advancing_quote(
                args.producer_url,
                args.consumer_url,
                args.timeout,
                args.poll_interval,
            )
            # A pause may succeed server-side even if the response is lost. Set
            # cleanup state first so the finally block always attempts resume.
            should_resume = True
            pause_status, pause_result = request_json(
                args.control_url, "/lab/pause", method="POST"
            )
            if pause_status != 200 or not pause_result.get("ok"):
                raise RuntimeError(f"producer did not accept pause: {pause_result!r}")
            pause_ack_monotonic = time.monotonic()
            frozen = pause_result.get("quote")
            if not isinstance(frozen, dict):
                raise RuntimeError("producer pause response did not include a frozen quote")

            _, frozen_seen_monotonic = wait_for_frozen_quote(
                args.consumer_url,
                frozen,
                args.timeout,
                args.poll_interval,
            )
            stale_metrics, stale_observed_monotonic = wait_for_stale(
                args.consumer_url,
                frozen,
                args.timeout,
                args.poll_interval,
            )
            readyz_status, _ = request_json(args.consumer_url, "/readyz")
            if readyz_status != 503:
                raise RuntimeError(
                    f"stale consumer readiness endpoint returned HTTP {readyz_status}, expected 503"
                )
            trials.append(
                {
                    "trial": trial_number,
                    "feed_id": frozen["feed_id"],
                    "frozen_sequence": frozen["sequence"],
                    "stale_sequence": stale_metrics.get("sequence"),
                    "pause_ack_to_stale_observed_seconds": round(
                        stale_observed_monotonic - pause_ack_monotonic, 4
                    ),
                    "frozen_quote_seen_to_stale_observed_seconds": round(
                        stale_observed_monotonic - frozen_seen_monotonic, 4
                    ),
                    "quote_age_seconds_at_observation": stale_metrics.get(
                        "quote_age_seconds"
                    ),
                    "consumer_readyz_http_status": readyz_status,
                }
            )

            resume_status, resume_result = request_json(
                args.control_url, "/lab/resume", method="POST"
            )
            if resume_status != 200 or not resume_result.get("ok"):
                raise RuntimeError(f"producer did not accept resume: {resume_result!r}")
            should_resume = False
            wait_until(
                "freshness recovery with a later sequence",
                args.timeout,
                args.poll_interval,
                lambda: request_json(args.consumer_url, "/metrics")[1],
                lambda metrics: metrics.get("fresh") is True
                and (
                    metrics.get("feed_id") != frozen["feed_id"]
                    or metrics.get("sequence", 0) > frozen["sequence"]
                ),
            )
    finally:
        if should_resume:
            try:
                request_json(args.control_url, "/lab/resume", method="POST")
            except (RuntimeError, OSError, TimeoutError):
                pass

    ack_samples = [sample["pause_ack_to_stale_observed_seconds"] for sample in trials]
    frozen_samples = [
        sample["frozen_quote_seen_to_stale_observed_seconds"] for sample in trials
    ]
    consumer_config = request_json(args.consumer_url, "/metrics")[1]
    producer_config = request_json(args.producer_url, "/metrics")[1]
    report = {
        "schema_version": 1,
        "helper_version": SCRIPT_VERSION,
        "measured_at_utc": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "scope": (
            "client-observed consumer feed-freshness detection; this is not a "
            "measurement of kubelet Pod Ready transition or EndpointSlice propagation"
        ),
        "environment": {
            "note": args.environment_note or None,
            "workload_mode": args.workload_mode,
            "measurement_host_platform": platform.platform(),
            "measurement_host_architecture": platform.machine(),
            "measurement_host_logical_cpu_count": os.cpu_count(),
            "python_version": sys.version.split()[0],
            "runtime_image_declared_by_fixture": IMAGE,
            "runtime_image_applied_to_measurement": args.workload_mode
            == "kubernetes-port-forward",
            "per_pod_resources_declared_by_fixture": DECLARED_PER_POD_RESOURCES,
            "fixture_resources_applied_to_measurement": args.workload_mode
            == "kubernetes-port-forward",
            "producer_update_interval_seconds": producer_config.get(
                "update_interval_seconds"
            ),
            "consumer_poll_interval_seconds": consumer_config.get(
                "poll_interval_seconds"
            ),
            "consumer_max_data_age_seconds": consumer_config.get(
                "max_data_age_seconds"
            ),
            "measurement_poll_interval_seconds": args.poll_interval,
            "http_request_timeout_seconds": 2.0,
            "producer_url": args.producer_url,
            "control_url": args.control_url,
            "consumer_url": args.consumer_url,
            "producer_paused_at_start": initial_producer.get("paused"),
            "consumer_fresh_at_start": initial_consumer.get("fresh"),
        },
        "method": (
            "Require a matching producer/consumer feed_id and sequence, verify a newer "
            "sequence, POST /lab/pause over the dedicated Pod-loopback control listener, then time both from pause acknowledgement and "
            "from the observer's first fresh report of the frozen sequence until its "
            "first stale report. Resume and require a later sequence before the next trial."
        ),
        "trials": trials,
        "summary_seconds": {
            "pause_ack_to_stale_observed": {
                "min": round(min(ack_samples), 4),
                "median": round(statistics.median(ack_samples), 4),
                "max": round(max(ack_samples), 4),
            },
            "frozen_quote_seen_to_stale_observed": {
                "min": round(min(frozen_samples), 4),
                "median": round(statistics.median(frozen_samples), 4),
                "max": round(max(frozen_samples), 4),
            },
        },
        "kubernetes_readiness_measurement": (
            "not collected; separately observe the consumer Pod Ready condition and "
            "EndpointSlice with kubectl, and record the cluster version and node details"
        ),
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
