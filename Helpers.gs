/**
 * Formats the date and time according to the format specified in the configuration.
 *
 * @param {string} date The date to be formatted.
 * @return {string} The formatted date string.
 */
function formatDate(date) {
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const day = date.slice(8, 10);
  let formattedDate;

  if (dateFormat == "YYYY/MM/DD") {
    formattedDate = year + "/" + month + "/" + day
  }
  else if (dateFormat == "DD/MM/YYYY") {
    formattedDate = day + "/" + month + "/" + year
  }
  else if (dateFormat == "MM/DD/YYYY") {
    formattedDate = month + "/" + day + "/" + year
  }
  else if (dateFormat == "YYYY-MM-DD") {
    formattedDate = year + "-" + month + "-" + day
  }
  else if (dateFormat == "DD-MM-YYYY") {
    formattedDate = day + "-" + month + "-" + year
  }
  else if (dateFormat == "MM-DD-YYYY") {
    formattedDate = month + "-" + day + "-" + year
  }
  else if (dateFormat == "YYYY.MM.DD") {
    formattedDate = year + "." + month + "." + day
  }
  else if (dateFormat == "DD.MM.YYYY") {
    formattedDate = day + "." + month + "." + year
  }
  else if (dateFormat == "MM.DD.YYYY") {
    formattedDate = month + "." + day + "." + year
  }

  if (date.length < 11) {
    return formattedDate
  }

  const time = date.slice(11, 16)
  const timeZone = date.slice(19)

  return formattedDate + " at " + time + " (UTC" + (timeZone == "Z" ? "" : timeZone) + ")"
}


/**
 * Takes an intended frequency in minutes and adjusts it to be the closest
 * acceptable value to use Google "everyMinutes" trigger setting (i.e. one of
 * the following values: 1, 5, 10, 15, 30).
 *
 * @param {?integer} The manually set frequency that the user intends to set.
 * @return {integer} The closest valid value to the intended frequency setting. Defaulting to 15 if no valid input is provided.
 */
function getValidTriggerFrequency(origFrequency) {
  if (!origFrequency > 0) {
    Logger.log("No valid frequency specified. Defaulting to 15 minutes.");
    return 15;
  }

  // Limit the original frequency to 1440
  origFrequency = Math.min(origFrequency, 1440);

  var acceptableValues = [5, 10, 15, 30].concat(
    Array.from({ length: 24 }, (_, i) => (i + 1) * 60)
  ); // [5, 10, 15, 30, 60, 120, ..., 1440]

  // Find the smallest acceptable value greater than or equal to the original frequency
  var roundedUpValue = acceptableValues.find(value => value >= origFrequency);

  Logger.log(
    "Intended frequency = " + origFrequency + ", Adjusted frequency = " + roundedUpValue
  );
  return roundedUpValue;
}

String.prototype.includes = function (phrase) {
  return this.indexOf(phrase) > -1;
}

/**
 * Takes an array of ICS calendars and target Google calendars and combines them
 *
 * @param {Array} calendarMap - Entries with source, target and optional settings,
 *   or legacy [source, target, colour] entries
 * @return {Array} Groups of {target, sources}, with each source's settings retained
 */
function condenseCalendarMap(calendarMap) {
  var result = [];
  for (var mapping of calendarMap) {
    var target = Array.isArray(mapping) ? mapping[1] : mapping.target;
    var source = Array.isArray(mapping) ? { source: mapping[0], colour: mapping[2] } : Object.assign({}, mapping);
    delete source.target;
    delete source.targetId;
    delete source.createTargetCalendarIfMissing;
    var index = -1;
    for (var i = 0; i < result.length; i++) {
      if (result[i].target == target) {
        index = i;
        break;
      }
    }

    if (index > -1)
      result[index].sources.push(source);
    else
      result.push({
        target: target, targetId: mapping.targetId,
        createTargetCalendarIfMissing: mapping.createTargetCalendarIfMissing, sources: [source]
      });
    if (index > -1 && mapping.targetId && result[index].targetId && mapping.targetId !== result[index].targetId)
      throw new Error("Conflicting target IDs for " + target);
    if (index > -1 && mapping.targetId) result[index].targetId = mapping.targetId;
    if (index > -1 && mapping.createTargetCalendarIfMissing !== undefined) {
      var existingChoice = result[index].createTargetCalendarIfMissing;
      if (existingChoice !== undefined && existingChoice !== mapping.createTargetCalendarIfMissing)
        throw new Error("Conflicting target creation settings for " + target);
      result[index].createTargetCalendarIfMissing = mapping.createTargetCalendarIfMissing;
    }
  }

  return result;
}

/** Use an explicitly configured source value, including false, before the global default. */
function sourceSetting(settings, name, fallback) {
  return settings && settings[name] !== undefined ? settings[name] : fallback;
}

function formattedTitle(summary, isAllDay, settings) {
  var prefix = sourceSetting(settings, "titlePrefix", titlePrefix);
  return prefix && (!sourceSetting(settings, "titlePrefixAllDayOnly", titlePrefixAllDayOnly) || isAllDay) ?
    prefix + (summary || "") : summary;
}

function decodeSafeLinks(text) {
  return text.replace(/https:\/\/[a-z0-9.-]+\.safelinks\.protection\.outlook\.com\/\?[^\s<>"']+/gi, function (link) {
    try {
      var parameter = /[?&]url=([^&]+)/i.exec(link);
      if (!parameter) return link;
      var decoded = decodeURIComponent(parameter[1]);
      return /^https?:\/\//i.test(decoded) ? decoded : link;
    } catch (e) { return link; }
  });
}

function icsDescription(event, fallback) {
  var property = event.getFirstProperty("description");
  if (!property) return undefined;
  var description = fallback;
  var altrep = property.getParameter("altrep");
  if (altrep && /^data:text\/html(?:;[^,]*)?,/i.test(altrep)) {
    try {
      var data = altrep.slice(altrep.indexOf(",") + 1);
      description = /;base64,/i.test(altrep) ?
        Utilities.newBlob(Utilities.base64Decode(data)).getDataAsString("UTF-8") : decodeURIComponent(data);
    } catch (e) { description = fallback; }
  }
  return description && description.trim() ? description : undefined;
}

/** An omitted window includes all history; recurring parents must be handled separately. */
function pastWindowCutoff(settings) {
  var days = sourceSetting(settings, "pastEventWindowDays", pastEventWindowDays);
  if (days == null) return null;
  if (!Number.isInteger(days) || days < 0) throw new Error("pastEventWindowDays must be a non-negative integer or null");
  return new Date(Date.now() - days * 86400000);
}

function endsBeforePastWindow(end, settings) {
  var cutoff = pastWindowCutoff(settings);
  if (!cutoff || !end) return false;
  var endDate = end instanceof Date ? end : new Date(end);
  return !isNaN(endDate.getTime()) && endDate < cutoff;
}

/** Keep private source URLs out of Calendar event metadata. */
function sourceAddressHash(source) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(source), Utilities.Charset.UTF_8)
    .map(function (byte) { return (byte & 255).toString(16).padStart(2, "0"); }).join("");
}

/** A shared event ID cannot safely identify one source when feeds reuse a UID. */
function registerSourceEvent(id, source) {
  if (!source) return;
  var hash = sourceAddressHash(source);
  if (!Object.prototype.hasOwnProperty.call(icsEventSourceHashes, id))
    icsEventSourceHashes[id] = [];
  if (icsEventSourceHashes[id].indexOf(hash) === -1)
    icsEventSourceHashes[id].push(hash);
}

/** A source colour takes precedence over its default colour. */
function configuredEventColor(sourceColor, settings) {
  var fallback = sourceSetting(settings, "defaultColor", defaultColor);
  var selected = sourceColor !== undefined ? sourceColor : (fallback === true ? undefined : fallback);
  if (selected === undefined) return undefined;
  var color = String(selected);
  if (Object.prototype.hasOwnProperty.call(CalendarApp.EventColor, color)) return CalendarApp.EventColor[color];
  if (Object.values(CalendarApp.EventColor).includes(color)) return color;
  Logger.log("Ignoring unsupported event colour: " + color);
  return undefined;
}

/**
 * Removes all triggers for the script's 'startSync' and 'install' function.
 */
function deleteAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (["startSync", "install", "main", "checkForUpdate", "AutoUpdate"].includes(triggers[i].getHandlerFunction())) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

/**
 * Gets the ressource from the specified URLs.
 *
 * @param {Array} sourceCalendarURLs - Source entries with optional settings
 * @return {Array} The resources fetched from the specified sources
 */
