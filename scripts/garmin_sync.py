"""Daily Garmin pull for Max.

Reads the last few days from Garmin Connect (unofficial API via the garminconnect library) and writes them to
Max's garmin_daily table through the ingest_garmin database function. Runs on a schedule in GitHub Actions.

Environment:
  GARMIN_TOKENS     Garmin login tokens, made once on your computer with scripts/garmin_login.py
  MAX_INGEST_KEY    The Garmin ingest key for Max
  MAX_LIFTER        Lifter name in Max (default Beau)
  DAYS              How many days back to fetch (default 3, so a missed run fills itself in)
"""
import datetime as dt
import json
import os
import sys
import urllib.request

from garminconnect import Garmin

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://bxswcxqkwkswffthqgls.supabase.co")
PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_5koVBvlr6eQSKk2QuSbWmg_wpCFJ6gQ")


def safe(fn, *args):
    try:
        return fn(*args) or {}
    except Exception as e:  # one missing metric shouldn't stop the day
        print(f"  {fn.__name__}{args}: {e}", file=sys.stderr)
        return {}


def local_time(ms):
    return dt.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else None


def day_row(g: Garmin, day: str) -> dict:
    stats = safe(g.get_stats, day)
    hrv = safe(g.get_hrv_data, day).get("hrvSummary") or {}
    sleep = safe(g.get_sleep_data, day).get("dailySleepDTO") or {}
    secs = sleep.get("sleepTimeSeconds")
    metrics = {
        "floors_climbed": stats.get("floorsAscended"),
        "min_hr": stats.get("minHeartRate"),
        "max_hr": stats.get("maxHeartRate"),
        "avg_stress": stats.get("averageStressLevel"),
        "body_battery_high": stats.get("bodyBatteryHighestValue"),
        "body_battery_low": stats.get("bodyBatteryLowestValue"),
        "avg_spo2": sleep.get("averageSpO2Value"),
        "lowest_spo2": sleep.get("lowestSpO2Value"),
        "avg_sleep_respiration": sleep.get("averageRespirationValue"),
        "sleep_start": local_time(sleep.get("sleepStartTimestampLocal")),
        "sleep_end": local_time(sleep.get("sleepEndTimestampLocal")),
        "deep_sleep_h": round(sleep["deepSleepSeconds"] / 3600, 2) if sleep.get("deepSleepSeconds") else None,
        "rem_sleep_h": round(sleep["remSleepSeconds"] / 3600, 2) if sleep.get("remSleepSeconds") else None,
        "hrv_weekly_avg": hrv.get("weeklyAvg"),
        "hrv_status": hrv.get("status"),
        "source": "garmin_sync",
    }
    return {
        "day": day,
        "resting_hr": stats.get("restingHeartRate"),
        "hrv_ms": hrv.get("lastNightAvg"),
        "sleep_h": round(secs / 3600, 2) if secs else None,
        "steps": stats.get("totalSteps"),
        "metrics": {k: v for k, v in metrics.items() if v is not None},
    }


def main():
    tokens = os.environ["GARMIN_TOKENS"].strip()
    key = os.environ["MAX_INGEST_KEY"].strip()
    lifter = os.environ.get("MAX_LIFTER", "Beau")
    days = int(os.environ.get("DAYS", "3"))

    g = Garmin()
    g.login(tokens)  # a long token string is read as saved tokens; no password needed
    today = dt.date.today()
    rows = [day_row(g, (today - dt.timedelta(days=i)).isoformat()) for i in range(days)]
    for r in rows:
        print(r["day"], "RHR", r["resting_hr"], "HRV", r["hrv_ms"], "sleep", r["sleep_h"], "steps", r["steps"])

    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/ingest_garmin",
        data=json.dumps({"p_key": key, "p_lifter": lifter, "p_rows": rows}).encode(),
        headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        print("saved", resp.read().decode(), "days for", lifter)


if __name__ == "__main__":
    main()
