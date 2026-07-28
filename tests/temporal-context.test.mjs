import assert from "node:assert/strict"
import test from "node:test"
import TemporalContextPlugin from "../dist/temporal-context.js"

function message(id, role, created, options = {}) {
  return {
    info: {
      id,
      sessionID: "session-1",
      role,
      time: { created },
      ...(options.summary ? { summary: true } : {}),
    },
    parts:
      options.parts ??
      (options.compaction
        ? [{ id: `${id}-part`, sessionID: "session-1", messageID: id, type: "compaction" }]
        : [{ id: `${id}-part`, sessionID: "session-1", messageID: id, type: "text", text: id }]),
  }
}

function at(iso) {
  return Date.parse(iso)
}

function markers(messages) {
  return messages.flatMap((item) =>
    item.parts
      .filter((part) => part.type === "text" && part.metadata?.opencode_temporal_context === true)
      .map((part) => ({ message: item.info.id, text: part.text })),
  )
}

async function withNow(now, callback) {
  const original = Date.now
  Date.now = () => now
  try {
    return await callback()
  } finally {
    Date.now = original
  }
}

async function hooks(timeZone = zone) {
  return TemporalContextPlugin({}, { timeZone })
}

async function transformMessages(messages, now, timeZone = zone) {
  const plugin = await hooks(timeZone)
  await withNow(now, () => plugin["experimental.chat.messages.transform"]({}, { messages }))
}

async function transformSystem(system, now, timeZone = zone) {
  const plugin = await hooks(timeZone)
  await withNow(now, () => plugin["experimental.chat.system.transform"]({}, { system }))
}

async function compactingContext(context, now, timeZone = zone) {
  const plugin = await hooks(timeZone)
  await withNow(now, () => plugin["experimental.session.compacting"]({ sessionID: "session-1" }, { context }))
}

const zone = "Europe/Berlin"
const now = at("2026-07-30T09:00:00+02:00")

test("exposes exactly one loader-safe plugin export", async () => {
  const module = await import("../dist/temporal-context.js")
  assert.deepEqual(Object.keys(module), ["default"])

  const loaded = []
  for (const initializer of Object.values(module)) loaded.push(await initializer({}, { timeZone: zone }))
  assert.equal(loaded.length, 1)
  assert.equal(typeof loaded[0]["experimental.chat.messages.transform"], "function")
})

test("rejects an invalid configured timezone during initialization", async () => {
  await assert.rejects(() => hooks("Not/A_Timezone"), /Invalid IANA timezone/)
})

test("assigns calendar dates in the configured timezone across DST", async () => {
  const dstNow = at("2026-03-30T09:00:00+02:00")
  const messages = [
    message("u1", "user", at("2026-03-28T23:30:00Z")),
    message("a1", "assistant", at("2026-03-29T00:31:00Z")),
    message("u2", "user", at("2026-03-29T22:30:00Z")),
  ]
  await transformMessages(messages, dstNow)
  assert.deepEqual(markers(messages), [
    { message: "u1", text: '<conversation_date value="2026-03-29"/>' },
    { message: "u2", text: '<conversation_date current="true"/>' },
  ])
})

test("adds no markers when all visible user turns are from today", async () => {
  const messages = [
    message("u1", "user", at("2026-07-30T08:00:00+02:00")),
    message("a1", "assistant", at("2026-07-30T08:01:00+02:00")),
  ]
  await transformMessages(messages, now)
  assert.deepEqual(markers(messages), [])
})

test("adds one absolute marker per historical user-turn day and a relative current boundary", async () => {
  const messages = [
    message("u1", "user", at("2026-07-28T08:00:00+02:00")),
    message("a1", "assistant", at("2026-07-28T08:01:00+02:00")),
    message("u2", "user", at("2026-07-29T08:00:00+02:00")),
    message("a2", "assistant", at("2026-07-29T08:01:00+02:00")),
    message("u3", "user", at("2026-07-30T08:00:00+02:00")),
  ]
  await transformMessages(messages, now)
  assert.deepEqual(markers(messages), [
    { message: "u1", text: '<conversation_date value="2026-07-28"/>' },
    { message: "u2", text: '<conversation_date value="2026-07-29"/>' },
    { message: "u3", text: '<conversation_date current="true"/>' },
  ])
})