function fetchSourceCalendars(sourceCalendarURLs) {
  var result = [];
  for (var source of sourceCalendarURLs) {
    var url = source.source.replace(/^webcal:\/\//, "https://");
    // iCal URLs can contain a private access token. Keep it out of logs and errors.
    var sourceLabel = /^https?:\/\//i.test(url) ?
      url.replace(/^(https?:\/\/[^/]+).*$/, "$1/[redacted]") : url;
    var colorId = source.colour;

    try {
      if (!/^https?:\/\//i.test(url)) {
        var sourceCalendar = findSourceGoogleCalendar(url);
        if (!sourceCalendar) throw new Error("Google Calendar source not found: " + url);
        result.push({ kind: "google", calendar: sourceCalendar, colorId: colorId, source: source.source, settings: source });
        continue;
      }
      var fetched = false;
      callWithBackoff(function () {
        var urlResponse;
        try {
          urlResponse = UrlFetchApp.fetch(url, { 'muteHttpExceptions': true });
        } catch (fetchError) {
          throw new Error(String(fetchError).split(url).join(sourceLabel));
        }
        if (urlResponse.getResponseCode() == 200) {
          var icsContent = urlResponse.getContentText("UTF-8");
          const icsRegex = RegExp("(BEGIN:VCALENDAR.*?END:VCALENDAR)", "s")
          var urlContent = icsRegex.exec(icsContent);
          if (urlContent == null) {
            // Microsoft Outlook has a bug that sometimes results in incorrectly formatted ics files. This tries to fix that problem.
            // Add END:VEVENT for every BEGIN:VEVENT that's missing it
            const veventRegex = /BEGIN:VEVENT(?:(?!END:VEVENT).)*?(?=.BEGIN|.END:VCALENDAR|$)/sg;
            icsContent = icsContent.replace(veventRegex, (match) => match + "\nEND:VEVENT");

            // Add END:VCALENDAR if missing
            if (!icsContent.endsWith("END:VCALENDAR")) {
              icsContent += "\nEND:VCALENDAR";
            }
            urlContent = icsRegex.exec(icsContent)
            if (urlContent == null) {
              Logger.log("[ERROR] Incorrect ics/ical URL: " + sourceLabel)
              reportOverallFailure = true;
              throw new Error("Invalid ICS source: " + sourceLabel);
            }
            Logger.log("[WARNING] Microsoft is incorrectly formatting ics/ical at: " + sourceLabel)
          }
          result.push({ kind: "ics", content: urlContent[0], colorId: colorId, source: source.source, settings: source });
          fetched = true;
          return;
        }
        else { //Throw here to make callWithBackoff run again
          throw "Error: Encountered HTTP error " + urlResponse.getResponseCode() + " when accessing " + sourceLabel;
        }
      }, defaultMaxRetries);
      if (!fetched) throw new Error("Could not fetch ICS source: " + sourceLabel);
    }
    catch (e) {
      Logger.log("Could not fetch source " + sourceLabel + ": " + String(e).split(url).join(sourceLabel));
      reportOverallFailure = true;
      result.failed = true;
    }
  }

  return result;
}

function findSourceGoogleCalendar(nameOrId) {
  var pageToken;
  do {
    var options = { maxResults: 250, showHidden: true };
    if (pageToken) options.pageToken = pageToken;
    var page = callWithBackoff(function () { return Calendar.CalendarList.list(options); }, defaultMaxRetries);
    if (!page) throw new Error("Could not list Google Calendars");
    var match = (page.items || []).filter(function (calendar) {
      return calendar.id === nameOrId || calendar.summary === nameOrId || calendar.summaryOverride === nameOrId;
    })[0];
    if (match) return match;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return null;
}

/**
 * Gets the user's Google Calendar with the specified name.
 * A new Calendar is created only when explicitly requested by its mapping.
 *
 * @param {string} targetCalendarName - The name of the calendar to return
 * @return {Calendar} The calendar retrieved or created
 */
function setupTargetCalendar(targetCalendarName, explicitId, createIfMissing) {
  var nameMatches = [];
  var idMatch;
  var pageToken;
  do {
    var options = { showHidden: true, maxResults: 250 };
    if (pageToken) options.pageToken = pageToken;
    var page = callWithBackoff(function () { return Calendar.CalendarList.list(options); }, defaultMaxRetries);
    if (!page) throw new Error("Could not list target calendars");
    var items = page.items || [];
    idMatch = items.filter(function (cal) { return cal.id === (explicitId || targetCalendarName); })[0];
    if (idMatch) {
      if (idMatch.accessRole !== "owner" && idMatch.accessRole !== "writer")
        throw new Error("Target calendar is not writable: " + (explicitId || targetCalendarName));
      return idMatch;
    }
    if (!explicitId) nameMatches = nameMatches.concat(items.filter(function (cal) {
      return cal.summaryOverride === targetCalendarName || cal.summary === targetCalendarName;
    }));
    pageToken = page.nextPageToken;
  } while (pageToken);

  if (explicitId) throw new Error("Target calendar ID not found: " + explicitId);
  if (nameMatches.length > 1)
    throw new Error("Multiple target calendars named " + targetCalendarName + "; set targetId in Config.gs");
  if (nameMatches.length === 1) {
    if (nameMatches[0].accessRole !== "owner" && nameMatches[0].accessRole !== "writer")
      throw new Error("Target calendar is not writable: " + targetCalendarName);
    return nameMatches[0];
  }
  if (/@|^[a-f0-9]{32,}$/.test(targetCalendarName))
    throw new Error("Target calendar ID not found or not writable: " + targetCalendarName);
  if (createIfMissing !== true)
    throw new Error("Target calendar not found: " + targetCalendarName +
      ". Check its name or set targetId; set createTargetCalendarIfMissing: true to create it deliberately.");

  Logger.log("Creating Calendar: " + targetCalendarName);
  var targetCalendar = Calendar.newCalendar();
  targetCalendar.summary = targetCalendarName;
  targetCalendar.description = "Created by GAS";
  targetCalendar.timeZone = Calendar.Settings.get("timezone").value;
  return Calendar.Calendars.insert(targetCalendar);
}

/**
 * Parses all sources using ical.js.
 * Registers all found timezones with TimezoneService.
 * Creates an Array with all events and adds the event-ids to the provided Array.
 *
 * @param {Array.string} responses - Array with all ical sources
 * @return {Array.ICALComponent} Array with all events found
 */
function parseResponses(responses) {
  var result = [];
  var nativeResults = [];
  for (var itm of responses) {
    if (itm.kind === "google") {
      try {
        if (itm.calendar.id === targetCalendarId) throw new Error("Source and target are the same Google Calendar");
        var nativeEvents = listSourceGoogleEvents(itm.calendar.id);
        if (!nativeEvents.some(function (event) { return event.status !== "cancelled"; }) &&
          sourceSetting(itm.settings, "skipIfEmptyFeed", skipIfEmptyFeed)) {
          Logger.log("Skipping cleanup because a Google Calendar source returned no active events");
          reportOverallFailure = true;
          responses.failed = true;
          continue;
        }
        var sourceName = itm.source || itm.calendar.id;
        var futureFilters = futureDateFilters(sourceName, itm.calendar.id);
        var windowed = futureFilters.length > 0;
        var occurrenceItems = windowed ? materializeNativeSeries(nativeEvents, itm, futureFilters) : [];
        if (windowed) {
          nativeEvents = nativeEvents.filter(function (event) {
            return !event.recurrence && !event.recurringEventId;
          });
        }
        nativeEvents = filterNativeEvents(nativeEvents, sourceName, itm.calendar.id);
        nativeEvents = nativeEvents.filter(function (event) {
          return event.recurrence || event.recurringEventId ||
            !endsBeforePastWindow(event.end && (event.end.dateTime || event.end.date), itm.settings);
        });
        occurrenceItems = occurrenceItems.filter(function (item) {
          var end = item.nativeEvent.end;
          return !endsBeforePastWindow(end && (end.dateTime || end.date), itm.settings);
        });
        nativeEvents.forEach(function (event) {
          if ((event.attendees || []).some(function (attendee) { return attendee.self && attendee.responseStatus === "declined"; })) return;
          if (event.recurringEventId && event.originalStartTime) {
            nativeResults.push({ nativeEvent: event, source: itm });
          } else if (event.status !== "cancelled") {
            nativeResults.push({ nativeEvent: event, source: itm });
            var eventKey = nativeEventKey(itm.calendar.id, event.id);
            icsEventsIds.push(eventKey);
            registerSourceEvent(eventKey, itm.source || itm.calendar.id);
          }
        });
        occurrenceItems.forEach(function (item) {
          nativeResults.push(item);
          icsEventsIds.push(item.sourceKey);
          registerSourceEvent(item.sourceKey, itm.source || itm.calendar.id);
        });
      } catch (e) {
        Logger.log("Could not read Google Calendar " + itm.calendar.id + ": " + e);
        reportOverallFailure = true;
        responses.failed = true;
      }
      continue;
    }
    var resp = itm.content;
    var colorId = itm.colorId;
    var jcalData = ICAL.parse(resp);
    var component = new ICAL.Component(jcalData);

    ICAL.helpers.updateTimezones(component);
    var vtimezones = component.getAllSubcomponents("vtimezone");
    for (var tz of vtimezones) {
      ICAL.TimezoneService.register(tz);
    }

    var allEvents = component.getAllSubcomponents("vevent");
    // VFREEBUSY is useful only when the provider supplies no VEVENTs.
    if (!allEvents.length) {
      var seenBusyIntervals = Object.create(null);
      component.getAllSubcomponents("vfreebusy").forEach(function (freebusy) {
        freebusy.getAllProperties("freebusy").forEach(function (property) {
          if (String(property.getParameter("fbtype") || "BUSY").toUpperCase() === "FREE") return;
          property.getValues().forEach(function (period) {
            var start = period.start;
            var end = period.end || (period.duration && start.clone().addDuration(period.duration));
            if (!start || !end) return;
            var uid = "freebusy-" + sourceAddressHash(itm.source + "|" + start.toString() + "|" + end.toString());
            if (seenBusyIntervals[uid]) return;
            seenBusyIntervals[uid] = true;
            var event = new ICAL.Component("vevent");
            event.addPropertyWithValue("uid", uid);
            event.addPropertyWithValue("dtstart", start);
            event.addPropertyWithValue("dtend", end);
            event.addPropertyWithValue("summary", "Busy");
            event.addPropertyWithValue("transp", "OPAQUE");
            allEvents.push(event);
          });
        });
      });
    }
    if (!allEvents.some(function (event) {
      return String(event.getFirstPropertyValue("status") || "").toLowerCase() !== "cancelled";
    }) && sourceSetting(itm.settings, "skipIfEmptyFeed", skipIfEmptyFeed)) {
      Logger.log("Skipping cleanup because an ICS source returned no active events");
      reportOverallFailure = true;
      responses.failed = true;
      continue;
    }
    var configuredColor = configuredEventColor(colorId, itm.settings);
    if (configuredColor !== undefined)
      allEvents.forEach(function (event) { event.updatePropertyWithValue("color", configuredColor); });

    var calName = component.getFirstPropertyValue("x-wr-calname") || component.getFirstPropertyValue("name");
    if (calName != null)
      allEvents.forEach(function (event) { event.addPropertyWithValue("parentCal", calName); });

    var futureFilters = futureDateFilters(itm.source);
    var icsEvents = futureFilters.length ? materializeICSSeries(allEvents, itm.source, futureFilters, itm.settings) : allEvents;
    var filteredEvents = filterICSEvents(icsEvents, itm.source);
    filteredEvents = filteredEvents.filter(function (event) {
      return event.hasProperty("rrule") || event.hasProperty("rdate") ||
        pastWindowCutoff(itm.settings) === null ||
        !endsBeforePastWindow(new ICAL.Event(event).endDate.toJSDate(), itm.settings);
    });
    filteredEvents.forEach(function (event) {
      event._sourceSettings = itm.settings;
      event._sourceAddress = itm.source;
    });
    result = [].concat(filteredEvents, result);
  }

  //No need to process cancelled events as they will be added to gcal's trash anyway
  result = result.filter(function (event) {
    try {
      return (event.getFirstPropertyValue('status').toString().toLowerCase() != "cancelled");
    } catch (e) {
      return true;
    }
  });

  result.forEach(function (event) {
    if (!event.hasProperty('uid')) {
      event.updatePropertyWithValue('uid', Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, event.toString()).toString(), Utilities.Charset.UTF_8);
    }
    if (event.hasProperty('recurrence-id')) {
      let recID = new ICAL.Time.fromString(event.getFirstPropertyValue('recurrence-id').toString(), event.getFirstProperty('recurrence-id'));
      if (event.getFirstProperty('recurrence-id').getParameter('tzid')) {
        let recUTCOffset = 0;
        let tz = event.getFirstProperty('recurrence-id').getParameter('tzid').toString();
        if (tz in tzidreplace) {
          tz = tzidreplace[tz];
        }
        let jsTime = new Date(event.getFirstPropertyValue('recurrence-id').toString());
        let utcTime = new Date(Utilities.formatDate(jsTime, "Etc/GMT", "HH:mm:ss MM/dd/yyyy"));
        let tgtTime = new Date(Utilities.formatDate(jsTime, tz, "HH:mm:ss MM/dd/yyyy"));
        recUTCOffset = (tgtTime - utcTime) / -1000;
        recID = recID.adjust(0, 0, 0, recUTCOffset).toString() + "Z";
        event.updatePropertyWithValue('recurrence-id', recID);
      }
      var exceptionKey = event.getFirstPropertyValue('uid').toString() + "_" + recID;
      icsEventsIds.push(exceptionKey);
      registerSourceEvent(exceptionKey, event._sourceAddress);
    }
    else {
      var eventKey = event.getFirstPropertyValue('uid').toString();
      icsEventsIds.push(eventKey);
      registerSourceEvent(eventKey, event._sourceAddress);
    }
  });

  return result.concat(nativeResults);
}

function nativeEventKey(calendarId, eventId) {
  return "gcal:" + calendarId + ":" + eventId;
}

function nativeInstanceKey(calendarId, seriesId, originalStartTime) {
  return "gcal-instance:" + calendarId + ":" + seriesId + ":" +
    (originalStartTime.dateTime || originalStartTime.date);
}

function futureDateFilters(source, calendarId) {
  return filters.filter(function (filter) {
    var parameter = filter.parameter.toLowerCase();
    return filterAppliesToSource(filter, source, calendarId) &&
      (parameter === "dtstart" || parameter === "dtend") &&
      ((filter.type === "include" && filter.comparison === ">") ||
        (filter.type === "exclude" && filter.comparison === "<"));
  });
}

/** Copy each occurrence of a future-filtered ICS series as a standalone event. */
function materializeICSSeries(events, source, futureFilters, settings) {
  var windowDays = sourceSetting(settings, "recurringInstanceWindowDays", recurringInstanceWindowDays);
  if (!Number.isInteger(windowDays) || windowDays < 1)
    throw new Error("recurringInstanceWindowDays must be a positive integer");
  var midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  var startOffset = Math.min.apply(null, futureFilters.map(function (filter) { return filter.offset || 0; }));
  var windowStart = midnight.getTime() + startOffset * 86400000;
  var windowEnd = windowStart + windowDays * 86400000;
  var sourceDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, source, Utilities.Charset.UTF_8)
    .map(function (byte) { return (byte & 255).toString(16).padStart(2, "0"); }).join("");
  var exceptions = {};
  events.forEach(function (component) {
    if (!component.hasProperty("recurrence-id")) return;
    var uid = component.getFirstPropertyValue("uid");
    if (!exceptions[uid]) exceptions[uid] = [];
    exceptions[uid].push(component);
  });
  var result = [];
  events.forEach(function (component) {
    if (component.hasProperty("recurrence-id")) return;
    if (!component.hasProperty("rrule") && !component.hasProperty("rdate")) {
      result.push(component);
      return;
    }
    var uid = component.getFirstPropertyValue("uid");
    if (!uid) {
      uid = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, component.toString(), Utilities.Charset.UTF_8).toString();
      component.updatePropertyWithValue("uid", uid);
    }
    // ICAL.Event otherwise auto-attaches every exception in the VCALENDAR,
    // including exceptions belonging to other series with the same start time.
    var series = new ICAL.Event(component, { exceptions: [], strictExceptions: true });
    (exceptions[uid] || []).forEach(function (exception) { series.relateException(exception); });
    var iterationEnd = windowEnd;
    (exceptions[uid] || []).forEach(function (exception) {
      if (!exception.hasProperty("dtstart")) return;
      var exceptionStart = new ICAL.Event(exception).startDate.toJSDate().getTime();
      var original = exception.getFirstPropertyValue("recurrence-id").toJSDate().getTime();
      if (exceptionStart < windowEnd && original >= windowEnd)
        iterationEnd = Math.max(iterationEnd, original + 1);
    });
    var iterator = series.iterator();
    var originalStart;
    var count = 0;
    while ((originalStart = iterator.next()) != null) {
      if (++count > 100000) throw new Error("ICS recurrence expansion exceeded 100000 instances for " + uid);
      // A moved exception may enter the window even if its original start is before it.
      if (originalStart.toJSDate().getTime() >= iterationEnd) break;
      var details = series.getOccurrenceDetails(originalStart);
      if (details.startDate.toJSDate().getTime() >= windowEnd ||
        details.endDate.toJSDate().getTime() <= windowStart) continue;
      if (String(details.item.component.getFirstPropertyValue("status") || "").toLowerCase() === "cancelled") continue;
      result.push(makeICSInstance(component, details, sourceDigest, uid));
    }
  });
  return result;
}

