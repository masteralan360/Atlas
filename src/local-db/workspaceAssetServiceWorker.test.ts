import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

const ORIGIN = "https://atlas.test";
const WORKSPACE_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000002";
const ASSET_PATH = `product-images/${WORKSPACE_ID}/nested/photo.png`;
const ASSET_HASH = "a".repeat(64);

class MemoryDirectory {
  constructor(
    private readonly directories = new Map<string, MemoryDirectory>(),
    private readonly files = new Map<string, Blob>(),
  ) {}

  addDirectory(name: string, directory: MemoryDirectory) {
    this.directories.set(name, directory);
    return directory;
  }

  addFile(name: string, file: Blob) {
    this.files.set(name, file);
  }

  async getDirectoryHandle(name: string) {
    const directory = this.directories.get(name);
    if (!directory) throw Object.assign(new Error("Directory not found"), { name: "NotFoundError" });
    return directory;
  }

  async getFileHandle(name: string) {
    const file = this.files.get(name);
    if (!file) throw Object.assign(new Error("File not found"), { name: "NotFoundError" });
    return { getFile: async () => file };
  }
}

function createOpfs(manifest: Record<string, { sha256: string; mimeType: string | null }>) {
  const root = new MemoryDirectory();
  const assets = root.addDirectory("atlas-backup-assets", new MemoryDirectory());
  const workspace = assets.addDirectory(encodeURIComponent(WORKSPACE_ID), new MemoryDirectory());
  const user = workspace.addDirectory(encodeURIComponent(USER_ID), new MemoryDirectory());
  user.addFile("manifest.json", new Blob([JSON.stringify(manifest)], { type: "application/json" }));
  user.addFile(ASSET_HASH, new Blob(["local-image"], { type: "image/png" }));
  return root;
}

function loadWorker(manifest: Record<string, { sha256: string; mimeType: string | null }>) {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const cacheStores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      const entries = cacheStores.get(name) ?? new Map<string, Response>();
      cacheStores.set(name, entries);
      return {
        put: async (request: Request, response: Response) => {
          entries.set(request.url, response.clone());
        },
        match: async (request: Request) => entries.get(request.url)?.clone(),
        delete: async (request: Request) => entries.delete(request.url),
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
      };
    },
    async keys() {
      return [...cacheStores.keys()];
    },
    async delete(name: string) {
      return cacheStores.delete(name);
    },
    async match(request: Request) {
      for (const entries of cacheStores.values()) {
        const response = entries.get(request.url);
        if (response) return response.clone();
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    navigator: { storage: { getDirectory: async () => createOpfs(manifest) } },
    clients: { matchAll: async () => [], claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.set(type, listener);
    },
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self,
    caches,
    URL,
    Request,
    Response,
    Blob,
    fetch,
    console,
    Date,
    Promise,
    Set,
    Map,
    JSON,
  });

  const bind = async (clientId: string) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get("message")?.({
      data: { type: "SET_WORKSPACE_ASSET_SCOPE", workspaceId: WORKSPACE_ID, userId: USER_ID },
      source: { id: clientId },
      ports: [{ postMessage: () => undefined }],
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    });
    await pending;
  };
  const requestAsset = async (clientId: string, options: { remote?: string; navigate?: boolean } = {}) => {
    const url = new URL("/__atlas_workspace_asset__", ORIGIN);
    url.searchParams.set("path", ASSET_PATH);
    url.searchParams.set("workspace", WORKSPACE_ID);
    url.searchParams.set("user", USER_ID);
    if (options.remote) url.searchParams.set("remote", options.remote);
    const request = options.navigate
      ? { url: url.href, method: "GET", mode: "navigate" }
      : new Request(url.href);
    const responses: Array<Promise<Response>> = [];
    listeners.get("fetch")?.({
      request,
      clientId,
      respondWith: (promise: Promise<Response>) => { responses.push(Promise.resolve(promise)); },
      waitUntil: () => undefined,
    });
    const responsePromise = responses[0];
    if (!responsePromise) throw new Error("The service worker did not handle the asset request.");
    return responsePromise;
  };

  return { bind, requestAsset };
}

describe("workspace asset service-worker route", () => {
  it("serves a scoped OPFS asset only to its bound controlled client", async () => {
    const worker = loadWorker({
      [ASSET_PATH]: { sha256: ASSET_HASH, mimeType: "text/html" },
    });

    expect((await worker.requestAsset("unbound-client")).status).toBe(404);
    await worker.bind("bound-client");
    const response = await worker.requestAsset("bound-client");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(await response.text()).toBe("local-image");
  });

  it("rejects top-level navigation even for a bound client", async () => {
    const worker = loadWorker({
      [ASSET_PATH]: { sha256: ASSET_HASH, mimeType: "image/png" },
    });
    await worker.bind("bound-client");
    expect((await worker.requestAsset("bound-client", { navigate: true })).status).toBe(404);
  });

  it("redirects an absent local asset without relaying remote bytes through Atlas", async () => {
    const worker = loadWorker({});
    await worker.bind("bound-client");
    const remote = `https://assets.example/${WORKSPACE_ID}/product-images/nested/photo.png`;
    const response = await worker.requestAsset("bound-client", { remote });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(remote);
  });
});
