import { ClientDatabase } from "@/storage/client-db"
import { ClientKVTable } from "@/storage/client-db.schema"
import { eq } from "drizzle-orm"
import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>()

    setStore(
      Object.fromEntries(
        ClientDatabase.use((db) =>
          db.select({ key: ClientKVTable.key, value: ClientKVTable.value }).from(ClientKVTable).all(),
        ).map((row) => [row.key, row.value]),
      ),
    )
    setReady(true)

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        ClientDatabase.transaction((db) => {
          if (store[key] === undefined) {
            db.delete(ClientKVTable).where(eq(ClientKVTable.key, key)).run()
            return
          }

          db.insert(ClientKVTable)
            .values({
              key,
              value: store[key],
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: ClientKVTable.key,
              set: {
                value: store[key],
                time_updated: Date.now(),
              },
            })
            .run()
        })
      },
    }
    return result
  },
})
