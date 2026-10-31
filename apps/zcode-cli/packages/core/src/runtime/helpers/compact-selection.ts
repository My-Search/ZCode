import {
  CompactTrigger,
  countContextPrefixMessages,
  estimateMessageTokens,
} from "../deps.js";
import {
  cloneRuntimeMessageEntry,
  isContextPrefixEntry,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../../compact/rounds.js";
import { buildProviderRequestMessages } from "./provider-request-messages.js";

export interface CompactEntrySelection {
  entriesForSummary: RuntimeMessageEntry[];
  groupsPreserved: number;
  preservedEntries: RuntimeMessageEntry[];
  totalGroups: number;
}

export function selectCompactEntries(input: {
  entries: readonly RuntimeMessageEntry[];
  minimumGroupsToPreserve?: number;
  trigger: CompactTrigger;
}): CompactEntrySelection {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  const baseGroupsToPreserve = split.shouldPreserveRecent && split.groups.length > 1 ? 1 : 0;
  const requestedGroupsToPreserve = Math.max(
    baseGroupsToPreserve,
    positiveInt(input.minimumGroupsToPreserve) ?? 0,
  );
  const maxGroupsToPreserve = Math.max(0, split.groups.length - 1);
  // 显式指定保留组数时（prompt-too-long 重选）manual 也必须保留；
  // 否则 /compact 只能靠丢弃最老轮次来缩短摘要请求，摘要完成后却替换全部历史。
  const groupsToPreserve =
    split.shouldPreserveRecent || requestedGroupsToPreserve > 0
      ? Math.min(requestedGroupsToPreserve, maxGroupsToPreserve)
      : 0;
  const summaryGroups =
    groupsToPreserve > 0
      ? split.groups.slice(0, split.groups.length - groupsToPreserve)
      : split.groups;
  const preservedGroups = groupsToPreserve > 0 ? split.groups.slice(-groupsToPreserve) : [];

  return {
    entriesForSummary: [...split.prefixEntries, ...summaryGroups.flat()].map(cloneRuntimeEntry),
    groupsPreserved: groupsToPreserve,
    preservedEntries: preservedGroups.flat().map(cloneRuntimeEntry),
    totalGroups: split.groups.length,
  };
}

export function selectCompactEntriesAfterPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
  currentGroupsPreserved: number;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  // Manual compact 也允许在摘要请求超长时把最近轮次移入保留段：
  // 这样旧内容进入摘要、最近内容原样保留，不会出现“摘要没看到最老轮次却被替换”的静默丢失。
  const canPreserveRecent =
    split.shouldPreserveRecent || input.trigger === CompactTrigger.Manual;
  if (!canPreserveRecent || split.groups.length < 2) {
    return null;
  }

  const maxGroupsToPreserve = split.groups.length - 1;
  if (input.currentGroupsPreserved >= maxGroupsToPreserve) {
    return null;
  }

  const summarizedGroupCount = split.groups.length - input.currentGroupsPreserved;
  const groupsForSummary = split.groups.slice(0, summarizedGroupCount);
  if (groupsForSummary.length < 2) {
    return null;
  }

  const groupsToMove = countRecentGroupsToPreserveAfterPromptTooLong(
    groupsForSummary,
    input.promptTooLongCause,
    { useMidConversationSystem: input.useMidConversationSystem },
  );
  const nextGroupsPreserved = Math.min(
    maxGroupsToPreserve,
    input.currentGroupsPreserved + groupsToMove,
  );
  if (nextGroupsPreserved <= input.currentGroupsPreserved) {
    return null;
  }

  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: nextGroupsPreserved,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function selectCompactEntriesForInitialPromptTooLong(input: {
  entries: readonly RuntimeMessageEntry[];
  promptTooLongCause: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection | null {
  const split = splitRuntimeEntriesForCompactSelection(input.entries, input.trigger);
  if (!split.shouldPreserveRecent || split.groups.length <= 3) {
    return null;
  }

  const tokenGap = getPromptTooLongTokenGap(input.promptTooLongCause);
  if (tokenGap === undefined) {
    return null;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(split.groups, {
    useMidConversationSystem: input.useMidConversationSystem,
  });
  const alreadyPreservedTokens = groupTokenEstimates.at(-1) ?? 0;
  const remainingTokenGap = tokenGap - alreadyPreservedTokens;
  if (remainingTokenGap <= 0) {
    return null;
  }

  const additionalGroupsToPreserve = countRecentGroupsToCoverTokenGap(
    groupTokenEstimates,
    split.groups.length - 1,
    remainingTokenGap,
  );
  const nextSelection = selectCompactEntries({
    entries: input.entries,
    minimumGroupsToPreserve: 1 + additionalGroupsToPreserve,
    trigger: input.trigger,
  });
  return hasEnoughRuntimeEntriesToCompact(nextSelection.entriesForSummary) ? nextSelection : null;
}

export function getRuntimeEntriesToSummarize(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.filter((entry) => !isContextPrefixEntry(entry)).map(cloneRuntimeEntry);
}

export function hasEnoughRuntimeEntriesToCompact(entries: readonly RuntimeMessageEntry[]): boolean {
  const entriesToSummarize = getRuntimeEntriesToSummarize(entries);
  return (
    groupRuntimeEntriesByCompactRound(entriesToSummarize).length >= 2 &&
    entriesToSummarize.some((entry) => runtimeEntryRole(entry) === "assistant")
  );
}

export function estimateRuntimeEntryTokens(
  entries: readonly RuntimeMessageEntry[],
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const providerMessages = buildProviderRequestMessages({
    entries,
    applyCacheControl: false,
    useMidConversationSystem: options.useMidConversationSystem,
  }).messages;
  return estimateMessageTokens(providerMessages);
}

function splitRuntimeEntriesForCompactSelection(
  inputEntries: readonly RuntimeMessageEntry[],
  trigger: CompactTrigger,
): {
  groups: RuntimeMessageEntry[][];
  prefixEntries: RuntimeMessageEntry[];
  shouldPreserveRecent: boolean;
} {
  const entries = inputEntries.map(cloneRuntimeEntry);
  const prefixCount = countContextPrefixMessages(entries);
  const prefixEntries = entries.slice(0, prefixCount);
  const bodyEntries = entries.slice(prefixCount);

  return {
    groups: groupRuntimeEntriesByCompactRound(bodyEntries),
    prefixEntries,
    shouldPreserveRecent: trigger === CompactTrigger.Auto || trigger === CompactTrigger.Reactive,
  };
}

function countRecentGroupsToPreserveAfterPromptTooLong(
  groupsForSummary: readonly RuntimeMessageEntry[][],
  promptTooLongCause: unknown,
  options: { useMidConversationSystem?: boolean } = {},
): number {
  const tokenGap = getPromptTooLongTokenGap(promptTooLongCause);
  if (tokenGap === undefined) {
    return 1;
  }

  const groupTokenEstimates = estimateCompactGroupTokens(groupsForSummary, {
    useMidConversationSystem: options.useMidConversationSystem,
  });
  return countRecentGroupsToCoverTokenGap(groupTokenEstimates, groupsForSummary.length, tokenGap);
}

function countRecentGroupsToCoverTokenGap(
  groupTokenEstimates: readonly number[],
  groupCount: number,
  tokenGap: number,
): number {
  if (tokenGap <= 0 || groupCount <= 0) {
    return 0;
  }

  let tokensCovered = 0;
  let groupsCovered = 0;
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    tokensCovered += groupTokenEstimates[index] ?? 0;
    groupsCovered += 1;
    if (tokensCovered >= tokenGap) break;
  }

  if (groupsCovered >= groupCount - 1) {
    return Math.max(1, Math.floor(groupCount / 2));
  }
  return Math.max(1, groupsCovered);
}

function estimateCompactGroupTokens(
  groups: readonly RuntimeMessageEntry[][],
  options: { useMidConversationSystem?: boolean } = {},
): number[] {
  return groups.map((group) =>
    estimateRuntimeEntryTokens(group, {
      useMidConversationSystem: options.useMidConversationSystem,
    }),
  );
}

function groupRuntimeEntriesByCompactRound(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[][] {
  // 服务端内置工具把一条持久化 assistant 拆成多条 runtime assistant；共用 compactGroupKey 的
  // 必须算作一组，否则保留组数与 selectPersistedCompactTail 按数据库消息算出的边界不一致。
  return groupByAssistantStartedRounds(entries, runtimeEntryRole, runtimeEntryCompactGroupKey);
}

function runtimeEntryCompactGroupKey(entry: RuntimeMessageEntry): string | undefined {
  return isRuntimeAttachmentEntry(entry) ? undefined : entry.compactGroupKey;
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function getPromptTooLongTokenGap(cause: unknown): number | undefined {
  let current: unknown = cause;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (typeof current === "string") {
      const gap = parsePromptTooLongTokenGap(current);
      if (gap !== undefined) return gap;
      return undefined;
    }
    if (current === undefined || current === null || typeof current !== "object") {
      return undefined;
    }
    if (seen.has(current)) return undefined;
    seen.add(current);

    const record = current as Record<string, unknown>;
    for (const key of ["message", "errorDetails", "details", "body"]) {
      const value = record[key];
      if (typeof value === "string") {
        const gap = parsePromptTooLongTokenGap(value);
        if (gap !== undefined) return gap;
      }
    }
    current = record.cause ?? record.lastError ?? record.error;
  }

  return undefined;
}

function parsePromptTooLongTokenGap(message: string): number | undefined {
  const match = message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (!match) return undefined;

  const actual = Number(match[1]?.replace(/,/g, ""));
  const limit = Number(match[2]?.replace(/,/g, ""));
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || actual <= limit) {
    return undefined;
  }
  return Math.ceil(actual - limit);
}

function cloneRuntimeEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  return cloneRuntimeMessageEntry(entry);
}

function runtimeEntryRole(entry: RuntimeMessageEntry): "system" | "user" | "assistant" | "tool" {
  if (isRuntimeAttachmentEntry(entry)) return "user";
  return entry.message.role;
}