test("three hundred messages on one historical day produce one marker", async () => {
  const messages = Array.from({ length: 300 }, (_, index) =>
    message(`m${index}`, index % 2 === 0 ? "user" : "assistant", at("2026-07-29T12:00:00+02:00") + index),
  )
  await transformMessages(messages, now)
  assert.equal(markers(messages).length, 1)
  assert.equal(markers(messages)[0]?.message, "m0")
})

test("assistant reasoning and tool parts remain unchanged across midnight", async () => {
  const assistant = message("a1", "assistant", at("2026-07-30T00:01:00+02:00"), {
    parts: [
      { id: "step", sessionID: "session-1", messageID: "a1", type: "step-start" },
      {
        id: "reasoning",
        sessionID: "session-1",
        messageID: "a1",
        type: "reasoning",
        text: "thinking",
        metadata: { openai: { itemId: "reasoning-1" } },
      },
      { id: "tool", sessionID: "session-1", messageID: "a1", type: "tool" },
    ],
  })
  const originalParts = structuredClone(assistant.parts)
  const messages = [
    message("u1", "user", at("2026-07-29T23:59:00+02:00")),
    assistant,
    message("u2", "user", at("2026-07-30T08:00:00+02:00")),
  ]
  await transformMessages(messages, now)
  assert.deepEqual(assistant.parts, originalParts)
  assert.deepEqual(markers(messages), [
    { message: "u1", text: '<conversation_date value="2026-07-29"/>' },
    { message: "u2", text: '<conversation_date current="true"/>' },
  ])
})

test("compaction controls are ignored and the summary starts a new raw-history segment", async () => {
  const messages = [
    message("compact", "user", now, { compaction: true }),
    message("summary", "assistant", now, { summary: true }),
    message("tail-u", "user", at("2026-07-29T15:00:00+02:00")),
    message("tail-a", "assistant", at("2026-07-29T15:01:00+02:00")),
    message("continue", "user", at("2026-07-30T09:01:00+02:00")),
  ]
  await transformMessages(messages, now)
  assert.deepEqual(markers(messages), [
    { message: "tail-u", text: '<conversation_date value="2026-07-29"/>' },
    { message: "continue", text: '<conversation_date current="true"/>' },
  ])
})

test("message transformation is idempotent without removing user-authored marker text", async () => {
  const authored = message("u1", "user", at("2026-07-29T08:00:00+02:00"), {
    parts: [
      {
        id: "authored",
        sessionID: "session-1",
        messageID: "u1",
        type: "text",
        text: '<conversation_date value="2020-01-01"/>',
      },
    ],
  })
  const messages = [authored]
  await transformMessages(messages, now)
  await transformMessages(messages, now)
  assert.equal(markers(messages).length, 1)
  assert.equal(authored.parts.filter((part) => part.id === "authored").length, 1)
})

test("system prompt date is normalized and instruction is added only once", async () => {
  const system = ["<env>\n  Today's date: Thu Jul 30 2026\n</env>"]
  await transformSystem(system, now)
  await transformSystem(system, now)
  assert.match(system[0], /Current date: 2026-07-30 \(Thursday; timezone: Europe\/Berlin\)/)
  assert.equal(system.filter((item) => item.includes("<temporal_metadata>")).length, 1)
  assert.match(system.at(-1), /immediately before user turns/)
})

test("compaction context resolves current markers and asks for selective retention", async () => {
  const context = []
  await compactingContext(context, now)
  assert.equal(context.length, 1)
  assert.match(context[0], /current="true" means 2026-07-30/)
  assert.match(context[0], /only when losing it could change chronology/)
  assert.match(context[0], /following assistant response/)
})
