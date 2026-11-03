"""Decides from GitHub's check runs for a commit whether it's safe to deploy.

Reads GitHub's JSON on stdin and prints one word: "deploy", "wait" or "skip". Uses only Python's
standard library, so the server needs nothing installed for it.
"""

import json
import sys


def decide(response: dict) -> str:
    runs = response.get("check_runs", [])
    # A commit that only changes docs runs no CI, so there's nothing to wait for.
    if not runs:
        return "deploy"
    if any(run["status"] != "completed" for run in runs):
        return "wait"
    if all(run["conclusion"] in ("success", "skipped", "neutral") for run in runs):
        return "deploy"
    return "skip"


if __name__ == "__main__":
    print(decide(json.load(sys.stdin)))
