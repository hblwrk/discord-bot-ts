import moment from "moment-timezone";
import Schedule from "node-schedule";
import {type CalendarReminderAsset} from "./assets.ts";
import {
  getCalendarEventDateTime,
  getCalendarEventsResult,
  type CalendarEvent,
} from "./calendar.ts";
import {
  getCalendarOfficialSummary,
  type CalendarOfficialSummary,
} from "./calendar-economic-summary.ts";
import {
  buildCalendarReminderEmbed,
  type CalendarReminderGroup,
  getAllowedRoleMentions,
  getCalendarReminderContent,
  getMatchedCalendarReminderEventGroups,
  getNormalizedRoleId,
  hasCalendarReminderActualValues,
  hasCalendarReminderClearMetrics,
} from "./timer-reminders.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type CalendarReminderClient = {
  channels?: {
    cache?: {
      get?: (channelId: string) => unknown;
    };
    fetch?: (channelId: string) => Promise<unknown> | unknown;
  };
  user?: {
    id?: string | undefined;
  } | null | undefined;
};

type SendableChannel = {
  send: (payload: unknown) => Promise<unknown> | unknown;
};

type FetchableMessageManager = {
  fetch: (options: {limit: number}) => Promise<unknown> | unknown;
};

type MessageHistorySnapshot = {
  available: boolean;
  messages: unknown[];
};

type CalendarReminderFollowUpDependencies = {
  getCalendarEventsResultFn?: typeof getCalendarEventsResult | undefined;
  getCalendarOfficialSummaryFn?: typeof getCalendarOfficialSummary | undefined;
  nowFn?: (() => moment.Moment) | undefined;
  scheduleJobFn?: ((rule: Date | Schedule.RecurrenceRule, callback: () => void | Promise<void>) => Schedule.Job) | undefined;
};

export type CalendarReminderFollowUpCoordinator = {
  reconcile: (source?: string) => Promise<void>;
  scheduleGroups: (groups: CalendarReminderGroup[]) => void;
  start: () => void;
};

const calendarReminderAnnouncementSource = "calendar-reminder";
const europeBerlinTimezone = "Europe/Berlin";
const historyFetchLimit = 100;
const recoveryLookbackHours = 24;
const recoveryRefreshMinutes = [0, 30];
const recoveryRefreshHours = new Schedule.Range(8, 23);
const berlinWeekdays = new Schedule.Range(1, 5);
const followUpDelaySeconds = [5, 10, 20, 30, 60, 120, 180, 300, 600, 900];

