const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function app(calendar = {}) {
  const context = vm.createContext({
    Calendar: {newEvent() { return {}; }, newEventSource() { return {}; },
      newEventOrganizer() { return {}; }, ...calendar},
    Logger: {log() {}},
    Utilities: {Charset: {UTF_8: 'UTF_8'}, DigestAlgorithm: {MD5: 'MD5'},
      computeDigest(_algorithm, value) { return Array.from(Buffer.from(value)); }},
    CalendarApp: {EventColor: {}},
  });
  for (const file of ['Config.gs', 'Code.gs', 'Filters.gs', 'Helpers.gs', 'tzid.gs', 'ical.js.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename: file});
  }
  context.callWithBackoff = fn => fn();
  return context;
}

function parse(s, name, settings = {}) {
  return s.parseResponses([{kind: 'ics', source: name, settings, content: fixture(name)}]);
}

test('upstream ICS examples parse timed and all-day events, recurrence, and cancellations', () => {
  const s = app();
  const events = parse(s, 'upstream-events.ics');
  assert.equal(events.length, 4);
  assert.deepEqual(Array.from(events, event => event.getFirstPropertyValue('uid')),
    ['timed-metadata', 'all-day-zero-length', 'recurring-with-exceptions', 'recurring-with-exceptions']);
  assert.equal(events.some(event => event.getFirstPropertyValue('status') === 'CANCELLED'), false);
  assert.equal(events[0].getFirstPropertyValue('parentCal'), 'Example source');
  assert.deepEqual(Array.from(s.icsEventsIds), ['timed-metadata', 'all-day-zero-length',
    'recurring-with-exceptions', 'recurring-with-exceptions_2026-10-28T09:00:00Z']);
  const recurrence = s.parseICSRecurrenceRule(events[2], 0);
  assert.ok(recurrence.includes('RRULE:FREQ=DAILY;COUNT=4'));
  assert.ok(recurrence.includes('EXDATE:20261027T090000Z'));
  assert.ok(recurrence.includes('RDATE:20261031T090000Z'));
  assert.equal(events[3].getFirstPropertyValue('recurrence-id').toString(), '2026-10-28T09:00:00Z');
});

test('upstream event metadata, attendees, reminders, and all-day end convert to Calendar events', () => {
  const s = app();
  const events = parse(s, 'upstream-events.ics', {addAttendees: true});
  const timed = s.createICSEvent(events[0], 'Etc/GMT');
  assert.equal(timed.summary, 'Planning');
  assert.equal(timed.description, 'Discuss the plan');
  assert.equal(timed.location, 'Room 2');
  assert.equal(timed.status, 'tentative');
  assert.equal(timed.visibility, 'private');
  assert.equal(timed.transparency, 'transparent');
  assert.equal(timed.source.url, 'https://example.test/meeting');
  assert.equal(timed.organizer.displayName, 'Alex');
  assert.equal(timed.attendees[0].email, 'sam@example.test');
  assert.equal(timed.attendees[0].displayName, 'Sam');
  assert.equal(timed.attendees[0].responseStatus, 'accepted');
  assert.equal(timed.reminders.overrides[0].minutes, 15);
  assert.equal(timed.extendedProperties.private.id, 'timed-metadata');

  const allDay = s.createICSEvent(events[1], 'Etc/GMT');
  assert.equal(allDay.start.date, '2026-10-25');
  assert.equal(allDay.end.date, '2026-10-26');
  assert.deepEqual(Array.from(allDay.reminders.overrides), []);

  const moved = s.createICSEvent(events[3], 'Etc/GMT');
  assert.equal(moved.recurringEventId, '2026-10-28T09:00:00Z');
  assert.equal(moved.summary, 'Moved standup');
});

test('upstream optional UID, named timezone, duration, colour, and EXRULE examples', () => {
  const s = app();
  s.CalendarApp.EventColor.RED = '11';
  const events = parse(s, 'upstream-edge-cases.ics');
  assert.equal(events.length, 3);
  const appointment = s.createICSEvent(events[0], 'Etc/GMT');
  assert.equal(appointment.start.timeZone, 'Europe/Paris');
  assert.equal(appointment.end.timeZone, 'Europe/Paris');
  assert.equal(new Date(appointment.end.dateTime) - new Date(appointment.start.dateTime), 45 * 60000);
  assert.equal(appointment.colorId, '11');
  assert.ok(events[1].getFirstPropertyValue('uid'));
  assert.equal(s.createICSEvent(events[1], 'Etc/GMT').summary, 'Event without UID');
  const recurrence = s.parseICSRecurrenceRule(events[2], 0);
  assert.ok(recurrence.includes('RRULE:FREQ=DAILY;COUNT=7'));
  assert.ok(recurrence.includes('EXRULE:FREQ=DAILY;COUNT=7;BYDAY=SA,SU'));
});

test('upstream VTODO examples coexist with events and sync both due date forms', () => {
  const inserted = [];
  const removed = [];
  const s = app();
  s.Tasks = {
    newTask() { return {}; },
    Tasklists: {list() { return {items: [{id: 'list', title: 'Tasks'}]}; }},
    Tasks: {
      list() { return {items: [{id: 'old-task'}]}; },
      insert(task, listId) { inserted.push({task, listId}); return {...task, id: 'created-' + inserted.length}; },
      remove(listId, id) { removed.push({listId, id}); },
    },
  };
  const source = {kind: 'ics', source: 'upstream-tasks.ics', settings: {},
    content: fixture('upstream-tasks.ics')};
  const events = s.parseResponses([source]);
  assert.equal(events.length, 1);
  assert.equal(events[0].getFirstPropertyValue('summary'), 'Meeting alongside tasks');
  s.processICSTasks([source]);
  assert.deepEqual(inserted.map(({task}) => [task.title, task.due]), [
    ['Submit report', '2026-11-02T00:00:00Z'],
    ['Call supplier', '2026-11-03T14:30:00Z'],
  ]);
  assert.deepEqual(removed, []);
  assert.ok(inserted.every(({task}) => /\[GAS-ICS-Sync:[0-9a-f]+:[0-9a-f]+\]/.test(task.notes)));
});

test('a task-only ICS feed syncs tasks without clearing calendar events', () => {
  const inserted = [];
  let cleanupCalls = 0;
  const s = app({
    Events: {list() { return {items: []}; }},
    Settings: {get() { return {value: 'Etc/GMT'}; }},
  });
  s.Tasks = {
    newTask() { return {}; },
    Tasklists: {list() { return {items: [{id: 'list', title: 'Tasks'}]}; }},
    Tasks: {list() { return {items: []}; }, insert(task) { inserted.push(task); return {...task, id: 'created'}; }, remove() {}},
  };
  s.LockService = {getScriptLock() { return {tryLock() { return true; }, releaseLock() {}}; }};
  s.addTasks = true;
  s.sourceCalendars = [{source: 'upstream-tasks-only.ics', target: 'Target'}];
  s.fetchSourceCalendars = () => [{kind: 'ics', source: 'upstream-tasks-only.ics', settings: {},
    content: fixture('upstream-tasks-only.ics')}];
  s.setupTargetCalendar = () => ({id: 'target'});
  s.processEventCleanup = () => { cleanupCalls++; };
  s.startSync();
  assert.deepEqual(inserted.map(task => [task.title, task.due]),
    [['Renew certificate', '2026-11-04T00:00:00Z']]);
  assert.equal(cleanupCalls, 0);
});

test('native Google Tasks sync updates by source identity and removes only owned tasks', () => {
  const s = app();
  s.addTasks = true;
  const sourceTasks = [
    {id: 'a', title: 'Native task A', notes: 'Details', due: '2026-11-05T00:00:00.000Z', status: 'needsAction'},
    {id: 'b', title: 'Native task B', status: 'completed'},
  ];
  const targetTasks = [{id: 'personal', title: 'Personal task', notes: 'Keep me', status: 'needsAction'}];
  const inserted = [];
  const patched = [];
  const removed = [];
  s.Tasks = {
    Tasklists: {list() { return {items: [{id: 'source-list', title: 'Source Tasks'},
      {id: 'target-list', title: 'Target Tasks'}]}; }},
    Tasks: {
      list(id, options) {
        assert.equal(options.maxResults, 100);
        if (id === 'source-list') return options.pageToken ? {items: sourceTasks.slice(1)} :
          {items: [sourceTasks[0]], nextPageToken: 'second'};
        return {items: targetTasks.map(task => ({...task}))};
      },
      insert(task, id) {
        assert.equal(id, 'target-list');
        const created = {...task, id: 'copy-' + (inserted.length + 1)};
        targetTasks.push(created);
        inserted.push(created);
        return created;
      },
      patch(task, id, taskId) {
        assert.equal(id, 'target-list');
        patched.push({task, taskId});
        Object.assign(targetTasks.find(item => item.id === taskId), task);
      },
      remove(id, taskId) {
        assert.equal(id, 'target-list');
        removed.push(taskId);
        targetTasks.splice(targetTasks.findIndex(task => task.id === taskId), 1);
      },
    },
  };
  const response = {kind: 'google', source: 'source-calendar',
    settings: {sourceTaskList: 'Source Tasks', targetTaskList: 'Target Tasks'}};
  s.processSourceTasks([response]);
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].title, 'Native task A');
  assert.equal(inserted[0].notes.startsWith('Details\n\n[GAS-ICS-Sync:'), true);
  assert.equal(inserted[0].due, '2026-11-05T00:00:00.000Z');
  assert.equal(inserted[1].status, 'completed');
  s.processSourceTasks([response]);
  assert.equal(inserted.length, 2);
  assert.equal(patched.length, 0);

  sourceTasks[0].title = 'Native task A revised';
  sourceTasks.splice(1);
  s.processSourceTasks([response]);
  assert.deepEqual(patched.map(({taskId}) => taskId), ['copy-1']);
  assert.deepEqual(removed, ['copy-2']);
  assert.ok(targetTasks.some(task => task.id === 'personal'));
});

test('native task-only sources skip event cleanup and reject self-copy', () => {
  const s = app({Events: {list() { return {items: []}; }}});
  s.addTasks = true;
  const responses = [{kind: 'google', source: 'source-calendar', calendar: {id: 'source-calendar'},
    settings: {sourceTaskList: 'Source Tasks', targetTaskList: 'Source Tasks'}}];
  assert.equal(s.parseResponses(responses).length, 0);
  assert.equal(responses.tasksOnly, true);
  assert.equal(responses.failed, undefined);
  s.Tasks = {Tasklists: {list() { return {items: [{id: 'same', title: 'Source Tasks'}]}; }},
    Tasks: {list() { return {items: [{id: 'a', title: 'Task'}]}; }}};
  assert.throws(() => s.processSourceTasks(responses), /must differ/);
});
