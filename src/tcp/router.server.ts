import net from "node:net";
import { Buffer } from "node:buffer";
import { ConsistentHash } from "../services/consistentHash.js";
import {
  decodeRequests,
  decodeResponses,
  decodeMgetKeys,
  encodeRequest,
  encodeMgetRequest,
  encodeResponse,
  Op,
  Status,
  type Request,
  type Response,
} from "./protocol.js";

const ROUTER_PORT = 4000;
const CACHE_PORT = 5000;

// Inside Docker, these are service names.
// Locally, they default to localhost.
const nodes = {
  "cache-a": process.env.CACHE_A_HOST ?? "127.0.0.1",
  "cache-b": process.env.CACHE_B_HOST ?? "127.0.0.1",
  "cache-c": process.env.CACHE_C_HOST ?? "127.0.0.1",
};

const ring = new ConsistentHash(100);

Object.keys(nodes).forEach((node) => ring.addNode(node));

function getNode(key: string): string {
  const node = ring.getNode(key);

  if (!node || !(node in nodes)) {
    throw new Error(`No cache node found for key: ${key}`);
  }

  return node;
}

const L1_TTL_MS = 5_000;

interface L1Entry {
  value: Buffer;
  expiresAt: number;
}

const l1Cache = new Map<string, L1Entry>();
let l1Hits = 0;
let l1Misses = 0;
const keyExpiresAt = new Map<string, number>();

function getFromL1(key: string): Response | null {
  const entry = l1Cache.get(key);

  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    l1Cache.delete(key);
    return null;
  }

  return {
    status: Status.OK,
    value: entry.value,
  };
}

function saveToL1(key: string, value: Buffer): void {
  const now = Date.now();

  const backendExpiry = keyExpiresAt.get(key) ?? Infinity;

  l1Cache.set(key, {
    value: Buffer.from(value),
    expiresAt: Math.min(now + L1_TTL_MS, backendExpiry),
  });
}

// One reusable TCP connection per cache node.
class CacheConnection {
  private socket: net.Socket;
  private pending: Buffer = Buffer.alloc(0);
  private current:
    | {
        resolve: (response: Response) => void;
        reject: (error: Error) => void;
      }
    | undefined = undefined;

  private queue: Promise<void> = Promise.resolve();
  private connected: Promise<void>;
  private closed = false;

  constructor(host: string) {
    this.socket = net.createConnection({
      host,
      port: CACHE_PORT,
    });

    this.connected = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });

    this.socket.on("data", (chunk: Buffer) => this.handleData(chunk));

    this.socket.on("error", (error) => {
      this.rejectCurrent(error);
    });

    this.socket.on("close", () => {
      this.closed = true;
      this.rejectCurrent(new Error("Cache connection closed"));
    });
  }

  // Responses may arrive in partial TCP chunks.
  private handleData(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);

    try {
      const result = decodeResponses(this.pending);
      this.pending = result.remaining;

      for (const response of result.responses) {
        if (!this.current) {
          this.socket.destroy();
          return;
        }

        const pendingRequest = this.current;
        this.current = undefined;
        pendingRequest.resolve(response);
      }
    } catch (error) {
      this.rejectCurrent(error as Error);
      this.socket.destroy();
    }
  }

  private rejectCurrent(error: Error): void {
    if (!this.current) return;

    const pendingRequest = this.current;
    this.current = undefined;
    pendingRequest.reject(error);
  }

  // Only one request at a time per connection.
  // This lets us match each response without request IDs.
  request(frame: Buffer): Promise<Response> {
    const result = this.queue.then(async () => {
      await this.connected;

      if (this.closed || this.socket.destroyed) {
        throw new Error("Cache connection is closed; restart the router");
      }

      return new Promise<Response>((resolve, reject) => {
        this.current = { resolve, reject };

        this.socket.write(frame, (error) => {
          if (error) this.rejectCurrent(error);
        });
      });
    });

    // Let later requests proceed even if this one fails.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }
}

// Create connections once instead of reconnecting for every request.
const connections = new Map<string, CacheConnection>();

for (const [node, host] of Object.entries(nodes)) {
  connections.set(node, new CacheConnection(host));
}

