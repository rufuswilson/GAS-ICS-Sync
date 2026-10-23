/*
* Calendar mappings and user settings for this Apps Script project.
*/

var sourceCalendars = [                // One entry per source. source can be an ICS URL or a Google Calendar ID/name.
                                       // target is the target calendar name. colour is optional; see
                                       // https://developers.google.com/apps-script/reference/calendar/event-color
                                       // Legacy [source, target, colour] entries are also supported.
  {source: "icsUrl1", target: "targetCalendar1"},
  {source: "icsUrl2", target: "targetCalendar2", colour: "11"},
  {source: "icsUrl3", target: "targetCalendar1"}

];

var howFrequent = 15;                     // What interval (minutes) to run this script on to check for new events.  Any integer can be used, but will be rounded up to 5, 10, 15, 30 or to the nearest hour after that.. 60, 120, etc. 1440 (24 hours) is the maximum value.  Anything above that will be replaced with 1440.
var addEventsToCalendar = true;           // If you turn this to "false", you can check the log (View > Logs) to make sure your events are being read correctly before turning this on
var modifyExistingEvents = true;          // If you turn this to "false", any event in the feed that was modified after being added to the calendar will not update
var removeEventsFromCalendar = true;      // If you turn this to "true", any event created by the script that is not found in the feed will be removed.
var removePastEventsFromCalendar = true;  // If you turn this to "false", any event that is in the past will not be removed.
var recurringInstanceWindowDays = 180;    // Future date filters copy recurring ICS and Google occurrences this many days ahead as individual events.
var addAlerts = "yes";                    // Whether to add the ics/ical alerts as notifications on the Google Calendar events or revert to the calendar's default reminders ("yes", "no", "default").
var addOrganizerToTitle = false;          // Whether to prefix the event name with the event organiser for further clarity
var descriptionAsTitles = false;          // Whether to use the ics/ical descriptions as titles (true) or to use the normal titles as titles (false)
var addCalToTitle = false;                // Whether to add the source calendar to title
var addAttendees = false;                 // Whether to add the attendee list. If true, duplicate events will be automatically added to the attendees' calendar.
var defaultAllDayReminder = -1;           // Default reminder for all day events in minutes before the day of the event (-1 = no reminder, the value has to be between 0 and 40320)
                                          // See https://github.com/derekantrican/GAS-ICS-Sync/issues/75 for why this is neccessary.
var overrideVisibility = "";              // Changes the visibility of the event ("default", "public", "private", "confidential"). Anything else will revert to the class value of the ICAL event.
var defaultColor = true;                 // true keeps source/calendar colours; otherwise use a CalendarApp.EventColor value when a source has no colour.
var addTasks = false;

var emailSummary = false;                 // Will email you when an event is added/modified/removed to your calendar
var email = "";                           // OPTIONAL: If "emailSummary" is set to true or you want to receive update notifications, you will need to provide your email address
var customEmailSubject = "";              // OPTIONAL: If you want to change the email subject, provide a custom one here. Default: "GAS-ICS-Sync Execution Summary"
var dateFormat = "YYYY-MM-DD"             // date format in the email summary (e.g. "YYYY-MM-DD", "DD.MM.YYYY", "MM/DD/YYYY". separators are ".", "-" and "/")

var defaultMaxRetries = 10; // Maximum retries for Calendar API calls.

// Updates from your fork. "auto" installs changes; "email" only sends a notice.
// "release" follows the latest published release; "bleeding-edge" follows the branch below.
var autoUpdateRepository = "rufuswilson/GAS-ICS-Sync";
var autoUpdateMode = "auto";               // "auto" or "email"
var autoUpdateChannel = "release";         // "release" or "bleeding-edge"
var autoUpdateBranch = "master";           // Used only for "bleeding-edge"
