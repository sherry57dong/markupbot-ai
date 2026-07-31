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

// ── Four annotation types ─────────────────────────────────────────────────────

/**
 * Red strikeout — pure deletion, no replacement.
 * Popup shows "DELETE" so the reviewer knows to cut this text.
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
 * Red strikeout on the old text + red FreeText above showing the new text.
 * Matches the visual style of professional PDF redline reviews.
 */
function addStrikeoutAndReplace(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  replacementText: string,
): void {
  const { x, y, width, height } = box;
  const { height: pageHeight } = page.getSize();
  const fontSize = Math.max(7, Math.min(box.fontSizeEstimate * 0.85, 11));
  const lineH = fontSize + 3;
  const textW = Math.max(width, replacementText.length * fontSize * 0.55 + 6);

  // Red strikeout on old text
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

  // Place FreeText above the strikeout if there's room; otherwise below.
  // (PDF y-axis goes up, so "above" means higher y — if that exceeds the page, flip.)
  const fitsAbove = y + height + 1 + lineH <= pageHeight;
  const ftY = fitsAbove ? y + height + 1 : Math.max(0, y - lineH - 1);

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("FreeText"),
    Rect: [x, ftY, x + textW, ftY + lineH],
    Contents: PDFString.of(replacementText),
    T: PDFString.of("MarkupBot AI"),
    DA: PDFString.of(`/Helv ${fontSize} Tf 0.85 0 0 rg`),
    C: [1, 0.75, 0.75],
    BS: pdfDoc.context.obj({ Type: PDFName.of("Border"), W: PDFNumber.of(0) }),
    F: PDFNumber.of(4),
  });
}

/**
 * Green caret (^) at the insertion point + green FreeText showing what to insert.
 * Use when adding a word or phrase without deleting anything.
 */
function addInsert(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  insertText: string,
): void {
  const { x, y, height } = box;
  const { height: pageHeight } = page.getSize();
  const fontSize = Math.max(7, Math.min(box.fontSizeEstimate * 0.85, 11));
  const lineH = fontSize + 3;
  const textW = insertText.length * fontSize * 0.55 + 6;
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

  // Place FreeText above the caret if there's room; otherwise below
  const fitsAbove = y + height + 1 + lineH <= pageHeight;
  const ftY = fitsAbove ? y + height + 1 : Math.max(0, y - lineH - 1);

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("FreeText"),
    Rect: [x - caretW, ftY, x - caretW + textW, ftY + lineH],
    Contents: PDFString.of(`^ ${insertText}`),
    T: PDFString.of("MarkupBot AI"),
    DA: PDFString.of(`/Helv ${fontSize} Tf 0 0.55 0 rg`),
    C: [0.75, 1, 0.75],
    BS: pdfDoc.context.obj({ Type: PDFName.of("Border"), W: PDFNumber.of(0) }),
    F: PDFNumber.of(4),
  });
}

/**
 * Amber sticky-note icon anchored to nearby text.
 * Use for image, layout, color, or any non-text feedback.
 */
function addMarginNote(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  noteText: string,
): void {
  const noteSize = 18;
  const { width: pageWidth } = page.getSize();
  // Always pin to the right gutter so the icon is always visible,
  // regardless of where the anchor text falls on the page.
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
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
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
