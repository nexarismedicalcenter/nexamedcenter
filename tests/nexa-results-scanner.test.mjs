import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, matchesMimeSignature } from "../services/nexa-results-scanner/server.mjs";

async function withScanner(scan, action, probeDuration) {
  const server = createServer({ scan, ...(probeDuration ? { probeDuration } : {}), scannerVersion: "test-scanner" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await action(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("scanner accepts signed JPEG, PNG, WebP, and supported audio containers", () => {
  assert.equal(matchesMimeSignature(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg"), true);
  assert.equal(matchesMimeSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
  assert.equal(matchesMimeSignature(Buffer.from("RIFF0000WEBP"), "image/webp"), true);
  assert.equal(matchesMimeSignature(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), "audio/webm"), true);
  assert.equal(matchesMimeSignature(Buffer.from("OggS"), "audio/ogg"), true);
  assert.equal(matchesMimeSignature(Buffer.from("0000ftypM4A "), "audio/mp4"), true);
  assert.equal(matchesMimeSignature(Buffer.from("ID3"), "audio/mpeg"), true);
  assert.equal(matchesMimeSignature(Buffer.from("not-a-jpeg"), "image/jpeg"), false);
});

test("scanner returns the infected verdict for a valid session photo", async () => {
  const response = await withScanner(async () => "INFECTED", async (baseUrl) => fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "INFECTED", scannerVersion: "test-scanner" });
});

test("scanner accepts a valid voice note, reports duration, and fails closed when scanning is unavailable", async () => {
  const cleanResponse = await withScanner(async () => "CLEAN", async (baseUrl) => fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]),
  }), async () => 12);
  assert.equal(cleanResponse.status, 200);
  assert.deepEqual(await cleanResponse.json(), { status: "CLEAN", scannerVersion: "test-scanner", durationSeconds: 12 });

  const unavailableResponse = await withScanner(async () => { throw new Error("scanner-unavailable"); }, async (baseUrl) => fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]),
  }), async () => 12);
  assert.equal(unavailableResponse.status, 503);
  assert.equal((await unavailableResponse.json()).status, "UNAVAILABLE");

  const probeUnavailableResponse = await withScanner(async () => "CLEAN", async (baseUrl) => fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00]),
  }), async () => { throw new Error("ffprobe-unavailable"); });
  assert.equal(probeUnavailableResponse.status, 503);
  assert.equal((await probeUnavailableResponse.json()).status, "UNAVAILABLE");
});

test("scanner rejects a file whose bytes do not match the declared media type", async () => {
  let scanCalled = false;
  const response = await withScanner(async () => { scanCalled = true; return "CLEAN"; }, async (baseUrl) => fetch(`${baseUrl}/scan`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: Buffer.from("not-webm"),
  }));
  assert.equal(response.status, 415);
  assert.equal(scanCalled, false);
});
