/*
*=========================================
*       INSTALLATION INSTRUCTIONS
*=========================================
*
* 1) Make a copy:
*      New Interface: Go to the project overview icon on the left (looks like this: ⓘ), then click the "copy" icon on the top right (looks like two files on top of each other)
*      Old Interface: Click in the menu "File" > "Make a copy..." and make a copy to your Google Drive
* 2) Settings: Edit Config.gs to set your calendar mappings and sync options
* 3) Install:
*      New Interface: Make sure your toolbar says "install" to the right of "Debug", then click "Run"
*      Old Interface: Click "Run" > "Run function" > "install"
* 4) Authorize: You will be prompted to authorize the program and will need to click "Advanced" > "Go to GAS-CalSync (unsafe)"
*      - For steps to follow in authorization, see this video: https://youtu.be/_5k10maGtek?t=1m22s
*      - To learn more about the permissions requested by the script visit https://github.com/derekantrican/GAS-ICS-Sync/wiki/Understanding-Permissions-in-GAS%E2%80%90ICS%E2%80%90Sync
* 5) You can also run "startSync" if you want to sync only once (New Interface: change the dropdown to the right of "Debug" from "install" to "startSync")
*
* **To stop the Script from running click in the menu "Run" > "Run function" > "uninstall" (New Interface: change the dropdown to the right of "Debug" from "install" to "uninstall")
*
*=========================================
*            CONFIGURATION
*=========================================
* Edit Config.gs to set your calendar mappings and sync options.
*
*=========================================
*           ABOUT THE AUTHOR
*=========================================
*
* GAS-CalSync is based on the original program created by Derek Antrican.
*
* If you would like to see other programs Derek has made, you can check out
* his website: derekantrican.com or his github: https://github.com/derekantrican
*
*=========================================
*            BUGS/FEATURES
*=========================================
*
* Please report GAS-CalSync issues at https://github.com/rufuswilson/GAS-CalSync/issues
*
*=========================================
*           $$ DONATIONS $$
*=========================================
*
* If you would like to donate and support the project,
* you can do that here: https://www.paypal.me/jonasg0b1011001
*
*=========================================
*             CONTRIBUTORS
*=========================================
* Andrew Brothers
* Github: https://github.com/agentd00nut
* Twitter: @abrothers656
*
* Joel Balmer
* Github: https://github.com/JoelBalmer
*
* Blackwind
* Github: https://github.com/blackwind
*
* Jonas Geissler
* Github: https://github.com/jonas0b1011001
*/


//=====================================================================================================
//!!!!!!!!!!!!!!!! DO NOT EDIT BELOW HERE UNLESS YOU REALLY KNOW WHAT YOU'RE DOING !!!!!!!!!!!!!!!!!!!!
//=====================================================================================================

var defaultMaxRetries = typeof defaultMaxRetries === "number" ? defaultMaxRetries : 10; // Keep a private Config.gs override.

// Defaults for Apps Script projects whose private Config.gs predates these options.
// Config.gs may override every value below; an explicit false or null is preserved.
var skipIfEmptyFeed = typeof skipIfEmptyFeed === "undefined" ? true : skipIfEmptyFeed;
var pastEventWindowDays = typeof pastEventWindowDays === "undefined" ? null : pastEventWindowDays;
var maxCleanupDeletesPerRun = typeof maxCleanupDeletesPerRun === "undefined" ? 100 : maxCleanupDeletesPerRun;
var recurringInstanceWindowDays = typeof recurringInstanceWindowDays === "undefined" ? 180 : recurringInstanceWindowDays;
var titlePrefix = typeof titlePrefix === "undefined" ? "" : titlePrefix;
var titlePrefixAllDayOnly = typeof titlePrefixAllDayOnly === "undefined" ? false : titlePrefixAllDayOnly;
var mapMicrosoftTentativeToFree = typeof mapMicrosoftTentativeToFree === "undefined" ? false : mapMicrosoftTentativeToFree;
var fallbackReminderMinutes = typeof fallbackReminderMinutes === "undefined" ? -1 : fallbackReminderMinutes;
var decodeOutlookSafeLinks = typeof decodeOutlookSafeLinks === "undefined" ? false : decodeOutlookSafeLinks;
var autoUpdateRepository = typeof autoUpdateRepository === "undefined" ? "rufuswilson/GAS-CalSync" : autoUpdateRepository;
var autoUpdateMode = typeof autoUpdateMode === "undefined" ? "auto" : autoUpdateMode;
var autoUpdateChannel = typeof autoUpdateChannel === "undefined" ? "release" : autoUpdateChannel;
var autoUpdateBranch = typeof autoUpdateBranch === "undefined" ? "stable" : autoUpdateBranch;

