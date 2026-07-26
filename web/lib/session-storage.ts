export type SessionStorageRecord = {
  id: string;
  updatedAt: number;
  [key: string]: unknown;
};

const DATABASE_NAME = "setu";
const DATABASE_VERSION = 1;
const SESSIONS_STORE = "sessions";
const META_STORE = "meta";
const ACTIVE_SESSION_KEY = "active-session-id";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
        database.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function readSessions<T extends SessionStorageRecord>(): Promise<T[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SESSIONS_STORE, "readonly");
    const request = transaction.objectStore(SESSIONS_STORE).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve((request.result as T[]).sort((a, b) => b.updatedAt - a.updatedAt));
    transaction.oncomplete = () => database.close();
  });
}

export async function writeSessions<T extends SessionStorageRecord>(sessions: T[]): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SESSIONS_STORE, "readwrite");
    const store = transaction.objectStore(SESSIONS_STORE);
    store.clear();
    sessions.forEach((session) => store.put(session));
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
  database.close();
}

export async function readActiveSessionId(): Promise<string | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(META_STORE, "readonly");
    const request = transaction.objectStore(META_STORE).get(ACTIVE_SESSION_KEY);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : null);
    transaction.oncomplete = () => database.close();
  });
}

export async function writeActiveSessionId(id: string | null): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(META_STORE, "readwrite");
    const store = transaction.objectStore(META_STORE);
    if (id) store.put(id, ACTIVE_SESSION_KEY);
    else store.delete(ACTIVE_SESSION_KEY);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
  database.close();
}
