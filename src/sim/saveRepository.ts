export interface SaveRepository {
  load(): Promise<unknown | null>;
  save(value: unknown): Promise<void>;
  delete(): Promise<void>;
  exportSave(): Promise<string>;
  importSave(json: string): Promise<unknown>;
}

const DATABASE = "prison-builder";
const STORE = "saves";
const SLOT = "autosave";

export class BrowserSaveRepository implements SaveRepository {
  async load(): Promise<unknown | null> {
    try {
      const local = await this.readBrowserSlot();
      if (local !== null) return local;
    } catch {
      // Development-file fallback below also supports private browsing modes
      // where IndexedDB may be disabled.
    }
    try {
      const response = await fetch("/api/save");
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async save(value: unknown): Promise<void> {
    let browserSaved = false;
    try {
      await this.writeBrowserSlot(value);
      browserSaved = true;
    } catch {
      browserSaved = false;
    }
    try {
      const response = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!response.ok && !browserSaved) throw new Error(`Save endpoint returned ${response.status}`);
    } catch (error) {
      if (!browserSaved) throw error;
    }
  }

  async delete(): Promise<void> {
    try {
      const db = await this.database();
      await this.request(db.transaction(STORE, "readwrite").objectStore(STORE).delete(SLOT));
      db.close();
    } catch {
      // A missing database is already equivalent to an empty slot.
    }
    try {
      await fetch("/api/save", { method: "DELETE" });
    } catch {
      // Production builds do not expose the optional development mirror.
    }
  }

  async exportSave(): Promise<string> {
    const value = await this.load();
    if (value === null) throw new Error("There is no save to export");
    return JSON.stringify(value, null, 2);
  }

  async importSave(json: string): Promise<unknown> {
    const value = JSON.parse(json) as unknown;
    await this.save(value);
    return value;
  }

  private async readBrowserSlot(): Promise<unknown | null> {
    const db = await this.database();
    const result = await this.request(db.transaction(STORE, "readonly").objectStore(STORE).get(SLOT));
    db.close();
    return result ?? null;
  }

  private async writeBrowserSlot(value: unknown): Promise<void> {
    const db = await this.database();
    await this.request(db.transaction(STORE, "readwrite").objectStore(STORE).put(value, SLOT));
    db.close();
  }

  private database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open save database"));
    });
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Save operation failed"));
    });
  }
}
