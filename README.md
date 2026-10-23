# GAS-ICS-Sync

This repository remains a fork of [derekantrican/GAS-ICS-Sync](https://github.com/derekantrican/GAS-ICS-Sync). The [`stable` branch](https://github.com/rufuswilson/GAS-ICS-Sync/tree/stable) is the GitHub default and contains this fork's calendar sync changes. Upstream changes are incorporated into `stable` when chosen; the fork relationship does not update that branch automatically.

This is a standalone script (that consists of multiple files). The purpose is to sync ics/ical calendars to Google Calendar. Google Calendar *can* already do this, but updates only happen once every 12 or even 24 hrs. This script can be run much more frequently.

### Source options in this fork

Edit `Config.gs` to set `sourceCalendars` and the sync options. Define `sourceCalendars` as a list of objects with `source`, `target`, and optional `colour`. `source` can be an ICS URL, a Google Calendar ID, or a subscribed calendar name. Use an ID when names are ambiguous. The per-source colour works with either source type:

```javascript
var sourceCalendars = [
  {source: "https://example.com/events.ics", target: "Target", colour: "11"},
  {source: "source-calendar-id@group.calendar.google.com", target: "Target"}
];
```

The previous array format remains supported, including mixed configurations: `[source, target]` or `[source, target, colour]`.

`target` names the target calendar. For a renamed target or duplicate display names, add `targetId` with its exact Google Calendar ID. The script fails if that ID is missing or not writable. Name-based selection also fails when several calendars have that name or the only match is read-only. A missing target is not created automatically; set `createTargetCalendarIfMissing: true` on a mapping only when you intend to create it. Use the same target ID and creation setting on every mapping sharing a target.

Internally, `condenseCalendarMap` groups entries as `{target, targetId, createTargetCalendarIfMissing, sources}`. Each source is an object with named fields. Object mappings can override these settings for that source: `defaultColor`, `addAlerts`, `addOrganizerToTitle`, `descriptionAsTitles`, `addCalToTitle`, `addAttendees`, `defaultAllDayReminder`, `overrideVisibility`, `recurringInstanceWindowDays`, `addEventsToCalendar`, `modifyExistingEvents`, `removeEventsFromCalendar`, `removePastEventsFromCalendar`, `skipIfEmptyFeed`, `pastEventWindowDays`, `titlePrefix`, `titlePrefixAllDayOnly`, `mapMicrosoftTentativeToFree`, `fallbackReminderMinutes`, and `decodeOutlookSafeLinks`. Unspecified settings use their global `Config.gs` values; an explicit `false` overrides a global `true`. For example:

```javascript
{source: "https://example.com/events.ics", target: "Target",
  addAlerts: "no", addCalToTitle: true,
  removeEventsFromCalendar: true, removePastEventsFromCalendar: false}
```

To create a new target on its first sync, set `createTargetCalendarIfMissing: true` on that target's mapping. After creation, copy its calendar ID into `targetId` and remove the creation option. This prevents a later rename or transient lookup failure from creating another calendar.

`colour` takes precedence over both the source's `defaultColor` and the global `defaultColor`. Copied events store a hash of the configured source address so cleanup can apply that source's removal settings without storing the address itself. Existing events are tagged when they still match one unambiguous source event. Older events that no longer match a source are preserved because their source cannot be identified safely. Task cleanup remains controlled by the global setting.

`skipIfEmptyFeed` defaults to `true`. If a successfully fetched ICS or Google Calendar source contains no active events (including a feed with only cancelled events), sync marks the run failed and preserves existing target events while continuing to process other sources. Set it to `false` on a source only when an intentionally empty source should clear its target events. This checks the source before event filters, so a filter that excludes every event does not count as an empty feed.

`pastEventWindowDays` defaults to `null` (all history). Set a non-negative number of days globally or per source to skip older, completed events while retaining recurring series. Target events older than that source's window are preserved during cleanup. The source is still fetched in full before this filter is applied. `maxCleanupDeletesPerRun` defaults to `100`; cleanup stores a cursor per target and resumes deletion in later sync runs. A failed deletion is reported and does not appear as a successful removal in the email summary.

ICS feeds are decoded as UTF-8 and require valid HTTPS certificates. VFREEBUSY-only feeds create one opaque “Busy” event per non-free interval; VEVENTs take precedence in mixed feeds. `titlePrefix` adds text before copied titles, and `titlePrefixAllDayOnly: true` limits it to all-day events. `mapMicrosoftTentativeToFree: true` maps Microsoft's tentative busy marker to free unless `TRANSP` is explicit. For ICS and Google Calendar sources, `fallbackReminderMinutes` adds a popup when `addAlerts: "yes"` finds no usable explicit reminder; `defaultAllDayReminder` takes precedence over calendar defaults for all-day events. `decodeOutlookSafeLinks: true` replaces recognized Outlook Safe Links in ICS descriptions with their target URL.

### Updates from this fork

`install()` checks GitHub once per day using `AutoUpdate()` in `Helpers.gs`. Set the update options in your private `Config.gs`:

```javascript
var autoUpdateRepository = "rufuswilson/GAS-ICS-Sync";
var autoUpdateMode = "auto";          // "auto" installs; "email" only notifies
var autoUpdateChannel = "bleeding-edge"; // "release" or "bleeding-edge"
var autoUpdateBranch = "stable";      // branch used for bleeding-edge
var email = "you@example.com";       // required for email mode
```

Release mode follows the latest published GitHub release. Bleeding edge follows the latest commit on the selected branch. This fork currently has no published release, so the repository copy of `Config.gs` defaults to `bleeding-edge` on `stable`. Both channels fetch code at one fixed tag or commit. `Config.gs` and `Filters.gs` in your Apps Script project are retained. Run `PreviewUpdate()` from the editor to preview the selected version and managed files without installing or sending email. `AutoUpdate()` checks and acts on the configured mode; running `install()` recreates the daily update trigger. An existing `checkForUpdate` trigger replaces itself with an `AutoUpdate` trigger on its next run.

Before enabling automatic installation in release mode, publish a release containing the `stable` code. The selected version must contain `AutoUpdate`; older versions are rejected so they cannot remove the updater. Release mode has nothing to install until the fork has a published release. For automatic installation or preview, enable the Apps Script API in the script's Google Cloud project and enable project access at [Apps Script settings](https://script.google.com/home/usersettings). Find the Cloud project number under Apps Script > Project Settings. If you cannot access its default Cloud project in Google Cloud Console, [attach a standard Cloud project](https://developers.google.com/apps-script/guides/cloud-platform-projects#switch_to_a_different_standard_cloud_project), enable the Apps Script API there, and reauthorize the script. After adding the `script.projects` scope, run `PreviewUpdate()` manually in the editor to grant the new permission before relying on the daily trigger. If you only want email notices, set `autoUpdateMode = "email"` and provide `email`.

If GitHub returns HTTP 403 with a rate-limit message, wait for the limit to reset. Without a token, the updater makes two GitHub API requests per check and fetches source files from pinned raw URLs. To authenticate the checks and source downloads, set a GitHub token in Apps Script **Project Settings > Script properties** under the exact key `GITHUB_TOKEN`; an environment variable or user property will not be read. With a token, source files are fetched through GitHub's Contents API, so the token needs read access to the configured repository (for a fine-grained token, grant Contents: read). Keep the token out of `Config.gs` and the repository. The installed Apps Script project must contain this version of `Helpers.gs` before its updater can use the token for source downloads.

Set `defaultColor` in `Config.gs` to a `CalendarApp.EventColor` value (for example, `CalendarApp.EventColor.RED`) to colour events from sources without an explicit `colour`. A source's `colour` takes precedence. Leave `defaultColor = true` to retain source and calendar colours.

Google Calendar sources copy ordinary and recurring events and their recurrence overrides. The script skips removal from a target when any of its sources cannot be read.

### Diagnosing missing events or an unexpected runtime exit

Run `CheckCurrentUserEmail()` in the Apps Script editor to log the account detected by `Config.gs` without syncing any calendars. The lookup uses the active user's email when available and falls back to the effective user, which is the account that owns a scheduled trigger. The manifest includes the `userinfo.email` scope for this lookup.

If a run reports newly copied events but none appear in the expected calendar, check the target calendar ID in the execution log and the IDs of calendars with duplicate display names. Set `targetId` to the intended writable calendar. The script now stops on an ambiguous name or missing target instead of silently creating a second calendar.

For an unexpected JavaScript runtime exit, inspect the last progress message: “Fetching source calendars,” “Listing existing target events,” “Listed … active target events so far,” “Parsing source events,” or “Processed … source events.” This narrows the exit to fetching, reading the target, parsing, or saving events. Target events are fetched in pages of 250. If the error persists, record the last progress message, approximate target-event count, execution time, and whether the same source succeeds with a separate target. Keep private feed URLs and event details out of shared logs.

### Filters and cleanup

Configure rules in `Filters.gs`. Date filters, attendee email filters, and the `allDay` filter work with both ICS and Google Calendar sources. Add an optional `source` to restrict a rule to one source; use the same URL, name, or ID as in `sourceCalendars`. An attendee rule matches if any attendee has the listed email address, ignoring case.

When a future date filter applies to an ICS or Google Calendar source, its recurring series are copied as individual occurrences within `recurringInstanceWindowDays` days of the filter cutoff (default 180). Each occurrence keeps a stable source key based on its original scheduled start, so a moved occurrence updates the same target event. Cancelled or filtered occurrences are omitted and removed from the target when `removeEventsFromCalendar` is enabled. Existing copied recurring series are also removed during this transition when both `removeEventsFromCalendar` and `removePastEventsFromCalendar` are enabled. Series without a future date filter continue to sync as recurring series.

To inspect script-created events in one configured target, call `clearGASEvents("Target")`. This only previews and returns a count. To remove them, call `clearGASEvents("Target", false)` explicitly. Only events marked `fromGAS=true` are selected. Keep private ICS URLs and personal account mappings in your own script configuration rather than a shared repository.

### Install or update manually

Use [the source files on `stable`](https://github.com/rufuswilson/GAS-ICS-Sync/tree/stable), including `appsscript.json`. Create a standalone Apps Script project, copy the `.gs` files and manifest into it, then edit `Config.gs` with your own calendar mappings. Enable the Calendar advanced service shown in the manifest; enable Tasks too if you use task syncing. Run `install()` once in the editor to create the sync trigger and grant the requested permissions. Test with a non-critical target calendar before using an existing one.

For a command-line installation, install [clasp](https://github.com/google/clasp), run `clasp login`, create an Apps Script project in the browser, then run `clasp clone SCRIPT_ID` in a new directory. Copy only this fork's `.gs` files and `appsscript.json` into that cloned directory, set your private `Config.gs`, and run `clasp push`. Keep the cloned directory private because it contains feed URLs and account settings. Run `install()` from the Apps Script editor after the push.

Before a manual update, save copies of your private `Config.gs` and `Filters.gs`, check the selected fork release or commit, and replace only the maintained script files. Review manifest scope changes, run `PreviewUpdate()` if the installed updater supports it, and reauthorize from the editor if prompted. Verify one sync and its execution log before relying on the trigger again. If an account password change or revoked grant leaves the trigger reporting authorization errors, open the project as the trigger owner, run `install()` manually, accept the requested scopes, and run a test sync. If Google still rejects the grant, remove the old project authorization in your Google account's third-party access settings and authorize the script again.

---------------

### Community

For questions about the original project, see the [upstream Discord](https://discord.gg/DRBpb4k). For issues with this fork's changes, use [this fork's issues](https://github.com/rufuswilson/GAS-ICS-Sync/issues).

![Discord](https://img.shields.io/discord/612735135120490496)

----------------

### Contributing

Run `node --test tests/*.test.js` from `rufuswilson/` before submitting changes. The suite includes a syntax and whitespace check for maintained Apps Script files and runs in GitHub Actions. To contribute, make your changes on a branch and open a pull request against `stable`.
