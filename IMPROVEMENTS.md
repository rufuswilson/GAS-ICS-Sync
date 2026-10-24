# GAS-CalSync: improvements to consider from upstream

Reviewed against GAS-CalSync on 24 October 2026. It includes `Config.gs`, Google Calendar source support, per-source settings, filters, an auto-updater, and regression tests. The upstream inventory comprises 25 open pull requests and 39 open issues from the earlier upstream review. These are feature bundles, not instructions to merge every PR. The current local suite passes 94 tests, and a sync was verified on the test account.

**Status:** The **Fixed and tested** section contains locally implemented items with regression tests. **Partial** means more work or verification is needed; **Design** needs a behavior or migration decision; **Investigate** lacks a confirmed cause. Priorities indicate a suggested order, not upstream severity.

## Reliability and data protection

### 6. Unexpected JavaScript runtime exit — Investigate

Source: [#510](https://github.com/derekantrican/GAS-ICS-Sync/issues/510).

The same 381 KB Outlook feed worked with a new target but produced an unexpected runtime exit with the old target. That suggests a target-specific stage, but the report has no trace that identifies it. Target events now load in pages of 250, repeated page tokens fail explicitly, and progress logs identify the last completed stage. If it recurs, capture the last stage, approximate target-event count, and execution time before attributing a cause. The platform exit may not be catchable by script code.

## Event identity, recurrence, and deletions

### 10. Prevent duplicates when an ICS provider changes UIDs — Partial, Design

Source: [#283](https://github.com/derekantrican/GAS-ICS-Sync/issues/283).

The fork now tags target events with a hash of their source address and tests two feeds that reuse the same UID. That solves cross-source UID collisions. It does not solve a provider changing a UID for the *same* event; any fallback matching rule needs a false-match policy and migration tests.

### 11. Keep manually deleted target events deleted — Design

Source: [PR #482](https://github.com/derekantrican/GAS-ICS-Sync/pull/482).

This changes the current source-authoritative behavior. Decide whether it is opt-in and how it interacts with recurring instances, source removals, and `clearGASEvents()` before adapting the PR.

## Source access, formats, and security

### 12. Authenticated feeds and source configuration — Partial, Design

Sources: [PR #430](https://github.com/derekantrican/GAS-ICS-Sync/pull/430), [PR #307](https://github.com/derekantrican/GAS-ICS-Sync/pull/307); issues [#157](https://github.com/derekantrican/GAS-ICS-Sync/issues/157), [#251](https://github.com/derekantrican/GAS-ICS-Sync/issues/251).

The fork already has object-based source entries, per-source setting overrides, and a separate `Config.gs`. Its `GITHUB_TOKEN` authenticates **updater downloads**, not calendar feeds. Add calendar authentication as optional source fields and keep secrets out of URLs, logs, and shared configuration. Decide which protocols to support; a CalDAV endpoint is not necessarily a downloadable ICS feed. #307 overlaps existing configuration and error handling, so port only needed behavior.

## Event content and availability

### 20. Privacy, locations, and meeting URLs — Fits, Design

Sources: [PR #509](https://github.com/derekantrican/GAS-ICS-Sync/pull/509), [PR #524](https://github.com/derekantrican/GAS-ICS-Sync/pull/524), [PR #447](https://github.com/derekantrican/GAS-ICS-Sync/pull/447); issue [#515](https://github.com/derekantrican/GAS-ICS-Sync/issues/515).

Treat these as one event-output policy for ICS and Google sources. Options can replace details with a title such as "Busy," omit location, or promote a Teams URL to location. Apply privacy first, then location removal, then optional Teams extraction; never reintroduce details hidden by privacy. Decide whether existing events are updated immediately or during ordinary sync.

## Filters, scheduling, and interface

### 25. Extend rules and decide cleanup outside filter windows — Partial, Design

Sources: issues [#69](https://github.com/derekantrican/GAS-ICS-Sync/issues/69), [#445](https://github.com/derekantrican/GAS-ICS-Sync/issues/445), [#474](https://github.com/derekantrican/GAS-ICS-Sync/issues/474).

`Filters.gs` already filters ICS and Google sources, and cleanup now observes per-source removal settings. #445 asks to retain target events outside a date window, while the fork's rolling-window tests expect their removal. Choose one cleanup policy or expose it as an option before extending date rules. General modification rules (#69) and Google Out of Office or Work Location items (#474) are separate features.

### 26. Per-source refresh intervals — Design

Sources: [PR #372](https://github.com/derekantrican/GAS-ICS-Sync/pull/372), [PR #463](https://github.com/derekantrican/GAS-ICS-Sync/pull/463); issue [#346](https://github.com/derekantrican/GAS-ICS-Sync/issues/346).

These proposals overlap. Do not merge #372 as written: its event-identity change can duplicate existing events. Preserve the fork's current keys and decide how skipped sources affect cleanup when several sources share one target.

### 27. Sync on event-update triggers — Design

Source: [PR #280](https://github.com/derekantrican/GAS-ICS-Sync/pull/280).

Define which calendar changes should trigger a one-way sync and prevent the script's own writes from causing a loop.

### 28. Minify the ICS parser for editor performance — Fits

Source: [#105](https://github.com/derekantrican/GAS-ICS-Sync/issues/105).

Replace the bundled `ical.js.gs` with a reproducibly minified build to reduce editor load time. Keep the source version and parser regression tests available for maintenance.

### 32. Add an HTML interface — Fits

Source: [#8](https://github.com/derekantrican/GAS-ICS-Sync/issues/8).

A UI could guide calendar mapping and filter configuration. Define the setup flow and how it writes `Config.gs` before implementation.

## Documentation and maintenance

### 31. Google app verification — External setup

Source: [#22](https://github.com/derekantrican/GAS-ICS-Sync/issues/22). This depends on the Google project and deployment; merging code alone will not remove the authorization warning.

# Fixed and tested

## Reliability and data protection

### 1. Preserve target events when a source fails or is unexpectedly empty — Fixed and covered

Sources: [PR #456](https://github.com/derekantrican/GAS-ICS-Sync/pull/456); issues [#455](https://github.com/derekantrican/GAS-ICS-Sync/issues/455), [#494](https://github.com/derekantrican/GAS-ICS-Sync/issues/494), [#508](https://github.com/derekantrican/GAS-ICS-Sync/issues/508).

`fetchSourceCalendars()` and `parseResponses()` mark failed sources; `startSync()` skips cleanup when a source fails. `skipIfEmptyFeed` now defaults to `true` and can be overridden per source. An ICS or Google source with no active events blocks cleanup, while other sources continue processing. Setting it to `false` permits intentional clearing. Tests cover two sources sharing a target, empty and cancelled-only sources, the explicit opt-out, and a populated feed whose events are all filtered out.

### 2. Fail safely on incomplete target-event pagination — Fixed and covered

Sources: [PR #533](https://github.com/derekantrican/GAS-ICS-Sync/pull/533); issue [#496](https://github.com/derekantrican/GAS-ICS-Sync/issues/496).

`startSync()` now checks the first and subsequent `Calendar.Events.list` pages and throws if a page is missing. That stops processing and cleanup rather than accepting an incomplete target list. Integration tests cover failure on the first page, failure on a later page, skipped cleanup, and lock release.

### 3. Use a lock for concurrent runs — Fixed and covered

Sources: [PR #504](https://github.com/derekantrican/GAS-ICS-Sync/pull/504), [PR #435](https://github.com/derekantrican/GAS-ICS-Sync/pull/435); issue [#284](https://github.com/derekantrican/GAS-ICS-Sync/issues/284).

`startSync()` now uses `LockService.getScriptLock()`, exits when it cannot acquire the lock, and releases it in `finally`. Tests cover lock contention, normal completion, and an exceptional exit. Do not add #435's old property-based guard. The trigger megathread may contain unrelated failures.

### 4. Isolate event failures and make deletion idempotent — Fixed and covered

Sources: issues [#282](https://github.com/derekantrican/GAS-ICS-Sync/issues/282), [#472](https://github.com/derekantrican/GAS-ICS-Sync/issues/472).

ICS and Google-source insert/update paths catch errors and mark the run failed. Cleanup now checks exhausted delete retries, treats a confirmed "resource has been deleted" response as already removed, skips missing IDs, and records email removals only after a successful deletion. Tests cover a failed deletion followed by a successful one, an already-deleted event, and missing IDs.

### 5. Bound historical processing and cleanup deletions — Fixed and covered

Sources: issues [#534](https://github.com/derekantrican/GAS-ICS-Sync/issues/534), [#505](https://github.com/derekantrican/GAS-ICS-Sync/issues/505).

`pastEventWindowDays` now optionally skips old completed ICS and Google-source events while retaining recurring parents; cleanup preserves target events older than the same source's window. `maxCleanupDeletesPerRun` bounds deletion attempts and stores a per-target cursor for later runs. Tests cover both source types, old-target preservation, and resumption across runs. Source feeds and target event lists are still fetched in full, so exceptionally large reads can still reach the Apps Script execution limit.

### 6a. Prevent wrong-target writes and accidental calendar duplication — Fixed and covered

Source: [#514](https://github.com/derekantrican/GAS-ICS-Sync/issues/514).

Reporters found redundant “Created by GAS” calendars, and some syncs wrote to one of those instead of the intended target. The exact trigger for the duplicates was not identified. Name-based target lookup now fails on duplicate or read-only matches; a missing target is created only with explicit `createTargetCalendarIfMissing: true`. A `targetId` selects one writable calendar exactly. Tests cover ambiguous names across pages, missing and read-only targets, deliberate creation, and ID selection. This prevents silent wrong-target writes in those cases; live Google behavior remains unverified.

### 7. Multi-calendar loop counter — Fixed and covered

Source: [#521](https://github.com/derekantrican/GAS-ICS-Sync/issues/521). The fork's outer loop does not reuse the reported `i` counter. A regression test confirms that `startSync()` processes two configured target calendars.

## Event identity, recurrence, and deletions

### 8. Exclude cancelled target events from ordinary updates — Fixed and covered

Sources: competing [PR #520](https://github.com/derekantrican/GAS-ICS-Sync/pull/520), [PR #526](https://github.com/derekantrican/GAS-ICS-Sync/pull/526), [PR #527](https://github.com/derekantrican/GAS-ICS-Sync/pull/527); issue [#315](https://github.com/derekantrican/GAS-ICS-Sync/issues/315).

Cancelled target events are excluded from the ordinary-event lookup and guarded in both ICS and Google-source save paths. Recurrence exceptions still use their own patch or removal path. Tests cover cancelled ordinary events and restoration of a cancelled recurrence instance.

### 9. Keep moved recurring occurrences attached to their original instance — Fixed and covered

Source: [#473](https://github.com/derekantrican/GAS-ICS-Sync/issues/473).

The fork uses the original occurrence start as a stable key. Tests now include a representative Outlook ICS fixture with a moved instance, plus existing ICS and Google-source recurrence cases. Live provider behavior remains unverified.

## Source access, formats, and security

### 13. Match target calendars by ID — Fixed and covered

Source: [PR #531](https://github.com/derekantrican/GAS-ICS-Sync/pull/531).

Target mappings now accept `targetId`, checked across calendar-list pages before display names. Missing or unwritable explicit IDs fail without creating a calendar. Tests cover renamed calendars, duplicate display names, and read-only IDs.

### 14. Decode ICS text as UTF-8 — Fixed and covered

Source: [PR #525](https://github.com/derekantrican/GAS-ICS-Sync/pull/525).

ICS responses explicitly use `getContentText("UTF-8")`. A test checks the requested charset and a non-ASCII feed response.

### 15. Support VFREEBUSY-only feeds — Fixed and covered

Source: [PR #528](https://github.com/derekantrican/GAS-ICS-Sync/pull/528).

`parseResponses()` synthesizes opaque busy events for non-`FREE` periods only when there are no VEVENTs. Keys are stable per source and interval. Tests cover free periods, busy periods, repeated parsing, and a mixed feed.

### 16. Preserve event timezones and recognize Webex aliases — Fixed and covered

Sources: [PR #213](https://github.com/derekantrican/GAS-ICS-Sync/pull/213); issue [#487](https://github.com/derekantrican/GAS-ICS-Sync/issues/487).

Added the four US Webex aliases from PR #213 to `tzid.gs`. Tests verify native copying retains a named source timezone on a daylight-saving transition, while existing recurrence tests cover named ICS timezones.

### 17. Validate HTTPS certificates — Fixed and covered

Source: [#486](https://github.com/derekantrican/GAS-ICS-Sync/issues/486).

`UrlFetchApp.fetch()` now uses normal certificate validation. A certificate failure marks the source failed, which blocks target cleanup; a test confirms the private feed URL is redacted in logs.

### 18. Accept absolute VALARM trigger times — Fixed and covered

Source: [#475](https://github.com/derekantrican/GAS-ICS-Sync/issues/475).

Absolute VALARM times now convert to reminder minutes before the event; duration triggers retain their existing handling. The test uses the reported `20250114T133635Z` value.

## Event content and availability

### 19. Preserve HTML descriptions and omit blank ones — Fixed and covered

Sources: [PR #535](https://github.com/derekantrican/GAS-ICS-Sync/pull/535); issue [#449](https://github.com/derekantrican/GAS-ICS-Sync/issues/449).

HTML from a `DESCRIPTION` `ALTREP` data URL is decoded when valid; malformed data falls back to plain text. Whitespace-only descriptions are omitted. The chosen description enters the event checksum, and tests cover a link, malformed data, and blank text.

### 21. Per-source title formatting — Fixed and covered

Sources: [PR #394](https://github.com/derekantrican/GAS-ICS-Sync/pull/394); issues [#366](https://github.com/derekantrican/GAS-ICS-Sync/issues/366), [#493](https://github.com/derekantrican/GAS-ICS-Sync/issues/493), [#479](https://github.com/derekantrican/GAS-ICS-Sync/issues/479).

`titlePrefix` and `titlePrefixAllDayOnly` can be configured per source or globally. Both ICS and Google-source titles are transformed before checksums. Existing `addCalToTitle` and legacy mappings remain supported; tests cover timed and all-day events from both source types.

### 22. Map Microsoft tentative events to free — Fixed and covered

Source: [PR #384](https://github.com/derekantrican/GAS-ICS-Sync/pull/384).

Optional `mapMicrosoftTentativeToFree` maps the Microsoft marker to `transparency: "transparent"` unless `TRANSP` is explicit. Tests cover the marker, an ordinary tentative event, and explicit opacity.

### 23. Reminder precedence and Outlook Safe Links — Fixed and covered

Sources: issues [#529](https://github.com/derekantrican/GAS-ICS-Sync/issues/529), [#172](https://github.com/derekantrican/GAS-ICS-Sync/issues/172).

An explicit all-day reminder now survives `addAlerts: "default"`; `"no"` still suppresses reminders and `"yes"` uses valid VALARMs. Optional `fallbackReminderMinutes` and `decodeOutlookSafeLinks` cover #172. Tests exercise the three alert modes, timed events, fallback, and recognized Safe Links URLs.

### 24. Shorter email summaries — Fixed and covered

Source: [PR #462](https://github.com/derekantrican/GAS-ICS-Sync/pull/462).

Email subject lines now omit zero-count changes; the detailed body remains. A test checks a single-category summary.

## Documentation and maintenance

### 29. Installation, updates, and reauthorization — Fixed and covered

Sources: [PR #489](https://github.com/derekantrican/GAS-ICS-Sync/pull/489); issues [#470](https://github.com/derekantrican/GAS-ICS-Sync/issues/470), [#222](https://github.com/derekantrican/GAS-ICS-Sync/issues/222).

The README now has fork-specific manual installation and `clasp` guidance, a manual update checklist, and steps to reauthorize after a password change or revoked grant. It no longer directs users to the older upstream script copy. The auto-updater's existing tests cover configuration preservation and preview mode.

### 30. Tests and style checks — Fixed and covered

Sources: issues [#41](https://github.com/derekantrican/GAS-ICS-Sync/issues/41), [#67](https://github.com/derekantrican/GAS-ICS-Sync/issues/67).

The fork now has 87 passing tests, including focused regressions for these fixes. A maintained-source syntax and whitespace check runs with the suite in GitHub Actions; it replaces the proposed external Hound service.