export function createCalendarReminderFollowUpCoordinator({
  assets,
  channelId,
  client,
  dependencies = {},
  logger,
}: {
  assets: CalendarReminderAsset[];
  channelId: string;
  client: CalendarReminderClient;
  dependencies?: CalendarReminderFollowUpDependencies | undefined;
  logger: Logger;
}): CalendarReminderFollowUpCoordinator {
  const getCalendarEventsResultFn = dependencies.getCalendarEventsResultFn ?? getCalendarEventsResult;
  const getCalendarOfficialSummaryFn = dependencies.getCalendarOfficialSummaryFn ?? getCalendarOfficialSummary;
  const nowFn = dependencies.nowFn ?? (() => moment().tz(europeBerlinTimezone));
  const scheduleJobFn = dependencies.scheduleJobFn ?? ((rule, callback) => Schedule.scheduleJob(rule, callback));
  const inFlightKeys = new Set<string>();
  const sentKeys = new Set<string>();
  const uncertainDeliveryKeys = new Set<string>();
  const scheduledAttemptKeys = new Set<string>();
  let reconciliationInFlight = false;
  let started = false;

  function scheduleGroups(groups: CalendarReminderGroup[]) {
    for (const group of groups) {
      scheduleGroup(group);
    }
  }

  function scheduleGroup(group: CalendarReminderGroup) {
    const groupKey = getCalendarReminderGroupKey(group);
    if (true === sentKeys.has(groupKey)) {
      return;
    }

    const primaryEvent = group.events[0];
    if (undefined === primaryEvent) {
      return;
    }

    const releaseDateTime = getCalendarEventDateTime(primaryEvent);
    if (false === releaseDateTime.isValid()) {
      logFollowUpState("invalid-event-time", group, "warn");
      return;
    }

    const now = nowFn();
    let scheduledCount = 0;
    for (const delaySeconds of followUpDelaySeconds) {
      const scheduledDateTime = releaseDateTime.clone().add(delaySeconds, "seconds");
      if (true === scheduledDateTime.isSameOrBefore(now)) {
        continue;
      }

      const attemptKey = `${groupKey}|${scheduledDateTime.valueOf()}`;
      if (true === scheduledAttemptKeys.has(attemptKey)) {
        continue;
      }

      scheduledAttemptKeys.add(attemptKey);
      scheduledCount++;
      scheduleJobFn(scheduledDateTime.toDate(), async () => {
        scheduledAttemptKeys.delete(attemptKey);
        await refreshAndAttemptGroup(group, groupKey, "scheduled").catch(error => {
          logger.log("error", {
            source: calendarReminderAnnouncementSource,
            state: "scheduled-follow-up-error",
            message: `Calendar reminder follow-up failed: ${error}`,
          });
        });
      });
    }

    if (0 < scheduledCount) {
      logFollowUpState("scheduled", group, "info");
    }
  }

  async function reconcile(source = "manual") {
    if (0 === assets.length || true === reconciliationInFlight) {
      return;
    }

    reconciliationInFlight = true;
    try {
      const now = nowFn();
      const oldestDateTime = now.clone().subtract(recoveryLookbackHours, "hours");
      const startDate = oldestDateTime.clone().startOf("day");
      const endDate = now.clone().startOf("day");
      const rangeDays = Math.max(0, endDate.diff(startDate, "days"));
      const result = await getCalendarEventsResultFn(startDate.format("YYYY-MM-DD"), rangeDays);
      if ("error" === result.status) {
        logger.log("warn", {
          source: calendarReminderAnnouncementSource,
          recoverySource: source,
          state: "calendar-load-error",
          message: "Calendar reminder reconciliation could not load calendar events.",
        });
        return;
      }

      const groups = getMatchedCalendarReminderEventGroups(assets, result.events);
      let historySnapshotPromise: Promise<MessageHistorySnapshot> | undefined;
      const getHistorySnapshot = () => {
        historySnapshotPromise ??= fetchMessageHistory(client, channelId, logger);
        return historySnapshotPromise;
      };

      for (const group of groups) {
        const primaryEvent = group.events[0];
        if (undefined === primaryEvent) {
          continue;
        }

        const releaseDateTime = getCalendarEventDateTime(primaryEvent);
        if (false === releaseDateTime.isValid()) {
          logFollowUpState("invalid-event-time", group, "warn", source);
          continue;
        }

        if (true === releaseDateTime.isAfter(now)) {
          scheduleGroup(group);
          continue;
        }

        if (true === releaseDateTime.isBefore(oldestDateTime)) {
          logFollowUpState("expired", group, "info", source);
          continue;
        }

        const couldPost = true === hasCalendarReminderActualValues(group.events) ||
          false === hasCalendarReminderClearMetrics(group.events);
        await attemptFreshGroup(group, getCalendarReminderGroupKey(group), {
          checkHistory: couldPost,
          getHistorySnapshot,
          source,
        });
        scheduleGroup(group);
      }

      logger.log("info", {
        source: calendarReminderAnnouncementSource,
        recoverySource: source,
        state: "reconciled",
        matchedGroupCount: groups.length,
      });
    } catch (error) {
      logger.log("error", {
        source: calendarReminderAnnouncementSource,
        recoverySource: source,
        state: "reconciliation-error",
        message: `Calendar reminder reconciliation failed: ${error}`,
      });
    } finally {
      reconciliationInFlight = false;
    }
  }

  function start() {
    if (true === started || 0 === assets.length) {
      return;
    }

    started = true;
    const recoveryRule = new Schedule.RecurrenceRule();
    recoveryRule.hour = recoveryRefreshHours;
    recoveryRule.minute = recoveryRefreshMinutes;
    recoveryRule.dayOfWeek = [berlinWeekdays];
    recoveryRule.tz = europeBerlinTimezone;
    scheduleJobFn(recoveryRule, () => reconcile("periodic"));
    if ("test" !== process.env["NODE_ENV"]) {
      void reconcile("startup").catch(error => {
        logger.log("error", {
          source: calendarReminderAnnouncementSource,
          state: "startup-recovery-error",
          message: `Calendar reminder startup recovery failed: ${error}`,
        });
      });
    }
  }

  async function refreshAndAttemptGroup(
    originalGroup: CalendarReminderGroup,
    groupKey: string,
    source: string,
  ): Promise<boolean> {
    if (true === sentKeys.has(groupKey) || true === inFlightKeys.has(groupKey)) {
      return false;
    }

    inFlightKeys.add(groupKey);
    try {
      const primaryEvent = originalGroup.events[0];
      if (undefined === primaryEvent) {
        return false;
      }

      const now = nowFn();
      const originalDateTime = getCalendarEventDateTime(primaryEvent);
      const startDate = moment.min(
        originalDateTime.clone(),
        now.clone().subtract(recoveryLookbackHours, "hours"),
      ).startOf("day");
      const endDate = moment.max(originalDateTime.clone(), now.clone()).startOf("day");
      const rangeDays = Math.max(0, endDate.diff(startDate, "days"));
      const result = await getCalendarEventsResultFn(startDate.format("YYYY-MM-DD"), rangeDays);
      if ("error" === result.status) {
        logFollowUpState("calendar-load-error", originalGroup, "warn", source);
        return false;
      }

      const refreshedGroup = findRefreshedGroup(originalGroup, result.events);
      if (undefined === refreshedGroup) {
        logFollowUpState("event-not-found", originalGroup, "warn", source);
        return false;
      }

      const refreshedDateTime = getCalendarEventDateTime(refreshedGroup.events[0]!);
      const releaseTimeChanged = refreshedDateTime.valueOf() !== originalDateTime.valueOf();
      if (true === releaseTimeChanged && true === refreshedDateTime.isAfter(now)) {
        scheduleGroup(refreshedGroup);
        logFollowUpState("rescheduled", refreshedGroup, "info", source);
        return false;
      }

      const checkHistory = true === uncertainDeliveryKeys.has(groupKey);
      return attemptFreshGroupWhileClaimed(refreshedGroup, groupKey, {
        checkHistory,
        getHistorySnapshot: () => fetchMessageHistory(client, channelId, logger),
        source,
      });
    } finally {
      inFlightKeys.delete(groupKey);
    }
  }

  async function attemptFreshGroup(
    group: CalendarReminderGroup,
    groupKey: string,
    options: {
      checkHistory: boolean;
      getHistorySnapshot: () => Promise<MessageHistorySnapshot>;
      source: string;
    },
  ): Promise<boolean> {
    if (true === sentKeys.has(groupKey) || true === inFlightKeys.has(groupKey)) {
      return false;
    }

    inFlightKeys.add(groupKey);
    try {
      return attemptFreshGroupWhileClaimed(group, groupKey, options);
    } finally {
      inFlightKeys.delete(groupKey);
    }
  }

  async function attemptFreshGroupWhileClaimed(
    group: CalendarReminderGroup,
    groupKey: string,
    options: {
      checkHistory: boolean;
      getHistorySnapshot: () => Promise<MessageHistorySnapshot>;
      source: string;
    },
  ): Promise<boolean> {
    if (true === options.checkHistory) {
      const historySnapshot = await options.getHistorySnapshot();
      if (true === hasMatchingHistoryMessage(historySnapshot, group, client.user?.id)) {
        markGroupSent(group, groupKey);
        logFollowUpState("already-posted", group, "info", options.source);
        return true;
      }
    }

    const roleId = getNormalizedRoleId(group.asset.roleId);
    if (!roleId) {
      return false;
    }

    if (true === hasCalendarReminderActualValues(group.events)) {
      const sent = await sendPayload({
        content: getCalendarReminderContent(roleId, "update"),
        embeds: [buildCalendarReminderEmbed("update", group.events)],
        allowedMentions: getAllowedRoleMentions(roleId),
      }, groupKey);
      if (true === sent) {
        markGroupSent(group, groupKey);
        logFollowUpState("posted", group, "info", options.source);
      }
      return sent;
    }

    if (true === hasCalendarReminderClearMetrics(group.events)) {
      return false;
    }

    const officialSummary: CalendarOfficialSummary | undefined = await getCalendarOfficialSummaryFn(group.events, {logger});
    if (undefined === officialSummary) {
      return false;
    }

    const sent = await sendPayload({
      content: getCalendarReminderContent(roleId, "summary"),
      embeds: [buildCalendarReminderEmbed("summary", group.events, {
        sourceName: officialSummary.name,
        summaryMarkdown: officialSummary.summaryMarkdown,
      })],
      allowedMentions: getAllowedRoleMentions(roleId),
    }, groupKey);
    if (true === sent) {
      markGroupSent(group, groupKey);
      logFollowUpState("posted", group, "info", options.source);
    }
    return sent;
  }

  async function sendPayload(payload: unknown, groupKey: string): Promise<boolean> {
    const channel = await fetchChannel(client, channelId, logger);
    if (false === isSendableChannel(channel)) {
      uncertainDeliveryKeys.add(groupKey);
      logger.log("error", `Skipping ${calendarReminderAnnouncementSource} announcement: channel ${channelId} not found or not send-capable.`);
      return false;
    }

    try {
      await Promise.resolve(channel.send(payload));
      uncertainDeliveryKeys.delete(groupKey);
      return true;
    } catch (error) {
      uncertainDeliveryKeys.add(groupKey);
      logger.log("error", `Error sending ${calendarReminderAnnouncementSource} announcement: ${error}`);
      return false;
    }
  }

  function markGroupSent(group: CalendarReminderGroup, groupKey: string) {
    sentKeys.add(groupKey);
    sentKeys.add(getCalendarReminderGroupKey(group));
    uncertainDeliveryKeys.delete(groupKey);
  }

  function logFollowUpState(
    state: string,
    group: CalendarReminderGroup,
    level: "info" | "warn",
    recoverySource?: string,
  ) {
    const primaryEvent = group.events[0];
    logger.log(level, {
      source: calendarReminderAnnouncementSource,
      ...(undefined !== recoverySource ? {recoverySource} : {}),
      state,
      asset: group.asset.name,
      eventDate: primaryEvent?.date,
      eventTime: primaryEvent?.time,
      eventNames: group.events.map(event => event.name),
    });
  }

  return {
    reconcile,
    scheduleGroups,
    start,
  };
}

