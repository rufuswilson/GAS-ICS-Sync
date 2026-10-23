const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function script(calendar, options = {}) {
  const logs = options.logs || [];
  const context = vm.createContext({
    Calendar: calendar,
    Logger: {log(message) { logs.push(String(message)); }},
    Utilities: {Charset: {UTF_8: 'UTF_8'}, DigestAlgorithm: {MD5: 'MD5'},
      computeDigest(_algorithm, value) { return Array.from(Buffer.from(value)); }, sleep() {}},
    CalendarApp: {EventColor: {BLUE: '9', RED: '11'}},
  });
  for (const filename of ['Config.gs', 'Code.gs', 'filters.gs', 'Helpers.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), context, {filename});
  }
  if (!options.realBackoff) context.callWithBackoff = fn => fn();
  return context;
}

test('retry limit is available from Code.gs without Config.gs', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), context);
  assert.equal(context.defaultMaxRetries, 10);
});

test('iCal HTTP 429 is retried without logging the private URL', () => {
  const privateUrl = 'https://calendar.google.com/calendar/ical/private-token/basic.ics';
  const logs = [];
  let calls = 0;
  const s = script({}, {logs, realBackoff: true});
  s.UrlFetchApp = {fetch() {
    calls++;
    return calls === 1 ? {getResponseCode() { return 429; }} :
      {getResponseCode() { return 200; }, getContentText() {
        return 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR';
      }};
  }};
  const responses = s.fetchSourceCalendars([{source: privateUrl}]);
  assert.equal(calls, 2);
  assert.equal(responses.length, 1);
  assert.equal(responses.failed, undefined);
  assert.equal(logs.join('\n').includes(privateUrl), false);
});

test('calendar groups use named fields and retain per-source settings', () => {
  const s = script({});
  const groups = s.condenseCalendarMap([
    {source: 'a.ics', target: 'Target', colour: '11', addAlerts: 'no'},
    ['b.ics', 'Target'],
    ['c.ics', 'Other', '9'],
    {source: 'd.ics', target: 'Target'},
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].target, 'Target');
  assert.deepEqual(Array.from(groups[0].sources, source => ({...source})), [
    {source: 'a.ics', colour: '11', addAlerts: 'no'},
    {source: 'b.ics', colour: undefined},
    {source: 'd.ics'},
  ]);
  assert.equal(groups[1].target, 'Other');
  assert.deepEqual({...groups[1].sources[0]}, {source: 'c.ics', colour: '9'});
});

test('default colour applies to ICS and native events, with source colour taking precedence', () => {
  const s = script({});
  s.defaultColor = 'RED';
  assert.equal(s.configuredEventColor(undefined), '11');
  assert.equal(s.configuredEventColor('9'), '9');

  const nativeEvent = {id: 'event-1', summary: 'Event', colorId: '9',
    start: {date: '2026-10-22'}, end: {date: '2026-10-23'}};
  const source = {calendar: {id: 'source-id', summary: 'Source'}};
  assert.equal(s.makeNativeEvent(nativeEvent, source).colorId, '11');
  assert.equal(s.makeNativeEvent(nativeEvent, {...source, colorId: '9'}).colorId, '9');

  const properties = {};
  const icsEvent = {updatePropertyWithValue(name, value) { properties[name] = value; },
    hasProperty(name) { return name === 'uid'; }, getFirstPropertyValue() { return 'uid-1'; }};
  s.ICAL = {parse() { return {}; }, Component: function() { return {
    getAllSubcomponents(name) { return name === 'vevent' ? [icsEvent] : []; },
    getFirstPropertyValue() { return null; },
  }; }, helpers: {updateTimezones() {}}, TimezoneService: {register() {}}};
  s.filterICSEvents = events => events;
  s.parseResponses([{kind: 'ics', content: 'calendar', colorId: undefined}]);
  assert.equal(properties.color, '11');
  s.parseResponses([{kind: 'ics', content: 'calendar', colorId: '9'}]);
  assert.equal(properties.color, '9');

  s.defaultColor = true;
  assert.equal(s.configuredEventColor(undefined), undefined);
  assert.equal(s.makeNativeEvent(nativeEvent, source).colorId, '9');
});