/** Check the account without running calendar sync. */
function CheckCurrentUserEmail() {
  return ShowCurrentUserEmail();
}

/** Public entry point used by the daily update trigger and manual runs. */
function AutoUpdate(dryRun) {
  return AutoUpdateImpl_(dryRun);
}

function install() {
  // Delete any already existing triggers so we don't create excessive triggers
  deleteAllTriggers();

  // Schedule sync routine to explicitly repeat and schedule the initial sync
  var adjustedMinutes = getValidTriggerFrequency(howFrequent);
  if (adjustedMinutes >= 60) {
    ScriptApp.newTrigger("startSync")
      .timeBased()
      .everyHours(adjustedMinutes / 60)
      .create();
  } else {
    ScriptApp.newTrigger("startSync")
      .timeBased()
      .everyMinutes(adjustedMinutes)
      .create();
  }
  ScriptApp.newTrigger("startSync").timeBased().after(1000).create();

  // Check the selected GitHub channel once a day.
  ScriptApp.newTrigger("AutoUpdate")
    .timeBased()
    .everyDays(1)
    .create();
}

function uninstall() {
  deleteAllTriggers();
}

/** Run this from the Apps Script editor to preview an update without installing it. */
function PreviewUpdate() {
  return AutoUpdate(true);
}

/**
 * Preview or remove events created by this script from one configured target.
 * Call clearGASEvents("Target") to preview, then clearGASEvents("Target", false)
 * to delete. This does not create a calendar when the target is missing.
 */
function clearGASEvents(targetName, dryRun) {
  if (!targetName || !condenseCalendarMap(sourceCalendars).some(function (group) { return group.target === targetName; }))
    throw new Error("Specify a configured target calendar name");

  var calendars = [];
  var pageToken;
  do {
    var options = { showHidden: true, maxResults: 250 };
    if (pageToken) options.pageToken = pageToken;
    var page = callWithBackoff(function () { return Calendar.CalendarList.list(options); }, defaultMaxRetries);
    if (!page) throw new Error("Could not list calendars");
    calendars = calendars.concat(page.items || []);
    pageToken = page.nextPageToken;
  } while (pageToken);
  var matches = calendars.filter(function (calendar) {
    return (calendar.summaryOverride || calendar.summary) === targetName &&
      (calendar.accessRole === "owner" || calendar.accessRole === "writer");
  });
  if (matches.length !== 1) throw new Error("Expected exactly one writable target calendar named " + targetName);

  var events = [];
  pageToken = undefined;
  do {
    var eventOptions = {
      maxResults: 2500, showDeleted: false, singleEvents: false,
      privateExtendedProperty: "fromGAS=true"
    };
    if (pageToken) eventOptions.pageToken = pageToken;
    var eventPage = callWithBackoff(function () { return Calendar.Events.list(matches[0].id, eventOptions); }, defaultMaxRetries);
    if (!eventPage) throw new Error("Could not list script-created events");
    events = events.concat((eventPage.items || []).filter(function (event) {
      return event.extendedProperties && event.extendedProperties.private &&
        event.extendedProperties.private.fromGAS === "true";
    }));
    pageToken = eventPage.nextPageToken;
  } while (pageToken);

  var preview = dryRun !== false;
  if (!preview) {
    events.sort(function (a, b) { return Number(!!a.recurrence) - Number(!!b.recurrence); });
    events.forEach(function (event) {
      var removed = callWithBackoff(function () {
        Calendar.Events.remove(matches[0].id, event.id);
        return true;
      }, defaultMaxRetries);
      if (!removed) throw new Error("Could not remove script-created event " + event.id);
    });
  }
  Logger.log((preview ? "Would remove " : "Removed ") + events.length + " script-created events from " + targetName);
  return { target: targetName, dryRun: preview, count: events.length };
}

