import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import type { BoundingBox, EditInstruction, PageLayout } from "./types.ts";

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

function pushAnnotation(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  annotDict: Record<string, unknown>,
): void {
  const ref = pdfDoc.context.register(pdfDoc.context.obj(annotDict));

  const existing = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of("Annots"), pdfDoc.context.obj([ref]));
  }
}

// Renders as a red strikethrough in Adobe Acrobat / Preview / any standard PDF viewer.
// Clicking the annotation opens a popup showing the suggested replacement text.
// The human reviewer can delete, accept, or modify it in Acrobat.
function addStrikeoutAnnotation(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  replacementText: string,
): void {
  const { x, y, width, height } = box;

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("StrikeOut"),
    // Bounding rectangle [llx, lly, urx, ury] in PDF user-space (y-up)
    Rect: [x, y, x + width, y + height],
    // QuadPoints order: upper-left, upper-right, lower-left, lower-right
    QuadPoints: [x, y + height, x + width, y + height, x, y, x + width, y],
    Contents: PDFString.of(`Replace with: ${replacementText}`),
    T: PDFString.of("MarkupBot AI"),
    C: [1, 0, 0], // red
    F: PDFNumber.of(4), // printable flag
    CA: PDFNumber.of(1), // full opacity
  });
}

// Renders as a standard yellow sticky-note icon in the margin.
// Click to expand and read the comment. Fully editable in Acrobat.
function addNoteAnnotation(
  pdfDoc: PDFDocument,
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  noteText: string,
): void {
  const noteSize = 18;
  const { width: pageWidth } = page.getSize();
  const noteX = Math.min(box.x + box.width + 14, pageWidth - noteSize - 6);

  pushAnnotation(pdfDoc, page, {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [noteX, box.y, noteX + noteSize, box.y + noteSize],
    Contents: PDFString.of(noteText),
    T: PDFString.of("MarkupBot AI"),
    Name: PDFName.of("Comment"),
    C: [1, 0.82, 0], // amber — matches Acrobat's default sticky-note colour
    F: PDFNumber.of(4),
    Open: false,
  });
}

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

    if (edit.action_type === "strikeout_and_replace") {
      addStrikeoutAnnotation(pdfDoc, page, box, edit.replacement_text);
    } else {
      addNoteAnnotation(pdfDoc, page, box, edit.replacement_text);
    }
  }

  return pdfDoc.save();
}
