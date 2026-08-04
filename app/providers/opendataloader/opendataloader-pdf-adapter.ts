import "server-only";

import { convert, type ConvertOptions } from "@opendataloader/pdf";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, win32 } from "node:path";
import { MAX_DOCUMENT_IMAGE_BYTES, MAX_DOCUMENT_IMAGE_TOTAL_BYTES, MAX_DOCUMENT_IMAGES, MAX_PDF_BYTES } from "../../../lib/chat-document";

export const OPENDATALOADER_HYBRID_URL_ENV = "OPENDATALOADER_HYBRID_URL";
export const DEFAULT_OPENDATALOADER_HYBRID_URL = "http://opendataloader-hybrid:5002";
export const OPENDATALOADER_HYBRID_TIMEOUT_MS = 120_000;
export const OPENDATALOADER_CONVERSION_TIMEOUT_MS = 300_000;
export const MAX_OPENDATALOADER_OUTPUT_FILES = 1_024;
export const MAX_OPENDATALOADER_OUTPUT_BYTES = 128 * 1024 * 1024;
export const MAX_OPENDATALOADER_TEXT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_OPENDATALOADER_PAGES = 2_000;
export const MAX_OPENDATALOADER_ELEMENTS = 100_000;
export const MAX_OPENDATALOADER_NESTING = 100;

export type OpenDataLoaderErrorCode = "invalid_input" | "cancelled" | "conversion_failed" | "conversion_timeout" | "invalid_output";

export class OpenDataLoaderPdfError extends Error {
  constructor(public readonly code: OpenDataLoaderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenDataLoaderPdfError";
  }
}

export type OpenDataLoaderBoundingBox = readonly [number, number, number, number];

export type OpenDataLoaderElement = {
  readonly type: string;
  readonly ["page number"]: number;
  readonly ["bounding box"]: OpenDataLoaderBoundingBox;
  readonly [key: string]: unknown;
};

export type OpenDataLoaderDocument = {
  readonly ["file name"]: string;
  readonly ["number of pages"]: number;
  readonly author: string | null;
  readonly title: string | null;
  readonly ["creation date"]: string | null;
  readonly ["modification date"]: string | null;
  readonly kids: OpenDataLoaderElement[];
};

export type OpenDataLoaderImage = {
  readonly source: string;
  readonly format: "png";
  readonly bytes: Uint8Array;
};

export type OpenDataLoaderPdfOutput = {
  readonly filename: string;
  readonly json: OpenDataLoaderDocument;
  readonly markdown: string;
  readonly images: OpenDataLoaderImage[];
};

export type OpenDataLoaderConverter = (inputPaths: string | string[], options: ConvertOptions) => Promise<string>;

export type OpenDataLoaderPdfAdapterOptions = {
  signal?: AbortSignal;
  /** Internal test seam; production uses the package's normal Java-backed converter. */
  converter?: OpenDataLoaderConverter;
  /** Internal test seam; production uses the operating system temporary directory. */
  tempDirectory?: string;
  conversionTimeoutMs?: number;
};

type OutputFile = {
  absolutePath: string;
  relativePath: string;
};

const INPUT_FILENAME = "input.pdf";
const MARKDOWN_PAGE_SEPARATOR = "\n\n<!-- WOWZERBOWSER_ODL_PAGE_%page-number% -->\n\n";

