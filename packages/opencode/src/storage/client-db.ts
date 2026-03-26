import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { init } from "#db"
import { ClientKVTable, ClientPromptHistoryTable } from "./client-db.schema"

declare const OPENCODE_CLIENT_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

const log = Log.create({ service: "client-db" })

type Journal = { sql: string; timestamp: number; name: string }[]

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

function parse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type Transaction = SQLiteTransaction<"sync", void>
type Client = SQLiteBunDatabase
type TxOrDb = Transaction | Client

function importKV(db: TxOrDb) {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(ClientKVTable)
    .get()
  if ((row?.count ?? 0) > 0) return

  const file = path.join(Global.Path.state, "kv.json")
  if (!existsSync(file)) return
  const data = parse(readFileSync(file, "utf-8"))
  if (!data || typeof data !== "object" || Array.isArray(data)) return

  const now = Date.now()
  const rows = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key,
      value,
      time_updated: now,
    }))
  if (rows.length === 0) return
  db.insert(ClientKVTable).values(rows).onConflictDoNothing().run()
}

function importPrompt(db: TxOrDb, limit: number) {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(ClientPromptHistoryTable)
    .get()
  if ((row?.count ?? 0) > 0) return

  const file = path.join(Global.Path.state, "prompt-history.jsonl")
  if (!existsSync(file)) return

  const now = Date.now()
  const rows = readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(parse)
    .filter((item): item is unknown => item !== undefined)
    .slice(-limit)
    .map((data) => ({
      data,
      time_created: now,
    }))
  if (rows.length === 0) return

  db.insert(ClientPromptHistoryTable).values(rows).run()
}

export namespace ClientDatabase {
  export const Path = path.join(Global.Path.state, "client.db")

  export const Client = lazy(() => {
    log.info("opening database", { path: Path })

    const db = init(Path)

    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA synchronous = NORMAL")
    db.run("PRAGMA busy_timeout = 5000")
    db.run("PRAGMA cache_size = -64000")
    db.run("PRAGMA foreign_keys = ON")
    db.run("PRAGMA wal_checkpoint(PASSIVE)")

    const entries =
      typeof OPENCODE_CLIENT_MIGRATIONS !== "undefined"
        ? OPENCODE_CLIENT_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../client-migration"))

    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_CLIENT_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrate(db, entries)
    }

    ;(db.transaction as any)((tx: TxOrDb) => {
      importKV(tx)
      importPrompt(tx, 50)
    })

    return db
  })

  export function close() {
    Client().$client.close()
    Client.reset()
  }

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
  }>("client-database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        return ctx.provide({ tx: Client() }, () => callback(Client()))
      }
      throw err
    }
  }

  export function transaction<T>(callback: (tx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        return (Client().transaction as any)((tx: TxOrDb) => {
          return ctx.provide({ tx }, () => callback(tx))
        })
      }
      throw err
    }
  }
}
