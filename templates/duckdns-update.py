#!/usr/bin/env python3
"""DuckDNS dynamic DNS updater."""

import sys
import urllib.parse
import urllib.request

CONFIG = "{{CONFIG_PATH}}"


def log(message: str) -> None:
    print(message, file=sys.stderr)


def strip_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_config(path: str) -> dict[str, str]:
    config: dict[str, str] = {}

    with open(path, encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()

            if not line or line.startswith("#"):
                continue

            if ":" not in line:
                raise ValueError(f"invalid config line {line_number}")

            key, value = line.split(":", 1)
            key = key.strip()
            value = strip_quotes(value.strip())

            if not key:
                raise ValueError(f"invalid config line {line_number}")

            config[key] = value

    return config


def update_duckdns(domain: str, token: str) -> str:
    query = urllib.parse.urlencode({"domains": domain, "token": token, "ip": ""})
    url = f"https://www.duckdns.org/update?{query}"

    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace").strip()


def main() -> int:
    try:
        config = load_config(CONFIG)
    except FileNotFoundError:
        log(f"duckdns update failed: config not found at {CONFIG}")
        return 1
    except OSError:
        log("duckdns update failed: unable to read config")
        return 1
    except ValueError as error:
        log(f"duckdns update failed: {error}")
        return 1

    domain = config.get("domain", "").strip()
    token = config.get("token", "").strip()

    if not domain or not token:
        log("duckdns update failed: config requires domain and token")
        return 1

    try:
        result = update_duckdns(domain, token)
    except Exception as error:  # noqa: BLE001
        log(f"duckdns update failed: {error.__class__.__name__}")
        return 1

    if result == "OK":
        log(f"duckdns update succeeded for domain {domain}")
        return 0

    if result == "KO":
        log(f"duckdns update failed for domain {domain}: KO")
        return 1

    log(f"duckdns update failed for domain {domain}: unexpected response {result!r}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
