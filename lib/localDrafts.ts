import "client-only";

const DATABASE_NAME = "3amjspace-local-drafts";
const STORE_NAME = "drafts";
const DATABASE_VERSION = 1;

type DraftRecord<T> = {
  key: string;
  value: T;
  updatedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local draft storage."));
  });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Local draft storage failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Local draft storage was interrupted."));
    });
  } finally {
    database.close();
  }
}

export async function loadLocalDraft<T>(key: string): Promise<T | null> {
  try {
    const record = await transact<DraftRecord<T> | undefined>("readonly", (store) => store.get(key));
    return record?.value ?? null;
  } catch {
    return null;
  }
}

export async function saveLocalDraft<T>(key: string, value: T): Promise<void> {
  try {
    await transact<IDBValidKey>("readwrite", (store) => store.put({ key, value, updatedAt: Date.now() }));
  } catch {
    // The composer still works when private browsing or storage policy blocks IndexedDB.
  }
}

export async function deleteLocalDraft(key: string): Promise<void> {
  try {
    await transact<undefined>("readwrite", (store) => store.delete(key));
  } catch {
    // A failed cleanup is harmless; the next successful submission overwrites it.
  }
}