function makeICSInstance(parent, details, sourceDigest, uid) {
  var component = new ICAL.Component(JSON.parse(JSON.stringify(parent.toJSON())));
  if (details.item.component !== parent) {
    details.item.component.getAllProperties().forEach(function (property) {
      var name = property.name;
      if (name === "uid" || name === "recurrence-id" || name === "rrule" || name === "rdate" || name === "exdate") return;
      component.removeAllProperties(name);
      component.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(property.toJSON()))));
    });
  }
  var startProperty = component.getFirstProperty("dtstart");
  var endProperty = component.getFirstProperty("dtend") || startProperty;
  ["rrule", "rdate", "exdate", "recurrence-id", "duration", "dtstart", "dtend"].forEach(function (name) {
    component.removeAllProperties(name);
  });
  [["dtstart", details.startDate, startProperty], ["dtend", details.endDate, endProperty]].forEach(function (item) {
    var property = item[2] ? new ICAL.Property(JSON.parse(JSON.stringify(item[2].toJSON()))) : new ICAL.Property(item[0]);
    property.jCal[0] = item[0];
    property.setValue(item[1]);
    component.addProperty(property);
  });
  component.updatePropertyWithValue("uid", "ics-instance:" + sourceDigest + ":" + uid + ":" + details.recurrenceId.toString());
  return component;
}

function materializeNativeSeries(events, source, futureFilters) {
  var windowDays = sourceSetting(source.settings, "recurringInstanceWindowDays", recurringInstanceWindowDays);
  if (!Number.isInteger(windowDays) || windowDays < 1)
    throw new Error("recurringInstanceWindowDays must be a positive integer");
  var midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  var startOffset = Math.min.apply(null, futureFilters.map(function (filter) { return filter.offset || 0; }));
  var timeMin = new Date(midnight.getTime() + startOffset * 86400000);
  var timeMax = new Date(timeMin.getTime() + windowDays * 86400000);
  var result = [];
  events.filter(function (event) { return event.recurrence && event.status !== "cancelled"; }).forEach(function (series) {
    var options = {
      maxResults: 2500, showDeleted: true,
      timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString()
    };
    var pageToken;
    do {
      if (pageToken) options.pageToken = pageToken;
      var page = callWithBackoff(function () {
        return Calendar.Events.instances(source.calendar.id, series.id, options);
      }, defaultMaxRetries);
      if (!page) throw new Error("Could not list source recurrence instances for " + series.id);
      (page.items || []).forEach(function (instance) {
        if (instance.status !== "cancelled") {
          if (!instance.start || !instance.end || !instance.originalStartTime)
            throw new Error("Incomplete source recurrence instance for " + series.id);
          var occurrence = Object.assign({}, instance);
          ["summary", "description", "location", "attendees", "organizer", "visibility",
            "transparency", "reminders", "source", "colorId"].forEach(function (field) {
              if (occurrence[field] === undefined && series[field] !== undefined) occurrence[field] = series[field];
            });
          result.push({
            nativeEvent: occurrence, source: source, materialized: true,
            sourceKey: nativeInstanceKey(source.calendar.id, series.id, instance.originalStartTime)
          });
        }
      });
      pageToken = page.nextPageToken;
    } while (pageToken);
  });
  var filtered = filterNativeEvents(result.map(function (item) { return item.nativeEvent; }),
    source.source || source.calendar.id, source.calendar.id, true);
  var keep = {};
  filtered.forEach(function (event) { keep[event.id] = true; });
  return result.filter(function (item) { return keep[item.nativeEvent.id]; });
}

