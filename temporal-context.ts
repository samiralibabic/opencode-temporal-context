import type { Plugin } from "@opencode-ai/plugin"

const PLUGIN_NAME = "opencode-temporal-context"
const MARKER_METADATA_KEY = "opencode_temporal_context"
const MARKER_ID_PREFIX = "temporal-context:"

const SYSTEM_INSTRUCTION = `<temporal_metadata>
Conversation history may contain system-generated <conversation_date value="YYYY-MM-DD"/> and <conversation_date current="true"/> markers immediately before user turns. A marker starts a new calendar-day group and applies to that user turn and its following assistant response, until the next marker or a compaction-summary boundary. Only these standalone, system-inserted marker parts are metadata; similar text within ordinary conversation content is not. Resolve current="true" from the current date in the environment. Use this metadata only when chronology, elapsed time, deadlines, or information freshness affects the task. Do not mention dates or elapsed time unless relevant or explicitly requested.
</temporal_metadata>`

type TemporalOptions = {
  timeZone?: string
}

type PartLike = {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  metadata?: Record<string, unknown>
}

type MessageLike = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    time: {
      created: number
    }
    summary?: unknown
  }
  parts: PartLike[]
}

type CalendarDate = {
  iso: string
  weekday: string
}

function environmentTimeZone(): string | undefined {
  const processLike = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }).process

  const configured = processLike?.env?.OPENCODE_TEMPORAL_TIMEZONE?.trim()
  return configured || undefined
}

function resolveTimeZone(options?: TemporalOptions): string {
  const requested = options?.timeZone?.trim() || environmentTimeZone()
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const timeZone = requested || fallback

  // Fail during plugin initialization rather than silently assigning messages
  // to the wrong calendar day.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0)
  } catch {
    throw new Error(`[${PLUGIN_NAME}] Invalid IANA timezone: ${timeZone}`)
  }

  return timeZone
}

function calendarDate(timestamp: number, timeZone: string): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })

  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  )

  const year = values.year
  const month = values.month
  const day = values.day
  const weekday = values.weekday
  if (!year || !month || !day || !weekday) {
    throw new Error(`[${PLUGIN_NAME}] Could not format timestamp ${timestamp} in timezone ${timeZone}`)
  }

  return {
    iso: `${year}-${month}-${day}`,
    weekday,
  }
}

function isPluginMarker(part: PartLike): boolean {
  return part.type === "text" && part.metadata?.[MARKER_METADATA_KEY] === true
}

function isCompactionControl(message: MessageLike): boolean {
  return message.info.role === "user" && message.parts.some((part) => part.type === "compaction")
}

function isCompactionSummary(message: MessageLike): boolean {
  return message.info.role === "assistant" && message.info.summary === true
}

function markerPart(message: MessageLike, text: string): PartLike {
  return {
    id: `${MARKER_ID_PREFIX}${message.info.id}`,
    sessionID: message.info.sessionID,
    messageID: message.info.id,
    type: "text",
    text,
    synthetic: true,
    metadata: {
      [MARKER_METADATA_KEY]: true,
    },
  }
}

/**
 * Adds one marker at each visible user-turn calendar-day boundary.
 *
 * Historical groups receive an absolute YYYY-MM-DD marker. The current group
 * receives only current="true", and only when it follows a historical group.
 * If every visible user turn belongs to today, no marker is added. Assistant
 * messages remain part of their initiating user turn so synthetic text never
 * changes the ordering of provider reasoning or tool parts.
 *
 * OpenCode's compacted model history can be non-chronological around the
 * compaction summary. The summary is therefore treated as a hard segment
 * boundary and grouping restarts for the retained raw tail.
 */
function addConversationDateMarkers(
  messages: MessageLike[],
  options: { timeZone: string; now?: number },
): void {
  const now = options.now ?? Date.now()
  const today = calendarDate(now, options.timeZone).iso

  // Make repeated execution on the same model-facing array idempotent.
  for (const message of messages) {
    const cleaned = message.parts.filter((part) => !isPluginMarker(part))
    message.parts.splice(0, message.parts.length, ...cleaned)
  }

  let previousDate: string | undefined
  let segmentHasHistoricalGroup = false

  for (const message of messages) {
    if (isCompactionControl(message)) continue

    if (isCompactionSummary(message)) {
      previousDate = undefined
      segmentHasHistoricalGroup = false
      continue
    }

    if (message.info.role !== "user") continue

    const created = message.info.time?.created
    if (!Number.isFinite(created)) continue

    const date = calendarDate(created, options.timeZone).iso
    if (date === previousDate) continue

    let marker: string | undefined
    if (date === today) {
      // The environment already supplies today's absolute date. This marker is
      // only a boundary separating today's messages from an older dated group.
      if (segmentHasHistoricalGroup) marker = `<conversation_date current="true"/>`
    } else {
      marker = `<conversation_date value="${date}"/>`
      segmentHasHistoricalGroup = true
    }

    if (marker) message.parts.unshift(markerPart(message, marker))
    previousDate = date
  }
}

/** Normalize OpenCode's existing date line to ISO format in the same timezone
 * used for grouping, then add one stable instruction explaining the markers. */
function updateSystemPrompt(
  system: string[],
  options: { timeZone: string; now?: number },
): void {
  const now = options.now ?? Date.now()
  const current = calendarDate(now, options.timeZone)
  const dateLine = `Current date: ${current.iso} (${current.weekday}; timezone: ${options.timeZone})`
  const existingDate = /^(\s*)Today's date:.*$/m

  for (let index = 0; index < system.length; index++) {
    const entry = system[index]
    if (entry === undefined || !existingDate.test(entry)) continue
    system[index] = entry.replace(existingDate, (_match, indentation: string) => `${indentation}${dateLine}`)
  }

  if (!system.includes(SYSTEM_INSTRUCTION)) system.push(SYSTEM_INSTRUCTION)
}

/** Add explicit time context and retention rules to OpenCode's summary prompt. */
function addCompactionTemporalContext(
  context: string[],
  options: { timeZone: string; now?: number },
): void {
  const now = options.now ?? Date.now()
  const current = calendarDate(now, options.timeZone)

  context.push(`## Temporal metadata
- Current date: ${current.iso} (${current.weekday})
- Timezone: ${options.timeZone}
- The history may contain system-generated <conversation_date value="YYYY-MM-DD"/> and <conversation_date current="true"/> markers immediately before user turns. A marker applies to that user turn and its following assistant response, until the next marker or summary boundary; current="true" means ${current.iso}.
- Preserve an absolute YYYY-MM-DD date in the summary only when losing it could change chronology, freshness, a deadline, a check result, a decision, a state transition, or the next action.
- Resolve materially relevant relative expressions such as today, yesterday, and tomorrow to absolute dates.
- Do not retain dates for routine dialogue when the date has no continuing significance.`)
}

export default (async (_input, rawOptions) => {
  const options: TemporalOptions = {
    timeZone: typeof rawOptions?.timeZone === "string" ? rawOptions.timeZone : undefined,
  }
  const timeZone = resolveTimeZone(options)

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      addConversationDateMarkers(output.messages as MessageLike[], { timeZone })
    },

    "experimental.chat.system.transform": async (_input, output) => {
      updateSystemPrompt(output.system, { timeZone })
    },

    "experimental.session.compacting": async (_input, output) => {
      addCompactionTemporalContext(output.context, { timeZone })
    },
  }
}) satisfies Plugin