// Per-calendar global variables (must be reset before processing each new calendar!)
var calendarEvents = [];
var calendarEventsIds = [];
var icsEventsIds = [];
var icsEventSourceHashes = Object.create(null);
var legacySeriesSourceHashes = Object.create(null);
var recurringEvents = [];
var targetCalendarId;
var targetCalendarName;

// Per-session global variables (must NOT be reset before processing each new calendar!)
var addedEvents = [];
var modifiedEvents = [];
var removedEvents = [];

// Syncing logic can set this to true to cause the Google Apps Script "Executions" dashboard to report failure
var reportOverallFailure = false;
var migrationPreviewMode = false;
var migrationActions = [];

function recordMigrationAction_(action, event, copy) {
  migrationActions.push({ action: action, target: targetCalendarName, targetId: targetCalendarId,
    eventId: event && event.id || "", sourceId: copy && copy.extendedProperties &&
      copy.extendedProperties.private && copy.extendedProperties.private.id || "",
    summary: copy && copy.summary || event && event.summary || "",
    start: copy && copy.start || event && event.start || null,
    digest: copy && copy.extendedProperties && copy.extendedProperties.private &&
      copy.extendedProperties.private.MD5 || "" });
}

function migrationFingerprint_() {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
    JSON.stringify(migrationActions), Utilities.Charset.UTF_8);
  return bytes.map(function (byte) { return (byte & 255).toString(16).padStart(2, "0"); }).join("");
}

/** Read-only preview of the changes that the v2 sync would make. */
function PreviewMigration() {
  return previewMigration_(true);
}

function previewMigration_(remember) {
  migrationActions = [];
  migrationPreviewMode = true;
  try {
    startSync();
    var fingerprint = migrationFingerprint_();
    if (remember) PropertiesService.getScriptProperties().setProperty("migrationPreview:v2", fingerprint);
    var result = { fingerprint: fingerprint, count: migrationActions.length,
      actions: migrationActions.slice() };
    Logger.log("Migration preview: " + JSON.stringify(result));
    return result;
  } finally {
    migrationPreviewMode = false;
  }
}

/** Apply a previously reviewed preview if it still describes the current changes. */
function ApplyMigration() {
  var properties = PropertiesService.getScriptProperties();
  var reviewed = properties.getProperty("migrationPreview:v2");
  if (!reviewed) throw new Error("Run PreviewMigration and review its execution log first");
  var fresh = previewMigration_(false);
  if (fresh.fingerprint !== reviewed)
    throw new Error("Migration changed since the review. Run PreviewMigration again, review its log, then run ApplyMigration");
  properties.deleteProperty("migrationPreview:v2");
  properties.setProperty("migrationApproved:v2", "true");
  try {
    startSync();
  } catch (error) {
    properties.deleteProperty("migrationApproved:v2");
    throw error;
  }
  Logger.log("Migration applied: " + fresh.count + " proposed changes");
  return { applied: true, count: fresh.count };
}