function listSourceGoogleEvents(calendarId) {
  var events = [];
  var pageToken;
  do {
    var options = { maxResults: 2500, showDeleted: true, singleEvents: false };
    if (pageToken) options.pageToken = pageToken;
    var page = callWithBackoff(function () { return Calendar.Events.list(calendarId, options); }, defaultMaxRetries);
    if (!page) throw new Error("Could not list source events");
    events = events.concat(page.items || []);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return events.filter(function (event) {
    return !(event.extendedProperties && event.extendedProperties.private && event.extendedProperties.private.fromGAS === "true");
  });
}

/**
 * Applies filters to source events based on filters defined in Filters.gs
 *
 * @param {Array.ICALComponent} Array with all events from the source calendars
 * @return {Array.ICALComponent} Array with filtered events
 */
function filterAppliesToSource(filter, source, calendarId) {
  return !filter.source || filter.source === source || filter.source === calendarId;
}

function matchesTextFilter(filter, values) {
  var criteria = filter.criterias || [];
  var comparison = filter.comparison || "equals";
  return values.some(function (value) {
    return criteria.some(function (criterion) {
      var actual = String(value);
      var expected = String(criterion);
      if (comparison === "equals") return actual.toLowerCase() === expected.toLowerCase();
      if (comparison === "begins with") return actual.toLowerCase().startsWith(expected.toLowerCase());
      if (comparison === "contains") return actual.toLowerCase().includes(expected.toLowerCase());
      if (comparison === "regex") return new RegExp(expected, "i").test(actual);
      throw new Error("Unsupported text filter comparison: " + comparison);
    });
  });
}

function excludeICSException(events, event) {
  if (!event.hasProperty('recurrence-id')) return;
  var uid = event.getFirstPropertyValue('uid');
  if (!uid) return;
  var parent = events.find(function (candidate) {
    return candidate.getFirstPropertyValue('uid') === uid && !candidate.hasProperty('recurrence-id');
  });
  if (parent) parent.addPropertyWithValue('exdate', event.getFirstPropertyValue('recurrence-id'));
}

function filterICSEvents(events, source) {
  Logger.log(`Applying ${filters.length} filters on ${events.length} ICS events.`);

  for (var filter of filters) {
    if (!filterAppliesToSource(filter, source)) continue;
    var parameter = filter.parameter.toLowerCase();
    events = events.filter(function (event) {
      try {
        if (["dtstart", "dtend"].includes(parameter)) {
          let referenceDate = new ICAL.Time.fromJSDate(new Date(), true).adjust(filter.offset || 0, 0, 0, 0);
          if (event.hasProperty('rrule') || event.hasProperty('rdate')) {
            if ((filter.comparison === ">" && filter.type === "exclude") || (filter.comparison === "<" && filter.type === "include")) {
              event = modifyICSRecurrenceEnd(event, referenceDate, parameter);
            } else if ((filter.comparison === "<" && filter.type === "exclude") || (filter.comparison === ">" && filter.type === "include")) {
              event = modifyICSRecurrenceStart(event, referenceDate, parameter);
            }
            return event !== null;
          }
          else {
            let eventTime = new ICAL.Time.fromString(event.getFirstPropertyValue(parameter).toString(), event.getFirstProperty(parameter));
            switch (filter.comparison) {
              case ">":
                return ((eventTime.compare(referenceDate) > 0) ^ (filter.type == "exclude"));
              case "<":
                return ((eventTime.compare(referenceDate) < 0) ^ (filter.type == "exclude"));
              case "default":
                return true;
            }
          }
        }
        else {
          var matches;
          if (parameter === "allday") {
            matches = event.hasProperty('dtstart') && event.getFirstPropertyValue('dtstart').isDate;
          } else if (parameter === "attendee") {
            var emails = event.getAllProperties('attendee').map(function (attendee) {
              return String(attendee.getFirstValue()).replace(/^mailto:/i, "");
            });
            matches = matchesTextFilter(filter, emails);
          } else {
            var values = event.getAllProperties(parameter).map(function (property) { return property.getFirstValue(); });
            matches = matchesTextFilter(filter, values);
          }
          var keep = filter.type === "exclude" ? !matches : matches;
          if (!keep) excludeICSException(events, event);
          return keep;
        }
      }
      catch (e) {
        Logger.log(e);
        return (filter.type == "exclude");
      }
    });
  }

  Logger.log(`${events.length} events left.`);
  return events;
}

function nativeEventTime(event, parameter) {
  var part = event[parameter === "dtstart" ? "start" : "end"];
  return part && (part.dateTime || part.date);
}

function nativeDateMatches(event, filter, reference) {
  var value = nativeEventTime(event, filter.parameter.toLowerCase());
  if (!value) return false;
  var eventTime = new Date(value).getTime();
  var referenceTime = reference.toJSDate().getTime();
  if (filter.comparison === ">") return eventTime > referenceTime;
  if (filter.comparison === "<") return eventTime < referenceTime;
  throw new Error("Unsupported date filter comparison: " + filter.comparison);
}

function nativeRecurrenceMatches(event, filter, reference, calendarId) {
  var referenceTime = reference.toJSDate().toISOString();
  var options = { maxResults: 2500, showDeleted: false };
  if (filter.comparison === ">") options.timeMin = referenceTime;
  else options.timeMax = referenceTime;
  var pageToken;
  do {
    if (pageToken) options.pageToken = pageToken;
    var page = callWithBackoff(function () { return Calendar.Events.instances(calendarId, event.id, options); }, defaultMaxRetries);
    if (!page) throw new Error("Could not read recurrence instances for " + event.id);
    if ((page.items || []).some(function (instance) { return nativeDateMatches(instance, filter, reference); })) return true;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return false;
}

function filterNativeEvents(events, source, calendarId, materialized) {
  if (!filters.some(function (filter) { return filterAppliesToSource(filter, source, calendarId); })) return events;
  var originalEvents = events;
  for (var filter of filters) {
    if (!filterAppliesToSource(filter, source, calendarId)) continue;
    var parameter = filter.parameter.toLowerCase();
    events = events.filter(function (event) {
      var matches;
      if (parameter === "dtstart" || parameter === "dtend") {
        var reference = new ICAL.Time.fromJSDate(new Date(), true).adjust(filter.offset || 0, 0, 0, 0);
        matches = event.recurrence ? nativeRecurrenceMatches(event, filter, reference, calendarId) : nativeDateMatches(event, filter, reference);
      } else if (parameter === "allday") {
        matches = !!(event.start && event.start.date);
      } else if (parameter === "attendee") {
        matches = matchesTextFilter(filter, (event.attendees || []).map(function (attendee) { return attendee.email; }).filter(Boolean));
      } else {
        var field = parameter === "summary" ? "summary" : parameter;
        matches = matchesTextFilter(filter, event[field] === undefined ? [] : [event[field]]);
      }
      return filter.type === "exclude" ? !matches : matches;
    });
  }
  if (materialized) return events;
  var survivingParents = {};
  events.forEach(function (event) { if (event.recurrence) survivingParents[event.id] = true; });
  events = events.filter(function (event) {
    return !event.recurringEventId || survivingParents[event.recurringEventId];
  });
  var keptIds = {};
  events.forEach(function (event) { keptIds[event.id] = true; });
  originalEvents.forEach(function (event) {
    if (event.recurringEventId && event.originalStartTime &&
      survivingParents[event.recurringEventId] && !keptIds[event.id]) {
      // Excluding an override must also suppress the parent's generated instance.
      events.push(Object.assign({}, event, { status: "cancelled" }));
    }
  });
  return events;
}

/**
 * Modifies the end of the given recurrence series.
 *
 * @param {ICAL.Component} event - The event to modify
 * @param {ICAL.Time} referenceDate - The new recurrence end date
 * @param {string} filterParameter - The parameter to filter on
 * @return {ICAL.Component|null} The modified event or null if no instances are within the range
 */
function modifyICSRecurrenceEnd(event, referenceDate, filterParameter) {
  let eventRefDate = new ICAL.Time.fromString(event.getFirstPropertyValue('dtstart').toString(), event.getFirstProperty('dtstart'));
  if (filterParameter.toLowerCase() === "dtend") {
    let eventEnd = new ICAL.Time.fromString(event.getFirstPropertyValue('dtend').toString(), event.getFirstProperty('dtend'));
    var eventDurartion = eventEnd.subtractDate(eventRefDate);
    eventRefDate = eventEnd;
  }
  let icalEvent = new ICAL.Event(event);

  if (eventRefDate.compare(referenceDate) >= 0) {
    return null;
  }

  if (event.hasProperty('rrule')) {
    let rrule = event.getFirstProperty('rrule');
    let recur = rrule.getFirstValue();
    var dtstart = event.getFirstPropertyValue('dtstart');
    var expand = new ICAL.RecurExpansion({ component: event, dtstart: dtstart });
    var next;
    var lastStartDate = null;
    var newCount = 0;
    // Iterate through the recurrence instances to find the last valid one before referenceDate
    while (next = expand.next()) {
      if (filterParameter.toLowerCase() === "dtstart") {
        if (next.compare(referenceDate) > 0) {
          break;
        }
        newCount++;
        lastStartDate = next;
      }
      else if (filterParameter.toLowerCase() === "dtend") {
        let tempEnd = next.clone();
        tempEnd.addDuration(eventDurartion);
        if (tempEnd.compare(referenceDate) > 0) {
          break;
        }
        newCount++;
        lastStartDate = next;
      }
    }

    // Remove EXDATEs that are after the endDate
    var exDates = event.getAllProperties('exdate');
    exDates.forEach(function (e) {
      var ex = new ICAL.Time.fromString(e.getFirstValue().toString(), e);
      if (ex.compare(lastStartDate) > 0) {
        event.removeProperty(e);
      }
      else {
        newCount++
      }
    });

    if (newCount == 0) {
      event.removeProperty('rrule');
    }
    else {
      if (recur.isByCount()) {
        recur.count = newCount;
        rrule.setValue(recur);
      }
      else {
        recur.until = referenceDate.clone();
        rrule.setValue(recur);
      }
    }
  }

  // Adjust RDATEs to exclude any dates beyond the endDate
  var rdates = event.getAllProperties('rdate');
  rdates.forEach(function (r) {
    var vals = r.getValues();
    vals = vals.filter(function (v) {
      var valTime = new ICAL.Time.fromString(v.toString(), r);
      if (filterParameter.toLowerCase() === "dtend") {
        valTime.addDuration(eventDurartion);
      }
      return valTime.compare(referenceDate) <= 0;
    });
    if (vals.length === 0) {
      event.removeProperty(r);
    } else if (vals.length === 1) {
      r.setValue(vals[0]);
    } else if (vals.length > 1) {
      r.setValues(vals);
    }
  });

  //Check and filter recurrence-exceptions
  if (filterParameter.toLowerCase() === "dtend") {
    for (let key in icalEvent.exceptions) {
      let recIdEnd = icalEvent.exceptions[key].recurrenceId.clone();
      recIdEnd.addDuration(eventDurartion);
      if ((icalEvent.exceptions[key].endDate.compare(referenceDate) > 0) && (recIdEnd.compare(referenceDate) <= 0)) {
        icalEvent.component.addPropertyWithValue('exdate', icalEvent.exceptions[key].recurrenceId.toString());
      }
      else if ((icalEvent.exceptions[key].endDate.compare(referenceDate) <= 0) && (recIdEnd.compare(referenceDate) > 0)) {
        icalEvent.component.addPropertyWithValue('rdate', icalEvent.exceptions[key].recurrenceId.toString());
      }
    }
  }
  else if (filterParameter.toLowerCase() === "dtstart") {
    for (let key in icalEvent.exceptions) {
      if ((icalEvent.exceptions[key].startDate.compare(referenceDate) < 0) && (icalEvent.exceptions[key].recurrenceId.compare(referenceDate) >= 0)) {
        icalEvent.component.addPropertyWithValue('rdate', icalEvent.exceptions[key].recurrenceId.toString());
      }
      else if ((icalEvent.exceptions[key].startDate.compare(referenceDate) >= 0) && (icalEvent.exceptions[key].recurrenceId.compare(referenceDate) < 0)) {
        icalEvent.component.addPropertyWithValue('exdate', icalEvent.exceptions[key].recurrenceId.toString());
      }
    }
  }

  return event;
}

/**
 * Modifies the start of the given recurrence series.
 *
 * @param {ICAL.Component} event - The event to modify
 * @param {ICAL.Time} referenceDate - The new recurrence start date
 * @param {string} filterParameter - The parameter to filter on
 * @return {ICAL.Component|null} The modified event or null if no instances are within the range
 */
function modifyICSRecurrenceStart(event, referenceDate, filterParameter) {
  let eventRefDate = new ICAL.Time.fromString(event.getFirstPropertyValue('dtstart').toString(), event.getFirstProperty('dtstart'));
  if (filterParameter.toLowerCase() === "dtend") {
    let eventEnd = new ICAL.Time.fromString(event.getFirstPropertyValue('dtend').toString(), event.getFirstProperty('dtend'));
    var eventDurartion = eventEnd.subtractDate(eventRefDate);
    eventRefDate = eventEnd;
  }
  let icalEvent = new ICAL.Event(event);

  if (eventRefDate.compare(referenceDate) < 0) {
    var dtstart = event.getFirstPropertyValue('dtstart');
    var expand = new ICAL.RecurExpansion({ component: event, dtstart: dtstart });
    var next;
    var newStartDate = null;
    var countskipped = 0;
    while (next = expand.next()) {
      if (filterParameter.toLowerCase() === "dtstart") {
        if (next.compare(referenceDate) < 0) {
          countskipped++;
          continue;
        }
      }
      else if (filterParameter.toLowerCase() === "dtend") {
        let tempEnd = next.clone();
        tempEnd.addDuration(eventDurartion);
        if (tempEnd.compare(referenceDate) < 0) {
          countskipped++;
          continue;
        }
      }

      newStartDate = next;
      break;
    }

    if (newStartDate === null) {
      return null;
    }

    var diff = newStartDate.subtractDate(icalEvent.startDate);
    icalEvent.endDate.addDuration(diff);
    var newEndDate = icalEvent.endDate;
    icalEvent.endDate = newEndDate;
    icalEvent.startDate = newStartDate;

    if (event.hasProperty('rrule')) {
      let rrule = event.getFirstProperty('rrule');
      let recur = rrule.getFirstValue();
      var exDates = event.getAllProperties('exdate');
      exDates.forEach(function (e) {
        var ex = new ICAL.Time.fromString(e.getFirstValue().toString(), e);
        if (ex < newStartDate) {
          event.removeProperty(e);
          if (recur.isByCount()) {
            countskipped++;
          }
        }
      });

      if (recur.isByCount()) {
        recur.count -= countskipped;
        rrule.setValue(recur);
      }
    }
  }

  var rdates = event.getAllProperties('rdate');
  rdates.forEach(function (r) {
    var vals = r.getValues();
    vals = vals.filter(function (v) {
      var valTime = new ICAL.Time.fromString(v.toString(), r);
      if (filterParameter.toLowerCase() === "dtend") {
        valTime.addDuration(eventDurartion);
      }
      return (valTime.compare(referenceDate) >= 0 && valTime.compare(icalEvent.startDate) > 0)
    });
    if (vals.length == 0) {
      event.removeProperty(r);
    }
    else if (vals.length == 1) {
      r.setValue(vals[0]);
    }
    else if (vals.length > 1) {
      r.setValues(vals);
    }
  });

  //Check and filter recurrence-exceptions
  if (filterParameter.toLowerCase() === "dtend") {
    for (let key in icalEvent.exceptions) {
      let recIdEnd = icalEvent.exceptions[key].recurrenceId.clone();
      recIdEnd.addDuration(eventDurartion);
      //Exclude the instance if it was moved from future to past
      if ((icalEvent.exceptions[key].endDate.compare(referenceDate) < 0) && (recIdEnd.compare(referenceDate) >= 0)) {
        icalEvent.component.addPropertyWithValue('exdate', icalEvent.exceptions[key].recurrenceId.toString());
      }//Re-add the instance if it is moved from past to future
      else if ((icalEvent.exceptions[key].endDate.compare(referenceDate) >= 0) && (recIdEnd.compare(referenceDate) < 0)) {
        icalEvent.component.addPropertyWithValue('rdate', icalEvent.exceptions[key].recurrenceId.toString());
      }
    }
  }
  else if (filterParameter.toLowerCase() === "dtstart") {
    for (let key in icalEvent.exceptions) {
      //Exclude the instance if it was moved from future to past
      if ((icalEvent.exceptions[key].startDate.compare(referenceDate) < 0) && (icalEvent.exceptions[key].recurrenceId.compare(referenceDate) >= 0)) {
        icalEvent.component.addPropertyWithValue('exdate', icalEvent.exceptions[key].recurrenceId.toString());
      }//Re-add the instance if it is moved from past to future
      else if ((icalEvent.exceptions[key].startDate.compare(referenceDate) >= 0) && (icalEvent.exceptions[key].recurrenceId.compare(referenceDate) < 0)) {
        icalEvent.component.addPropertyWithValue('rdate', icalEvent.exceptions[key].recurrenceId.toString());
      }
    }
  }

  return event;
}

/**
 * Creates a Google Calendar event and inserts it to the target calendar.
 *
 * @param {ICAL.Component} event - The event to process
 * @param {string} calendarTz - The timezone of the target calendar
 */
function processICSEvent(event, calendarTz) {
  var settings = event._sourceSettings;
  //------------------------ Create the event object ------------------------
  var newEvent = createICSEvent(event, calendarTz);
  if (newEvent == null)
    return;

  // Exceptions are patched onto the parent later; they are not ordinary events.
  if (event.hasProperty('recurrence-id')) {
    Logger.log("Saving event instance for later: " + newEvent.recurringEventId);
    recurringEvents.push({ event: newEvent, settings: settings });
    return;
  }

  var eventId = newEvent.extendedProperties.private.id;
  var sourceHash = newEvent.extendedProperties.private.sourceHash;
  var candidates = [];
  for (var i = 0; i < calendarEventsIds.length; i++) {
    if (calendarEventsIds[i] === eventId) candidates.push(i);
  }
  var index = candidates.filter(function (i) {
    var properties = calendarEvents[i].extendedProperties && calendarEvents[i].extendedProperties.private;
    return calendarEvents[i].status !== "cancelled" && sourceHash && properties && properties.sourceHash === sourceHash;
  })[0];
  if (index === undefined && candidates.length === 1) {
    var existingProperties = calendarEvents[candidates[0]].extendedProperties.private || {};
    var activeSources = icsEventSourceHashes[eventId] || [];
    if (calendarEvents[candidates[0]].status !== "cancelled" && !existingProperties.sourceHash && activeSources.length <= 1) index = candidates[0];
  }
  if (index === undefined) index = -1;
  var needsUpdate = index > -1;
  if (needsUpdate && calendarEvents[index].status !== "cancelled" &&
    calendarEvents[index].extendedProperties.private.MD5 === newEvent.extendedProperties.private.MD5)
    return;

  //------------------------ Send event object to gcal ------------------------
  if (needsUpdate) {
    if (sourceSetting(settings, "modifyExistingEvents", modifyExistingEvents)) {
      var oldEvent = calendarEvents[index];
      Logger.log("Updating existing event " + newEvent.extendedProperties.private["id"]);
      try {
        var updatedEvent = callWithBackoff(function () {
          return Calendar.Events.update(newEvent, targetCalendarId, calendarEvents[index].id);
        }, defaultMaxRetries);
        if (!updatedEvent) throw new Error("Could not update ICS event " + eventId);
        newEvent = updatedEvent;
      }
      catch (e) {
        Logger.log(`Operation failed with error "${e}"`);
        reportOverallFailure = true;
        newEvent = null;
      }
      if (newEvent != null && emailSummary) {
        modifiedEvents.push([[oldEvent.summary, newEvent.summary, oldEvent.start.date || oldEvent.start.dateTime, newEvent.start.date || newEvent.start.dateTime, oldEvent.end.date || oldEvent.end.dateTime, newEvent.end.date || newEvent.end.dateTime, oldEvent.location, newEvent.location, oldEvent.description, newEvent.description], targetCalendarName]);
      }
    }
  }
  else {
    if (sourceSetting(settings, "addEventsToCalendar", addEventsToCalendar)) {
      Logger.log("Adding new event " + newEvent.extendedProperties.private["id"]);
      try {
        var insertedEvent = callWithBackoff(function () {
          return Calendar.Events.insert(newEvent, targetCalendarId);
        }, defaultMaxRetries);
        if (!insertedEvent) throw new Error("Could not insert ICS event " + eventId);
        newEvent = insertedEvent;
      }
      catch (e) {
        Logger.log(`Operation failed with error "${e}"`);
        reportOverallFailure = true;
        newEvent = null;
      }
      if (newEvent != null && emailSummary) {
        addedEvents.push([[newEvent.summary, newEvent.start.date || newEvent.start.dateTime, newEvent.end.date || newEvent.end.dateTime, newEvent.location, newEvent.description], targetCalendarName]);
      }
    }
  }
}

/** Build only writable Google Calendar event fields, then track the source identity. */
function makeNativeEvent(sourceEvent, source, sourceKey, materialized) {
  var settings = source.settings;
  var fields = ["summary", "description", "location", "start", "end", "recurrence", "status",
    "transparency", "visibility", "colorId", "reminders", "source"];
  if (sourceSetting(settings, "addAttendees", addAttendees)) fields.push("attendees");
  var copy = {};
  fields.forEach(function (field) {
    if (sourceEvent[field] !== undefined) copy[field] = JSON.parse(JSON.stringify(sourceEvent[field]));
  });
  if (materialized) delete copy.recurrence;
  if (sourceSetting(settings, "descriptionAsTitles", descriptionAsTitles) && copy.description) copy.summary = copy.description;
  if (sourceSetting(settings, "addOrganizerToTitle", addOrganizerToTitle) && sourceEvent.organizer) {
    copy.summary = (sourceEvent.organizer.displayName || sourceEvent.organizer.email) + ": " + (copy.summary || "");
  }
  if (sourceSetting(settings, "addCalToTitle", addCalToTitle)) copy.summary = "(" + (source.calendar.summaryOverride || source.calendar.summary) + ") " + (copy.summary || "");
  copy.summary = formattedTitle(copy.summary, !!(copy.start && copy.start.date), settings);
  var configuredColor = configuredEventColor(source.colorId, settings);
  if (configuredColor !== undefined) copy.colorId = configuredColor;
  var visibility = sourceSetting(settings, "overrideVisibility", overrideVisibility).toLowerCase();
  if (["default", "public", "private", "confidential"].indexOf(visibility) !== -1)
    copy.visibility = visibility;
  var alerts = sourceSetting(settings, "addAlerts", addAlerts);
  if (alerts === "no") copy.reminders = { useDefault: false, overrides: [] };
  else {
    var allDayReminder = sourceSetting(settings, "defaultAllDayReminder", defaultAllDayReminder);
    var isAllDay = !!(copy.start && copy.start.date);
    var validAllDayReminder = isAllDay && 0 <= allDayReminder && allDayReminder <= 40320;
    if (alerts === "default") {
      copy.reminders = validAllDayReminder ?
        { useDefault: false, overrides: [{ method: "popup", minutes: allDayReminder }] } :
        { useDefault: true };
    } else if (alerts === "yes") {
      var sourceOverrides = copy.reminders && copy.reminders.overrides;
      var hasSourceReminders = sourceOverrides && sourceOverrides.length > 0;
      if (!hasSourceReminders && validAllDayReminder)
        copy.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: allDayReminder }] };
      else if (!hasSourceReminders) {
        var fallbackMinutes = sourceSetting(settings, "fallbackReminderMinutes", fallbackReminderMinutes);
        if (0 <= fallbackMinutes && fallbackMinutes <= 40320)
          copy.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: fallbackMinutes }] };
        else if (isAllDay)
          copy.reminders = { useDefault: false, overrides: [] };
        else
          copy.reminders = { useDefault: true };
      }
    }
  }
  var id = sourceKey || nativeEventKey(source.calendar.id, sourceEvent.id);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(copy), Utilities.Charset.UTF_8).toString();
  copy.extendedProperties = {
    private: {
      fromGAS: "true", id: id, MD5: digest,
      sourceHash: sourceAddressHash(source.source || source.calendar.id)
    }
  };
  return copy;
}

