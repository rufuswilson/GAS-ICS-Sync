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
* 4) Authorize: You will be prompted to authorize the program and will need to click "Advanced" > "Go to GAS-ICS-Sync (unsafe)"
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
* This program was created by Derek Antrican
*
* If you would like to see other programs Derek has made, you can check out
* his website: derekantrican.com or his github: https://github.com/derekantrican
*
*=========================================
*            BUGS/FEATURES
*=========================================
*
* Please report any issues at https://github.com/derekantrican/GAS-ICS-Sync/issues
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

var defaultMaxRetries = 10; // Maximum number of retries for api functions (with exponential backoff)

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

function uninstall(){
  deleteAllTriggers();
}

/** Run this from the Apps Script editor to preview an update without installing it. */
function PreviewUpdate(){
  return AutoUpdate(true);
}

/**
 * Preview or remove events created by this script from one configured target.
 * Call clearGASEvents("Target") to preview, then clearGASEvents("Target", false)
 * to delete. This does not create a calendar when the target is missing.
 */
function clearGASEvents(targetName, dryRun){
  if (!targetName || !condenseCalendarMap(sourceCalendars).some(function(group){ return group.target === targetName; }))
    throw new Error("Specify a configured target calendar name");

  var calendars = [];
  var pageToken;
  do {
    var options = {showHidden: true, maxResults: 250};
    if (pageToken) options.pageToken = pageToken;
    var page = callWithBackoff(function(){ return Calendar.CalendarList.list(options); }, defaultMaxRetries);
    if (!page) throw new Error("Could not list calendars");
    calendars = calendars.concat(page.items || []);
    pageToken = page.nextPageToken;
  } while (pageToken);
  var matches = calendars.filter(function(calendar){
    return (calendar.summaryOverride || calendar.summary) === targetName &&
      (calendar.accessRole === "owner" || calendar.accessRole === "writer");
  });
  if (matches.length !== 1) throw new Error("Expected exactly one writable target calendar named " + targetName);

  var events = [];
  pageToken = undefined;
  do {
    var eventOptions = {maxResults: 2500, showDeleted: false, singleEvents: false,
      privateExtendedProperty: "fromGAS=true"};
    if (pageToken) eventOptions.pageToken = pageToken;
    var eventPage = callWithBackoff(function(){ return Calendar.Events.list(matches[0].id, eventOptions); }, defaultMaxRetries);
    if (!eventPage) throw new Error("Could not list script-created events");
    events = events.concat((eventPage.items || []).filter(function(event){
      return event.extendedProperties && event.extendedProperties.private &&
        event.extendedProperties.private.fromGAS === "true";
    }));
    pageToken = eventPage.nextPageToken;
  } while (pageToken);

  var preview = dryRun !== false;
  if (!preview) {
    events.sort(function(a, b){ return Number(!!a.recurrence) - Number(!!b.recurrence); });
    events.forEach(function(event){
      var removed = callWithBackoff(function(){
        Calendar.Events.remove(matches[0].id, event.id);
        return true;
      }, defaultMaxRetries);
      if (!removed) throw new Error("Could not remove script-created event " + event.id);
    });
  }
  Logger.log((preview ? "Would remove " : "Removed ") + events.length + " script-created events from " + targetName);
  return {target: targetName, dryRun: preview, count: events.length};
}

// Per-calendar global variables (must be reset before processing each new calendar!)
var calendarEvents = [];
var calendarEventsIds = [];
var icsEventsIds = [];
var icsEventSourceHashes = Object.create(null);
var recurringEvents = [];
var nativeExceptions = [];
var targetCalendarId;
var targetCalendarName;

// Per-session global variables (must NOT be reset before processing each new calendar!)
var addedEvents = [];
var modifiedEvents = [];
var removedEvents = [];

// Syncing logic can set this to true to cause the Google Apps Script "Executions" dashboard to report failure
var reportOverallFailure = false;

