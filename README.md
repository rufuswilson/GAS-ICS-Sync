# GAS-ICS-Sync

### ⚠️⚠️ This project is looking for contributors and people to help answer questions! Please message @developers on the Discord! ⚠️⚠️

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

Internally, `condenseCalendarMap` groups entries as `{target, sources}`. Each source is an object with named fields. Object mappings can override these settings for that source: `defaultColor`, `addAlerts`, `addOrganizerToTitle`, `descriptionAsTitles`, `addCalToTitle`, `addAttendees`, `defaultAllDayReminder`, `overrideVisibility`, `recurringInstanceWindowDays`, `addEventsToCalendar`, `modifyExistingEvents`, `removeEventsFromCalendar`, and `removePastEventsFromCalendar`. Unspecified settings use their global `Config.gs` values; an explicit `false` overrides a global `true`. For example:

```javascript
{source: "https://example.com/events.ics", target: "Target",
  addAlerts: "no", addCalToTitle: true,
  removeEventsFromCalendar: true, removePastEventsFromCalendar: false}
```

`colour` takes precedence over both the source's `defaultColor` and the global `defaultColor`. Copied events store a hash of the configured source address so cleanup can apply that source's removal settings without storing the address itself. Existing events are tagged when they still match one unambiguous source event. Older events that no longer match a source are preserved because their source cannot be identified safely. Task cleanup remains controlled by the global setting.

### Updates from this fork

`install()` checks GitHub once per day using `AutoUpdate()` in `Helpers.gs`. Set the update options in your private `Config.gs`:

```javascript
var autoUpdateRepository = "rufuswilson/GAS-ICS-Sync";
var autoUpdateMode = "auto";          // "auto" installs; "email" only notifies
var autoUpdateChannel = "release";    // "release" or "bleeding-edge"
var autoUpdateBranch = "master";      // branch used for bleeding-edge
var email = "you@example.com";       // required for email mode
```

Release mode follows the latest published GitHub release. Bleeding edge follows the latest commit on the selected branch. Both fetch code at one fixed tag or commit. `Config.gs` and `Filters.gs` in your Apps Script project are retained. Run `PreviewUpdate()` from the editor to preview the selected version and managed files without installing or sending email. `AutoUpdate()` checks and acts on the configured mode; running `install()` recreates the daily update trigger. An existing `checkForUpdate` trigger replaces itself with an `AutoUpdate` trigger on its next run.

Before enabling automatic installation, publish this updated code to the fork and create a release if using release mode. The selected version must contain `AutoUpdate`; older versions are rejected so they cannot remove the updater. Release mode has nothing to install until the fork has a published release. For automatic installation or preview, enable the Apps Script API in the script's Google Cloud project and enable project access at [Apps Script settings](https://script.google.com/home/usersettings). Find the Cloud project number under Apps Script > Project Settings. If you cannot access its default Cloud project in Google Cloud Console, [attach a standard Cloud project](https://developers.google.com/apps-script/guides/cloud-platform-projects#switch_to_a_different_standard_cloud_project), enable the Apps Script API there, and reauthorize the script. After adding the `script.projects` scope, run `PreviewUpdate()` manually in the editor to grant the new permission before relying on the daily trigger. If you only want email notices, set `autoUpdateMode = "email"` and provide `email`.

If GitHub returns HTTP 403 with a rate-limit message, wait for the limit to reset. Without a token, the updater makes two GitHub API requests per check and fetches source files from pinned raw URLs. To authenticate the checks and source downloads, set a GitHub token in Apps Script **Project Settings > Script properties** under the exact key `GITHUB_TOKEN`; an environment variable or user property will not be read. With a token, source files are fetched through GitHub's Contents API, so the token needs read access to the configured repository (for a fine-grained token, grant Contents: read). Keep the token out of `Config.gs` and the repository. The installed Apps Script project must contain this version of `Helpers.gs` before its updater can use the token for source downloads.

Set `defaultColor` in `Config.gs` to a `CalendarApp.EventColor` value (for example, `CalendarApp.EventColor.RED`) to colour events from sources without an explicit `colour`. A source's `colour` takes precedence. Leave `defaultColor = true` to retain source and calendar colours.

Google Calendar sources copy ordinary and recurring events and their recurrence overrides. The script skips removal from a target when any of its sources cannot be read.

### Filters and cleanup

Configure rules in `Filters.gs`. Date filters, attendee email filters, and the `allDay` filter work with both ICS and Google Calendar sources. Add an optional `source` to restrict a rule to one source; use the same URL, name, or ID as in `sourceCalendars`. An attendee rule matches if any attendee has the listed email address, ignoring case.

When a future date filter applies to an ICS or Google Calendar source, its recurring series are copied as individual occurrences within `recurringInstanceWindowDays` days of the filter cutoff (default 180). Each occurrence keeps a stable source key based on its original scheduled start, so a moved occurrence updates the same target event. Cancelled or filtered occurrences are omitted and removed from the target when `removeEventsFromCalendar` is enabled. Existing copied recurring series are also removed during this transition when both `removeEventsFromCalendar` and `removePastEventsFromCalendar` are enabled. Series without a future date filter continue to sync as recurring series.

To inspect script-created events in one configured target, call `clearGASEvents("Target")`. This only previews and returns a count. To remove them, call `clearGASEvents("Target", false)` explicitly. Only events marked `fromGAS=true` are selected. Keep private ICS URLs and personal account mappings in your own script configuration rather than a shared repository.

[If you want to use this, please copy the script from here](https://script.google.com/d/1BOk8MDLbLaHh6SwG1M1tsgNXjkcC-79LE0QoipRuTDxbO3fMVvqoROQD/edit?newcopy=true)

**To make a copy in the new Google Apps Script interface:**
1. Go to the project overview icon on the left (looks like this: ⓘ)
2. Click the "copy" icon on the top right (looks like two files on top of each other)

**NOTE:** If too many people are accessing the file at the same time, Google may lock you out. You can follow these instructions to set up the script: https://github.com/derekantrican/GAS-ICS-Sync/wiki/Setting-up-the-script-manually

---------------

### Questions? Comments? Anything else?
[Join the Discord!](https://discord.gg/DRBpb4k)

![Discord](https://img.shields.io/discord/612735135120490496)

----------------

### Contributing

If you would like to contribute to this repository, please fork the repository, make your changes, and start a pull request. If your pull request is approved, I will add you as a contributer directly to the repository


**If you would like to fund an issue, you can do that through here: https://issuehunt.io/repos/136078981/**