function processNativeEvent(item) {
  var event = item.nativeEvent;
  if (!item.materialized && event.recurringEventId && event.originalStartTime) {
    nativeExceptions.push(item);
    return;
  }
  if (!event.start || !event.end) return;
  var copy = makeNativeEvent(event, item.source, item.sourceKey, item.materialized);
  var index = calendarEventsIds.findIndex(function (id, i) {
    return id === copy.extendedProperties.private.id && calendarEvents[i].status !== "cancelled";
  });
  if (index !== -1 && calendarEvents[index].extendedProperties.private.MD5 === copy.extendedProperties.private.MD5) return;
  try {
    var oldEvent = index === -1 ? null : calendarEvents[index];
    if (oldEvent && !sourceSetting(item.source.settings, "modifyExistingEvents", modifyExistingEvents) ||
      !oldEvent && !sourceSetting(item.source.settings, "addEventsToCalendar", addEventsToCalendar)) return;
    var saved = callWithBackoff(function () {
      return oldEvent ? Calendar.Events.update(copy, targetCalendarId, oldEvent.id) : Calendar.Events.insert(copy, targetCalendarId);
    }, defaultMaxRetries);
    if (!saved) throw new Error("Could not save native event " + event.id);
    if (emailSummary) {
      if (oldEvent) modifiedEvents.push([[oldEvent.summary, saved.summary, oldEvent.start.date || oldEvent.start.dateTime, saved.start.date || saved.start.dateTime, oldEvent.end.date || oldEvent.end.dateTime, saved.end.date || saved.end.dateTime, oldEvent.location, saved.location, oldEvent.description, saved.description], targetCalendarName]);
      else addedEvents.push([[saved.summary, saved.start.date || saved.start.dateTime, saved.end.date || saved.end.dateTime, saved.location, saved.description], targetCalendarName]);
    }
  } catch (e) {
    Logger.log("Could not sync native event " + event.id + ": " + e);
    reportOverallFailure = true;
  }
}

/** Apply source recurrence overrides to the corresponding target series instance. */
function processNativeExceptions() {
  nativeExceptions.forEach(function (item) {
    var sourceEvent = item.nativeEvent;
    try {
      var parentKey = nativeEventKey(item.source.calendar.id, sourceEvent.recurringEventId);
      var parentList = callWithBackoff(function () { return Calendar.Events.list(targetCalendarId, { privateExtendedProperty: "id=" + parentKey, maxResults: 2500 }); }, defaultMaxRetries);
      if (!parentList) throw new Error("Could not find target recurring parent");
      var parent = (parentList.items || []).filter(function (event) { return event.recurrence && event.extendedProperties && event.extendedProperties.private && event.extendedProperties.private.id === parentKey; })[0];
      if (!parent) throw new Error("Target recurring parent is missing: " + parentKey);
      var originalStart = sourceEvent.originalStartTime.dateTime || sourceEvent.originalStartTime.date;
      var instanceList = callWithBackoff(function () { return Calendar.Events.instances(targetCalendarId, parent.id, { originalStart: originalStart, showDeleted: true }); }, defaultMaxRetries);
      if (!instanceList) throw new Error("Could not list target recurrence instances");
      var instances = instanceList.items || [];
      var instance = instances.filter(function (event) {
        return event.originalStartTime && sameOriginalStart(event.originalStartTime.dateTime || event.originalStartTime.date, originalStart);
      })[0];
      if (!instance) throw new Error("Target recurrence instance is missing: " + originalStart);
      if (sourceEvent.status === "cancelled") {
        if (sourceSetting(item.source.settings, "removeEventsFromCalendar", removeEventsFromCalendar) && instance.status !== "cancelled")
          callWithBackoff(function () { return Calendar.Events.remove(targetCalendarId, instance.id); }, defaultMaxRetries);
        return;
      }
      if (!sourceSetting(item.source.settings, "modifyExistingEvents", modifyExistingEvents)) return;
      var copy = makeNativeEvent(sourceEvent, item.source);
      copy.extendedProperties.private["rec-id"] = nativeEventKey(item.source.calendar.id, sourceEvent.id);
      if (instance.status !== "cancelled" && instance.extendedProperties && instance.extendedProperties.private && instance.extendedProperties.private.MD5 === copy.extendedProperties.private.MD5) return;
      if (instance.status === "cancelled" && !copy.status) copy.status = "confirmed";
      var savedException = callWithBackoff(function () { return Calendar.Events.patch(copy, targetCalendarId, instance.id); }, defaultMaxRetries);
      if (!savedException) throw new Error("Could not update target recurrence instance");
    } catch (e) {
      Logger.log("Could not sync native recurrence exception " + sourceEvent.id + ": " + e);
      reportOverallFailure = true;
    }
  });
}

/**
 * Creates a Google Calendar Event based on the specified ICALEvent.
 * Will return null if the event has not changed since the last sync.
 *
 * @param {ICAL.Component} event - The event to process
 * @param {string} calendarTz - The timezone of the target calendar
 * @return {?Calendar.Event} The Calendar.Event that will be added to the target calendar
 */
function createICSEvent(event, calendarTz) {
  var settings = event._sourceSettings;
  event.removeProperty('dtstamp');
  var icalEvent = new ICAL.Event(event);

  var newEvent =
    callWithBackoff(function () {
      return Calendar.newEvent();
    }, defaultMaxRetries);
  if (icalEvent.startDate.isDate) { //All-day event
    if (icalEvent.startDate.compare(icalEvent.endDate) == 0) {
      //Adjust dtend in case dtstart equals dtend as this is not valid for allday events
      icalEvent.endDate = icalEvent.endDate.adjust(1, 0, 0, 0);
    }

    newEvent = {
      start: { date: icalEvent.startDate.toString() },
      end: { date: icalEvent.endDate.toString() }
    };
  }
  else { //Normal (not all-day) event
    newEvent = {
      start: {
        dateTime: icalEvent.startDate.toString(),
        timeZone: validateICSTimeZone(icalEvent.startDate.timezone || icalEvent.startDate.zone, calendarTz)
      },
      end: {
        dateTime: icalEvent.endDate.toString(),
        timeZone: validateICSTimeZone(icalEvent.endDate.timezone || icalEvent.endDate.zone, calendarTz)
      },
    };
  }

  if (sourceSetting(settings, "addAttendees", addAttendees) && event.hasProperty('attendee')) {
    newEvent.attendees = [];
    for (var att of icalEvent.attendees) {
      var mail = parseICSAttendeeMail(att.toICALString());
      if (mail != null) {
        var newAttendee = { 'email': mail };

        var name = parseICSAttendeeName(att.toICALString());
        if (name != null)
          newAttendee['displayName'] = name;

        var resp = parseICSAttendeeResp(att.toICALString());
        if (resp != null)
          newAttendee['responseStatus'] = resp;

        newEvent.attendees.push(newAttendee);
      }
    }
  }

  if (event.hasProperty('status')) {
    var status = event.getFirstPropertyValue('status').toString().toLowerCase();
    if (["confirmed", "tentative", "cancelled"].indexOf(status) > -1)
      newEvent.status = status;
  }

  if (event.hasProperty('url') && event.getFirstPropertyValue('url').toString().substring(0, 4) == 'http') {
    newEvent.source = callWithBackoff(function () {
      return Calendar.newEventSource();
    }, defaultMaxRetries);
    newEvent.source.url = event.getFirstPropertyValue('url').toString();
    newEvent.source.title = 'link';
  }

  if (event.hasProperty('sequence')) {
    //newEvent.sequence = icalEvent.sequence; Currently disabled as it is causing issues with recurrence exceptions
  }

  if (sourceSetting(settings, "descriptionAsTitles", descriptionAsTitles) && event.hasProperty('description'))
    newEvent.summary = icalEvent.description;
  else if (event.hasProperty('summary'))
    newEvent.summary = icalEvent.summary;

  if (event.hasProperty('organizer')) {
    var organizerName = event.getFirstProperty('organizer').getParameter('cn');
    var organizerMail = event.getFirstProperty('organizer').getParameter('mailto');
    newEvent.organizer = callWithBackoff(function () {
      return Calendar.newEventOrganizer();
    }, defaultMaxRetries);
    if (organizerName)
      newEvent.organizer.displayName = organizerName.toString();
    if (organizerMail)
      newEvent.organizer.email = organizerMail.toString();

    if (sourceSetting(settings, "addOrganizerToTitle", addOrganizerToTitle) && organizerName) {
      newEvent.summary = organizerName + ": " + newEvent.summary;
    }
  }

  if (sourceSetting(settings, "addCalToTitle", addCalToTitle) && event.hasProperty('parentCal')) {
    var calName = event.getFirstPropertyValue('parentCal');
    newEvent.summary = "(" + calName + ") " + newEvent.summary;
  }

  newEvent.summary = formattedTitle(newEvent.summary, icalEvent.startDate.isDate, settings);

  var description = icsDescription(event, icalEvent.description);
  if (description && sourceSetting(settings, "decodeOutlookSafeLinks", decodeOutlookSafeLinks))
    description = decodeSafeLinks(description);
  if (description) newEvent.description = description;

  if (event.hasProperty('location'))
    newEvent.location = icalEvent.location;

  var validVisibilityValues = ["default", "public", "private", "confidential"];
  var visibility = sourceSetting(settings, "overrideVisibility", overrideVisibility).toLowerCase();
  if (validVisibilityValues.includes(visibility)) {
    newEvent.visibility = visibility;
  } else if (event.hasProperty('class')) {
    var classString = event.getFirstPropertyValue('class').toString().toLowerCase();
    if (validVisibilityValues.includes(classString))
      newEvent.visibility = classString;
  }

  if (event.hasProperty('transp')) {
    var transparency = event.getFirstPropertyValue('transp').toString().toLowerCase();
    if (["opaque", "transparent"].indexOf(transparency) > -1)
      newEvent.transparency = transparency;
  }
  else if (sourceSetting(settings, "mapMicrosoftTentativeToFree", mapMicrosoftTentativeToFree) &&
    String(event.getFirstPropertyValue('x-microsoft-cdo-busystatus') || '').toUpperCase() === 'TENTATIVE')
    newEvent.transparency = 'transparent';

  if (icalEvent.startDate.isDate) {
    var allDayReminder = sourceSetting(settings, "defaultAllDayReminder", defaultAllDayReminder);
    if (0 <= allDayReminder && allDayReminder <= 40320) {
      newEvent.reminders = { 'useDefault': false, 'overrides': [{ 'method': 'popup', 'minutes': allDayReminder }] };//reminder as defined by the user
    }
    else {
      newEvent.reminders = { 'useDefault': false, 'overrides': [] };//no reminder
    }
  }
  else {
    newEvent.reminders = { 'useDefault': true, 'overrides': [] };//will set the default reminders as set at calendar.google.com
  }

  switch (sourceSetting(settings, "addAlerts", addAlerts)) {
    case "yes":
      var valarms = event.getAllSubcomponents('valarm');
      if (valarms.length > 0) {
        var overrides = [];
        for (var valarm of valarms) {
          var triggerProperty = valarm.getFirstProperty('trigger');
          if (!triggerProperty) continue;
          // Some providers omit VALUE=DATE-TIME; ical.js then tries to parse
          // the timestamp as a duration before we can inspect it.
          var trigger = String(triggerProperty.jCal[3]);
          if (overrides.length < 5) { //Google supports max 5 reminder-overrides
            var timer;
            if (/^\d{8}T\d{6}Z?$/.test(trigger) || /^\d{4}-\d\d-\d\dT/.test(trigger)) {
              try {
                var normalizedTrigger = trigger.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/,
                  "$1-$2-$3T$4:$5:$6$7");
                var alarmTime = ICAL.Time.fromString(normalizedTrigger);
                timer = Math.round((icalEvent.startDate.toJSDate().getTime() - alarmTime.toJSDate().getTime()) / 60000);
              } catch (e) { continue; }
            } else if (/^-?P/i.test(trigger)) {
              timer = parseICSNotificationTime(trigger);
            }
            if (0 <= timer && timer <= 40320)
              overrides.push({ 'method': 'popup', 'minutes': timer });
          }
        }

        if (overrides.length > 0) {
          newEvent.reminders = {
            'useDefault': false,
            'overrides': overrides
          };
        }
      }
      if (!valarms.length || !newEvent.reminders.overrides || !newEvent.reminders.overrides.length) {
        var fallbackMinutes = sourceSetting(settings, "fallbackReminderMinutes", fallbackReminderMinutes);
        if (0 <= fallbackMinutes && fallbackMinutes <= 40320)
          newEvent.reminders = { 'useDefault': false, 'overrides': [{ 'method': 'popup', 'minutes': fallbackMinutes }] };
      }
      break;
    case "no":
      newEvent.reminders = {
        'useDefault': false,
        'overrides': []
      };
      break;
    case "default":
      if (!(icalEvent.startDate.isDate && 0 <= allDayReminder && allDayReminder <= 40320))
        newEvent.reminders = { 'useDefault': true, 'overrides': [] };
      break;
  }

  if (icalEvent.isRecurring()) {
    // Calculate targetTZ's UTC-Offset
    var calendarUTCOffset = 0;
    var jsTime = new Date();
    var utcTime = new Date(Utilities.formatDate(jsTime, "Etc/GMT", "HH:mm:ss MM/dd/yyyy"));
    var tgtTime = new Date(Utilities.formatDate(jsTime, calendarTz, "HH:mm:ss MM/dd/yyyy"));
    calendarUTCOffset = tgtTime - utcTime;
    newEvent.recurrence = parseICSRecurrenceRule(event, calendarUTCOffset);
  }

  newEvent.extendedProperties = { private: { fromGAS: "true", id: icalEvent.uid } };
  if (event._sourceAddress)
    newEvent.extendedProperties.private.sourceHash = sourceAddressHash(event._sourceAddress);

  if (event.hasProperty('recurrence-id')) {
    newEvent.recurringEventId = event.getFirstPropertyValue('recurrence-id').toString();
    newEvent.extendedProperties.private['rec-id'] = newEvent.extendedProperties.private['id'] + "_" + newEvent.recurringEventId;
  }

  if (event.hasProperty('color')) {
    let colorID = event.getFirstPropertyValue('color').toString();
    if (Object.keys(CalendarApp.EventColor).includes(colorID)) {
      newEvent.colorId = CalendarApp.EventColor[colorID];
    } else if (Object.values(CalendarApp.EventColor).includes(colorID)) {
      newEvent.colorId = colorID;
    }; //else unsupported value
  }

  // Hash the rendered event after applying source settings and colour.
  var digestFields = Object.assign({}, newEvent);
  delete digestFields.extendedProperties;
  newEvent.extendedProperties.private.MD5 = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, JSON.stringify(digestFields), Utilities.Charset.UTF_8).toString();

  return newEvent;
}

