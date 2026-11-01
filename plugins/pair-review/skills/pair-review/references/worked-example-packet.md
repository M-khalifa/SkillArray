# Worked example: a filled task packet (round 2 of a real review)

This is the packet of a real second-round review, of an alarm feature in an Android TV add-on for the open-source
[cleanyourtv](https://github.com/Gathin23/cleanyourtv) project, with local paths and personal details removed. Use it as a
model for your own `task-packet.md`: what goes in each section, how specific the criteria are, and how the fixed findings
of round 1 are handed to round 2. The template with every slot is in `task-packet-template.md`.

What makes it work:
- **Background** gives facts the seats cannot find in the code (how the device behaves), marked as given.
- **Acceptance criteria** describe outcomes a user would notice, each with a tag the findings can cite.
- **Known deviations** lists what is intended, and every finding fixed in round 1, so the seats spend no claim on them.
- **Start here** names the files in reading order and the functions that matter.
- **Evidence** pastes the test result lines, because a sandboxed seat may not be able to run the tests.
- **Hypotheses** are suspected defects, each written so that CONFIRMED means the defect exists.

```markdown
# Task packet: re-review of the alarm path (prayer call, recitations, early wake, standby, volume)

Profile: Code. Target: `<path to the add-on checkout>` (not a git repository).
Read-only review: do not edit, create or delete any file in the target; do not commit.
Review round: 2

## Scope
- In scope, all under `addons/prayer-times/app/src/main/java/com/majnioui/tv/prayer/`: `Handover.java` (new),
  `QuranActivity.java` (rewritten), `AzanService.java`, `AzanActivity.java`, `PreWakeActivity.java`, `PrayerAlerts.java`,
  `AlertReceiver.java` (new), `TestHooksActivity.java` (new), `Screen.java` (new), `MorningQuran.java`, `SleepService.java`,
  `WakePlan.java`, `TimesProvider.java`; `addons/prayer-times/app/src/main/AndroidManifest.xml`; the test
  `addons/prayer-times/app/src/test/java/com/majnioui/tv/prayer/HandoverTest.java`.
- Out of scope: the launcher, the weather add-on, the options screen layout, the times page except its call to
  `PrayerAlerts.rearm`, README wording, style and naming.

## Background (facts from testing on the target TV; treat as given)
- Google TV, Android 12, targetSdk 34, minSdk 26; standby mode "Network Standby".
- With the screen off an alarm fires on time, but the activity it starts can begin up to about three minutes late; with
  the screen on, at once. So an early wake (`PreWakeActivity`, `prewake_minutes` = 4) turns the screen on before each
  prayer call and recitation, and alarms open activities directly.
- The TV suspends shortly after the screen turns off and ignores app wakelocks; only an activity with turn-screen-on
  wakes the screen. A force-stop drops the accessibility service and every alarm (recovered by `RevivalService` and
  `SleepService.ensureEnabled`). `SleepService` (the accessibility lock-screen action) is the only way back to standby.
- The schedule can make events overlap: a daily morning recitation of about two hours, and a dawn prayer time that
  moves through the year, so the prayer call can come before, during or after the recitation.
- `Handover` is the single owner of "which volume to give back and whether to go back to standby" when the prayer call
  and a recitation overlap; `AzanService` and `QuranActivity` report events to it and apply the returned `Step`.
  `HandoverTest` runs every overlap through it.

## Acceptance criteria (tag each one so claims can cite it)
- [AC-1] After any combination of prayer call and recitation (either first, overlapping, either failing, keys pressed
  or not, TV on or woken), the final media volume is the one the user had before the first of them changed it, and the
  TV goes back to standby exactly when one of them woke it and nobody pressed a key or turned it off; never in the middle
  of the call or under a recitation still playing.
- [AC-2] Audio never overlaps: a recitation never starts or resumes while the call plays; it pauses for the call and
  carries on after.
- [AC-3] A switched-off, late (beyond `LATE_MS`), duplicate, failed or skipped event never leaves the TV on with nothing
  playing, never plays, and never lights the screen when it is skipped before waking.
- [AC-4] Every way a recitation or call ends (played out, Stop/Dismiss, Back, the stream failing after retries or never
  preparing, the TV turned off with the remote, another app taking the sound, a takeover by another recitation, a
  system recreate) reaches `Handover` exactly once and leaves no handler, receiver, focus or player behind.
- [AC-5] Only the add-on itself and adb can raise alerts, calls or test alarms (`AlertReceiver` not exported,
  `TestHooksActivity` behind `android.permission.DUMP`); every armed PendingIntent has a matching cancel path.
- [AC-6] Nothing crashes or misbehaves on API 26-30 (minSdk 26).

## Known deviations from the criteria
- Volumes, lead minutes and stream URLs are build-time config.xml values on purpose. The call's audio file has no stated
  license yet (known).
- Fixed in round 1; do not spend a claim on these unless the fix is wrong or incomplete: wall-clock times on DST days;
  test alarms surviving a re-arm; the status pill stopped when no longer near; switches armed before the network; a call
  with every prayer off counted as off; any call exit after a wake sleeping the TV unless a key was pressed; lateness
  checked before the screen turns on; the prepare watchdog and give-up path; volume restored on every recitation exit;
  key press and volume carried across a takeover; the recitation waits for the call; the early wake rechecking its
  event's switch and closed only by its own event; screen-off handling in the recitation; another app taking the sound
  closes the recitation; private `AlertReceiver`; DUMP-gated test hooks; API 27/28 guards via `Screen` and SDK checks.

## Start here
1. `Handover.java` and `HandoverTest.java` (is the model right, and complete?).
2. `QuranActivity.java` (every path to `onDestroy`; the `resumed` branch for a system recreate; the `onNewIntent`
   takeover; `play`, `onFocusChange`, `retryOrGiveUp`).
3. `AzanService.java` (`onStartCommand`, `play`, `finish`: `handedIn`, `Handover.azanEnd`, `QuranActivity.azanFinished`).
4. `AzanActivity.java`, `PreWakeActivity.java` (the skip ladder, `stillWanted`, `consumeWoke`, `close(at)`).
5. `PrayerAlerts.java` (`arm`, `cancelAlarms`, the `onReceive` guard), `AlertReceiver.java`, `TestHooksActivity.java`,
   the manifest.

## Evidence both seats may cite
- Pre-flight snapshot hash recorded. JVM unit tests (`testReleaseUnitTest`), exit 0:
  - `addons/prayer-times: tests 40 failures+errors 0` (includes the 11 `HandoverTest` scenarios)
  - `launcher: tests 255 failures+errors 0`
  - `addons/weather: tests 8 failures+errors 0`
- Mutation check by the author on `Handover`: removing "a key during the call marks the recitation" turns
  `keyDuringTheAzanKeepsTheTvOnAfterTheRecitationToo` red; removing "no standby under a recitation still playing" turns
  `recitationOpensDuringAnAzanThatWokeTheTv` red; restored, all green.

## Author-reported evidence (not reproducible; never cite it as EXECUTED)
- On the TV, earlier builds: early wake, then the call on time from standby, back to standby after; a recitation with a
  dawn call during it paused and resumed; a force-stop recovered by `RevivalService`. The current build is installed with
  alarms verified armed (one per event) but has not yet run a standby overlap on the device.

## Hypotheses to test
- [H1] `Handover` can be left in a stale state (a call or recitation flag stuck true) by some exit path, so a later
  recitation never plays or a later call restores the wrong volume.
- [H2] The `resumed` branch in `QuranActivity.onCreate` (system recreate) or the takeover recreate can register with
  `Handover` twice, never, or end it twice.
- [H3] A volume can still be restored to the wrong value when the user changes the volume during the call or the
  recitation, or when a call with KEEP volume overlaps a recitation.
- [H4] A call skipped in `AzanService` (late, duplicate) after `AzanActivity` turned the screen on can leave the TV on, or
  put it to standby under a playing recitation.
- [H5] Some PendingIntent armed with one component or action (including old builds' broadcasts and foreground-service
  intents) is never cancelled, so an alarm fires after its feature is off.
- [H6] `TestHooksActivity` with `android.permission.DUMP` cannot be started from `adb shell am start`, or can be started
  by an app.
- [H7] The static `QuranActivity.current` / `Handover.STATE` across a process death or a second recitation can call into
  a destroyed activity.
- [H8] At least one guard this round added is untested: name up to 5 guards in `Handover`, `QuranActivity` or
  `AzanService`; for each, say whether a `HandoverTest` scenario covers it (reasoning from the test code is acceptable).

## Checks
- JVM tests: `./gradlew -q testReleaseUnitTest` in `addons/prayer-times` with JDK 17 and an Android SDK; they write build
  folders, so only in a disposable copy, or rely on the results above. No device or adb access.

## Severity note
Default rubric. Worse than usual: anything that plays when switched off, plays twice or over itself, leaves a high
volume at night or early in the morning, wakes the TV and leaves it on, puts it to standby while someone watches, or
crashes the alarm path. It runs unattended in a home.

## Output
Findings in the required schema in your own findings file. Then exactly `## Checks performed` (or, with no claim, only
`## No findings`), holding exactly one line `Blocked: none` or `Blocked: <what>: <the error>`.
Web verification is off (repo-only review). Close with one line: `web: <n> queries, <n> page fetches`.
```

## A quick recheck of a small fix diff

When the last round's fixes are small, one fresh reviewer can check them instead of a full round. Draft the packet with
`review-run recheck --from-run <old-run-dir> --out <new-run-dir>/task-packet.md`, start one fresh agent (never a fork of
your conversation) with it, ask for the findings as text in its reply, and require evidence that fits each finding: a
command and its output when it can be run, otherwise the file:line and the quoted code. Treat what it reports as leads to
verify: there is no blind exchange and no auditor, so it does not replace a review round.
