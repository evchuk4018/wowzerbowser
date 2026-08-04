import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  convertPdfWithOpenDataLoader,
  DEFAULT_OPENDATALOADER_HYBRID_URL,
  OpenDataLoaderPdfError,
  OPENDATALOADER_HYBRID_URL_ENV,
} from "../app/providers/opendataloader/opendataloader-pdf-adapter.ts";

const validDocument = (source) => JSON.stringify({
  "file name": "input.pdf",
  "number of pages": 1,
  author: null,
  title: null,
  "creation date": null,
  "modification date": null,
  kids: [{
    type: "image",
    "page number": 1,
    "bounding box": [0, 0, 10, 10],
    source,
    format: "png",
  }],
});

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "wowzerbowser-opendataloader-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("converts bytes with the Java client configuration and returns typed JSON, Markdown, and PNG output", async () => {
  await withTempDirectory(async (tempDirectory) => {
    const inputBytes = new Uint8Array([37, 80, 68, 70]);
    const previousUrl = process.env[OPENDATALOADER_HYBRID_URL_ENV];
    process.env[OPENDATALOADER_HYBRID_URL_ENV] = "http://private-hybrid:5002";
    try {
      const result = await convertPdfWithOpenDataLoader(inputBytes, "report.pdf", {
        tempDirectory,
        converter: async (inputPath, options) => {
          assert.deepEqual([...await readFile(inputPath)], [...inputBytes]);
          assert.equal(options.format, "json,markdown");
          assert.equal(options.imageOutput, "external");
          assert.equal(options.imageFormat, "png");
          assert.equal(options.hybrid, "docling-fast");
           assert.equal(options.hybridMode, "auto");
           assert.equal(options.hybridUrl, "http://private-hybrid:5002");
           assert.equal(options.hybridTimeout, "120000");
           assert.equal(options.hybridFallback, false);
           await writeFile(join(options.outputDir, "input.json"), validDocument("input.png"));
           await writeFile(join(options.outputDir, "input.md"), "![image](<input.png>)\n");
          await writeFile(join(options.outputDir, "input.png"), Buffer.from([137, 80, 78, 71]));
          return "";
        },
      });
      assert.equal(result.filename, "report.pdf");
      assert.equal(result.json["number of pages"], 1);
      assert.match(result.markdown, /input\.png/);
      assert.deepEqual([...result.images[0].bytes], [137, 80, 78, 71]);
    } finally {
      if (previousUrl === undefined) delete process.env[OPENDATALOADER_HYBRID_URL_ENV];
      else process.env[OPENDATALOADER_HYBRID_URL_ENV] = previousUrl;
    }
    assert.deepEqual(await readdir(tempDirectory), []);
  });
});

test("uses the private Compose backend default and rejects malformed or traversal output", async () => {
  await withTempDirectory(async (tempDirectory) => {
    const makeConverter = (json) => async (_inputPath, options) => {
      assert.equal(options.hybridUrl, DEFAULT_OPENDATALOADER_HYBRID_URL);
      await writeFile(join(options.outputDir, "input.json"), json);
      await writeFile(join(options.outputDir, "input.md"), "content");
    };
    await assert.rejects(
      convertPdfWithOpenDataLoader(new Uint8Array([1]), "bad.pdf", {
        tempDirectory,
        converter: makeConverter("not-json"),
      }),
      (error) => error instanceof OpenDataLoaderPdfError && error.code === "invalid_output",
    );
    await assert.rejects(
      convertPdfWithOpenDataLoader(new Uint8Array([1]), "traversal.pdf", {
        tempDirectory,
        converter: makeConverter(validDocument("../outside.png")),
      }),
      (error) => error instanceof OpenDataLoaderPdfError && error.code === "invalid_output",
    );
  });
});

test("accepts metadata-only image elements and bounds referenced image output", async () => {
  await withTempDirectory(async (tempDirectory) => {
    await assert.doesNotReject(convertPdfWithOpenDataLoader(new Uint8Array([1]), "metadata.pdf", {
      tempDirectory,
      converter: async (_inputPath, options) => {
        await writeFile(join(options.outputDir, "input.json"), validDocument(undefined));
        await writeFile(join(options.outputDir, "input.md"), "content");
      },
    }));

    const kids = Array.from({ length: 33 }, (_, index) => ({
      type: "image",
      "page number": 1,
      "bounding box": [0, 0, 10, 10],
      source: `image-${index}.png`,
      format: "png",
    }));
    await assert.rejects(
      convertPdfWithOpenDataLoader(new Uint8Array([1]), "many-images.pdf", {
        tempDirectory,
        converter: async (_inputPath, options) => {
          await writeFile(join(options.outputDir, "input.json"), JSON.stringify({ ...JSON.parse(validDocument("image-0.png")), kids }));
          await writeFile(join(options.outputDir, "input.md"), "content");
          await Promise.all(kids.map((kid) => writeFile(join(options.outputDir, kid.source), Buffer.from([1]))));
        },
      }),
      (error) => error instanceof OpenDataLoaderPdfError && error.code === "invalid_output",
    );
  });
});

test("honors an already-aborted signal without starting Java", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    convertPdfWithOpenDataLoader(new Uint8Array([1]), "cancelled.pdf", {
      signal: controller.signal,
      converter: async () => {
        called = true;
        return "";
      },
    }),
    (error) => error instanceof OpenDataLoaderPdfError && error.code === "cancelled",
  );
  assert.equal(called, false);
});

test("returns cancellation promptly while deferring workspace cleanup until conversion settles", async () => {
  await withTempDirectory(async (tempDirectory) => {
    const controller = new AbortController();
    let resolveConversion;
    const conversion = new Promise((resolve) => { resolveConversion = resolve; });
    const result = convertPdfWithOpenDataLoader(new Uint8Array([1]), "slow.pdf", {
      signal: controller.signal,
      tempDirectory,
      converter: async () => conversion,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(result, (error) => error instanceof OpenDataLoaderPdfError && error.code === "cancelled");
    assert.equal((await readdir(tempDirectory)).length, 1);
    resolveConversion("");
    for (let attempt = 0; attempt < 10 && (await readdir(tempDirectory)).length !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(await readdir(tempDirectory), []);
  });
});

test("bounds a conversion that never settles", async () => {
  await withTempDirectory(async (tempDirectory) => {
    let resolveConversion;
    const conversion = new Promise((resolve) => { resolveConversion = resolve; });
    const result = convertPdfWithOpenDataLoader(new Uint8Array([1]), "timeout.pdf", {
      tempDirectory,
      conversionTimeoutMs: 5,
      converter: async () => conversion,
    });
    const rejection = assert.rejects(result, (error) => error instanceof OpenDataLoaderPdfError && error.code === "conversion_timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rejection;
    resolveConversion("");
    for (let attempt = 0; attempt < 10 && (await readdir(tempDirectory)).length !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(await readdir(tempDirectory), []);
  });
});
