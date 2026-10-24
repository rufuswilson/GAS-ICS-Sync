# GAS-CalSync upstream ICS compatibility examples

These synthetic feeds exercise the iCalendar features handled by the original
`derekantrican` implementation. `../upstream-ics.test.js` parses them with the
fork's bundled ical.js and checks the resulting Calendar events or Tasks.

| Fixture | Cases |
| --- | --- |
| `upstream-events.ics` | Timed event; all-day event with an equal start and end; summary, description, location, status, class, transparency, URL, organizer, attendee, and VALARM; RRULE, EXDATE, RDATE, moved RECURRENCE-ID, and cancelled event; calendar name |
| `upstream-edge-cases.ics` | VTIMEZONE/TZID, DURATION, color, generated UID, and legacy EXRULE |
| `upstream-tasks.ics` | VTODO with date-only and UTC timed DUE values alongside a VEVENT |
| `upstream-tasks-only.ics` | VTODO-only feed, with calendar event cleanup suppressed |
| `outlook-moved.ics` | Outlook recurrence override moved from its original start |

Run `node --test tests/*.test.js` from the `rufuswilson` directory. Other
tests cover source settings, filters, and newer fork-specific ICS behavior.
