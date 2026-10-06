"""Hold release workflows until the scheduled dispatcher explicitly starts them."""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path


def main():
    try:
        with Path(".release-config.json").open("r", encoding="utf-8") as release_file:
            release_config = json.load(release_file)
    except (OSError, json.JSONDecodeError):
        # Missing or stale metadata must not turn an ordinary release into a skip.
        release_config = {}

    schedule_enabled = release_config.get("schedule_enabled") is True
    schedule_status = release_config.get("schedule_status")
    requested_schedule_id = os.environ.get("SCHEDULE_ID", "").strip()
    configured_schedule_id = release_config.get("schedule_id")
    scheduled_tag = release_config.get("scheduled_tag")
    gate_scope = os.environ.get("SCHEDULE_GATE_SCOPE", "")
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    ref_name = os.environ.get("GITHUB_REF_NAME", "")
    ref_type = os.environ.get("GITHUB_REF_TYPE", "")

    scheduled_at = None
    if (
        schedule_enabled
        and schedule_status in ("pending", "dispatching")
        and isinstance(configured_schedule_id, str)
        and configured_schedule_id
        and isinstance(scheduled_tag, str)
        and re.fullmatch(r"v\d+(?:\.\d+)*", scheduled_tag)
    ):
        try:
            parsed_schedule_time = datetime.fromisoformat(
                release_config["scheduled_at_utc"].replace("Z", "+00:00")
            )
            if parsed_schedule_time.tzinfo is not None:
                scheduled_at = parsed_schedule_time.astimezone(timezone.utc)
        except (KeyError, AttributeError, TypeError, ValueError):
            scheduled_at = None

    active_schedule = scheduled_at is not None
    schedule_is_due = (
        active_schedule
        and requested_schedule_id == configured_schedule_id
        and scheduled_at <= datetime.now(timezone.utc)
    )
    manual_run = event_name == "workflow_dispatch"
    manual_override = manual_run and requested_schedule_id != configured_schedule_id

    should_hold = False
    if active_schedule and not schedule_is_due:
        if requested_schedule_id == configured_schedule_id:
            # A dispatcher-tagged run must never start before its saved time.
            should_hold = True
        elif not manual_override and gate_scope == "release":
            should_hold = (
                event_name == "push"
                and ref_type == "tag"
                and ref_name == scheduled_tag
            )
        elif not manual_override and gate_scope == "cloudflare":
            should_hold = (
                event_name == "push"
                and ref_type == "branch"
                and ref_name == "main"
            )

    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output_file:
            output_file.write(f"hold={'true' if should_hold else 'false'}\n")

    if should_hold:
        print("A scheduled release is pending; this automatic or manual run is held.")
    else:
        print(
            "Schedule gate passed "
            f"(valid_schedule={active_schedule}, scope={gate_scope or 'unspecified'}, "
            f"ref={ref_name or 'unspecified'})."
        )


if __name__ == "__main__":
    main()
