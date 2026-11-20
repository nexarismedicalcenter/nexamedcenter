import http from "node:http";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const SCAN_TIMEOUT_MS = 30_000;
const AUDIO_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_CONCURRENT_SCANS = 2;
const MAX_ALLOWED_CONCURRENT_SCANS = 16;
const execFileAsync = promisify(execFile);
const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);

function configuredMaxConcurrentScans(value = process.env.NEXA_SCANNER_MAX_CONCURRENT_SCANS) {
  if (value === undefined || value === "") return DEFAULT_MAX_CONCURRENT_SCANS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_ALLOWED_CONCURRENT_SCANS) {
    throw new Error(`NEXA_SCANNER_MAX_CONCURRENT_SCANS must be an integer from 1 to ${MAX_ALLOWED_CONCURRENT_SCANS}.`);
  }
  return parsed;
}

function matchesMimeSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mime === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/webp") return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "audio/webm") return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "audio/ogg") return buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS";
  if (mime === "audio/mp4") return buffer.length >= 8 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
  if (mime === "audio/mpeg") return buffer.length >= 3 && (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));
  return false;
}

function readLimitedBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        if (!rejected) {
          rejected = true;
          reject(Object.assign(new Error("file-too-large"), { statusCode: 413 }));
        }
        request.resume();
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on("aborted", () => {
      if (rejected) return;
      rejected = true;
      reject(Object.assign(new Error("request-aborted"), { statusCode: 400 }));
    });
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

async function scanWithClamAV(buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexa-scan-"));
  const filePath = path.join(directory, randomUUID());
  try {
    await writeFile(filePath, buffer, { mode: 0o600, flag: "wx" });
    return await new Promise((resolve, reject) => {
      const scanner = spawn(process.env.CLAMSCAN_BIN || "clamdscan", ["--no-summary", "--fdpass", filePath], { stdio: "ignore" });
      const timer = setTimeout(() => { scanner.kill("SIGKILL"); reject(new Error("scan-timeout")); }, SCAN_TIMEOUT_MS);
      scanner.once("error", (error) => { clearTimeout(timer); reject(error); });
      scanner.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve("CLEAN");
        else if (code === 1) resolve("INFECTED");
        else reject(new Error("scanner-engine-failed"));
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function probeAudioDuration(buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexa-audio-probe-"));
  const filePath = path.join(directory, randomUUID());
  try {
    await writeFile(filePath, buffer, { mode: 0o600, flag: "wx" });
    const result = await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { timeout: AUDIO_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 });
    const duration = Number.parseFloat(String(result.stdout || "").trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > 300) throw new Error("audio-duration-invalid");
    return Math.ceil(duration);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createServer({ scan = scanWithClamAV, probeDuration = probeAudioDuration, scannerVersion = "ClamAV", maxConcurrentScans = DEFAULT_MAX_CONCURRENT_SCANS } = {}) {
  if (!Number.isSafeInteger(maxConcurrentScans) || maxConcurrentScans < 1 || maxConcurrentScans > MAX_ALLOWED_CONCURRENT_SCANS) {
    throw new Error(`maxConcurrentScans must be an integer from 1 to ${MAX_ALLOWED_CONCURRENT_SCANS}.`);
  }
  let activeScans = 0;
  return http.createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/scan") {
      response.writeHead(404);
      response.end();
      return;
    }
    let acquiredScanSlot = false;
    try {
      const mime = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      if (!ALLOWED_MIME.has(mime)) throw Object.assign(new Error("unsupported-file-type"), { statusCode: 415 });
      if (activeScans >= maxConcurrentScans) {
        response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "2" });
        response.end(JSON.stringify({ status: "UNAVAILABLE", error: "scanner-busy" }));
        request.resume();
        return;
      }
      activeScans += 1;
      acquiredScanSlot = true;
      const buffer = await readLimitedBody(request);
      if (!buffer.length || !matchesMimeSignature(buffer, mime)) throw Object.assign(new Error("file-signature-mismatch"), { statusCode: 415 });
      const verdict = await scan(buffer);
      if (verdict !== "CLEAN" && verdict !== "INFECTED") throw new Error("invalid-scanner-verdict");
      const durationSeconds = verdict === "CLEAN" && mime.startsWith("audio/") ? await probeDuration(buffer, mime) : null;
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: verdict, scannerVersion: String(scannerVersion).slice(0, 80), ...(durationSeconds ? { durationSeconds } : {}) }));
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const status = Number(error?.statusCode) || 503;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "UNAVAILABLE", error: status < 500 ? "invalid-file" : "scanner-unavailable" }));
    } finally {
      if (acquiredScanSlot) activeScans -= 1;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer({
    scannerVersion: process.env.CLAMAV_VERSION || "ClamAV",
    maxConcurrentScans: configuredMaxConcurrentScans(),
  });
  server.listen(port, "0.0.0.0");
  server.on("error", () => process.exit(1));
}

export { MAX_FILE_BYTES, matchesMimeSignature, probeAudioDuration, readLimitedBody, createServer };