function cancelled(): OpenDataLoaderPdfError {
  return new OpenDataLoaderPdfError("cancelled", "OpenDataLoader PDF conversion was cancelled.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(cancelled());
        else resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isContained(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return childRelativePath === "" || (childRelativePath !== ".." && !childRelativePath.startsWith(`..${requirePathSeparator(childRelativePath)}`) && !isAbsolute(childRelativePath));
}

function requirePathSeparator(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function invalidOutput(message: string, options?: ErrorOptions): OpenDataLoaderPdfError {
  return new OpenDataLoaderPdfError("invalid_output", message, options);
}

async function walkFiles(root: string, current: string, rootRealPath: string, files: OutputFile[], depth = 0): Promise<void> {
  if (depth > MAX_OPENDATALOADER_NESTING) throw invalidOutput("OpenDataLoader produced excessively nested output.");
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isSymbolicLink()) throw invalidOutput("OpenDataLoader produced a symbolic link in its output.");

    const resolvedPath = await realpath(absolutePath);
    if (!isContained(rootRealPath, resolvedPath)) {
      throw invalidOutput("OpenDataLoader produced output outside its temporary workspace.");
    }
    if (entry.isDirectory()) {
      await walkFiles(root, absolutePath, rootRealPath, files, depth + 1);
    } else if (entry.isFile()) {
      if (files.length >= MAX_OPENDATALOADER_OUTPUT_FILES) throw invalidOutput(`OpenDataLoader produced more than ${MAX_OPENDATALOADER_OUTPUT_FILES} output files.`);
      files.push({
        absolutePath,
        relativePath: relative(root, absolutePath).split("\\").join("/"),
      });
    } else {
      throw invalidOutput("OpenDataLoader produced an unsupported output entry.");
    }
  }
}

async function collectOutputFiles(workspace: string, outputDirectory: string): Promise<OutputFile[]> {
  const workspaceRealPath = await realpath(workspace);
  const outputStats = await readdir(outputDirectory, { withFileTypes: true });
  if (outputStats.length === 0) throw invalidOutput("OpenDataLoader produced no output files.");
  const outputRealPath = await realpath(outputDirectory);
  if (!isContained(workspaceRealPath, outputRealPath)) {
    throw invalidOutput("OpenDataLoader output escaped its temporary workspace.");
  }

  const workspaceEntries = await readdir(workspace, { withFileTypes: true });
  for (const entry of workspaceEntries) {
    if (entry.name !== INPUT_FILENAME && entry.name !== "output") {
      throw invalidOutput("OpenDataLoader produced an unexpected workspace entry.");
    }
  }

  const files: OutputFile[] = [];
  await walkFiles(outputDirectory, outputDirectory, workspaceRealPath, files);
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += (await stat(file.absolutePath)).size;
    if (totalBytes > MAX_OPENDATALOADER_OUTPUT_BYTES) throw invalidOutput(`OpenDataLoader produced more than ${MAX_OPENDATALOADER_OUTPUT_BYTES} output bytes.`);
  }
  return files;
}

function requireOneOutput(files: OutputFile[], extensions: readonly string[], label: string): OutputFile {
  const matches = files.filter((file) => extensions.includes(extname(file.relativePath).toLowerCase()));
  if (matches.length !== 1) {
    throw invalidOutput(`OpenDataLoader must produce exactly one ${label} output.`);
  }
  return matches[0];
}

async function readTextOutput(file: OutputFile, label: string): Promise<string> {
  const fileStats = await stat(file.absolutePath);
  if (fileStats.size > MAX_OPENDATALOADER_TEXT_OUTPUT_BYTES) {
    throw invalidOutput(`OpenDataLoader produced more than ${MAX_OPENDATALOADER_TEXT_OUTPUT_BYTES} bytes of ${label}.`);
  }
  return readFile(file.absolutePath, "utf8");
}

function requireRelativePngPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) {
    throw invalidOutput("OpenDataLoader produced an invalid image path.");
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || value.startsWith("/")) {
    throw invalidOutput("OpenDataLoader produced an absolute image path.");
  }

  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw invalidOutput("OpenDataLoader produced an image path traversal.");
  }
  if (extname(value).toLowerCase() !== ".png") {
    throw invalidOutput("OpenDataLoader produced a non-PNG image path.");
  }
  return parts.join("/");
}

function validateBoundingBox(value: unknown): OpenDataLoaderBoundingBox {
  if (!Array.isArray(value) || value.length !== 4 || value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
    throw invalidOutput("OpenDataLoader produced an invalid element bounding box.");
  }
  return value as unknown as OpenDataLoaderBoundingBox;
}

type ValidationState = { elementCount: number };

function validateTableRow(value: unknown, pageCount: number, imageSources: Set<string>, state: ValidationState, depth: number): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidOutput("OpenDataLoader produced malformed table rows.");
  }
  const row = value as Record<string, unknown>;
  if (row.type !== "table row" || !Number.isSafeInteger(row["row number"]) || Number(row["row number"]) < 1 || !Array.isArray(row.cells)) {
    throw invalidOutput("OpenDataLoader produced malformed table rows.");
  }
  for (const cell of row.cells) validateElement(cell, pageCount, imageSources, state, depth + 1);
}

