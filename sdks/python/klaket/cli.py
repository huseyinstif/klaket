"""Klaket CLI — talk to a Klaket API from the terminal.

    klaket ingest "https://youtube.com/watch?v=..."          # queue, print job id
    klaket ingest "https://..." --wait                       # queue + wait + print result JSON
    klaket status <job-id>
    klaket result <job-id>
    klaket search <job-id> "docker compose"
    klaket usage

Configuration: --api-url / KLAKET_API_URL (default http://localhost:8484),
--api-key / KLAKET_API_KEY (only needed against a cloud deployment).
"""

import argparse
import json
import os
import sys

from . import Klaket, KlaketError, __version__


def _client(args: argparse.Namespace) -> Klaket:
    return Klaket(base_url=args.api_url, api_key=args.api_key)


def _dump(data) -> None:
    json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


def _cmd_ingest(args) -> None:
    k = _client(args)
    job_id = k.ingest(
        args.url,
        language=args.language,
        model=args.model,
        prompt=args.prompt,
        num_speakers=args.num_speakers,
        translate_to=args.translate_to,
        webhook_url=args.webhook_url,
    )
    if args.wait:
        print(f"queued {job_id} - waiting...", file=sys.stderr)
        k.wait(job_id, timeout=args.timeout)
        _dump(k.result(job_id))
    else:
        _dump({"id": job_id, "status": "queued"})


def _cmd_status(args) -> None:
    _dump(_client(args).status(args.job_id))


def _cmd_wait(args) -> None:
    _dump(_client(args).wait(args.job_id, timeout=args.timeout))


def _cmd_result(args) -> None:
    _dump(_client(args).result(args.job_id))


def _cmd_search(args) -> None:
    _dump(_client(args).search(args.job_id, args.query))


def _cmd_delete(args) -> None:
    _client(args).delete(args.job_id)
    print(f"deleted {args.job_id}", file=sys.stderr)


def _cmd_usage(args) -> None:
    _dump(_client(args).usage())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="klaket", description="Turn any video into LLM-ready data."
    )
    parser.add_argument("--version", action="version", version=f"klaket {__version__}")
    parser.add_argument(
        "--api-url",
        default=os.environ.get("KLAKET_API_URL", "http://localhost:8484"),
        help="Klaket API base URL (env KLAKET_API_URL)",
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get("KLAKET_API_KEY", ""),
        help="API key for cloud mode (env KLAKET_API_KEY)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("ingest", help="queue a video (URL or worker-visible path)")
    p.add_argument("url")
    p.add_argument("--language", default="auto", help="ISO 639-1 hint (default: auto)")
    p.add_argument("--model", default="", help="whisper model: tiny|base|small|medium|large-v3")
    p.add_argument("--prompt", default="", help="context hint: proper nouns, jargon (max 500 chars)")
    p.add_argument("--num-speakers", type=int, default=0, help="diarization hint (0 = auto)")
    p.add_argument("--translate-to", default="", help="translate transcript to this ISO 639-1 language")
    p.add_argument("--webhook-url", default="", help="POSTed on done/failed")
    p.add_argument("--wait", action="store_true", help="wait and print the full result JSON")
    p.add_argument("--timeout", type=float, default=1800, help="max seconds to wait (with --wait)")
    p.set_defaults(func=_cmd_ingest)

    p = sub.add_parser("status", help="show job status")
    p.add_argument("job_id")
    p.set_defaults(func=_cmd_status)

    p = sub.add_parser("wait", help="block until a job finishes")
    p.add_argument("job_id")
    p.add_argument("--timeout", type=float, default=1800)
    p.set_defaults(func=_cmd_wait)

    p = sub.add_parser("result", help="print the LLM-ready result JSON")
    p.add_argument("job_id")
    p.set_defaults(func=_cmd_result)

    p = sub.add_parser("search", help="find moments inside a processed video")
    p.add_argument("job_id")
    p.add_argument("query")
    p.set_defaults(func=_cmd_search)

    p = sub.add_parser("delete", help="delete a job and its artifacts")
    p.add_argument("job_id")
    p.set_defaults(func=_cmd_delete)

    p = sub.add_parser("usage", help="show this month's video-minute usage")
    p.set_defaults(func=_cmd_usage)

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except KlaketError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