test('Google Calendar lookup follows pagination and parse keeps stable source IDs', () => {
  const calendar = {CalendarList: {list(options) {
    return options.pageToken ? {items: [{id: 'source-id', summary: 'Source'}]} :
      {items: [{id: 'other', summary: 'Other'}], nextPageToken: 'next'};
  }}, Events: {list() { return {items: [
    {id: 'event-1', summary: 'Keep', start: {date: '2026-10-22'}, end: {date: '2026-10-23'}},
    {id: 'event-2', summary: 'Declined', attendees: [{self: true, responseStatus: 'declined'}]},
    {id: 'event-3', status: 'cancelled'},
  ]}; }}};
  const s = script(calendar);
  s.targetCalendarId = 'target-id';
  const responses = s.fetchSourceCalendars([{source: 'Source'}]);
  const events = s.parseResponses(responses);
  assert.equal(events.length, 1);
  assert.equal(responses[0].settings.source, 'Source');
  assert.equal(events[0].nativeEvent.id, 'event-1');
  assert.deepEqual(Array.from(s.icsEventsIds), ['gcal:source-id:event-1']);
});

test('email summary reads named calendar groups', () => {
  const s = script({});
  let message;
  s.MailApp = {sendEmail(value) { message = value; }};
  s.email = 'user@example.com';
  s.addedEvents = [[['Meeting', '2026-10-22', '2026-10-23'], 'Target']];
  s.sendSummary();
  assert.match(message.htmlBody, /Target: 1 added events/);
  assert.match(message.htmlBody, /Name: Meeting/);
});

test('failed native source is marked so target cleanup can be skipped', () => {
  const s = script({CalendarList: {list() { return {items: [{id: 'source-id', summary: 'Source'}]}; }},
    Events: {list() { throw Error('unavailable'); }}});
  s.targetCalendarId = 'target-id';
  const responses = s.fetchSourceCalendars([{source: 'Source'}]);
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, true);
});

test('native event uses a stable source key and skips an unchanged target event', () => {
  let writes = 0;
  const s = script({Events: {insert() { writes++; }, update() { writes++; }}});
  s.targetCalendarId = 'target-id';
  const source = {calendar: {id: 'source-id', summary: 'Source'}};
  const nativeEvent = {id: 'event-1', summary: 'Event', start: {date: '2026-10-22'}, end: {date: '2026-10-23'}};
  const copy = s.makeNativeEvent(nativeEvent, source);
  s.calendarEventsIds = [copy.extendedProperties.private.id];
  s.calendarEvents = [{extendedProperties: {private: {MD5: copy.extendedProperties.private.MD5}}}];
  s.processNativeEvent({nativeEvent, source});
  assert.equal(writes, 0);
  assert.equal(copy.extendedProperties.private.id, 'gcal:source-id:event-1');
});

test('recurrence exception patches its original instance, never the next instance', () => {
  let patched;
  const calendar = {Events: {
    list() { return {items: [{id: 'parent', recurrence: ['RRULE:FREQ=DAILY'],
      extendedProperties: {private: {id: 'source-uid', fromGAS: 'true'}}}]}; },
    instances() { return {items: [{id: 'wrong', originalStartTime: {date: '2026-10-23'}},
      {id: 'right', originalStartTime: {date: '2026-10-22'}}]}; },
    patch(body, _calendarId, id) { patched = {body, id}; return {id}; },
  }};
  const s = script(calendar);
  s.targetCalendarId = 'target-id';
  const exception = {recurringEventId: '2026-10-22', extendedProperties: {private: {id: 'source-uid', MD5: 'new'}}};
  s.processICSEventInstance(exception);
  assert.equal(patched.id, 'right');
  assert.equal(patched.body.recurringEventId, undefined);
});

test('native cancelled recurrence exception removes only the matching instance', () => {
  let removed;
  const s = script({Events: {
    list() { return {items: [{id: 'parent', recurrence: ['RRULE:FREQ=DAILY'],
      extendedProperties: {private: {id: 'gcal:source-id:series'}}}]}; },
    instances() { return {items: [{id: 'wrong', originalStartTime: {date: '2026-10-23'}},
      {id: 'right', originalStartTime: {date: '2026-10-22'}}]}; },
    remove(_calendarId, id) { removed = id; return {}; },
  }});
  s.targetCalendarId = 'target-id';
  s.nativeExceptions = [{source: {calendar: {id: 'source-id'}}, nativeEvent: {
    id: 'cancelled', recurringEventId: 'series', originalStartTime: {date: '2026-10-22'}, status: 'cancelled',
  }}];
  s.processNativeExceptions();
  assert.equal(removed, 'right');
});