/** Check every existing target before a scheduled sync can write to any of them. */
function requireMigrationReview_() {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty("migrationApproved:v2") === "true") return;
  var groups = condenseCalendarMap(sourceCalendars);
  if (groups.length < 2) return; // The normal target read checks a single target before writing.
  groups.forEach(function (group) {
    var target;
    try {
      target = setupTargetCalendar(group.target, group.targetId, false);
    } catch (error) {
      if (group.createTargetCalendarIfMissing === true &&
        /^Error: Target calendar not found: /.test(String(error))) return;
      throw error;
    }
    var pageToken;
    var seen = Object.create(null);
    do {
      var options = { showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: 250 };
      if (pageToken) options.pageToken = pageToken;
      var page = callWithBackoff(function () { return Calendar.Events.list(target.id, options); }, defaultMaxRetries);
      if (!page) throw new Error("Could not check target events before migration: " + group.target);
      if ((page.items || []).some(function (event) {
        var privateFields = event.extendedProperties && event.extendedProperties.private;
        return event.status !== "cancelled" && privateFields &&
          privateFields.fromGAS === "true" && privateFields.syncVersion !== "2";
      })) throw new Error("Legacy copied events found in " + group.target +
        ". Run PreviewMigration, review the log, then run ApplyMigration");
      pageToken = page.nextPageToken;
      if (pageToken && seen[pageToken]) throw new Error("Repeated target-event page token for " + group.target);
      if (pageToken) seen[pageToken] = true;
    } while (pageToken);
  });
  properties.setProperty("migrationApproved:v2", "true");
}

