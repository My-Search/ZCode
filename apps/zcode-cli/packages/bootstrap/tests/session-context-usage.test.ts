import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
  type SessionProjection,
} from "@zcode/contracts";
import { resolveSessionContextUsage } from "../src/zcode-protocol/session-mapper.js";

function assistantMessage(tokens: {
  total?: number;
  input: number;
  output: number;
}): MessageWithParts {
  return {
    info: {
      id: "msg_assistant",
      sessionID: "session_1",
      role: "assistant",
      time: { created: 1 },
      tokens: { ...tokens, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  } as unknown as MessageWithParts;
}

function mainTurnComplete(contextUsageBreakdown: { source: string; chars: number }[]): SessionEvent {
  return {
    id: "evt_1",
    sessionID: "session_1",
    type: SessionEventType.ModelComplete,
    timestamp: new Date(0),
    payload: {
      content: "streamed reply",
      querySource: "main_turn",
      stopReason: "stop",
      usage: { inputTokens: 0, outputTokens: 328, totalTokens: 328 },
      contextUsageBreakdown,
    },
  } as unknown as SessionEvent;
}

function sessionProjection(contextUsed: number): SessionProjection {
  return {
    contextUsed,
    contextWindow: 1_000_000,
  } as SessionProjection;
}

describe("resolveSessionContextUsage", () => {
  it("estimates from request breakdown when streaming usage has no input tokens", () => {
    const usage = resolveSessionContextUsage({
      messages: [assistantMessage({ input: 0, output: 328, total: 328 })],
      persistedContextUsageBreakdownEvents: [
        mainTurnComplete([
          { source: "messages", chars: 900 },
          { source: "system_prompt", chars: 600 },
        ]),
      ],
      projection: sessionProjection(0),
    });

    // 1500 字符 / 3 + 328 output；不能退回成 output-only 的 328。
    expect(usage).toMatchObject({ used: 828, size: 1_000_000 });
  });

  it("keeps provider context usage when the latest assistant has input tokens", () => {
    const usage = resolveSessionContextUsage({
      messages: [assistantMessage({ input: 12_000, output: 200, total: 12_200 })],
      projection: sessionProjection(12_200),
    });

    expect(usage).toMatchObject({ used: 12_200, size: 1_000_000 });
  });
});