test('attendee and all-day filters apply to the selected Google Calendar source', () => {
  const s = script({});
  s.filters = [
    {source: 'source-id', parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['PERSON@example.com']},
    {parameter: 'allDay', type: 'exclude'},
  ];
  const events = [
    {id: 'attendee', start: {dateTime: '2026-10-23T10:00:00Z'}, attendees: [{email: 'person@EXAMPLE.com'}]},
    {id: 'all-day', start: {date: '2026-10-23'}},
    {id: 'keep', start: {dateTime: '2026-10-23T10:00:00Z'}},
  ];
  assert.deepEqual(Array.from(s.filterNativeEvents(events, 'source-id', 'source-id'), e => e.id), ['keep']);
  assert.deepEqual(Array.from(s.filterNativeEvents(events.slice(0, 1), 'other-id', 'other-id'), e => e.id), ['attendee']);
});

test('date filter retains a Google recurrence with future instances and drops past events', () => {
  let instanceQueries = 0;
  const s = script({Events: {instances() {
    instanceQueries++;
    return {items: [{start: {date: '2026-10-24'}, end: {date: '2026-10-25'}}]};
  }}});
  s.ICAL = {Time: {fromJSDate: function() { return {adjust() { return this; }, toString() { return '2026-10-23'; }}; }}};
  s.filters = [{parameter: 'dtend', type: 'include', comparison: '>', offset: 0}];
  const events = [
    {id: 'past', start: {date: '2026-10-20'}, end: {date: '2026-10-21'}},
    {id: 'series', recurrence: ['RRULE:FREQ=DAILY'], start: {date: '2026-10-20'}, end: {date: '2026-10-21'}},
    {id: 'future', start: {date: '2026-10-24'}, end: {date: '2026-10-25'}},
  ];
  assert.deepEqual(Array.from(s.filterNativeEvents(events, 'source-id', 'source-id'), e => e.id), ['series', 'future']);
  assert.equal(instanceQueries, 1);
});

test('future filter copies Google recurrence instances as stable individual events', () => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const date = days => new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10);
  const originalStart = date(2) + 'T09:00:00Z';
  const movedStart = date(3) + 'T11:00:00Z';
  const inserted = [];
  const updated = [];
  const s = script({Events: {
    list() { return {items: [
      {id: 'series', recurrence: ['RRULE:FREQ=DAILY'], start: {dateTime: date(-5) + 'T09:00:00Z'},
        end: {dateTime: date(-5) + 'T10:00:00Z'}},
      {id: 'override', recurringEventId: 'series', originalStartTime: {dateTime: originalStart},
        start: {dateTime: movedStart}, end: {dateTime: date(3) + 'T12:00:00Z'}},
    ]}; },
    instances() { return {items: [
      {id: 'instance', recurringEventId: 'series', originalStartTime: {dateTime: originalStart},
        start: {dateTime: movedStart}, end: {dateTime: date(3) + 'T12:00:00Z'}},
      {id: 'cancelled', recurringEventId: 'series', originalStartTime: {dateTime: date(4) + 'T09:00:00Z'}, status: 'cancelled'},
    ]}; },
    insert(body) { inserted.push(body); return Object.assign({id: 'target-instance'}, body); },
    update(body, _calendarId, id) { updated.push({body, id}); return Object.assign({id}, body); },
  }});
  s.ICAL = {Time: {fromJSDate: function() { return {adjust() { return this; }, toString() { return date(0); }}; }}};
  s.filters = [{parameter: 'dtend', type: 'include', comparison: '>', offset: 0}];
  s.targetCalendarId = 'target-id';
  const source = {kind: 'google', calendar: {id: 'source-id', summary: 'Source'}, source: 'source-id'};
  const items = s.parseResponses([source]);
  assert.equal(items.length, 1);
  assert.equal(items[0].materialized, true);
  assert.equal(items[0].sourceKey, 'gcal-instance:source-id:series:' + originalStart);
  assert.deepEqual(Array.from(s.icsEventsIds), [items[0].sourceKey]);
  s.processNativeEvent(items[0]);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].recurrence, undefined);
  assert.equal(inserted[0].extendedProperties.private.id, items[0].sourceKey);
  assert.equal(s.nativeExceptions.length, 0);
  const shifted = Object.assign({}, items[0].nativeEvent, {start: {dateTime: date(5) + 'T11:00:00Z'}});
  assert.equal(s.makeNativeEvent(shifted, source, items[0].sourceKey, true).extendedProperties.private.id,
    inserted[0].extendedProperties.private.id);
  s.calendarEventsIds = [items[0].sourceKey];
  s.calendarEvents = [Object.assign({id: 'target-instance'}, inserted[0])];
  s.processNativeEvent(Object.assign({}, items[0], {nativeEvent: shifted}));
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 'target-instance');
});

