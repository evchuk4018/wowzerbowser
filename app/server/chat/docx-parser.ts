import mammoth from "mammoth";
import type { ChatDocumentPage, ChatDocumentImageAnalysis } from "../../../lib/chat-document";

const PAGE_CHAR_LIMIT = 8_000;
const SUPPORTED_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type DocxImage = { imageNumber: number; bytes: Uint8Array; contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
export type ParsedDocx = { pages: ChatDocumentPage[]; imageCount: number; images: DocxImage[] };

function validatePackage(bytes: Uint8Array): void {
  const legacySignature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (legacySignature.every((value, index) => bytes[index] === value)) throw new Error("Legacy .doc files are not supported.");
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("The uploaded file is not a valid DOCX package.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true), offset = view.getUint32(eocd + 16, true);
  let cursor = offset;
  const names = new Set<string>();
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("The DOCX ZIP directory is malformed.");
    if ((view.getUint16(cursor + 8, true) & 1) !== 0) throw new Error("Encrypted DOCX files are not supported.");
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error("The DOCX ZIP directory is malformed.");
    const name = new TextDecoder().decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("The DOCX ZIP contains an unsafe path.");
    names.add(name); cursor = end;
  }
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) throw new Error("The ZIP file is not a valid DOCX document.");
}

export function splitDocxLogicalPages(text: string): ChatDocumentPage[] {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n+/).map((value) => value.trim()).filter(Boolean);
  const pages: string[] = [];
  let current = "";
  const flush = () => { if (current) { pages.push(current); current = ""; } };
  for (const paragraph of paragraphs) {
    if (paragraph.length > PAGE_CHAR_LIMIT) {
      flush();
      for (let start = 0; start < paragraph.length; start += PAGE_CHAR_LIMIT) pages.push(paragraph.slice(start, start + PAGE_CHAR_LIMIT));
    } else if (!current) current = paragraph;
    else if (current.length + 2 + paragraph.length <= PAGE_CHAR_LIMIT) current += `\n\n${paragraph}`;
    else { flush(); current = paragraph; }
  }
  flush();
  return pages.map((page, index) => ({ pageNumber: index + 1, text: page, extractionMethod: "native" as const }));
}

export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocx> {
  validatePackage(bytes);
  const buffer = Buffer.from(bytes);
  const raw = await mammoth.extractRawText({ buffer });
  const pages = splitDocxLogicalPages(raw.value);
  if (!pages.length) throw new Error("Empty DOCX files are not supported.");
  const images: DocxImage[] = [];
  let imageCount = 0;
  await mammoth.convertToHtml({ buffer }, { convertImage: mammoth.images.imgElement(async (image) => {
    imageCount += 1;
    if (images.length < 4 && SUPPORTED_IMAGES.has(image.contentType)) images.push({ imageNumber: imageCount, bytes: Uint8Array.from(Buffer.from(await image.read("base64"), "base64")), contentType: image.contentType as DocxImage["contentType"] });
    return { src: "" };
  }) });
  return { pages, imageCount, images };
}

export type AnalyzeDocxImage = (image: DocxImage, imageNumber: number) => Promise<Omit<ChatDocumentImageAnalysis, "imageNumber">>;