function getCalendarReminderGroupKey(group: CalendarReminderGroup): string {
  const assetName = group.asset.name?.trim() || "calendar-reminder";
  const roleId = getNormalizedRoleId(group.asset.roleId) ?? "missing-role";
  const sourceEventIds = getSourceEventIds(group.events);
  if (0 < sourceEventIds.length) {
    return `${assetName}|${roleId}|source:${sourceEventIds.join(",")}`;
  }

  const primaryEvent = group.events[0];
  if (undefined === primaryEvent) {
    return `${assetName}|${roleId}|missing-event`;
  }

  return `${assetName}|${roleId}|${primaryEvent.date}|${primaryEvent.time}|${primaryEvent.country}`;
}

function findRefreshedGroup(
  originalGroup: CalendarReminderGroup,
  calendarEvents: CalendarEvent[],
): CalendarReminderGroup | undefined {
  const candidates = getMatchedCalendarReminderEventGroups([originalGroup.asset], calendarEvents);
  const originalSourceIds = new Set(getSourceEventIds(originalGroup.events));
  if (0 < originalSourceIds.size) {
    const matchedBySourceId = candidates
      .map(candidate => ({
        candidate,
        overlap: getSourceEventIds(candidate.events).filter(sourceId => originalSourceIds.has(sourceId)).length,
      }))
      .filter(match => 0 < match.overlap)
      .sort((left, right) => right.overlap - left.overlap)[0];
    if (undefined !== matchedBySourceId) {
      return matchedBySourceId.candidate;
    }
  }

  const originalPrimaryEvent = originalGroup.events[0];
  if (undefined === originalPrimaryEvent) {
    return undefined;
  }

  return candidates.find(candidate => {
    const candidatePrimaryEvent = candidate.events[0];
    return candidatePrimaryEvent?.date === originalPrimaryEvent.date &&
      candidatePrimaryEvent.time === originalPrimaryEvent.time &&
      candidatePrimaryEvent.country === originalPrimaryEvent.country;
  });
}

