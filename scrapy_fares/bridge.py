#!/usr/bin/env python3
"""Bridge: Node.js calls this script, which runs a Scrapy spider via Oxylabs Web Unblocker."""
import sys
import os
import json
import subprocess

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: bridge.py <from_eva> <to_eva> <date> [time] [sparpreis] [age] [bahncard]"}))
        sys.exit(1)

    from_eva = sys.argv[1]
    to_eva = sys.argv[2]
    date_str = sys.argv[3]
    time_str = sys.argv[4] if len(sys.argv) > 4 else "10:00:00"
    sparpreis = sys.argv[5] if len(sys.argv) > 5 else "false"
    age = sys.argv[6] if len(sys.argv) > 6 else ""
    bahncard = sys.argv[7] if len(sys.argv) > 7 else ""

    script_dir = os.path.dirname(os.path.abspath(__file__))
    settings_path = os.path.join(script_dir, "bahn_spider", "settings.py")

    cmd = [
        sys.executable, "-m", "scrapy", "crawl", "bahn_fare",
        "-s", f"SETTINGS_MODULE=bahn_spider.settings",
        "-a", f"from_eva={from_eva}",
        "-a", f"to_eva={to_eva}",
        "-a", f"date_str={date_str}",
        "-a", f"time_str={time_str}",
        "-a", f"sparpreis={sparpreis}",
    ]
    if age:
        cmd.extend(["-a", f"age={age}"])
    if bahncard:
        cmd.extend(["-a", f"bahncard={bahncard}"])

    env = os.environ.copy()
    env["SCRAPY_SETTINGS_MODULE"] = "bahn_spider.settings"

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=90,
            cwd=script_dir, env=env,
        )
        # Scrapy prints the result as the last JSON line
        stdout = result.stdout.strip()
        for line in reversed(stdout.split("\n")):
            line = line.strip()
            if line.startswith("{"):
                print(line)
                return
        print(json.dumps({"error": "scrapy: no JSON output", "stderr": result.stderr[-300:] if result.stderr else ""}))
    except subprocess.TimeoutExpired:
        print(json.dumps({"error": "scrapy: timeout (90s)"}))
    except Exception as e:
        print(json.dumps({"error": f"scrapy: {str(e)[:200]}"}))


if __name__ == "__main__":
    main()
