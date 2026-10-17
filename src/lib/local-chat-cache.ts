export type LocalChatMessage = Record<string, unknown> & {
  id: string;
  conversation_id: string;
  created_at: string;
};

export type LocalConversation = Record<string, unknown> & {
  id: string;
};

type CachedMessages = {
  userId: string;
  conversationId: string;
  messages: LocalChatMessage[];
  updatedAt: number;
};

export type PendingTextMessage = {
  id: string;
  userId: string;
  conversationId: string;
  payload: {
    id: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    reply_to: string | null;
    message_type: "text";
    created_at: string;
  };
  localMessage: LocalChatMessage;
  queuedAt: number;
};

type CachedConversations = {
  userId: string;
  conversations: LocalConversation[];
  updatedAt: number;
};

type CachedPrivacySettings = {
  userId: string;
  conversationId: string;
  isHidden: boolean;
  isLocked: boolean;
  hasPin: boolean;
  hasSecretCode: boolean;
  updatedAt: number;
};

const DATABASE_NAME = "gushu-local-chat";
const DATABASE_VERSION = 4;
const MESSAGE_STORE = "messages";
const OUTBOX_STORE = "outbox";
const CONVERSATION_STORE = "conversations";
const PRIVACY_SETTINGS_STORE = "privacy-settings";

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable"));
  }

  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        database.createObjectStore(MESSAGE_STORE, {
          keyPath: ["userId", "conversationId"],
        });
      }
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const outbox = database.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        outbox.createIndex("byUser", "userId");
        outbox.createIndex("byUserConversation", ["userId", "conversationId"]);
      }
      if (!database.objectStoreNames.contains(CONVERSATION_STORE)) {
        database.createObjectStore(CONVERSATION_STORE, { keyPath: "userId" });
      }
      if (!database.objectStoreNames.contains(PRIVACY_SETTINGS_STORE)) {
        database.createObjectStore(PRIVACY_SETTINGS_STORE, {
          keyPath: ["userId", "conversationId"],
        });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };

    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open local chat storage"));
    };
  });

  return databasePromise;
}

export async function readCachedMessages(
  userId: string,
  conversationId: string,
): Promise<LocalChatMessage[] | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([MESSAGE_STORE, OUTBOX_STORE], "readonly");
    const cachedRequest = transaction.objectStore(MESSAGE_STORE).get([userId, conversationId]);
    const pendingRequest = transaction
      .objectStore(OUTBOX_STORE)
      .index("byUserConversation")
      .getAll([userId, conversationId]);
    let cachedRecord: CachedMessages | undefined;
    let pendingMessages: PendingTextMessage[] = [];

    cachedRequest.onsuccess = () => {
      cachedRecord = cachedRequest.result as CachedMessages | undefined;
    };
    pendingRequest.onsuccess = () => {
      pendingMessages = pendingRequest.result as PendingTextMessage[];
    };
    transaction.oncomplete = () => {
      const messages = new Map<string, LocalChatMessage>();
      for (const message of cachedRecord?.messages ?? []) {
        if (message?.id) messages.set(message.id, message);
      }
      for (const pending of pendingMessages) {
        messages.set(pending.id, pending.localMessage);
      }
      const result = Array.from(messages.values()).sort(
        (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
      );
      resolve(result.length ? result : cachedRecord ? [] : null);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not read local chat"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local chat read was aborted"));
  });
}

export async function writeCachedMessages(
  userId: string,
  conversationId: string,
  messages: LocalChatMessage[],
): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(MESSAGE_STORE, "readwrite");
    transaction.objectStore(MESSAGE_STORE).put({
      userId,
      conversationId,
      messages: messages.slice(-1000),
      updatedAt: Date.now(),
    } satisfies CachedMessages);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save local chat"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local chat save was aborted"));
  });
}

export async function readCachedConversations(userId: string): Promise<LocalConversation[] | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(CONVERSATION_STORE, "readonly")
      .objectStore(CONVERSATION_STORE)
      .get(userId);
    request.onsuccess = () => {
      const record = request.result as CachedConversations | undefined;
      resolve(Array.isArray(record?.conversations) ? record.conversations : null);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read local inbox"));
  });
}

export async function writeCachedConversations(
  userId: string,
  conversations: LocalConversation[],
): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CONVERSATION_STORE, "readwrite");
    transaction.objectStore(CONVERSATION_STORE).put({
      userId,
      conversations,
      updatedAt: Date.now(),
    } satisfies CachedConversations);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save local inbox"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Local inbox save was aborted"));
  });
}

export async function readCachedPrivacySettings(
  userId: string,
  conversationId: string,
): Promise<{
  is_hidden: boolean;
  is_locked: boolean;
  pin_hash: string | null;
  secret_code_hash: string | null;
} | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(PRIVACY_SETTINGS_STORE, "readonly")
      .objectStore(PRIVACY_SETTINGS_STORE)
      .get([userId, conversationId]);
    request.onsuccess = () => {
      const settings = request.result as CachedPrivacySettings | undefined;
      resolve(
        settings
          ? {
              is_hidden: settings.isHidden,
              is_locked: settings.isLocked,
              pin_hash: settings.hasPin ? "device-locked" : null,
              secret_code_hash: settings.hasSecretCode ? "device-locked" : null,
            }
          : null,
      );
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read chat privacy settings"));
  });
}

export async function writeCachedPrivacySettings(
  userId: string,
  conversationId: string,
  settings: {
    is_hidden?: boolean | null;
    is_locked?: boolean | null;
    pin_hash?: string | null;
    secret_code_hash?: string | null;
  },
): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PRIVACY_SETTINGS_STORE, "readwrite");
    transaction.objectStore(PRIVACY_SETTINGS_STORE).put({
      userId,
      conversationId,
      isHidden: !!settings.is_hidden,
      isLocked: !!settings.is_locked,
      hasPin: !!settings.pin_hash,
      hasSecretCode: !!settings.secret_code_hash,
      updatedAt: Date.now(),
    } satisfies CachedPrivacySettings);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save chat privacy settings"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Privacy settings save was aborted"));
  });
}

export async function enqueueTextMessage(message: PendingTextMessage): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OUTBOX_STORE, "readwrite");
    transaction.objectStore(OUTBOX_STORE).put(message);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not queue message"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Message queue write was aborted"));
  });
}

export async function listPendingTextMessages(userId: string): Promise<PendingTextMessage[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE, "readonly")
      .objectStore(OUTBOX_STORE)
      .index("byUser")
      .getAll(userId);
    request.onsuccess = () => resolve(request.result as PendingTextMessage[]);
    request.onerror = () => reject(request.error ?? new Error("Could not read pending messages"));
  });
}

export async function removePendingTextMessage(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(OUTBOX_STORE, "readwrite");
    transaction.objectStore(OUTBOX_STORE).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not remove pending message"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Message queue delete was aborted"));
  });
}
