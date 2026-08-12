import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
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

  // If the match falls within a single item and is shorter than it,
  // estimate sub-item bounds by character-position fraction so that
  // e.g. "$100" inside "Save up to $100 instantly" only highlights "$100".
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

  // Multi-item match: use combined bounding box
  const minX = Math.min(...overlapping.map((i) => i.x));
  const maxX = Math.max(...overlapping.map((i) => i.x + i.width));
  const minY = Math.min(...overlapping.map((i) => i.y));
  const maxY = Math.max(...overlapping.map((i) => i.y + i.height));
  const avgFontSize = overlapping.reduce((sum, i) => sum + i.height, 0) / overlapping.length;

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
  // PDF spec order: upper-left, upper-right, lower-left, lower-right
  return [x, y + h, x + w, y + h, x, y, x + w, y];
}

// ── Four annotation types ─────────────────────────────────────────────────────

/**
 * Red strikeout — pure deletion.
 * Renders as a red line through the text in every PDF viewer.
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
    T: PDFString.of("Redink"),
    C: [1, 0, 0],
    F: PDFNumber.of(4),
  });
}

/**
 * Red strikeout with replacement text in the popup.
 * Matches professional PDF redline style — the reviewer clicks the annotation
 * to read the replacement; no text is drawn on the page.
 */
function addStrikeoutAndReplace(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  replacementText: string,
): void {
  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("StrikeOut"),
    Rect: [box.x, box.y, box.x + box.width, box.y + box.height],
    QuadPoints: quadPoints(box.x, box.y, box.width, box.height),
    Contents: PDFString.of(`Replace with: ${replacementText}`),
    T: PDFString.of("Redink"),
    C: [1, 0, 0],
    F: PDFNumber.of(4),
  });
}

/**
 * Green caret at the insertion point — popup shows text to insert.
 */
function addInsert(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  insertText: string,
): void {
  const { x, y, height } = box;
  const caretW = Math.min(height * 0.7, 8);

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Caret"),
    Rect: [x - caretW, y, x, y + height],
    RD: [0, 0, 0, 0],
    Contents: PDFString.of(`Insert: ${insertText}`),
    T: PDFString.of("Redink"),
    C: [0, 0.6, 0],
    F: PDFNumber.of(4),
    Sy: PDFName.of("None"),
  });
}

/**
 * Purple speech-bubble sticky note for image/layout comments.
 * Placed on the OPPOSITE side from the anchor text so the icon lands on the
 * image/photo area (anchor text is usually in the text panel on the other side).
 */
function addMarginNote(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  noteText: string,
): void {
  const noteSize = 20;
  const { width: pageWidth } = page.getSize();
  // If anchor text is in the right half, put icon on the left (photo side), and vice versa.
  const anchorMidX = box.x + box.width / 2;
  const noteX = anchorMidX > pageWidth / 2 ? 8 : pageWidth - noteSize - 8;

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [noteX, box.y, noteX + noteSize, box.y + noteSize],
    Contents: PDFString.of(noteText),
    T: PDFString.of("Redink"),
    Name: PDFName.of("Comment"),
    C: [0.55, 0.15, 0.75],
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
  const pages = pdfDoc.getPages();

  for (const edit of edits) {
    let box: BoundingBox | null = null;

    // For margin notes with a page_hint, search that page first so the icon
    // always lands on the right page even when anchor text is not unique.
    if (edit.action_type === "margin_note" && edit.page_hint != null && edit.page_hint >= 1) {
      const hintIdx = edit.page_hint - 1;
      if (hintIdx < pageLayouts.length) {
        box = locateTextOnPage(pageLayouts[hintIdx], edit.target_text);
        if (!box && pageLayouts[hintIdx].items.length > 0) {
          const fi = pageLayouts[hintIdx].items[0];
          box = { pageIndex: hintIdx, x: fi.x, y: fi.y, width: fi.width, height: fi.height, fontSizeEstimate: fi.height || 10 };
        }
      }
    }

    // Fall back to searching all pages in order
    if (!box) {
      for (const layout of pageLayouts) {
        box = locateTextOnPage(layout, edit.target_text);
        if (box) break;
      }
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
        addStrikeoutAndReplace(pdfDoc, page, box, edit.replacement_text);
        break;
      case "insert":
        addInsert(pdfDoc, page, box, edit.replacement_text);
        break;
      case "margin_note":
        addMarginNote(pdfDoc, page, box, edit.replacement_text);
        break;
    }
  }

  return pdfDoc.save();
}
