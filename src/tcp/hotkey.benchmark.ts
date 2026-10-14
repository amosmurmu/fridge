import net from "node:net";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";

import { encodeRequest, decodeResponses, Op, Status } from "./protocol.js";

const PORT = Number(process.env.CACHE_PORT ?? 5003);
const HOST = process.env.CACHE_HOST ?? "127.0.0.1";

const REQUESTS = Number(process.env.REQUESTS ?? 10_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);

const HOT_KEY = "flash-sale:product:123:stock";

// This script benchmarks one node directly first.
// That isolates cache-node performance from router overhead.

function sendGet(key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let completed = false;
    const start = performance.now();

    function fail(error: Error) {
      if (completed) return;
      completed = true;
      socket.destroy();
      reject(error);
    }

    socket.setTimeout(3000);

    socket.on("connect", () => {
      socket.write(encodeRequest(Op.GET, key));
    });

    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);

      const result = decodeResponses(pending);
      pending = result.remaining;

      if (result.responses.length > 0 && !completed) {
        const response = result.responses[0]!;
        const latency = performance.now() - start;

        completed = true;
        socket.end();

        if (
          response.status !== Status.OK &&
          response.status !== Status.NOT_FOUND
        ) {
          reject(new Error(`GET failed: ${response.status}`));
          return;
        }

        resolve(latency);
      }
    });

    socket.on("timeout", () => {
      fail(new Error("Request timed out"));
    });

    socket.on("error", fail);

    socket.on("close", () => {
      if (!completed) {
        fail(new Error("Connection closed before response"));
      }
    });
  });
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)]!;
}

async function main() {
  // Seed the hot key before measuring.
  const seedSocket = net.createConnection({ host: HOST, port: PORT });

  await new Promise<void>((resolve, reject) => {
    seedSocket.once("connect", () => {
      seedSocket.write(encodeRequest(Op.SET, HOT_KEY, "100"));
    });

    seedSocket.on("data", (chunk: Buffer) => {
      const result = decodeResponses(chunk);

      if (result.responses.length > 0) {
        seedSocket.end();
        resolve();
      }
    });

    seedSocket.once("error", reject);
  });

  // Workers repeatedly request the same key.
  let nextRequest = 0;
  let failures = 0;
  const latencies: number[] = [];

  const start = performance.now();

  async function worker() {
    while (true) {
      const requestId = nextRequest++;

      if (requestId >= REQUESTS) return;

      try {
        const latency = await sendGet(HOT_KEY);
        latencies.push(latency);
      } catch {
        failures++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsedSeconds = (performance.now() - start) / 1000;
  latencies.sort((a, b) => a - b);

  console.log("\nHot-key benchmark");
  console.log("-----------------");
  console.log(`Requests requested: ${REQUESTS}`);
  console.log(`Successful: ${latencies.length}`);
  console.log(`Failed: ${failures}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Elapsed: ${elapsedSeconds.toFixed(2)} s`);
  console.log(
    `Throughput: ${(latencies.length / elapsedSeconds).toFixed(0)} req/s`,
  );

  if (latencies.length > 0) {
    console.log(`P50: ${percentile(latencies, 50).toFixed(3)} ms`);
    console.log(`P95: ${percentile(latencies, 95).toFixed(3)} ms`);
    console.log(`P99: ${percentile(latencies, 99).toFixed(3)} ms`);
    console.log(`Max: ${latencies[latencies.length - 1]!.toFixed(3)} ms`);
  }
}

main().catch(console.error);
