import asyncio
import json
import logging
import os
import sys

from sehatmate_voice.config import Config


def main():
    print("WORKER_STARTUP_STAGE:CONFIG")

    config = Config.from_env()

    print("WORKER_STARTUP_STAGE:CONFIG_OK")

    os.environ["OTEL_SDK_DISABLED"] = "true"

    # SDK/provider logs may contain request bodies or transcripts.
    # Keep them disabled and emit only our own sanitized startup markers.
    logging.disable(logging.CRITICAL)

    if len(sys.argv) > 1 and sys.argv[1] == "check":
        from sehatmate_voice.diagnostics import preflight

        result = preflight(config)
        print(json.dumps(result))
        raise SystemExit(0 if result["ok"] else 1)

    print("WORKER_STARTUP_STAGE:IMPORTS")

    from livekit.agents import AgentServer, JobExecutorType, cli
    from sehatmate_voice.runtime import run_job

    print("WORKER_STARTUP_STAGE:IMPORTS_OK")

    slots = set()
    lock = asyncio.Lock()

    print("WORKER_STARTUP_STAGE:SERVER_CREATE")

    server = AgentServer(
        ws_url=config.livekit_url,
        api_key=config.livekit_key,
        api_secret=config.livekit_secret,
        job_executor_type=JobExecutorType.THREAD,
        host="0.0.0.0",
        port=8081,
        max_retry=config.retries,
        num_idle_processes=0,
        drain_timeout=20,
        shutdown_process_timeout=20,
    )

    print("WORKER_STARTUP_STAGE:SERVER_OK")

    async def request(job):
        async with lock:
            try:
                metadata = json.loads(job.job.metadata)

                valid = (
                    set(metadata) == {"voiceSessionId"}
                    and isinstance(metadata["voiceSessionId"], str)
                    and not job.job.enable_recording
                )

            except (ValueError, TypeError, KeyError):
                valid = False

            if not valid or len(slots) >= config.concurrent_jobs:
                await job.reject()
                return

            slots.add(job.id)

        try:
            await job.accept(identity=f"agent-{job.id}")
        except Exception:
            slots.discard(job.id)
            raise

    async def ended(ctx):
        slots.discard(ctx.job.id)

    print("WORKER_STARTUP_STAGE:REGISTER_SESSION")

    server.rtc_session(
        run_job,
        agent_name="sehatmate-voice",
        on_request=request,
        on_session_end=ended,
    )

    print("WORKER_STARTUP_STAGE:SESSION_REGISTERED")
    print("WORKER_STARTUP_STAGE:RUN_APP")

    cli.run_app(server)


if __name__ == "__main__":
    try:
        main()

    except ValueError as error:
        # Config validation messages contain only variable names/reasons,
        # never secret values.
        print(
            "WORKER_STARTUP_ERROR:"
            f"VALUE_ERROR:{str(error)}"
        )
        raise SystemExit(1) from None

    except TypeError as error:
        # Useful for incompatible SDK constructor/function arguments.
        print(
            "WORKER_STARTUP_ERROR:"
            f"TYPE_ERROR:{str(error)}"
        )
        raise SystemExit(1) from None

    except Exception as error:
        # Never serialize arbitrary exception messages because provider/SDK
        # errors could contain URLs, payloads or other sensitive context.
        print(
            "WORKER_STARTUP_ERROR:"
            f"{type(error).__name__}"
        )
        raise SystemExit(1) from None