"""Hold release workflows until the scheduled dispatcher explicitly starts them."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def main():
    with Path(".release-config.json").open("r", encoding="utf-8") as release_file:
        release_config = json.load(release_file)

    schedule_enabled = release_config.get("schedule_enabled", False)
    requested_schedule_id = os.environ.get("SCHEDULE_ID", "").strip()
    configured_schedule_id = release_config.get("schedule_id")

    schedule_is_due = False
    if schedule_enabled and requested_schedule_id == configured_schedule_id:
        try:
            scheduled_at = datetime.fromisoformat(
                release_config["scheduled_at_utc"].replace("Z", "+00:00")
            )
            schedule_is_due = scheduled_at <= datetime.now(timezone.utc)
        except (KeyError, AttributeError, TypeError, ValueError):
            schedule_is_due = False

    should_proceed = (
        not schedule_enabled
        or schedule_is_due
    )

    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as output_file:
            output_file.write(f"proceed={'true' if should_proceed else 'false'}\n")

    if should_proceed:
        print("Release schedule gate passed.")
    else:
        print("A scheduled release is pending; this automatic or manual run is held.")


if __name__ == "__main__":
    main()
