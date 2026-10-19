#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DOCUMENTS = 8;
const MAX_CONCURRENCY = 4;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_CHARACTERS = 6_000;
const MAX_OUTPUT_LINE_BYTES = 6_000;
const MAX_INLINE_SEGMENT_JSON_BYTES = 4_096;
const MIN_INLINE_MAX_BYTES = 1_024;
const MAX_INLINE_MAX_BYTES = 49_152;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage() {
  return [
    "Usage: node paperclip-read-documents.mjs --document ISSUE_ID/KEY [--document ISSUE_ID/KEY ...]",
    "Optional: --inline-max-bytes N returns complete documents inline when the complete output fits (1024-49152 bytes).",
    "Fetches up to 8 current issue documents in parallel and writes complete UTF-8 bodies",
    "as private files under the current working directory. Prints a JSON manifest to stdout.",
  ].join("\n");
}

function parseArguments(args) {
  const documents = [];
  let inlineMaxBytes;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true, documents: [] };
    if (arg === "--inline-max-bytes") {
      if (inlineMaxBytes !== undefined) throw new Error("--inline-max-bytes may be provided only once.");
      const value = args[++index];
      if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`--inline-max-bytes must be an integer from ${MIN_INLINE_MAX_BYTES} to ${MAX_INLINE_MAX_BYTES}.`);
      inlineMaxBytes = Number(value);
      if (!Number.isSafeInteger(inlineMaxBytes) || inlineMaxBytes < MIN_INLINE_MAX_BYTES || inlineMaxBytes > MAX_INLINE_MAX_BYTES) throw new Error(`--inline-max-bytes must be an integer from ${MIN_INLINE_MAX_BYTES} to ${MAX_INLINE_MAX_BYTES}.`);
      continue;
    }
    if (arg !== "--document" || !args[index + 1]) throw new Error(`Unexpected or incomplete argument: ${arg ?? ""}`);
    const value = args[++index];
    const separator = value.lastIndexOf("/");
    if (separator < 1 || separator === value.length - 1) throw new Error(`Invalid document reference: ${value}`);
    const issueId = value.slice(0, separator);
    const key = value.slice(separator + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(issueId)) throw new Error(`Invalid issue id or identifier: ${issueId}`);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key)) throw new Error(`Invalid document key: ${key}`);
    documents.push({ issueId, key });
  }
  if (documents.length === 0) throw new Error("Pass at least one --document ISSUE_ID/KEY reference.");
  if (documents.length > MAX_DOCUMENTS) throw new Error(`At most ${MAX_DOCUMENTS} documents can be read at once.`);
  if (new Set(documents.map(({ issueId, key }) => `${issueId}\0${key}`)).size !== documents.length) throw new Error("Duplicate document references are not allowed.");
  return { help: false, documents, ...(inlineMaxBytes === undefined ? {} : { inlineMaxBytes }) };
}

function splitBody(body) {
  const segments = [];
  let current = "";
  let count = 0;
  for (const character of body) {
    if (count === MAX_SEGMENT_CHARACTERS) {
      segments.push(current);
      current = "";
      count = 0;
    }
    current += character;
    count += 1;
  }
  if (current.length > 0 || segments.length === 0) segments.push(current);
  return segments;
}

function splitBodyForInline(body) {
  const segments = [];
  let current = "";
  let currentJsonBytes = 2;
  for (const character of body) {
    const encodedCharacter = JSON.stringify(character).slice(1, -1);
    const encodedCharacterBytes = Buffer.byteLength(encodedCharacter, "utf8");
    if (currentJsonBytes + encodedCharacterBytes > MAX_INLINE_SEGMENT_JSON_BYTES) {
      if (current.length === 0) throw new Error("A Unicode character exceeds the inline segment limit.");
      segments.push(current);
      current = "";
      currentJsonBytes = 2;
    }
    current += character;
    currentJsonBytes += encodedCharacterBytes;
  }
  if (current.length > 0 || segments.length === 0) segments.push(current);
  return segments;
}

function outputLinesFit(value) {
  const lines = value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
  return lines.every((line) => Buffer.byteLength(line, "utf8") <= MAX_OUTPUT_LINE_BYTES);
}