test('materialized instances inherit attendee details and failed expansion blocks cleanup', () => {
  const s = script({Events: {
    list() { return {items: [{id: 'series', recurrence: ['RRULE:FREQ=DAILY'],
      attendees: [{email: 'skip@example.com'}]}]}; },
    instances() { return {items: [{id: 'instance', recurringEventId: 'series',
      originalStartTime: {date: '2026-10-24'}, start: {date: '2026-10-24'}, end: {date: '2026-10-25'}}]}; },
  }});
  s.ICAL = {Time: {fromJSDate: function() { return {adjust() { return this; }, toString() { return '2026-10-23'; }}; }}};
  s.filters = [
    {parameter: 'dtend', type: 'include', comparison: '>', offset: 0},
    {parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['skip@example.com']},
  ];
  s.targetCalendarId = 'target-id';
  const source = {kind: 'google', calendar: {id: 'source-id', summary: 'Source'}, source: 'source-id'};
  assert.equal(s.parseResponses([source]).length, 0);

  s.Calendar.Events.instances = () => { throw Error('unavailable'); };
  const responses = [source];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.failed, true);
});

test('cleanup removes a previous copied series and occurrences outside the rolling window', () => {
  const removed = [];
  const s = script({Events: {remove(_calendarId, id) { removed.push(id); }}});
  s.targetCalendarId = 'target-id';
  s.icsEventsIds = ['gcal-instance:source-id:series:2026-10-24T09:00:00Z'];
  s.calendarEventsIds = [
    'gcal:source-id:series',
    'gcal-instance:source-id:series:2026-10-20T09:00:00Z',
    'gcal-instance:source-id:series:2026-10-24T09:00:00Z',
  ];
  s.calendarEvents = s.calendarEventsIds.map((id, i) => ({
    id: 'target-' + i, start: {dateTime: '2026-10-20T09:00:00Z'},
  }));
  s.processEventCleanup();
  assert.deepEqual(removed, ['target-0', 'target-1']);
});

test('excluding a Google recurrence override suppresses its generated instance', () => {
  const s = script({});
  s.filters = [{parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['skip@example.com']}];
  const events = [
    {id: 'series', recurrence: ['RRULE:FREQ=DAILY'], start: {dateTime: '2026-10-23T09:00:00Z'}},
    {id: 'override', recurringEventId: 'series', originalStartTime: {dateTime: '2026-10-24T09:00:00Z'},
      attendees: [{email: 'skip@example.com'}]},
  ];
  const filtered = s.filterNativeEvents(events, 'source-id', 'source-id');
  assert.deepEqual(Array.from(filtered, e => [e.id, e.status || 'confirmed']), [
    ['series', 'confirmed'], ['override', 'cancelled'],
  ]);
});

