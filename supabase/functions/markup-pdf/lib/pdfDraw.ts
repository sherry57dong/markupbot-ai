import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { BoundingBox, EditInstruction, PageLayout } from "./types.ts";

// ── Text locator ──────────────────────────────────────────────────────────────

function locateTextOnPage(layout: PageLayout, targetText: string): BoundingBox | null {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const haystack = normalize(layout.fullText);
  const needle = normalize(targetText);

  if (!needle) return null;

  const matchIndex = haystack.indexOf(needle);
  if (matchIndex === -1) return null;

  const matchEnd = matchIndex + needle.length;

  const overlapping = layout.items.filter(
    (item) => item.startOffset < matchEnd && item.endOffset > matchIndex,
  );

  if (overlapping.length === 0) return null;

  // If the match falls within a single text item and is shorter than it,
  // estimate sub-item bounds by finding the needle's position within that item's text.
  // This prevents a 3-word target from highlighting the whole sentence.
  if (overlapping.length === 1) {
    const item = overlapping[0];
    const itemText = normalize(item.text);
    const posInItem = itemText.indexOf(needle);
    if (posInItem !== -1 && itemText.length > needle.length && item.width > 0) {
      const startFrac = posInItem / itemText.length;
      const widthFrac = needle.length / itemText.length;
      return {
        pageIndex: layout.pageIndex,
        x: item.x + item.width * startFrac,
        y: item.y,
        width: Math.max(item.width * widthFrac, 4),
        height: item.height,
        fontSizeEstimate: item.height || 10,
      };
    }
  }

  // Multiple items (target spans lines): use their combined bounding box.
  const minX = Math.min(...overlapping.map((i) => i.x));
  const maxX = Math.max(...overlapping.map((i) => i.x + i.width));
  const minY = Math.min(...overlapping.map((i) => i.y));
  const maxY = Math.max(...overlapping.map((i) => i.y + i.height));
  const avgFontSize =
    overlapping.reduce((sum, i) => sum + i.height, 0) / overlapping.length;

  return {
    pageIndex: layout.pageIndex,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    fontSizeEstimate: avgFontSize || 10,
  };
}

// ── Annotation helpers ────────────────────────────────────────────────────────

function pushAnnotation(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  dict: Record<string, unknown>,
): void {
  const ref = pdfDoc.context.register(pdfDoc.context.obj(dict));
  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of("Annots"), pdfDoc.context.obj([ref]));
  }
}

function quadPoints(x: number, y: number, w: number, h: number): number[] {
  // upper-left, upper-right, lower-left, lower-right (PDF y-up)
  return [x, y + h, x + w, y + h, x, y, x + w, y];
}

type PDFFont = Awaited<ReturnType<PDFDocument["embedFont"]>>;

// ── Four annotation types ─────────────────────────────────────────────────────

/**
 * Red strikeout — pure deletion, no replacement.
 */
function addStrikeoutOnly(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
): void {
  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("StrikeOut"),
    Rect: [box.x, box.y, box.x + box.width, box.y + box.height],
    QuadPoints: quadPoints(box.x, box.y, box.width, box.height),
    Contents: PDFString.of("DELETE"),
    T: PDFString.of("MarkupBot AI"),
    C: [1, 0, 0],
    F: PDFNumber.of(4),
  });
}

/**
 * Red strikeout on old text + red replacement text drawn directly on the page.
 * Drawing directly (not FreeText annotation) guarantees the text is always visible.
 */
function addStrikeoutAndReplace(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  replacementText: string,
  font: PDFFont,
): void {
  const { x, y, width, height } = box;
  const { height: pageHeight } = page.getSize();
  const fontSize = Math.max(7, Math.min(box.fontSizeEstimate * 0.85, 11));
  const lineH = fontSize + 4;

  // Red StrikeOut annotation on old text
  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("StrikeOut"),
    Rect: [x, y, x + width, y + height],
    QuadPoints: quadPoints(x, y, width, height),
    Contents: PDFString.of(`Replace with: ${replacementText}`),
    T: PDFString.of("MarkupBot AI"),
    C: [1, 0, 0],
    F: PDFNumber.of(4),
  });

  // Draw replacement text directly on the page — always rendered,
  // unlike FreeText annotations which require an appearance stream to be visible.
  // Place above the strikeout if there's room; otherwise place below.
  const fitsAbove = y + height + 2 + fontSize <= pageHeight;
  const textY = fitsAbove ? y + height + 2 : Math.max(2, y - lineH);

  page.drawText(replacementText, {
    x,
    y: textY,
    size: fontSize,
    font,
    color: rgb(0.85, 0, 0),
  });
}

/**
 * Green caret at insertion point + green text drawn directly on the page.
 */
function addInsert(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  insertText: string,
  font: PDFFont,
): void {
  const { x, y, height } = box;
  const { height: pageHeight } = page.getSize();
  const fontSize = Math.max(7, Math.min(box.fontSizeEstimate * 0.85, 11));
  const lineH = fontSize + 4;
  const caretW = Math.min(height * 0.7, 8);

  // Caret annotation — appears as ^ symbol at insertion point
  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Caret"),
    Rect: [x - caretW, y, x, y + height],
    Contents: PDFString.of(`Insert: ${insertText}`),
    T: PDFString.of("MarkupBot AI"),
    C: [0, 0.6, 0],
    F: PDFNumber.of(4),
    Sy: PDFName.of("None"),
  });

  // Draw insert text directly on the page
  const fitsAbove = y + height + 2 + fontSize <= pageHeight;
  const textY = fitsAbove ? y + height + 2 : Math.max(2, y - lineH);

  page.drawText(`^ ${insertText}`, {
    x: x - caretW,
    y: textY,
    size: fontSize,
    font,
    color: rgb(0, 0.55, 0),
  });
}

/**
 * Amber sticky-note icon pinned to the right gutter of the page.
 * Always visible regardless of where the anchor text falls.
 */
function addMarginNote(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  noteText: string,
): void {
  const noteSize = 18;
  const { width: pageWidth } = page.getSize();
  const noteX = pageWidth - noteSize - 6;

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [noteX, box.y, noteX + noteSize, box.y + noteSize],
    Contents: PDFString.of(noteText),
    T: PDFString.of("MarkupBot AI"),
    Name: PDFName.of("Comment"),
    C: [1, 0.82, 0],
    F: PDFNumber.of(4),
    Open: false,
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function applyMarkupToPdf(
  originalPdfBytes: Uint8Array,
  pageLayouts: PageLayout[],
  edits: EditInstruction[],
): Promise<Uint8Array> {
  console.log("AI edits to apply:", JSON.stringify(edits));

  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  for (const edit of edits) {
    let box: BoundingBox | null = null;
    for (const layout of pageLayouts) {
      box = locateTextOnPage(layout, edit.target_text);
      if (box) break;
    }

    if (!box) {
      console.warn(`Could not locate: "${edit.target_text}"`);
      continue;
    }

    const page = pages[box.pageIndex];

    switch (edit.action_type) {
      case "strikeout_only":
        addStrikeoutOnly(pdfDoc, page, box);
        break;
      case "strikeout_and_replace":
        addStrikeoutAndReplace(pdfDoc, page, box, edit.replacement_text, font);
        break;
      case "insert":
        addInsert(pdfDoc, page, box, edit.replacement_text, font);
        break;
      case "margin_note":
        addMarginNote(pdfDoc, page, box, edit.replacement_text);
        break;
    }
  }

  return pdfDoc.save();
}
