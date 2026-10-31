import { describe, expect, it } from "vitest";
import { estimateContextTokensFromUsageBreakdown } from "@zcode/shared";

import {
  SessionEventType,
  createModelUsageSummary,
  createModelUsageSummaryFromEvents,
  createSessionEvent,
  getModelUsageContextTokens,
  getModelUsageInputWindowTokens,
  getModelUsageTotalTokens,
  modelMessageContentToText,
} from "../src/index.js";
import type { SessionId, TraceId } from "../src/index.js";

describe("model usage contracts", () => {
  it("summarizes provider usage without double-counting cache breakdowns", () => {
    const summary = createModelUsageSummary([
      {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        reasoningTokens: 5,
      },
      {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    ]);

    expect(summary).toEqual({
      source: "provider",
      modelRequestCount: 2,
      inputTokens: 130,
      outputTokens: 34,
      totalTokens: 164,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      reasoningTokens: 5,
      webFetchRequests: 0,
      webSearchRequests: 0,
    });
  });

  it("summarizes provider-native server tool usage", () => {
    const summary = createModelUsageSummary([
      {
        inputTokens: 12,
        outputTokens: 8,
        serverToolUse: { webSearchRequests: 2 },
      },
      {
        serverToolUse: { webFetchRequests: 1 },
      },
    ]);

    expect(summary).toEqual({
      source: "provider",
      modelRequestCount: 2,
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webFetchRequests: 1,
      webSearchRequests: 2,
    });
  });

  it("falls back to cache fields only when input tokens are absent", () => {
    expect(
      getModelUsageTotalTokens({
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      }),
    ).toBe(15);
  });

  it("computes context usage without double-counting cache breakdowns", () => {
    expect(
      getModelUsageContextTokens({
        inputTokens: 137_154,
        outputTokens: 56,
        totalTokens: 137_210,
        cacheReadTokens: 136_896,
      }),
    ).toBe(137_210);
    expect(getModelUsageContextTokens({ inputTokens: 10, outputTokens: 4 })).toBe(14);
    expect(getModelUsageContextTokens({ totalTokens: 10, cacheReadTokens: 4 })).toBe(10);
  });

  it("uses normalized total input as input window tokens", () => {
    expect(
      getModelUsageInputWindowTokens({
        inputTokens: 137_154,
        outputTokens: 56,
        totalTokens: 137_210,
        cacheReadTokens: 136_896,
      }),
    ).toBe(137_154);
    expect(getModelUsageInputWindowTokens({ outputTokens: 3, cacheReadTokens: 5 })).toBe(5);
  });

  it("treats output-only streaming usage as missing input, not as context usage", () => {
    // 流式 Anthropic 代理只在 message_start 回 input_tokens=0，最终只带 output_tokens；
    // 这类 usage 不能渲染成 328/1M 的假水位。
    expect(
      getModelUsageContextTokens({
        inputTokens: 0,
        outputTokens: 328,
        totalTokens: 328,
      }),
    ).toBeUndefined();
    expect(
      getModelUsageContextTokens({
        outputTokens: 328,
        totalTokens: 328,
      }),
    ).toBeUndefined();
    expect(
      getModelUsageInputWindowTokens({
        inputTokens: 0,
        outputTokens: 328,
        totalTokens: 328,
      }),
    ).toBeUndefined();
  });

  it("estimates context usage from the request breakdown when input usage is missing", () => {
    expect(
      estimateContextTokensFromUsageBreakdown([{ chars: 600 }, { chars: 300 }], 20),
    ).toBe(320);
    expect(estimateContextTokensFromUsageBreakdown([], 20)).toBeUndefined();
  });

  it("collects model usage from model_complete events", () => {
    const sessionId = "session-usage" as SessionId;
    const traceId = "trace-usage" as TraceId;
    const summary = createModelUsageSummaryFromEvents([
      createSessionEvent(
        SessionEventType.ModelComplete,
        sessionId,
        {
          content: "first",
          stopReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
        { traceId },
      ),
      createSessionEvent(
        SessionEventType.ModelComplete,
        sessionId,
        {
          content: "second",
          stopReason: "stop",
          usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
        },
        { traceId },
      ),
    ]);

    expect(summary?.modelRequestCount).toBe(2);
    expect(summary?.totalTokens).toBe(37);
  });

  it("converts structured model message content to stable text placeholders", () => {
    expect(
      modelMessageContentToText([
        { type: "text", text: "hello" },
        {
          type: "image",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
          source: { id: "image-1", kind: "inline", placeholder: "[Image 1]" },
        },
        { type: "resource_link", uri: "file://README.md", title: "README" },
      ]),
    ).toBe("hello\n\n[Attached image/png: [Image 1]]\n\n[Resource: README]");
  });

  it("counts failed response usage once alongside completed model usage", () => {
    const sessionId = "usage" as SessionId;
    const events = [
      createSessionEvent(SessionEventType.ModelNetworkStatus, sessionId, {
        type: "model_request_completed",
        usage: { inputTokens: 3, outputTokens: 1 },
      }),
      createSessionEvent(SessionEventType.ModelComplete, "usage" as SessionId, {
        content: "recovered",
        stopReason: "stop",
        usage: { inputTokens: 3, outputTokens: 1 },
      }),
    ];
    const failed = createSessionEvent(SessionEventType.ModelNetworkStatus, sessionId, {
      type: "model_request_failed",
      requestId: "overflow",
      reason: "context_exceeded",
      usage: { inputTokens: 80, outputTokens: 5 },
    });
    expect(createModelUsageSummaryFromEvents([...events, failed])).toMatchObject({
      inputTokens: 83,
      outputTokens: 6,
      totalTokens: 89,
      modelRequestCount: 2,
    });
    expect(createModelUsageSummaryFromEvents(events)?.totalTokens).toBe(4);
    expect(
      createModelUsageSummaryFromEvents([
        createSessionEvent(SessionEventType.ModelNetworkStatus, sessionId, {
          type: "model_request_failed",
          usage: {},
        }),
      ]),
    ).toBeUndefined();
    expect(
      createModelUsageSummaryFromEvents([
        createSessionEvent(SessionEventType.ModelNetworkStatus, sessionId, {
          type: "model_request_failed",
          usage: { totalTokens: 0 },
        }),
      ]),
    ).toMatchObject({ totalTokens: 0, modelRequestCount: 1 });
  });
});