test('ICS attendee exclusion suppresses the matching recurrence exception', () => {
  const s = script({});
  s.filters = [{parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['person@example.com']}];
  const exdates = [];
  const uid = 'series-uid';
  const parent = {
    hasProperty(name) { return name === 'uid'; },
    getFirstPropertyValue() { return uid; },
    getAllProperties() { return []; },
    addPropertyWithValue(name, value) { exdates.push([name, value]); },
  };
  const exception = {
    hasProperty(name) { return name === 'recurrence-id'; },
    getFirstPropertyValue(name) { return name === 'uid' ? uid : '2026-10-23'; },
    getAllProperties(name) { return name === 'attendee' ? [{getFirstValue() { return 'MAILTO:PERSON@example.com'; }}] : []; },
  };
  assert.deepEqual(Array.from(s.filterICSEvents([parent, exception], 'feed.ics')), [parent]);
  assert.deepEqual(exdates, [['exdate', '2026-10-23']]);
});

test('bundled ICS parser applies attendee and all-day filters', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [
    {parameter: 'attendee', type: 'exclude', comparison: 'equals', criterias: ['person@example.com']},
    {parameter: 'allDay', type: 'exclude'},
  ];
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:attendee\nDTSTART:20261024T100000Z\nDTEND:20261024T110000Z\nATTENDEE:mailto:PERSON@example.com\nEND:VEVENT\nBEGIN:VEVENT\nUID:all-day\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nEND:VEVENT\nBEGIN:VEVENT\nUID:keep\nDTSTART:20261024T120000Z\nDTEND:20261024T130000Z\nEND:VEVENT\nEND:VCALENDAR`;
  const component = new s.ICAL.Component(s.ICAL.parse(feed));
  const remaining = s.filterICSEvents(component.getAllSubcomponents('vevent'), 'feed.ics');
  assert.deepEqual(Array.from(remaining, event => event.getFirstPropertyValue('uid')), ['keep']);
});

test('future-filtered ICS series copies stable individual instances with overrides and cancellations', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [{source: 'feed.ics', parameter: 'dtstart', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const stamp = (offset, hour = 10) => {
    const date = new Date(day.getTime() + offset * 86400000);
    date.setUTCHours(hour);
    return date.toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  };
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:series\nDTSTART:${stamp(-1)}\nDTEND:${stamp(-1, 11)}\nRRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Original\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:${stamp(1)}\nDTSTART:${stamp(1, 12)}\nDTEND:${stamp(1, 13)}\nSUMMARY:Moved\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:${stamp(2)}\nDTSTART:${stamp(2)}\nDTEND:${stamp(2, 11)}\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR`;
  const parsed = s.parseResponses([{source: 'feed.ics', content: feed}]);
  assert.equal(parsed.length, 3);
  assert.ok(parsed.every(event => !event.hasProperty('rrule') && !event.hasProperty('recurrence-id')));
  assert.deepEqual(Array.from(parsed, event => event.getFirstPropertyValue('summary')).sort(), ['Moved', 'Original', 'Original']);
  assert.equal(parsed.find(event => event.getFirstPropertyValue('summary') === 'Moved').getFirstPropertyValue('dtstart').hour, 12);
  assert.match(parsed.find(event => event.getFirstPropertyValue('summary') === 'Moved').toString(), /DTSTART:.*Z/);
  assert.ok(s.icsEventsIds.every(id => id.startsWith('ics-instance:')));
  assert.equal(new Set(s.icsEventsIds).size, 3);
  const again = s.parseResponses([{source: 'feed.ics', content: feed}]);
  assert.deepEqual(Array.from(again, event => event.getFirstPropertyValue('uid')), Array.from(parsed, event => event.getFirstPropertyValue('uid')));
});

