/*
Filters for ICS and Google Calendar source events.
Define each filter with the following structure and add them to the var filters array:
{
  source: "source ID or URL", // Optional: apply only to this sourceCalendars entry.
  parameter: "property",      // Event property (e.g., "summary", "dtend", "dtstart", "attendee", "allDay").
  type: "include/exclude",    // Whether to include or exclude events matching the criteria.
  comparison: "method",       // Comparison method: "equals", "begins with", "contains", "regex", "<", ">".
                              // Note: "<", ">" only apply for date/time properties.
  criterias: ["values"],      // Array of values or patterns; omit for allDay.
  offset: number              // (Optional) For date/time properties, specify an offset in days.
}
*/
var filters = [];

// Attendee email matching is case-insensitive. An event matches if any attendee
// matches. Use parameter: "allDay", type: "exclude" to omit all-day events.
// A filter without source applies to every source. For Google Calendar sources,
// source may be the configured name or the resolved calendar ID.

/* Examples:
var filters = [
  {
    parameter: "summary",       // Exclude events whose summary starts with "Pending:" or contains "cancelled".
    type: "exclude",
    comparison: "regex",
    criterias: ["^Pending:", "cancelled"]
  },
  {
    parameter: "categories",    // Include only events categorized as "Meetings".
    type: "include",
    comparison: "equals",
    criterias: ["Meetings"]
  },
  {
    parameter: "dtend",       // Keep events ending after today; recurring ICS and Google events use the configured rolling window.
    type: "include",
    comparison: ">",
    offset: 0
  },
  {
    parameter: "dtstart",       // Exclude events starting more than 14 days from now.
    type: "exclude",
    comparison: ">",
    offset: 14
  },
  {
    source: "source-calendar-id@group.calendar.google.com",
    parameter: "attendee",
    type: "exclude",
    comparison: "equals",
    criterias: ["person@example.com"]
  },
  {
    parameter: "allDay",
    type: "exclude"
  }
];
*/