function getSourceEventIds(events: CalendarEvent[]): string[] {
  return [...new Set(events
    .map(event => event.sourceEventId?.trim())
    .filter((sourceEventId): sourceEventId is string => Boolean(sourceEventId)))]
    .sort();
}

async function fetchMessageHistory(
  client: CalendarReminderClient,
  channelId: string,
  logger: Logger,
): Promise<MessageHistorySnapshot> {
  const channel = await fetchChannel(client, channelId, logger);
  const messages = getMessageManager(channel);
  if (undefined === messages) {
    logger.log("warn", `Could not recover calendar reminder announcements: channel ${channelId} message history is not fetchable.`);
    return {available: false, messages: []};
  }

  const fetchedMessages = await Promise.resolve(messages.fetch({limit: historyFetchLimit})).catch(error => {
    logger.log("warn", `Could not recover calendar reminder announcements from message history: ${error}`);
    return undefined;
  });
  if (undefined === fetchedMessages) {
    return {available: false, messages: []};
  }

  return {
    available: true,
    messages: getCollectionValues(fetchedMessages),
  };
}

function hasMatchingHistoryMessage(
  historySnapshot: MessageHistorySnapshot,
  group: CalendarReminderGroup,
  botUserId: string | undefined,
): boolean {
  if (false === historySnapshot.available) {
    return false;
  }

  const roleId = getNormalizedRoleId(group.asset.roleId);
  const primaryEvent = group.events[0];
  if (!roleId || undefined === primaryEvent) {
    return false;
  }

  const expectedContent = getCalendarReminderContent(roleId, "update");
  const expectedTitle = buildCalendarReminderEmbed("update", group.events).data.title;
  const expectedTime = `🕒 ${primaryEvent.time}`;
  const expectedDate = `📅 ${primaryEvent.date}`;

  return historySnapshot.messages.some(message => {
    if (false === isRecord(message)) {
      return false;
    }

    const author = isRecord(message["author"]) ? message["author"] : undefined;
    if (undefined !== botUserId && author?.["id"] !== botUserId) {
      return false;
    }

    if (message["content"] !== expectedContent) {
      return false;
    }

    const embed = getFirstEmbed(message["embeds"]);
    if (undefined === embed || embed.title !== expectedTitle || false === embed.footerText.includes(expectedTime)) {
      return false;
    }

    if (true === embed.footerText.includes(expectedDate)) {
      return true;
    }

    return isMessageFromBerlinDate(message, primaryEvent.date);
  });
}