function startSync() {
  var syncLock = LockService.getScriptLock();
  if (!syncLock.tryLock(1000)) {
    if (migrationPreviewMode) throw new Error("Could not preview migration while another sync is running");
    Logger.log("Another iteration is currently running! Exiting...");
    return;
  }

  var runUserEmail = typeof getSyncUserEmail_ === "function" ? getSyncUserEmail_() : "";
  if (runUserEmail) Logger.log("Run by user: " + runUserEmail);

  try {
    reportOverallFailure = false;
    addedEvents = [];
    modifiedEvents = [];
    removedEvents = [];
    if (migrationPreviewMode) migrationActions = [];
    else if (typeof PropertiesService !== "undefined") requireMigrationReview_();

    //Disable email notification if no mail adress is provided
    emailSummary = emailSummary && email != "";

    var calendarGroups = condenseCalendarMap(sourceCalendars);
    for (var calendar of calendarGroups) {
      //------------------------ Reset globals ------------------------
      calendarEvents = [];
      calendarEventsIds = [];
      icsEventsIds = [];
      icsEventSourceHashes = Object.create(null);
      legacySeriesSourceHashes = Object.create(null);
      recurringEvents = [];

      targetCalendarName = calendar.target;
      var sourceCalendarURLs = calendar.sources;
      var canAddOrModify = sourceCalendarURLs.some(function (source) {
        return sourceSetting(source, "addEventsToCalendar", addEventsToCalendar) ||
          sourceSetting(source, "modifyExistingEvents", modifyExistingEvents);
      });
      var canRemove = sourceCalendarURLs.some(function (source) {
        return sourceSetting(source, "removeEventsFromCalendar", removeEventsFromCalendar);
      });
      var vevents;

      //------------------------ Fetch URL items ------------------------
      Logger.log("Fetching source calendars");
      var responses = fetchSourceCalendars(sourceCalendarURLs);
      Logger.log("Syncing " + responses.length + " calendars to " + targetCalendarName);
      // A failed source must never make its existing target events look obsolete.
      var sourceFetchFailed = responses.failed === true;
      if (migrationPreviewMode && sourceFetchFailed)
        throw new Error("Could not preview migration because a source could not be read");

      //------------------------ Get target calendar information------------------------
      var targetCalendar = setupTargetCalendar(targetCalendarName, calendar.targetId,
        !migrationPreviewMode && calendar.createTargetCalendarIfMissing);
      targetCalendarId = targetCalendar.id;
      Logger.log("Working on calendar: " + targetCalendarId);

      //------------------------ Parse existing events --------------------------
      if (canAddOrModify || canRemove) {
        // Smaller pages avoid one very large Calendar API response for an old target.
        var targetEventPageSize = 250;
        Logger.log("Listing existing target events");
        var eventList =
          callWithBackoff(function () {
            return Calendar.Events.list(targetCalendarId, { showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: targetEventPageSize });
          }, defaultMaxRetries);
        if (!eventList) throw new Error("Could not list target events for " + targetCalendarName);
        calendarEvents = calendarEvents.concat((eventList.items || []).filter(function (event) { return event.status !== "cancelled"; }));
        Logger.log("Listed " + calendarEvents.length + " active target events so far");
        //loop until we received all events
        var seenTargetPageTokens = Object.create(null);
        while (eventList.nextPageToken) {
          if (seenTargetPageTokens[eventList.nextPageToken])
            throw new Error("Repeated target-event page token for " + targetCalendarName);
          seenTargetPageTokens[eventList.nextPageToken] = true;
          eventList = callWithBackoff(function () {
            return Calendar.Events.list(targetCalendarId, { showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: targetEventPageSize, pageToken: eventList.nextPageToken });
          }, defaultMaxRetries);

          if (!eventList) throw new Error("Could not list all target events for " + targetCalendarName);
          calendarEvents = calendarEvents.concat((eventList.items || []).filter(function (event) { return event.status !== "cancelled"; }));
          Logger.log("Listed " + calendarEvents.length + " active target events so far");
        }
        Logger.log("Fetched " + calendarEvents.length + " existing events from " + targetCalendarName);
        if (!migrationPreviewMode && typeof PropertiesService !== "undefined" &&
          PropertiesService.getScriptProperties().getProperty("migrationApproved:v2") !== "true" &&
          calendarEvents.some(function (event) {
            var props = event.extendedProperties && event.extendedProperties.private;
            return props && props.fromGAS === "true" && props.syncVersion !== "2";
          }))
          throw new Error("Legacy copied events found. Run PreviewMigration, review the log, then run ApplyMigration");
        for (var i = 0; i < calendarEvents.length; i++) {
          if (calendarEvents[i].extendedProperties != null) {
            var privateProperties = calendarEvents[i].extendedProperties.private || {};
            calendarEventsIds[i] = privateProperties["rec-id"] || privateProperties["id"];
          }
        }

        //------------------------ Parse ical events --------------------------
        Logger.log("Parsing source events");
        vevents = parseResponses(responses);
        sourceFetchFailed = responses.failed === true;
        if (migrationPreviewMode && sourceFetchFailed)
          throw new Error("Could not preview migration because a source could not be parsed");
        Logger.log("Parsed " + vevents.length + " events from sources");
      }

      //------------------------ Process ical events ------------------------
      if (canAddOrModify) {
        Logger.log("Processing " + vevents.length + " events");
        var calendarTz =
          callWithBackoff(function () {
            return Calendar.Settings.get("timezone").value;
          }, defaultMaxRetries);

        vevents.forEach(function (e, index) {
          processSourceEvent(e, calendarTz);
          if ((index + 1) % 100 === 0) Logger.log("Processed " + (index + 1) + " of " + vevents.length + " source events");
        });

        Logger.log("Done processing events");
      }

      //------------------------ Remove old events from calendar ------------------------
      if (canRemove && !sourceFetchFailed && !responses.tasksOnly && !reportOverallFailure) {
        Logger.log("Checking " + calendarEvents.length + " events for removal");
        processEventCleanup(sourceCalendarURLs);
        Logger.log("Done checking events for removal");
      }
      else if (sourceFetchFailed || responses.tasksOnly || reportOverallFailure)
        Logger.log("Skipping cleanup because a source had no active events, could not be read, or an event could not be saved");

      //------------------------ Process Tasks ------------------------
      if (!migrationPreviewMode && addTasks && !sourceFetchFailed) {
        try {
          processSourceTasks(responses);
        } catch (taskError) {
          Logger.log("Could not sync tasks: " + taskError);
          reportOverallFailure = true;
        }
      }

      //------------------------ Add Recurring Event Instances ------------------------
      Logger.log("Processing " + recurringEvents.length + " Recurrence Instances!");
      recurringEvents.forEach(syncSourceException);
    }

    if (!migrationPreviewMode && (addedEvents.length + modifiedEvents.length + removedEvents.length) > 0 && emailSummary) {
      sendSummary();
    }
    Logger.log("Sync finished!");
    if (reportOverallFailure) {
      // Cause the Google Apps Script "Executions" dashboard to show a failure
      // (the message text does not seem to be logged anywhere)
      throw new Error('The sync operation produced errors. See log for details.');
    }
  } finally {
    syncLock.releaseLock();
  }
}