/**
 * Patches an existing event instance with the provided Calendar.Event.
 * The instance that needs to be updated is identified by the recurrence-id of the provided event.
 *
 * @param {Calendar.Event} recEvent - The event instance to process
 */
function processICSEventInstance(recEvent, settings) {
  var sourceId = recEvent.extendedProperties.private.id;
  var sourceHash = recEvent.extendedProperties.private.sourceHash;
  var originalStart = recEvent.recurringEventId;
  try {
    var parents = callWithBackoff(function () {
      return Calendar.Events.list(targetCalendarId, { privateExtendedProperty: "id=" + sourceId, maxResults: 2500 });
    }, defaultMaxRetries);
    if (!parents) throw new Error("Could not find target recurring parent");
    var matchingParents = (parents.items || []).filter(function (event) {
      return event.recurrence && event.extendedProperties && event.extendedProperties.private &&
        event.extendedProperties.private.fromGAS === "true" && event.extendedProperties.private.id === sourceId;
    });
    var parent = matchingParents.filter(function (event) {
      return sourceHash && event.extendedProperties.private.sourceHash === sourceHash;
    })[0];
    if (!parent && matchingParents.length === 1 &&
      !matchingParents[0].extendedProperties.private.sourceHash &&
      (icsEventSourceHashes[sourceId] || []).length <= 1)
      parent = matchingParents[0];
    if (!parent) throw new Error("Recurring parent is missing: " + sourceId);
    var instances = callWithBackoff(function () {
      return Calendar.Events.instances(targetCalendarId, parent.id, { originalStart: originalStart, showDeleted: true, maxResults: 2500 });
    }, defaultMaxRetries);
    if (!instances) throw new Error("Could not list target recurrence instances");
    var instance = (instances.items || []).filter(function (event) {
      return event.originalStartTime && sameOriginalStart(event.originalStartTime.dateTime || event.originalStartTime.date, originalStart);
    })[0];
    if (!instance) throw new Error("Recurrence instance is missing: " + originalStart);
    if (!sourceSetting(settings, "modifyExistingEvents", modifyExistingEvents) || (instance.status !== "cancelled" && instance.extendedProperties && instance.extendedProperties.private &&
      instance.extendedProperties.private.MD5 === recEvent.extendedProperties.private.MD5)) return;
    delete recEvent.recurringEventId; // This is the source recurrence-id, not a Google parent event ID.
    if (instance.status === "cancelled" && !recEvent.status) recEvent.status = "confirmed";
    var updated = callWithBackoff(function () { return Calendar.Events.patch(recEvent, targetCalendarId, instance.id); }, defaultMaxRetries);
    if (!updated) throw new Error("Could not update recurrence instance: " + instance.id);
  } catch (e) {
    Logger.log("Could not sync recurrence exception " + sourceId + " at " + originalStart + ": " + e);
    reportOverallFailure = true;
  }
}

function sameOriginalStart(first, second) {
  if (first === second) return true;
  if (!first || !second) return false;
  if (first.length === 10 || second.length === 10) return first.slice(0, 10) === second.slice(0, 10);
  return new Date(first).getTime() === new Date(second).getTime();
}

/**
 * Deletes obsolete events only when their hashed source identifies a configured
 * source whose removal settings allow it. Legacy events are backfilled when a
 * current feed ID identifies their source unambiguously.
 */
function processEventCleanup(sources) {
  var policies = Object.create(null);
  (sources || []).forEach(function (source) {
    var hash = sourceAddressHash(source.source);
    if (Object.prototype.hasOwnProperty.call(policies, hash)) {
      // Repeated mappings for one source with conflicting settings are ambiguous.
      if (policies[hash] &&
        (sourceSetting(policies[hash], "removeEventsFromCalendar", removeEventsFromCalendar) !==
          sourceSetting(source, "removeEventsFromCalendar", removeEventsFromCalendar) ||
          sourceSetting(policies[hash], "removePastEventsFromCalendar", removePastEventsFromCalendar) !==
          sourceSetting(source, "removePastEventsFromCalendar", removePastEventsFromCalendar) ||
          sourceSetting(policies[hash], "pastEventWindowDays", pastEventWindowDays) !==
          sourceSetting(source, "pastEventWindowDays", pastEventWindowDays)))
        policies[hash] = null;
    } else {
      policies[hash] = source;
    }
  });
  if (!Number.isInteger(maxCleanupDeletesPerRun) || maxCleanupDeletesPerRun < 1)
    throw new Error("maxCleanupDeletesPerRun must be a positive integer");
  var properties = PropertiesService.getScriptProperties();
  var cursorKey = "cleanupCursor:" + sourceAddressHash(targetCalendarId);
  var cursor = Number(properties.getProperty(cursorKey) || 0);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= calendarEvents.length) cursor = 0;
  var attempts = 0;
  for (var step = 0; step < calendarEvents.length; step++) {
    var i = (cursor + step) % calendarEvents.length;
    var currentID = calendarEventsIds[i];
    var feedIndex = icsEventsIds.indexOf(currentID);
    var activeHashes = icsEventSourceHashes[currentID] || [];
    var privateProperties = calendarEvents[i].extendedProperties && calendarEvents[i].extendedProperties.private;
    if (!privateProperties) continue;
    var hash = privateProperties.sourceHash;
    if (!hash && feedIndex !== -1 && activeHashes.length === 1) {
      hash = activeHashes[0];
      try {
        var updatedPrivate = Object.assign({}, privateProperties, { sourceHash: hash });
        var patched = callWithBackoff(function () {
          return Calendar.Events.patch({ extendedProperties: { private: updatedPrivate } },
            targetCalendarId, calendarEvents[i].id);
        }, defaultMaxRetries);
        if (!patched) throw new Error("Could not tag existing event");
        privateProperties.sourceHash = hash;
      } catch (e) {
        Logger.log("Could not tag existing event " + currentID + ": " + e);
        reportOverallFailure = true;
        return;
      }
    }
    var stillInFeed = activeHashes.length ? activeHashes.indexOf(hash) !== -1 : feedIndex !== -1;
    if (!hash || !policies[hash] || stillInFeed || calendarEvents[i].recurringEventId != null)
      continue;
    var settings = policies[hash];
    if (!sourceSetting(settings, "removeEventsFromCalendar", removeEventsFromCalendar)) continue;
    if (!sourceSetting(settings, "removePastEventsFromCalendar", removePastEventsFromCalendar) &&
      !(new Date(calendarEvents[i].start.dateTime) > new Date() ||
        new Date(calendarEvents[i].start.date) > new Date())) continue;
    if (!calendarEvents[i].recurrence && endsBeforePastWindow(
      calendarEvents[i].end && (calendarEvents[i].end.dateTime || calendarEvents[i].end.date), settings)) continue;
    if (!currentID || !calendarEvents[i].id) {
      Logger.log("Skipping cleanup for an event without a source or target ID");
      reportOverallFailure = true;
      continue;
    }
    Logger.log("Deleting old event " + currentID);
    attempts++;
    var removed = false;
    try {
      removed = callWithBackoff(function () {
        Calendar.Events.remove(targetCalendarId, calendarEvents[i].id);
        return true;
      }, defaultMaxRetries);
      if (!removed) throw new Error("Could not delete target event " + currentID);
    }
    catch (e) {
      if (/resource has been deleted/i.test(String(e)))
        Logger.log("Target event was already deleted: " + currentID);
      else {
        Logger.log(`Operation failed with error "${e}"`);
        reportOverallFailure = true;
      }
    }

    if (removed && emailSummary) {
      removedEvents.push([[calendarEvents[i].summary, calendarEvents[i].start.date || calendarEvents[i].start.dateTime, calendarEvents[i].end.date || calendarEvents[i].end.dateTime, calendarEvents[i].location, calendarEvents[i].description], targetCalendarName]);
    }
    if (attempts >= maxCleanupDeletesPerRun) {
      properties.setProperty(cursorKey, String((i + 1) % calendarEvents.length));
      return;
    }
  }
  properties.deleteProperty(cursorKey);
}