async function fetchDocument(reference, apiRoot, apiKey, runId, batchSignal) {
  const endpoint = new URL(`${apiRoot}/api/issues/${encodeURIComponent(reference.issueId)}/documents/${encodeURIComponent(reference.key)}`);
  if (endpoint.origin !== new URL(apiRoot).origin || endpoint.pathname.includes("%2F")) throw new Error("Document URL escaped the configured Paperclip API origin.");
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  if (runId) headers["x-paperclip-run-id"] = runId;
  const response = await fetch(endpoint, { method: "GET", headers, redirect: "manual", signal: AbortSignal.any([batchSignal, AbortSignal.timeout(30_000)]) });
  if (!response.ok) throw new Error(`GET ${reference.issueId}/${reference.key} failed with HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error(`GET ${reference.issueId}/${reference.key} returned a non-JSON response.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`GET ${reference.issueId}/${reference.key} returned no response body.`);
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Document ${reference.issueId}/${reference.key} exceeds the ${MAX_DOCUMENT_BYTES}-byte safety bound.`);
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, byteLength);
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`GET ${reference.issueId}/${reference.key} returned malformed JSON.`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)
    || typeof document.id !== "string" || document.id.length === 0
    || typeof document.issueId !== "string" || !UUID_PATTERN.test(document.issueId)
    || (UUID_PATTERN.test(reference.issueId) && document.issueId.toLowerCase() !== reference.issueId.toLowerCase())
    || document.key !== reference.key
    || typeof document.body !== "string"
    || typeof document.latestRevisionId !== "string" || document.latestRevisionId.length === 0
    || !Number.isSafeInteger(document.latestRevisionNumber) || document.latestRevisionNumber < 1
    || (document.title !== null && typeof document.title !== "string")) {
    throw new Error(`GET ${reference.issueId}/${reference.key} did not return the requested document with a complete body and revision.`);
  }
  return {
    requestedIssueId: reference.issueId,
    issueId: document.issueId,
    key: document.key,
    title: document.title,
    format: typeof document.format === "string" ? document.format : null,
    latestRevisionId: document.latestRevisionId,
    latestRevisionNumber: document.latestRevisionNumber,
    sourceTrust: document.sourceTrust ?? null,
    body: document.body,
    bodyBytes: Buffer.byteLength(document.body, "utf8"),
    bodySha256: createHash("sha256").update(document.body, "utf8").digest("hex"),
  };
}

async function mapBounded(items, limit, callback) {
  const results = new Array(items.length);
  let next = 0;
  const controller = new AbortController();
  let firstError;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      if (controller.signal.aborted) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await callback(items[index], controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          firstError = error;
          controller.abort(error);
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

async function writePrivateFile(filePath, content) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function run(args, env = process.env, cwd = process.cwd()) {
  const parsed = parseArguments(args);
  if (parsed.help) return { help: usage() };
  const apiBase = env.PAPERCLIP_API_URL;
  const apiKey = env.PAPERCLIP_API_KEY;
  if (!apiBase || !apiKey) throw new Error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required.");
  let base;
  try { base = new URL(apiBase); } catch { throw new Error("PAPERCLIP_API_URL must be an absolute URL."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("PAPERCLIP_API_URL must be an HTTP(S) origin/base path without embedded credentials, query, or fragment.");
  const basePath = base.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  const apiRoot = `${base.origin}${basePath}`;

  const documents = await mapBounded(parsed.documents, MAX_CONCURRENCY, (reference, signal) => fetchDocument(reference, apiRoot, apiKey, env.PAPERCLIP_RUN_ID, signal));
  const totalBytes = documents.reduce((sum, document) => sum + document.bodyBytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Requested documents exceed the ${MAX_TOTAL_BYTES}-byte total safety bound.`);

  const outputRoot = path.resolve(cwd, `.paperclip-documents-${randomUUID()}`);
  await mkdir(outputRoot, { recursive: false, mode: 0o700 });
  try {
    const manifestDocuments = [];
    for (const document of documents) {
      const documentRoot = path.join(outputRoot, `${document.issueId}-${document.key}`);
      await mkdir(documentRoot, { recursive: false, mode: 0o700 });
      const segments = splitBody(document.body);
      const segmentManifest = [];
      for (let index = 0; index < segments.length; index += 1) {
        const name = `segment-${String(index + 1).padStart(3, "0")}.txt`;
        await writePrivateFile(path.join(documentRoot, name), segments[index]);
        segmentManifest.push({ path: path.join(documentRoot, name), characters: Array.from(segments[index]).length });
      }
      manifestDocuments.push({
        requestedIssueId: document.requestedIssueId,
        issueId: document.issueId,
        key: document.key,
        title: document.title,
        format: document.format,
        latestRevisionId: document.latestRevisionId,
        latestRevisionNumber: document.latestRevisionNumber,
        sourceTrust: document.sourceTrust,
        bodyBytes: document.bodyBytes,
        bodySha256: document.bodySha256,
        segments: segmentManifest,
      });
    }
    const manifest = { outputRoot, documents: manifestDocuments };
    if (parsed.inlineMaxBytes === undefined) return manifest;

    const manifestPath = path.join(outputRoot, "manifest.json");
    await writePrivateFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // Raw bodies alone cannot fit this budget: avoid encoding an oversized
    // batch only to discard it. All complete segments already exist above.
    if (totalBytes <= parsed.inlineMaxBytes) {
      const inlineDocuments = documents.map((document) => ({
        issueId: document.issueId,
        key: document.key,
        latestRevisionId: document.latestRevisionId,
        latestRevisionNumber: document.latestRevisionNumber,
        bodyBytes: document.bodyBytes,
        bodySha256: document.bodySha256,
        bodySegments: splitBodyForInline(document.body),
      }));
      const inlinePayload = `${JSON.stringify({ inlineComplete: true, documents: inlineDocuments }, null, 2)}\n`;
      const inlineHeader = `${JSON.stringify({ delivery: "inline", manifestPath, ...manifest })}\n`;
      const inlineOutput = `${inlineHeader}${inlinePayload}`;
      if (Buffer.byteLength(inlineOutput, "utf8") <= parsed.inlineMaxBytes && outputLinesFit(inlineOutput)) return { stdout: inlineOutput };
    }

    const segmentHeader = `${JSON.stringify({ delivery: "segments", manifestPath, ...manifest })}\n`;
    if (Buffer.byteLength(segmentHeader, "utf8") <= parsed.inlineMaxBytes && outputLinesFit(segmentHeader)) return { stdout: segmentHeader };

    const compactHeader = `${JSON.stringify({ delivery: "manifest-file", manifestPath })}\n`;
    if (Buffer.byteLength(compactHeader, "utf8") <= parsed.inlineMaxBytes && outputLinesFit(compactHeader)) return { stdout: compactHeader };
    throw new Error("The manifest-file fallback header exceeds --inline-max-bytes.");
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function isMainModule() {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const result = await run(process.argv.slice(2));
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(typeof result.stdout === "string" ? result.stdout : `${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
