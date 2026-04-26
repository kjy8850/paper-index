import argparse
import sys
from .cost_gate import CostLimitExceeded
from .db import close
from . import pipeline


def main():
    parser = argparse.ArgumentParser(prog="batch_runner")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("enqueue")
    sub.add_parser("submit")
    sub.add_parser("poll")
    sub.add_parser("apply")
    sub.add_parser("status")
    args = parser.parse_args()

    try:
        if args.cmd == "enqueue":
            path = pipeline.enqueue()
            if path:
                print(f"JSONL: {path}")
        elif args.cmd == "submit":
            pipeline.submit()
        elif args.cmd == "poll":
            pipeline.poll()
        elif args.cmd == "apply":
            pipeline.apply()
        elif args.cmd == "status":
            pipeline.status()
    except CostLimitExceeded as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[ERROR] {e}", file=sys.stderr)
        raise
    finally:
        close()


main()