/**
 * Processes and adds all vtodo components as Tasks to the user's Google Account
 *
 * @param {Array.string} responses - Array with all ical sources
 */
function processICSTasks(responses) {
  var taskLists = Tasks.Tasklists.list().items;
  var taskList = taskLists[0];

  var existingTasks = Tasks.Tasks.list(taskList.id).items || [];
  var existingTasksIds = []
  Logger.log("Fetched " + existingTasks.length + " existing tasks from " + taskList.title);
  for (var i = 0; i < existingTasks.length; i++) {
    existingTasksIds[i] = existingTasks[i].id;
  }

  var icsTasksIds = [];
  var vtasks = [];

  for (var resp of responses) {
    var jcalData = ICAL.parse(resp.content);
    var component = new ICAL.Component(jcalData);

    vtasks = [].concat(component.getAllSubcomponents("vtodo"), vtasks);
  }

  vtasks.forEach(function (task) { icsTasksIds.push(task.getFirstPropertyValue('uid').toString()); });

  Logger.log("\tProcessing " + vtasks.length + " tasks");
  for (var task of vtasks) {
    var newtask = Tasks.newTask();
    newtask.id = task.getFirstPropertyValue("uid").toString();
    newtask.title = task.getFirstPropertyValue("summary").toString();
    var dueDate = task.getFirstPropertyValue("due").toJSDate();
    newtask.due = (dueDate.getFullYear()) + "-" + ("0" + (dueDate.getMonth() + 1)).slice(-2) + "-" + ("0" + dueDate.getDate()).slice(-2) + "T" + ("0" + dueDate.getHours()).slice(-2) + ":" + ("0" + dueDate.getMinutes()).slice(-2) + ":" + ("0" + dueDate.getSeconds()).slice(-2) + "Z";

    Tasks.Tasks.insert(newtask, taskList.id);
  }
  Logger.log("\tDone processing tasks");

  //-------------- Remove old Tasks -----------
  // ID can't be used as identifier as the API reassignes a random id at task creation
  if (removeEventsFromCalendar) {
    Logger.log("Checking " + existingTasksIds.length + " tasks for removal");
    for (var i = 0; i < existingTasksIds.length; i++) {
      var currentID = existingTasks[i].id;
      var feedIndex = icsTasksIds.indexOf(currentID);

      if (feedIndex == -1) {
        Logger.log("Deleting old task " + currentID);
        Tasks.Tasks.remove(taskList.id, currentID);
      }
    }

    Logger.log("Done removing tasks");
  }
  //----------------------------------------------------------------
}

/**
 * Validates provided Timezone descriptor and if needed replaces it with an IANA timezone descriptor.
 *
 * @param {string} tzid - Timezone descriptor to validate
 * @return {string} Valid IANA timezone descriptor
 */
function validateICSTimeZone(tzid, calendarTz) {
  tzid = tzid.toString();
  let IanaTZ;
  if (tzids.indexOf(tzid) == -1) {
    if (tzid in tzidreplace) {
      IanaTZ = tzidreplace[tzid];
    }
    else {//floating time
      IanaTZ = calendarTz;
    }
    Logger.log("Converting ICS timezone " + tzid + " to Google Calendar (IANA) timezone " + IanaTZ);
  }
  return IanaTZ || tzid;
}

/**
 * Parses the provided ICAL.Component to find all recurrence rules.
 *
 * @param {ICAL.Component} vevent - The event to parse
 * @param {number} utcOffset - utc offset of the target calendar
 * @return {Array.String} Array with all recurrence components found in the provided event
 */
function parseICSRecurrenceRule(vevent, utcOffset) {
  var recurrenceRules = vevent.getAllProperties('rrule');
  var exRules = vevent.getAllProperties('exrule');//deprecated, for compatibility only
  var exDates = vevent.getAllProperties('exdate');
  var rDates = vevent.getAllProperties('rdate');

  var recurrence = [];
  for (var recRule of recurrenceRules) {
    if (recRule.getParameter('tzid')) {
      let tz = recRule.getParameter('tzid').toString();
      if (tz in tzidreplace) {
        tz = tzidreplace[tz];
      }
      recRule.setParameter('tzid', tz);
    }
    var recIcal = recRule.toICALString();
    var adjustedTime;

    var untilMatch = RegExp("(.*)(UNTIL=)(\\d\\d\\d\\d)(\\d\\d)(\\d\\d)T(\\d\\d)(\\d\\d)(\\d\\d)(;.*|\\b)", "g").exec(recIcal);
    if (untilMatch != null) {
      adjustedTime = new Date(Date.UTC(parseInt(untilMatch[3], 10), parseInt(untilMatch[4], 10) - 1, parseInt(untilMatch[5], 10), parseInt(untilMatch[6], 10), parseInt(untilMatch[7], 10), parseInt(untilMatch[8], 10)));
      adjustedTime = (Utilities.formatDate(new Date(adjustedTime - utcOffset), "etc/GMT", "YYYYMMdd'T'HHmmss'Z'"));
      recIcal = untilMatch[1] + untilMatch[2] + adjustedTime + untilMatch[9];
    }

    recurrence.push(recIcal);
  }

  for (var exRule of exRules) {
    if (exRule.getParameter('tzid')) {
      let tz = exRule.getParameter('tzid').toString();
      if (tz in tzidreplace) {
        tz = tzidreplace[tz];
      }
      exRule.setParameter('tzid', tz);
    }
    recurrence.push(exRule.toICALString());
  }

  for (var exDate of exDates) {
    if (exDate.getParameter('tzid')) {
      let tz = exDate.getParameter('tzid').toString();
      if (tz in tzidreplace) {
        tz = tzidreplace[tz];
      }
      exDate.setParameter('tzid', tz);
    }
    recurrence.push(exDate.toICALString());
  }

  for (var rDate of rDates) {
    if (rDate.getParameter('tzid')) {
      let tz = rDate.getParameter('tzid').toString();
      if (tz in tzidreplace) {
        tz = tzidreplace[tz];
      }
      rDate.setParameter('tzid', tz);
    }
    recurrence.push(rDate.toICALString());
  }

  return recurrence;
}

/**
 * Parses the provided string to find the name of an Attendee.
 * Will return null if no name is found.
 *
 * @param {string} veventString - The string to parse
 * @return {?String} The Attendee's name found in the string, null if no name was found
 */
function parseICSAttendeeName(veventString) {
  var nameMatch = RegExp("(cn=)([^;$:]*)", "gi").exec(veventString);
  if (nameMatch != null && nameMatch.length > 1)
    return nameMatch[2];
  else
    return null;
}

/**
 * Parses the provided string to find the mail adress of an Attendee.
 * Will return null if no mail adress is found.
 *
 * @param {string} veventString - The string to parse
 * @return {?String} The Attendee's mail adress found in the string, null if nothing was found
 */
function parseICSAttendeeMail(veventString) {
  var mailMatch = RegExp("(:mailto:)([^;$:]*)", "gi").exec(veventString);
  if (mailMatch != null && mailMatch.length > 1)
    return mailMatch[2];
  else
    return null;
}

/**
 * Parses the provided string to find the response of an Attendee.
 * Will return null if no response is found or the response string is not supported by google calendar.
 *
 * @param {string} veventString - The string to parse
 * @return {?String} The Attendee's response found in the string, null if nothing was found or unsupported
 */
function parseICSAttendeeResp(veventString) {
  var respMatch = RegExp("(partstat=)([^;$:]*)", "gi").exec(veventString);
  if (respMatch != null && respMatch.length > 1) {
    if (['NEEDS-ACTION'].indexOf(respMatch[2].toUpperCase()) > -1) {
      respMatch[2] = 'needsAction';
    }
    else if (['ACCEPTED', 'COMPLETED'].indexOf(respMatch[2].toUpperCase()) > -1) {
      respMatch[2] = 'accepted';
    }
    else if (['DECLINED'].indexOf(respMatch[2].toUpperCase()) > -1) {
      respMatch[2] = 'declined';
    }
    else if (['DELEGATED', 'IN-PROCESS', 'TENTATIVE'].indexOf(respMatch[2].toUpperCase())) {
      respMatch[2] = 'tentative';
    }
    else {
      respMatch[2] = null;
    }
    return respMatch[2];
  }
  else {
    return null;
  }
}

/**
 * Parses the provided string to find the notification time of an event.
 * Will return 0 by default.
 *
 * @param {string} notificationString - The string to parse
 * @return {number} The notification time in minutes
 */
function parseICSNotificationTime(notificationString) {
  //https://www.kanzaki.com/docs/ical/duration-t.html
  var reminderTime = 0;

  //We will assume all notifications are BEFORE the event
  if (notificationString[0] == "+" || notificationString[0] == "-")
    notificationString = notificationString.substr(1);

  notificationString = notificationString.substr(1); //Remove "P" character

  var minuteMatch = RegExp("\\d+M", "g").exec(notificationString);
  var hourMatch = RegExp("\\d+H", "g").exec(notificationString);
  var dayMatch = RegExp("\\d+D", "g").exec(notificationString);
  var weekMatch = RegExp("\\d+W", "g").exec(notificationString);

  if (weekMatch != null) {
    reminderTime += parseInt(weekMatch[0].slice(0, -1)) * 7 * 24 * 60; //Remove the "W" off the end

    return reminderTime; //Return the notification time in minutes
  }
  else {
    if (minuteMatch != null)
      reminderTime += parseInt(minuteMatch[0].slice(0, -1)); //Remove the "M" off the end

    if (hourMatch != null)
      reminderTime += parseInt(hourMatch[0].slice(0, -1)) * 60; //Remove the "H" off the end

    if (dayMatch != null)
      reminderTime += parseInt(dayMatch[0].slice(0, -1)) * 24 * 60; //Remove the "D" off the end

    return reminderTime; //Return the notification time in minutes
  }
}

/**
* Sends an email summary with added/modified/deleted events.
*/
function sendSummary() {
  var subject;
  var body;

  var counts = [];
  if (addedEvents.length) counts.push(addedEvents.length + " new");
  if (modifiedEvents.length) counts.push(modifiedEvents.length + " modified");
  if (removedEvents.length) counts.push(removedEvents.length + " deleted");
  var subject = (customEmailSubject || "GAS-ICS-Sync Execution Summary") +
    (counts.length ? ": " + counts.join(", ") : ": no changes");
  addedEvents = condenseCalendarMap(addedEvents);
  modifiedEvents = condenseCalendarMap(modifiedEvents);
  removedEvents = condenseCalendarMap(removedEvents);

  body = "GAS-ICS-Sync made the following changes to your calendar:<br/>";
  for (var tgtCal of addedEvents) {
    body += `<br/>${tgtCal.target}: ${tgtCal.sources.length} added events<br/><ul>`;
    for (var addedEvent of tgtCal.sources) {
      body += "<li>"
        + "Name: " + addedEvent.source[0] + "<br/>"
        + "Start: " + formatDate(addedEvent.source[1]) + "<br/>"
        + "End: " + formatDate(addedEvent.source[2]) + "<br/>"
        + (addedEvent.source[3] ? ("Location: " + addedEvent.source[3] + "<br/>") : "")
        + (addedEvent.source[4] ? ("Description: " + addedEvent.source[4] + "<br/>") : "")
        + "</li>";
    }
    body += "</ul>";
  }

  for (var tgtCal of modifiedEvents) {
    body += `<br/>${tgtCal.target}: ${tgtCal.sources.length} modified events<br/><ul>`;
    for (var modifiedEvent of tgtCal.sources) {
      body += "<li>"
        + (modifiedEvent.source[0] != modifiedEvent.source[1] ? ("<del>Name: " + modifiedEvent.source[0] + "</del><br/>") : "")
        + "Name: " + modifiedEvent.source[1] + "<br/>"
        + (modifiedEvent.source[2] != modifiedEvent.source[3] ? ("<del>Start: " + formatDate(modifiedEvent.source[2]) + "</del><br/>") : "")
        + " Start: " + formatDate(modifiedEvent.source[3]) + "<br/>"
        + (modifiedEvent.source[4] != modifiedEvent.source[5] ? ("<del>End: " + formatDate(modifiedEvent.source[4]) + "</del><br/>") : "")
        + " End: " + formatDate(modifiedEvent.source[5]) + "<br/>"
        + (modifiedEvent.source[6] != modifiedEvent.source[7] ? ("<del>Location: " + (modifiedEvent.source[6] ? modifiedEvent.source[6] : "") + "</del><br/>") : "")
        + (modifiedEvent.source[7] ? (" Location: " + modifiedEvent.source[7] + "<br/>") : "")
        + (modifiedEvent.source[8] != modifiedEvent.source[9] ? ("<del>Description: " + (modifiedEvent.source[8] ? modifiedEvent.source[8] : "") + "</del><br/>") : "")
        + (modifiedEvent.source[9] ? (" Description: " + modifiedEvent.source[9] + "<br/>") : "")
        + "</li>";
    }
    body += "</ul>";
  }

  for (var tgtCal of removedEvents) {
    body += `<br/>${tgtCal.target}: ${tgtCal.sources.length} removed events<br/><ul>`;
    for (var removedEvent of tgtCal.sources) {
      body += "<li>"
        + "<del>Name: " + removedEvent.source[0] + "</del><br/>"
        + "<del>Start: " + formatDate(removedEvent.source[1]) + "</del><br/>"
        + "<del>End: " + formatDate(removedEvent.source[2]) + "</del><br/>"
        + (removedEvent.source[3] ? ("<del>Location: " + removedEvent.source[3] + "</del><br/>") : "")
        + (removedEvent.source[4] ? ("<del>Description: " + removedEvent.source[4] + "</del><br/>") : "")
        + "</li>";
    }
    body += "</ul>";
  }

  body += "<br/><br/>Do you have any problems or suggestions? Contact us at <a href='https://github.com/derekantrican/GAS-ICS-Sync/'>github</a>.";
  var message = {
    to: email,
    subject: subject,
    htmlBody: body,
    name: "GAS-ICS-Sync"
  };

  MailApp.sendEmail(message);
}