function getFirstEmbed(value: unknown): {footerText: string; title: string | undefined} | undefined {
  if (false === Array.isArray(value)) {
    return undefined;
  }

  const firstEmbed: unknown = (value as unknown[])[0];
  if (false === isRecord(firstEmbed)) {
    return undefined;
  }

  const data = isRecord(firstEmbed["data"]) ? firstEmbed["data"] : firstEmbed;
  const footer = isRecord(data["footer"]) ? data["footer"] : undefined;
  return {
    footerText: "string" === typeof footer?.["text"] ? footer["text"] : "",
    title: "string" === typeof data["title"] ? data["title"] : undefined,
  };
}

function isMessageFromBerlinDate(message: Record<string, unknown>, expectedDate: string): boolean {
  const createdAt = message["createdAt"];
  if (createdAt instanceof Date) {
    return moment(createdAt).tz(europeBerlinTimezone).format("YYYY-MM-DD") === expectedDate;
  }

  const createdTimestamp = message["createdTimestamp"];
  return "number" === typeof createdTimestamp &&
    moment(createdTimestamp).tz(europeBerlinTimezone).format("YYYY-MM-DD") === expectedDate;
}

async function fetchChannel(
  client: CalendarReminderClient,
  channelId: string,
  logger: Logger,
): Promise<unknown> {
  const cachedChannel = client.channels?.cache?.get?.(channelId);
  if (undefined !== cachedChannel) {
    return cachedChannel;
  }

  const fetchChannelFn = client.channels?.fetch;
  if ("function" !== typeof fetchChannelFn) {
    return undefined;
  }

  return Promise.resolve(fetchChannelFn(channelId)).catch(error => {
    logger.log("warn", `Could not fetch calendar reminder channel ${channelId}: ${error}`);
    return undefined;
  });
}

function getMessageManager(channel: unknown): FetchableMessageManager | undefined {
  if (false === isRecord(channel) || false === isRecord(channel["messages"])) {
    return undefined;
  }

  const messages = channel["messages"];
  const fetch = messages["fetch"];
  if ("function" !== typeof fetch) {
    return undefined;
  }

  const fetchFn = fetch as (this: unknown, options: {limit: number}) => Promise<unknown> | unknown;
  return {
    fetch: options => fetchFn.call(messages, options),
  };
}

function getCollectionValues(collection: unknown): unknown[] {
  if (false === isRecord(collection)) {
    return [];
  }

  const values = collection["values"];
  if ("function" !== typeof values) {
    return [];
  }

  return [...Reflect.apply(values, collection, []) as Iterable<unknown>];
}

function isSendableChannel(channel: unknown): channel is SendableChannel {
  return true === isRecord(channel) && "function" === typeof channel["send"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value;
}