function sendToNode(node: string, frame: Buffer): Promise<Response> {
  const connection = connections.get(node);

  if (!connection) {
    return Promise.reject(new Error(`Unknown cache node: ${node}`));
  }

  return connection.request(frame);
}

// Route a normal GET, SET, or DEL using its key.

async function handleSingleKey(request: Request): Promise<Response> {
  const key = request.key.toString("utf8");

  // 1. Check L1 before contacting the cache node.
  if (request.op === Op.GET) {
    const cached = getFromL1(key);

    if (cached) {
      l1Hits++;
      return cached;
    }
  }
  l1Misses++;
  // 2. On a miss, route to the correct cache node.
  const node = getNode(key);

  const frame = encodeRequest(
    request.op,
    key,
    request.value.toString("utf8"),
    request.ttlMs,
  );

  const response = await sendToNode(node, frame);

  // 3. Cache successful GET results.
  if (request.op === Op.GET) {
    if (response.status === Status.OK) {
      saveToL1(key, response.value);
    } else {
      l1Cache.delete(key);
    }
  }

  // 4. After a successful SET, invalidate old data.
  if (request.op === Op.SET && response.status === Status.OK) {
    l1Cache.delete(key);

    keyExpiresAt.set(
      key,
      request.ttlMs > 0 ? Date.now() + request.ttlMs : Infinity,
    );
  }

  // 5. A DEL must never leave the old value in L1.
  if (request.op === Op.DEL) {
    l1Cache.delete(key);
    keyExpiresAt.delete(key);
  }

  return response;
}

// Split MGET keys by node, then restore their original order.
async function handleMget(request: Request): Promise<Response> {
  const keys = decodeMgetKeys(request.key);

  if (keys.length === 0) {
    return { status: Status.OK, value: Buffer.from("[]") };
  }

  const groups = new Map<string, { key: string; index: number }[]>();

  keys.forEach((key, index) => {
    const node = getNode(key);
    const group = groups.get(node) ?? [];

    group.push({ key, index });
    groups.set(node, group);
  });

  const values: (unknown | null)[] = Array(keys.length).fill(null);

  await Promise.all(
    [...groups.entries()].map(async ([node, entries]) => {
      const frame = encodeMgetRequest(entries.map((entry) => entry.key));
      const response = await sendToNode(node, frame);

      if (response.status !== Status.OK) {
        throw new Error(`MGET failed on ${node}`);
      }

      const nodeValues: unknown = JSON.parse(response.value.toString("utf8"));

      if (!Array.isArray(nodeValues) || nodeValues.length !== entries.length) {
        throw new Error(`Invalid MGET response from ${node}`);
      }

      entries.forEach((entry, index) => {
        values[entry.index] = nodeValues[index] ?? null;
      });
    }),
  );

  return {
    status: Status.OK,
    value: Buffer.from(JSON.stringify(values)),
  };
}

async function routeRequest(request: Request): Promise<Response> {
  if (request.op === Op.MGET) {
    return handleMget(request);
  }

  return handleSingleKey(request);
}

// Handle requests from clients connecting to the router.
function handleClient(client: net.Socket): void {
  let pending: Buffer = Buffer.alloc(0);
  let processing: Promise<void> = Promise.resolve();

  client.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    let result;

    try {
      result = decodeRequests(pending);
    } catch (error) {
      console.error("Invalid client request:", error);
      client.destroy();
      return;
    }

    pending = result.remaining;

    // Process requests from this client in arrival order.
    for (const request of result.requests) {
      processing = processing.then(async () => {
        try {
          const response = await routeRequest(request);

          if (!client.destroyed) {
            client.write(encodeResponse(response.status, response.value));
          }
        } catch (error) {
          console.error("Router error:", error);

          if (!client.destroyed) {
            client.write(encodeResponse(Status.ERROR, "Router request failed"));
          }
        }
      });
    }
  });

  const startHits = l1Hits;
  const startMisses = l1Misses;

  client.on("close", () => {
    console.log("L1 stats for this client:");
    console.log("Hits:", l1Hits - startHits);
    console.log("Misses:", l1Misses - startMisses);
  });
}

const server = net.createServer(handleClient);

server.listen(ROUTER_PORT, "0.0.0.0", () => {
  console.log(`Router listening on port ${ROUTER_PORT}`);
});
