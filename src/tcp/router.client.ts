import net from "node:net";
import { Buffer } from "node:buffer";
import { ConsistentHash } from "../services/consistentHash.js";
import {
  encodeRequest,
  decodeResponses,
  Op,
  type Response,
  Status,
  encodeMgetRequest,
} from "./protocol.js";

const ring = new ConsistentHash(100);

const nodes: Record<string, number> = {
  "cache-a": 5001,
  "cache-b": 5002,
  "cache-c": 5003,
};

for (const node of Object.keys(nodes)) {
  ring.addNode(node);
}

function getNode(key: string): string {
  const node = ring.getNode(key);

  if (!node || nodes[node] === undefined) {
    throw new Error(`No cache node found for key: ${key}`);
  }

  return node;
}

function sendToNode(node: string, request: Buffer): Promise<Response> {
  const port = nodes[node];

  if (port === undefined) {
    throw new Error(`Unknown cache node: ${node}`);
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port,
    });

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let completed = false;

    function fail(error: Error) {
      if (completed) return;
      completed = true;
      socket.destroy();
      reject(error);
    }

    socket.setTimeout(3000);

    socket.on("connect", () => {
      socket.write(request);
    });

    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);

      const result = decodeResponses(pending);
      pending = result.remaining;

      if (result.responses.length > 0 && !completed) {
        completed = true;
        socket.end();
        resolve(result.responses[0]!);
      }
    });

    socket.on("timeout", () => {
      fail(new Error(`Timeout connecting to ${node}`));
    });

    socket.on("error", (error) => {
      fail(error);
    });

    socket.on("close", () => {
      if (!completed) {
        fail(new Error(`Connection closed before ${node} responded`));
      }
    });
  });
}

function sendRequest(key: string, request: Buffer): Promise<Response> {
  const node = getNode(key);

  console.log(`Routing "${key}" -> ${node}`);

  return sendToNode(node, request);
}

async function sendMget(keys: string[]): Promise<(unknown | null)[]> {
  if (keys.length === 0) return [];

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
      const nodeKeys = entries.map((entry) => entry.key);

      console.log(`MGET ${nodeKeys.join(",")} -> ${node}`);

      const response = await sendToNode(node, encodeMgetRequest(nodeKeys));

      if (response.status !== Status.OK) {
        throw new Error(`MGET failed on ${node}`);
      }

      const nodeValues: unknown = JSON.parse(response.value.toString("utf8"));

      if (!Array.isArray(nodeValues) || nodeValues.length !== entries.length) {
        throw new Error(`Invalid MGET response from ${node}`);
      }

      entries.forEach((entry, i) => {
        values[entry.index] = nodeValues[i] ?? null;
      });
    }),
  );

  return values;
}

async function main() {
  const entries = [
    ["user:1", "Amos"],
    ["user:2", "John"],
    ["user:3", "Alice"],
    ["user:4", "Bob"],
  ] as const;

  // Seed the cache so we can test MGET across nodes.
  for (const [key, value] of entries) {
    const response = await sendRequest(key, encodeRequest(Op.SET, key, value));

    console.log(`SET ${key}:`, response.status);
  }

  const keys = ["user:1", "missing", "user:3", "user:2", "user:4"];

  const values = await sendMget(keys);

  console.log("\nMGET results:");
  console.log(
    keys.map((key, i) => ({
      key,
      value: values[i],
    })),
  );
}

main().catch(console.error);
