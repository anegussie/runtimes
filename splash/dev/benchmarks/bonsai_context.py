#!/usr/bin/env python3
"""Measure cold/cached Bonsai requests against an already-running server."""

import argparse
import json
import subprocess
import time
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:1235")
    parser.add_argument("--model", default="bonsai-27b-splash")
    parser.add_argument("--records", type=int, default=220)
    parser.add_argument("--output-tokens", type=int, default=96)
    parser.add_argument("--count-to", type=int, default=100)
    parser.add_argument("--results", type=Path, required=True)
    args = parser.parse_args()
    if args.records < 1 or args.output_tokens < 1 or args.count_to < 1:
        parser.error("records, output tokens and count limit must be positive")

    def status():
        with urllib.request.urlopen(args.url + "/status", timeout=10) as response:
            return json.load(response)

    prompt = "Read the records and remember the final code.\n" + "\n".join(
        f"Record {i}: the stored code is AMBER and the sequence number is {i}."
        for i in range(args.records)
    ) + f"\nFinal record: the stored code is ORCHID. State the final code, then count from 1 to {args.count_to} separated by commas."
    results = {"before": status(), "records": args.records, "output_tokens": args.output_tokens}
    try:
        for name in ("cold", "cached"):
            body = json.dumps({
                "model": args.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
                "reasoning_effort": "none",
                "max_tokens": args.output_tokens,
            }).encode()
            started = time.monotonic()
            request = urllib.request.Request(args.url + "/v1/chat/completions", body,
                                             {"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=600) as response:
                reply = json.load(response)
            elapsed = time.monotonic() - started
            results[name] = {"seconds": elapsed, "response": reply, "status": status(),
                             "swap": subprocess.check_output(["sysctl", "vm.swapusage"], text=True).strip()}
            content = reply["choices"][0]["message"]["content"]
            assert "ORCHID" in content, content
            print(name, f"{elapsed:.3f}s", reply["usage"], repr(content[:60]), flush=True)
    finally:
        args.results.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