function startSync(){
  var syncLock = LockService.getScriptLock();
  if (!syncLock.tryLock(1000)) {
    Logger.log("Another iteration is currently running! Exiting...");
    return;
  }
  try {

  //Disable email notification if no mail adress is provided
  emailSummary = emailSummary && email != "";

  var calendarGroups = condenseCalendarMap(sourceCalendars);
  for (var calendar of calendarGroups){
    //------------------------ Reset globals ------------------------
    calendarEvents = [];
    calendarEventsIds = [];
    icsEventsIds = [];
    icsEventSourceHashes = Object.create(null);
    recurringEvents = [];
    nativeExceptions = [];

    targetCalendarName = calendar.target;
    var sourceCalendarURLs = calendar.sources;
    var canAddOrModify = sourceCalendarURLs.some(function(source){
      return sourceSetting(source, "addEventsToCalendar", addEventsToCalendar) ||
        sourceSetting(source, "modifyExistingEvents", modifyExistingEvents);
    });
    var canRemove = sourceCalendarURLs.some(function(source){
      return sourceSetting(source, "removeEventsFromCalendar", removeEventsFromCalendar);
    });
    var vevents;

    //------------------------ Fetch URL items ------------------------
    Logger.log("Fetching source calendars");
    var responses = fetchSourceCalendars(sourceCalendarURLs);
    Logger.log("Syncing " + responses.length + " calendars to " + targetCalendarName);
    // A failed source must never make its existing target events look obsolete.
    var sourceFetchFailed = responses.failed === true;

    //------------------------ Get target calendar information------------------------
    var targetCalendar = setupTargetCalendar(targetCalendarName, calendar.targetId,
      calendar.createTargetCalendarIfMissing);
    targetCalendarId = targetCalendar.id;
    Logger.log("Working on calendar: " + targetCalendarId);

    //------------------------ Parse existing events --------------------------
    if(canAddOrModify || canRemove){
      // Smaller pages avoid one very large Calendar API response for an old target.
      var targetEventPageSize = 250;
      Logger.log("Listing existing target events");
      var eventList =
        callWithBackoff(function(){
            return Calendar.Events.list(targetCalendarId, {showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: targetEventPageSize});
        }, defaultMaxRetries);
      if (!eventList) throw new Error("Could not list target events for " + targetCalendarName);
      calendarEvents = calendarEvents.concat((eventList.items || []).filter(function(event){ return event.status !== "cancelled"; }));
      Logger.log("Listed " + calendarEvents.length + " active target events so far");
      //loop until we received all events
      var seenTargetPageTokens = Object.create(null);
      while (eventList.nextPageToken){
        if (seenTargetPageTokens[eventList.nextPageToken])
          throw new Error("Repeated target-event page token for " + targetCalendarName);
        seenTargetPageTokens[eventList.nextPageToken] = true;
        eventList = callWithBackoff(function(){
          return Calendar.Events.list(targetCalendarId, {showDeleted: false, privateExtendedProperty: "fromGAS=true", maxResults: targetEventPageSize, pageToken: eventList.nextPageToken});
        }, defaultMaxRetries);

        if (!eventList) throw new Error("Could not list all target events for " + targetCalendarName);
        calendarEvents = calendarEvents.concat((eventList.items || []).filter(function(event){ return event.status !== "cancelled"; }));
        Logger.log("Listed " + calendarEvents.length + " active target events so far");
      }
      Logger.log("Fetched " + calendarEvents.length + " existing events from " + targetCalendarName);
      for (var i = 0; i < calendarEvents.length; i++){
        if (calendarEvents[i].extendedProperties != null){
          var privateProperties = calendarEvents[i].extendedProperties.private || {};
          calendarEventsIds[i] = privateProperties["rec-id"] || privateProperties["id"];
        }
      }

      //------------------------ Parse ical events --------------------------
      Logger.log("Parsing source events");
      vevents = parseResponses(responses);
      sourceFetchFailed = responses.failed === true;
      Logger.log("Parsed " + vevents.length + " events from sources");
    }

    //------------------------ Process ical events ------------------------
    if (canAddOrModify){
      Logger.log("Processing " + vevents.length + " events");
      var calendarTz =
        callWithBackoff(function(){
          return Calendar.Settings.get("timezone").value;
        }, defaultMaxRetries);

      vevents.forEach(function(e, index){
        if (e.nativeEvent) processNativeEvent(e);
        else processICSEvent(e, calendarTz);
        if ((index + 1) % 100 === 0) Logger.log("Processed " + (index + 1) + " of " + vevents.length + " source events");
      });

      Logger.log("Done processing events");
    }

    //------------------------ Remove old events from calendar ------------------------
    if(canRemove && !sourceFetchFailed && !reportOverallFailure){
      Logger.log("Checking " + calendarEvents.length + " events for removal");
      processEventCleanup(sourceCalendarURLs);
      Logger.log("Done checking events for removal");
    }
    else if (sourceFetchFailed || reportOverallFailure)
      Logger.log("Skipping cleanup because a source could not be read or an event could not be saved");

    //------------------------ Process Tasks ------------------------
    if (addTasks && !sourceFetchFailed && responses.some(function(source){ return source.kind === "ics"; })){
      processICSTasks(responses.filter(function(source){ return source.kind === "ics"; }));
    }

    //------------------------ Add Recurring Event Instances ------------------------
    Logger.log("Processing " + recurringEvents.length + " Recurrence Instances!");
    for (var recEvent of recurringEvents){
      processICSEventInstance(recEvent.event, recEvent.settings);
    }
    processNativeExceptions();
  }

  if ((addedEvents.length + modifiedEvents.length + removedEvents.length) > 0 && emailSummary){
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