function validateElement(value: unknown, pageCount: number, imageSources: Set<string>, state: ValidationState, depth = 0): OpenDataLoaderElement {
  if (depth > MAX_OPENDATALOADER_NESTING) throw invalidOutput("OpenDataLoader produced excessively nested content.");
  state.elementCount += 1;
  if (state.elementCount > MAX_OPENDATALOADER_ELEMENTS) throw invalidOutput(`OpenDataLoader produced more than ${MAX_OPENDATALOADER_ELEMENTS} content elements.`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidOutput("OpenDataLoader produced a malformed content element.");
  }
  const element = value as Record<string, unknown>;
  if (typeof element.type !== "string" || element.type.length === 0) {
    throw invalidOutput("OpenDataLoader produced a content element without a type.");
  }
  if (!Number.isSafeInteger(element["page number"]) || Number(element["page number"]) < 1 || Number(element["page number"]) > pageCount) {
    throw invalidOutput("OpenDataLoader produced an invalid content element page number.");
  }
  validateBoundingBox(element["bounding box"]);

  if (element.content !== undefined && typeof element.content !== "string") {
    throw invalidOutput("OpenDataLoader produced malformed text content.");
  }
  if (element.source !== undefined) {
    const source = requireRelativePngPath(element.source);
    imageSources.add(source);
    if (element.type === "image" && element.format !== undefined && element.format !== "png") {
      throw invalidOutput("OpenDataLoader produced an image with a non-PNG format.");
    }
  }
  if (element.kids !== undefined) {
    if (!Array.isArray(element.kids)) throw invalidOutput("OpenDataLoader produced malformed nested content.");
    for (const child of element.kids) validateElement(child, pageCount, imageSources, state, depth + 1);
  }
  if (element["list items"] !== undefined) {
    if (!Array.isArray(element["list items"])) throw invalidOutput("OpenDataLoader produced malformed list content.");
    for (const child of element["list items"] as unknown[]) validateElement(child, pageCount, imageSources, state, depth + 1);
  }
  if (element.rows !== undefined) {
    if (!Array.isArray(element.rows)) throw invalidOutput("OpenDataLoader produced malformed table content.");
    for (const row of element.rows as unknown[]) validateTableRow(row, pageCount, imageSources, state, depth + 1);
  }
  return element as OpenDataLoaderElement;
}

function parseJsonDocument(value: string): { document: OpenDataLoaderDocument; imageSources: Set<string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidOutput("OpenDataLoader produced invalid JSON.", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidOutput("OpenDataLoader produced a malformed JSON document.");
  }

  const document = parsed as Record<string, unknown>;
  if (typeof document["file name"] !== "string" || !Number.isSafeInteger(document["number of pages"]) || Number(document["number of pages"]) < 1 || Number(document["number of pages"]) > MAX_OPENDATALOADER_PAGES) {
    throw invalidOutput("OpenDataLoader produced invalid document metadata.");
  }
  for (const key of ["author", "title", "creation date", "modification date"]) {
    if (document[key] !== null && typeof document[key] !== "string") {
      throw invalidOutput("OpenDataLoader produced invalid document metadata.");
    }
  }
  if (!Array.isArray(document.kids)) throw invalidOutput("OpenDataLoader produced no content element list.");

  const imageSources = new Set<string>();
  const state: ValidationState = { elementCount: 0 };
  for (const child of document.kids) validateElement(child, Number(document["number of pages"]), imageSources, state);
  return { document: document as OpenDataLoaderDocument, imageSources };
}

function markdownImageSources(markdown: string): Set<string> {
  const sources = new Set<string>();
  const pattern = /!\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  for (const match of markdown.matchAll(pattern)) {
    const value = match[1].startsWith("<") && match[1].endsWith(">") ? match[1].slice(1, -1) : match[1];
    sources.add(requireRelativePngPath(value.replaceAll(/\\([\\()[\]])/g, "$1")));
  }
  return sources;
}

function getHybridUrl(): string {
  return process.env[OPENDATALOADER_HYBRID_URL_ENV]?.trim() || DEFAULT_OPENDATALOADER_HYBRID_URL;
}

function conversionOptions(outputDirectory: string): ConvertOptions {
  return {
    outputDir: outputDirectory,
    imageDir: outputDirectory,
    format: "json,markdown",
    imageOutput: "external",
    imageFormat: "png",
    markdownPageSeparator: MARKDOWN_PAGE_SEPARATOR,
    hybrid: "docling-fast",
    hybridMode: "auto",
    hybridUrl: getHybridUrl(),
    hybridTimeout: String(OPENDATALOADER_HYBRID_TIMEOUT_MS),
    hybridFallback: false,
    quiet: true,
  };
}

