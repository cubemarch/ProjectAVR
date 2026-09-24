"""Print per-track frame counts for the live session, once a second.

The failure this exists for: a stereo broadcast that silently degrades to mono
looks completely healthy from every other angle - session live, frames
climbing, picture on screen - and the only symptom is that both eyes show the
same image. Watching `left` and `right` climb independently is the quickest way
to tell a real stereo pair from a duplicated one.

    python3 test/watch-live-tracks.py [base-url]
"""

import datetime
import json
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
URL = BASE + "/api/live/sessions"

TRACKS = ("left", "right", "packed")


def render(session):
    stats = session.get("stats", {})
    parts = []

    for name in TRACKS:
        track = stats.get(name)
        if not track:
            continue
        frames = track.get("frames", 0)
        keyframes = track.get("keyframes", 0)
        fps = track.get("fps", 0)
        parts.append("%s: %6d frames / %3d key / %4s fps" % (name, frames, keyframes, fps))

    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    print("  %s  %s  %s" % (stamp, session.get("id", "?"), "   ".join(parts)))

    left = stats.get("left", {}).get("frames", 0)
    right = stats.get("right", {}).get("frames", 0)

    if left and not right:
        print("      -> RIGHT EYE IS NOT ARRIVING. Both eyes are the wide camera.")
    elif left and right and abs(left - right) > max(30, left * 0.25):
        print("      -> eyes are badly out of step (%d vs %d)." % (left, right))


def main():
    print("watching %s - ctrl-c to stop" % URL)

    while True:
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        try:
            with urllib.request.urlopen(URL, timeout=3) as response:
                doc = json.load(response)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as err:
            print("  %s  server unreachable (%s)" % (stamp, err))
            time.sleep(1)
            continue

        sessions = doc.get("sessions", [])
        if not sessions:
            print("  %s  no live session" % stamp)
        for session in sessions:
            render(session)

        time.sleep(1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("")
