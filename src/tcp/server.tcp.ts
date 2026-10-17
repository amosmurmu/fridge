import net from "node:net";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CacheService } from "../services/cache.services.js";
import {
  decodeMgetKeys,
  decodeRequests,
  encodeResponse,
  Op,
  Status,
} from "./protocol.js";

type Request = ReturnType<typeof decodeRequests>["requests"][number];

const cache = new CacheService(1000);
const AOF_PATH = resolve(process.env.AOF_PATH ?? "./data/cache.aof");

type AofRecord =
  | {
      op: "SET";
      key: string;
      value: string;
      expiresAt: number | null;
    }
  | {
      op: "DEL";
      key: string;
    };

// Append one complete operation to the log.
async function appendAof(record: AofRecord): Promise<void> {
  await appendFile(AOF_PATH, `${JSON.stringify(record)}\n`, "utf8");
}

// Replay the log before accepting client connections.
async function loadAof(): Promise<void> {
  await mkdir(dirname(AOF_PATH), { recursive: true });

  // Create the file if this is a fresh cache node.
  await appendFile(AOF_PATH, "", "utf8");

  const content = await readFile(AOF_PATH, "utf8");
  const lines = content.split("\n");

  // An interrupted write can leave an incomplete final line.
  // Ignore that line; every complete record ends with '\n'.
  if (!content.endsWith("\n")) {
    lines.pop();
  }

  let restored = 0;
  let expired = 0;

  for (const line of lines) {
    if (!line) continue;

    // Invalid complete records should fail startup rather than
    // silently loading a potentially incorrect cache.
    const record = JSON.parse(line) as AofRecord;

    if (record.op === "SET") {
      if (record.expiresAt === null) {
        cache.set(record.key, record.value);
        restored++;
        continue;
      }

      const remainingMs = record.expiresAt - Date.now();

      if (remainingMs > 0) {
        cache.set(record.key, record.value, remainingMs);
        restored++;
      } else {
        cache.del(record.key);
        expired++;
      }
    } else if (record.op === "DEL") {
      cache.del(record.key);
    } else {
      throw new Error("Unknown AOF operation");
    }
  }

  console.log(`AOF loaded: ${restored} entries restored, ${expired} expired`);
  console.log(`AOF file: ${AOF_PATH}`);
}

async function processRequest(
  socket: net.Socket,
  request: Request,
): Promise<void> {
  if (socket.destroyed) return;

  const key = request.key.toString("utf8");
  const value = request.value.toString("utf8");

  switch (request.op) {
    case Op.GET: {
      const result = cache.get(key);

      if (result === null) {
        socket.write(encodeResponse(Status.NOT_FOUND));
      } else {
        socket.write(encodeResponse(Status.OK, String(result)));
      }
      break;
    }

    case Op.SET: {
      // Preserve the existing behavior: a zero TTL means no expiry.
      // A negative TTL deletes the key, as CacheService did before.
      if (request.ttlMs < 0) {
        await appendAof({ op: "DEL", key });
        cache.del(key);
        socket.write(encodeResponse(Status.OK));
        break;
      }

      const expiresAt = request.ttlMs > 0 ? Date.now() + request.ttlMs : null;

      // Write the log first. If this fails, do not apply the SET.
      await appendAof({
        op: "SET",
        key,
        value,
        expiresAt,
      });

      if (expiresAt === null) {
        cache.set(key, value);
      } else {
        const remainingMs = expiresAt - Date.now();

        if (remainingMs > 0) {
          cache.set(key, value, remainingMs);
        } else {
          cache.del(key);
        }
      }

      socket.write(encodeResponse(Status.OK));
      break;
    }

    case Op.DEL: {
      // Log even when missing, so older SET records won't resurrect it.
      await appendAof({ op: "DEL", key });

      const deleted = cache.del(key);
      socket.write(encodeResponse(deleted ? Status.OK : Status.NOT_FOUND));
      break;
    }

    case Op.MGET: {
      const keys = decodeMgetKeys(request.key);
      const values = cache.mget(keys);

      socket.write(encodeResponse(Status.OK, JSON.stringify(values)));
      break;
    }

    default: {
      socket.write(encodeResponse(Status.ERROR, "Unknown operation"));
    }
  }
}

const server = net.createServer((socket) => {
  console.log("Client connected");

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    try {
      const result = decodeRequests(pending);
      pending = result.remaining;

      // Serialize operations across clients. This keeps log order
      // consistent with the order in which requests are accepted.
      for (const request of result.requests) {
        operationQueue = operationQueue
          .then(() => processRequest(socket, request))
          .catch((error: unknown) => {
            console.error("Cache operation failed:", error);

            if (!socket.destroyed) {
              socket.write(
                encodeResponse(Status.ERROR, "Cache operation failed"),
              );
            }
          });
      }
    } catch (error) {
      console.error("Invalid request:", error);
      socket.destroy();
    }
  });

  socket.on("end", () => {
    console.log("Client disconnected");
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });
});

// One queue shared by all client connections on this cache node.
let operationQueue: Promise<void> = Promise.resolve();

const PORT = Number(process.env.PORT ?? 5000);

async function start(): Promise<void> {
  await loadAof();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`TCP cache server listening on port ${PORT}`);
  });
}

start().catch((error: unknown) => {
  console.error("Failed to start cache server:", error);
  process.exitCode = 1;
});