export async function convertPdfWithOpenDataLoader(
  bytes: Uint8Array,
  filename: string,
  options: OpenDataLoaderPdfAdapterOptions = {},
): Promise<OpenDataLoaderPdfOutput> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new OpenDataLoaderPdfError("invalid_input", "OpenDataLoader requires non-empty PDF bytes.");
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new OpenDataLoaderPdfError("invalid_input", "OpenDataLoader PDFs must be 25 MiB or smaller.");
  }
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new OpenDataLoaderPdfError("invalid_input", "OpenDataLoader requires a PDF filename.");
  }
  throwIfAborted(options.signal);

  let workspace: string | undefined;
  let conversionPromise: Promise<string> | undefined;
  let cleanupDeferred = false;
  const timeoutMs = options.conversionTimeoutMs ?? OPENDATALOADER_CONVERSION_TIMEOUT_MS;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const conversionSignal = timeoutSignal
    ? options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    : options.signal;
  const deferWorkspaceCleanup = () => {
    if (!workspace || cleanupDeferred) return;
    const cancelledWorkspace = workspace;
    cleanupDeferred = true;
    void conversionPromise?.catch(() => undefined)
      .then(() => rm(cancelledWorkspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 }))
      .catch(() => undefined);
  };
  try {
    workspace = await mkdtemp(join(options.tempDirectory ?? tmpdir(), "wowzerbowser-opendataloader-"));
    const inputPath = join(workspace, INPUT_FILENAME);
    const outputDirectory = join(workspace, "output");
    await mkdir(outputDirectory, { mode: 0o700 });
    await writeFile(inputPath, bytes, { mode: 0o600 });

    const converter = options.converter ?? convert;
    conversionPromise = Promise.resolve().then(() => converter(inputPath, conversionOptions(outputDirectory)));
    try {
      await awaitWithAbort(conversionPromise, conversionSignal);
    } catch (error) {
      if (timeoutSignal?.aborted && !options.signal?.aborted) {
        deferWorkspaceCleanup();
        throw new OpenDataLoaderPdfError("conversion_timeout", "OpenDataLoader PDF conversion timed out.", { cause: error });
      }
      if (error instanceof OpenDataLoaderPdfError) {
        if (error.code === "cancelled") deferWorkspaceCleanup();
        throw error;
      }
      if (options.signal?.aborted) throw cancelled();
      throw new OpenDataLoaderPdfError("conversion_failed", "OpenDataLoader PDF conversion failed.", { cause: error });
    }
    throwIfAborted(options.signal);

    const files = await collectOutputFiles(workspace, outputDirectory);
    const jsonFile = requireOneOutput(files, [".json"], "JSON");
    const markdownFile = requireOneOutput(files, [".md", ".markdown"], "Markdown");
    const jsonResult = parseJsonDocument(await readTextOutput(jsonFile, "JSON"));
    const markdown = await readTextOutput(markdownFile, "Markdown");
    const imageSources = new Set([...jsonResult.imageSources, ...markdownImageSources(markdown)]);
    const imageFiles = files.filter((file) => extname(file.relativePath).toLowerCase() === ".png");
    const imagesBySource = new Map(imageFiles.map((file) => [file.relativePath, file]));
    for (const source of imageSources) {
      if (!imagesBySource.has(source)) throw invalidOutput(`OpenDataLoader referenced a missing image: ${source}`);
    }
    if (imageSources.size > MAX_DOCUMENT_IMAGES) {
      throw invalidOutput(`OpenDataLoader produced more than ${MAX_DOCUMENT_IMAGES} referenced images.`);
    }
    const referencedImageFiles = [...imageSources].map((source) => imagesBySource.get(source)!);
    let totalImageBytes = 0;
    for (const file of referencedImageFiles) {
      const fileStats = await stat(file.absolutePath);
      if (fileStats.size > MAX_DOCUMENT_IMAGE_BYTES) {
        throw invalidOutput(`OpenDataLoader produced an image larger than ${MAX_DOCUMENT_IMAGE_BYTES} bytes.`);
      }
      totalImageBytes += fileStats.size;
      if (totalImageBytes > MAX_DOCUMENT_IMAGE_TOTAL_BYTES) {
        throw invalidOutput(`OpenDataLoader produced more than ${MAX_DOCUMENT_IMAGE_TOTAL_BYTES} image bytes.`);
      }
    }
    const images = await Promise.all(referencedImageFiles.map(async (file) => ({
      source: file.relativePath,
      format: "png" as const,
      bytes: await readFile(file.absolutePath),
    })));

    return { filename, json: jsonResult.document, markdown, images };
  } finally {
    // The package cannot receive an AbortSignal, so let its Java child finish before removing its workspace.
    if (!cleanupDeferred) {
      if (conversionPromise) await conversionPromise.catch(() => undefined);
      if (workspace) await rm(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
    }
  }
}