/**
 * Runs the specified function with exponential backoff and returns the result.
 * Will return null if the function did not succeed afterall.
 *
 * @param {function} func - The function that should be executed
 * @param {Number} maxRetries - How many times the function should try if it fails
 * @return {?Calendar.Event} The Calendar.Event that was added in the calendar, null if func did not complete successfully
 */
var backoffRecoverableErrors = [
  "service invoked too many times in a short time",
  "rate limit exceeded",
  "internal error",
  "http error 403", // forbidden
  "http error 408", // request timeout
  "http error 423", // locked
  "http error 429", // rate limited
  "http error 500", // internal server error
  "http error 503", // service unavailable
  "http error 504"  // gateway timeout
];
function callWithBackoff(func, maxRetries) {
  var tries = 0;
  var result;
  while (tries <= maxRetries) {
    tries++;
    try {
      result = func();
      return result;
    }
    catch (err) {
      err = err.message || err;
      if (err.includes("is not a function") || !backoffRecoverableErrors.some(function (e) {
        return err.toLowerCase().includes(e);
      })) {
        throw err;
      } else if (tries > maxRetries) {
        Logger.log(`Error, giving up after trying ${maxRetries} times [${err}]`);
        return null;
      } else {
        Logger.log("Error, Retrying... [" + err + "]");
        Utilities.sleep(Math.pow(2, tries) * 100) +
          (Math.round(Math.random() * 100));
      }
    }
  }
  return null;
}

/** Migrate an old daily update trigger without disturbing sync triggers. */
function checkForUpdate() {
  var triggers = ScriptApp.getProjectTriggers();
  var hasAutoUpdate = triggers.some(function (trigger) {
    return trigger.getHandlerFunction() === "AutoUpdate";
  });
  if (!hasAutoUpdate)
    ScriptApp.newTrigger("AutoUpdate").timeBased().everyDays(1).create();
  triggers.forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "checkForUpdate")
      ScriptApp.deleteTrigger(trigger);
  });
}

// Identify the account running a manual sync or owning its scheduled trigger.
function getSyncUserEmail_() {
  if (typeof Session === "undefined") return ""; // Allows local tests to load this file.
  var activeEmail = Session.getActiveUser().getEmail();
  var effectiveEmail = Session.getEffectiveUser().getEmail();
  return String(activeEmail || effectiveEmail || "").toLowerCase();
}

/** Run from the editor to confirm which account the script can identify. */
function ShowCurrentUserEmail() {
  var userEmail = getSyncUserEmail_();
  if (!userEmail) throw new Error("Apps Script did not provide an account email");
  Logger.log("Run by user: " + userEmail);
  return userEmail;
}

/**
 * Check the configured fork for an update. AutoUpdate(true) previews without
 * writing project content or sending an email. The installed Config.gs and
 * Filters.gs are always retained, including when the release contains copies.
 */
function AutoUpdateImpl_(dryRun) {
  var preview = dryRun === true;
  var repo = String(autoUpdateRepository || "");
  var mode = String(autoUpdateMode || "");
  var channel = String(autoUpdateChannel || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("Set autoUpdateRepository to owner/repository in Config.gs");
  if (mode !== "auto" && mode !== "email")
    throw new Error("autoUpdateMode must be auto or email");
  if (channel !== "release" && channel !== "bleeding-edge")
    throw new Error("autoUpdateChannel must be release or bleeding-edge");
  if (channel === "bleeding-edge" && !/^[A-Za-z0-9._\/-]+$/.test(String(autoUpdateBranch || "")))
    throw new Error("Set a valid autoUpdateBranch in Config.gs");

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log("Another update check is running");
    return;
  }
  try {
    var api = "https://api.github.com/repos/" + repo;
    var version;
    if (channel === "release") {
      var release = autoUpdateGithubJson_(api + "/releases/latest");
      if (!release.tag_name || !release.html_url)
        throw new Error("Latest GitHub release has no tag or URL");
      version = {
        ref: release.tag_name, key: "release:" + release.tag_name,
        url: release.html_url
      };
    } else {
      var branch = autoUpdateGithubJson_(api + "/branches/" + encodeURIComponent(autoUpdateBranch));
      if (!branch.commit || !/^[a-f0-9]{40}$/.test(branch.commit.sha || ""))
        throw new Error("GitHub branch response has no commit SHA");
      version = {
        ref: branch.commit.sha, key: "commit:" + branch.commit.sha,
        url: "https://github.com/" + repo + "/commit/" + branch.commit.sha
      };
    }

    var properties = PropertiesService.getScriptProperties();
    var propertyKey = "AutoUpdate:" + repo + ":" + channel + ":" + (channel === "bleeding-edge" ? autoUpdateBranch : "release");
    var lastSeen = properties.getProperty(propertyKey);
    if (!preview && lastSeen === version.key) {
      Logger.log("Already handled " + version.key);
      return version;
    }

    if (mode === "email" && !preview) {
      if (!email) throw new Error("Set email in Config.gs for email update notices");
      MailApp.sendEmail(email, "GAS-ICS-Sync update available: " + version.key,
        "An update is available from " + repo + ": " + version.url);
      properties.setProperty(propertyKey, version.key);
      Logger.log("Sent update notice for " + version.key);
      return version;
    }

    // Fetch all root-level Apps Script sources at the same immutable ref.
    var contentsUrl = api + "/contents?ref=" + encodeURIComponent(version.ref);
    var listing = autoUpdateGithubJson_(contentsUrl);
    if (!Array.isArray(listing)) throw new Error("GitHub repository root is not a directory");
    var remoteFiles = [];
    var names = {};
    listing.forEach(function (entry) {
      if (entry.type !== "file") return;
      var name = entry.name;
      if (/^(Config|Filters)\.gs$/i.test(name)) return;
      if (!/\.gs$/.test(name) && name !== "appsscript.json") return;
      var source = autoUpdateRawFile_(repo, version.ref, name);
      var scriptName = name === "appsscript.json" ? "appsscript" : name.slice(0, -3);
      if (names[scriptName]) throw new Error("Duplicate script file " + scriptName);
      names[scriptName] = true;
      remoteFiles.push({ name: scriptName, type: name === "appsscript.json" ? "JSON" : "SERVER_JS", source: source });
    });
    ["Code", "Helpers", "ical.js", "tzid", "appsscript"].forEach(function (required) {
      if (!names[required]) throw new Error("Release is missing " + required);
    });
    var remoteHelpers = remoteFiles.filter(function (file) { return file.name === "Helpers"; })[0].source;
    var remoteCode = remoteFiles.filter(function (file) { return file.name === "Code"; })[0].source;
    var hasLegacyUpdater = /function\s+AutoUpdate\s*\(/.test(remoteHelpers);
    var hasSplitUpdater = /function\s+AutoUpdateImpl_\s*\(/.test(remoteHelpers) &&
      /function\s+AutoUpdate\s*\(/.test(remoteCode);
    if (!hasLegacyUpdater && !hasSplitUpdater)
      throw new Error("Selected version does not contain AutoUpdate; publish this updater to the fork first");

    var manifest = remoteFiles.filter(function (file) { return file.name === "appsscript"; })[0];
    var manifestObject = JSON.parse(manifest.source);
    var projectUrl = "https://script.googleapis.com/v1/projects/" +
      encodeURIComponent(ScriptApp.getScriptId()) + "/content";
    var current = autoUpdateScriptRequest_(projectUrl, "get");
    if (!Array.isArray(current.files)) throw new Error("Apps Script returned no project files");
    var currentManifest = current.files.filter(function (file) { return file.name === "appsscript"; })[0];
    if (!currentManifest) throw new Error("This Apps Script project has no manifest");
    var currentManifestObject = JSON.parse(currentManifest.source);
    var requiredScopes = ["https://www.googleapis.com/auth/script.projects",
      "https://www.googleapis.com/auth/script.external_request"];
    if (Array.isArray(currentManifestObject.oauthScopes))
      requiredScopes = requiredScopes.concat(currentManifestObject.oauthScopes);
    if (!Array.isArray(manifestObject.oauthScopes)) manifestObject.oauthScopes = [];
    requiredScopes.forEach(function (scope) {
      if (manifestObject.oauthScopes.indexOf(scope) < 0) manifestObject.oauthScopes.push(scope);
    });
    manifest.source = JSON.stringify(manifestObject, null, 2);
    var preserved = current.files.filter(function (file) {
      return !names[file.name] || /^(Config|Filters)$/i.test(file.name);
    }).map(function (file) { return { name: file.name, type: file.type, source: file.source }; });
    if (!preserved.some(function (file) { return file.name.toLowerCase() === "config"; }))
      throw new Error("This Apps Script project has no Config.gs to preserve");
    if (!preserved.some(function (file) { return file.name.toLowerCase() === "filters"; }))
      throw new Error("This Apps Script project has no Filters.gs to preserve");
    version.files = remoteFiles.map(function (file) { return file.name; });
    if (preview) {
      Logger.log("Would install " + version.key + " from " + version.url +
        "; managed files: " + version.files.join(", "));
      return version;
    }

    autoUpdateScriptRequest_(projectUrl, "put", { files: remoteFiles.concat(preserved) });
    properties.setProperty(propertyKey, version.key);
    Logger.log("Installed " + version.key + " from " + version.url);
    return version;
  } finally {
    lock.releaseLock();
  }
}

function autoUpdateGithubJson_(url) {
  var headers = { Accept: "application/vnd.github+json", "User-Agent": "GAS-ICS-Sync-AutoUpdate" };
  var token = String(PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN") || "").trim();
  if (token) headers.Authorization = "Bearer " + token;
  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: headers
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    var responseText = response.getContentText("UTF-8");
    var message = responseText;
    try { message = JSON.parse(responseText).message || responseText; } catch (e) { }
    throw new Error("GitHub API returned HTTP " + status + " for " + url + ": " +
      String(message).slice(0, 300));
  }
  return JSON.parse(response.getContentText("UTF-8"));
}

function autoUpdateRawFile_(repo, ref, name) {
  // Raw URLs cannot reliably access private repositories. Use the authenticated
  // Contents API when a token is configured, at the same pinned ref as the listing.
  if (String(PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN") || "").trim()) {
    var apiUrl = "https://api.github.com/repos/" + repo + "/contents/" +
      encodeURIComponent(name) + "?ref=" + encodeURIComponent(ref);
    var file = autoUpdateGithubJson_(apiUrl);
    if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string")
      throw new Error("GitHub returned no base64 content for " + name);
    return Utilities.newBlob(Utilities.base64Decode(file.content.replace(/\s/g, "")))
      .getDataAsString("UTF-8");
  }
  var url = "https://raw.githubusercontent.com/" + repo + "/" +
    encodeURIComponent(ref) + "/" + encodeURIComponent(name);
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300)
    throw new Error("GitHub file download returned HTTP " + status + " for " + name);
  return response.getContentText("UTF-8");
}

function autoUpdateScriptRequest_(url, method, body) {
  var options = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }
  };
  if (body) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }
  var response = UrlFetchApp.fetch(url, options);
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    var errorText = response.getContentText("UTF-8");
    if (status === 403 && /Apps Script API has not been used in project|Apps Script API.*disabled/i.test(errorText))
      throw new Error("Enable the Apps Script API in this script's Google Cloud project, then retry. " +
        "Find the project in Apps Script > Project Settings. If its default Cloud project is inaccessible, " +
        "attach a standard Cloud project first. Also enable Apps Script API access at " +
        "https://script.google.com/home/usersettings.");
    throw new Error("Apps Script API returned HTTP " + status + ": " + errorText.slice(0, 300));
  }
  return JSON.parse(response.getContentText("UTF-8"));
}