test('ICS override moved into the window from a later original date keeps its original identity', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.recurringInstanceWindowDays = 3;
  s.filters = [{parameter: 'dtstart', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  const stamp = offset => new Date(day.getTime() + offset * 86400000 + 10 * 3600000)
    .toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:series\nDTSTART:${stamp(1)}\nDTEND:${stamp(1).replace('T100000Z', 'T110000Z')}\nRRULE:FREQ=DAILY;COUNT=10\nEND:VEVENT\nBEGIN:VEVENT\nUID:series\nRECURRENCE-ID:${stamp(6)}\nDTSTART:${stamp(2)}\nDTEND:${stamp(2).replace('T100000Z', 'T110000Z')}\nSUMMARY:Moved in\nEND:VEVENT\nEND:VCALENDAR`;
  const events = s.parseResponses([{source: 'feed.ics', content: feed}]);
  const moved = events.find(event => event.getFirstPropertyValue('summary') === 'Moved in');
  assert.ok(moved);
  assert.ok(moved.getFirstPropertyValue('uid').endsWith(':' + new Date(day.getTime() + 6 * 86400000 + 10 * 3600000).toISOString().replace('.000Z', 'Z')));
});

test('materialized ICS events retain all-day dates and named timezones', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [{parameter: 'dtstart', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 1);
  const date = day.toISOString().slice(0, 10).replace(/-/g, '');
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:all-day\nDTSTART;VALUE=DATE:${date}\nDTEND;VALUE=DATE:${date}\nRRULE:FREQ=DAILY;COUNT=2\nEND:VEVENT\nBEGIN:VEVENT\nUID:zoned\nDTSTART;TZID=Europe/Paris:${date}T100000\nDTEND;TZID=Europe/Paris:${date}T110000\nRRULE:FREQ=DAILY;COUNT=2\nEND:VEVENT\nEND:VCALENDAR`;
  const events = s.parseResponses([{source: 'feed.ics', content: feed}]);
  assert.equal(events.length, 4);
  assert.ok(events.filter(event => event.getFirstPropertyValue('uid').includes('all-day'))
    .every(event => event.getFirstProperty('dtstart').getFirstValue().isDate));
  assert.ok(events.filter(event => event.getFirstPropertyValue('uid').includes('zoned'))
    .every(event => event.getFirstProperty('dtstart').getParameter('tzid') === 'Europe/Paris'));
});

test('an ICS override never changes a different series at the same recurrence time', () => {
  const s = script({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ical.js.gs'), 'utf8'), s, {filename: 'ical.js.gs'});
  s.filters = [{parameter: 'dtend', type: 'include', comparison: '>', offset: 0}];
  const day = new Date();
  day.setUTCHours(10, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + 1);
  const stamp = (offset, hour) => {
    const value = new Date(day.getTime() + offset * 86400000);
    value.setUTCHours(hour);
    return value.toISOString().replace(/[-:]/g, '').replace(/\.000Z$/, 'Z');
  };
  const feed = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:first\nDTSTART:${stamp(0, 10)}\nDTEND:${stamp(0, 11)}\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:First\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nDTSTART:${stamp(0, 10)}\nDTEND:${stamp(0, 11)}\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:Second\nEND:VEVENT\nBEGIN:VEVENT\nUID:second\nRECURRENCE-ID:${stamp(1, 10)}\nDTSTART:${stamp(1, 12)}\nDTEND:${stamp(1, 13)}\nSUMMARY:Moved second\nEND:VEVENT\nEND:VCALENDAR`;
  const events = s.parseResponses([{source: 'feed.ics', content: feed}]);
  const first = events.filter(event => event.getFirstPropertyValue('uid').includes(':first:'));
  const second = events.filter(event => event.getFirstPropertyValue('uid').includes(':second:'));
  assert.deepEqual(Array.from(first, event => event.getFirstPropertyValue('summary')), ['First', 'First']);
  assert.deepEqual(Array.from(second, event => event.getFirstPropertyValue('summary')), ['Second', 'Moved second']);
});

test('clearGASEvents previews by default and deletes only script-created events when explicit', () => {
  const removed = [];
  const s = script({
    CalendarList: {list() { return {items: [{id: 'target-id', summary: 'targetCalendar1', accessRole: 'owner'}]}; }},
    Events: {
      list() { return {items: [
        {id: 'parent', recurrence: ['RRULE:FREQ=DAILY'], extendedProperties: {private: {fromGAS: 'true'}}},
        {id: 'owned', extendedProperties: {private: {fromGAS: 'true'}}},
        {id: 'other', extendedProperties: {private: {fromGAS: 'false'}}},
      ]}; },
      remove(_calendar, id) { removed.push(id); },
    },
  });
  assert.equal(s.clearGASEvents('targetCalendar1').count, 2);
  assert.deepEqual(removed, []);
  assert.equal(s.clearGASEvents('targetCalendar1', false).dryRun, false);
  assert.deepEqual(removed, ['owned', 'parent']);
  assert.throws(() => s.clearGASEvents('unconfigured', false));
});
