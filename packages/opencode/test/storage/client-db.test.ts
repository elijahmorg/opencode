import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import { rm } from "fs/promises"
import path from "path"
import { desc, eq, sql } from "drizzle-orm"
import { Global } from "../../src/global"
import { ClientDatabase } from "../../src/storage/client-db"
import { ClientKVTable, ClientPromptHistoryTable } from "../../src/storage/client-db.schema"

async function clear() {
  ClientDatabase.close()
  await rm(ClientDatabase.Path, { force: true }).catch(() => undefined)
  await rm(`${ClientDatabase.Path}-wal`, { force: true }).catch(() => undefined)
  await rm(`${ClientDatabase.Path}-shm`, { force: true }).catch(() => undefined)
  await rm(path.join(Global.Path.state, "kv.json"), { force: true }).catch(() => undefined)
  await rm(path.join(Global.Path.state, "prompt-history.jsonl"), { force: true }).catch(() => undefined)
}

function kv() {
  return Object.fromEntries(
    ClientDatabase.use((db) =>
      db.select({ key: ClientKVTable.key, value: ClientKVTable.value }).from(ClientKVTable).all(),
    ).map((row) => [row.key, row.value]),
  ) as Record<string, unknown>
}

function prompt(limit: number) {
  return ClientDatabase.use((db) =>
    db
      .select({ data: ClientPromptHistoryTable.data })
      .from(ClientPromptHistoryTable)
      .orderBy(desc(ClientPromptHistoryTable.id))
      .limit(limit)
      .all(),
  )
    .reverse()
    .map((row) => row.data) as { input: string; parts: unknown[] }[]
}

function setKV(key: string, value: unknown) {
  ClientDatabase.transaction((db) => {
    if (value === undefined) {
      db.delete(ClientKVTable).where(eq(ClientKVTable.key, key)).run()
      return
    }

    db.insert(ClientKVTable)
      .values({
        key,
        value,
        time_updated: Date.now(),
      })
      .onConflictDoUpdate({
        target: ClientKVTable.key,
        set: {
          value,
          time_updated: Date.now(),
        },
      })
      .run()
  })
}

function appendPrompt(data: unknown, limit: number) {
  ClientDatabase.transaction((db) => {
    db.insert(ClientPromptHistoryTable)
      .values({
        data,
        time_created: Date.now(),
      })
      .run()

    db.run(sql`DELETE FROM client_prompt_history WHERE id NOT IN (
      SELECT id FROM client_prompt_history ORDER BY id DESC LIMIT ${limit}
    )`)
  })
}

describe("ClientDatabase", () => {
  beforeEach(async () => {
    await clear()
  })

  afterEach(async () => {
    await clear()
  })

  test("imports legacy files once", async () => {
    await Bun.write(path.join(Global.Path.state, "kv.json"), JSON.stringify({ alpha: 1, beta: "x" }))
    await Bun.write(
      path.join(Global.Path.state, "prompt-history.jsonl"),
      `${JSON.stringify({ input: "one", parts: [] })}\nnot-json\n${JSON.stringify({ input: "two", parts: [] })}\n`,
    )

    const first = kv()
    expect(first.alpha).toBe(1)
    expect(first.beta).toBe("x")

    const prompts = prompt(50)
    expect(prompts.length).toBe(2)
    expect(prompts[0].input).toBe("one")
    expect(prompts[1].input).toBe("two")

    ClientDatabase.close()

    await Bun.write(path.join(Global.Path.state, "kv.json"), JSON.stringify({ gamma: 3 }))
    await Bun.write(
      path.join(Global.Path.state, "prompt-history.jsonl"),
      `${JSON.stringify({ input: "three", parts: [] })}\n`,
    )

    const second = kv()
    expect(second.gamma).toBeUndefined()

    const prompts2 = prompt(50)
    expect(prompts2.length).toBe(2)
  })

  test("keeps prompt history capped", () => {
    for (let i = 0; i < 60; i++) {
      appendPrompt({ input: `${i}`, parts: [] }, 50)
    }

    const rows = prompt(50)
    expect(rows.length).toBe(50)
    expect(rows[0].input).toBe("10")
    expect(rows[49].input).toBe("59")
  })

  test("upserts and deletes kv values", () => {
    setKV("key", { ok: true })
    const first = kv()
    expect(first.key).toEqual({ ok: true })

    setKV("key", undefined)
    const second = kv()
    expect("key" in second).toBe(false)
  })
})
