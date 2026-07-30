import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { BoundingBox, EditInstruction, PageLayout } from "./types.ts";

const RED = rgb(0.85, 0.1, 0.1);

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

export async function applyMarkupToPdf(
  originalPdfBytes: Uint8Array,
  pageLayouts: PageLayout[],
  edits: EditInstruction[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const edit of edits) {
    let box: BoundingBox | null = null;
    for (const layout of pageLayouts) {
      box = locateTextOnPage(layout, edit.target_text);
      if (box) break;
    }

    if (!box) {
      console.warn(`Could not locate on any page: "${edit.target_text}"`);
      continue;
    }

    const page = pages[box.pageIndex];

    if (edit.action_type === "strikeout_and_replace") {
      drawStrikeoutAndReplacement(page, box, edit.replacement_text, font);
    } else {
      drawMarginNote(page, box, edit.replacement_text, font);
    }
  }

  return pdfDoc.save();
}

function drawStrikeoutAndReplacement(
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  replacementText: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
) {
  // Red line through the middle of the original text
  const strikeY = box.y + box.height / 2;
  page.drawLine({
    start: { x: box.x, y: strikeY },
    end: { x: box.x + box.width, y: strikeY },
    thickness: Math.max(1, box.fontSizeEstimate * 0.08),
    color: RED,
  });

  // Replacement text drawn above the struck-through original
  const replacementFontSize = Math.max(6, box.fontSizeEstimate * 0.85);
  page.drawText(replacementText, {
    x: box.x,
    y: box.y + box.height * 1.15,
    size: replacementFontSize,
    font,
    color: RED,
    maxWidth: Math.max(box.width * 2.5, 200),
  });
}

function drawMarginNote(
  page: ReturnType<PDFDocument["getPages"]>[number],
  box: BoundingBox,
  noteText: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
) {
  const { width: pageWidth } = page.getSize();
  const noteFontSize = Math.max(7, box.fontSizeEstimate * 0.75);

  // Dashed underline to mark the anchor point
  page.drawLine({
    start: { x: box.x, y: box.y - 2 },
    end: { x: box.x + box.width, y: box.y - 2 },
    thickness: 1,
    color: RED,
    dashArray: [2, 2],
  });

  // Note in the right margin, level with the anchor
  const marginX = Math.min(box.x + box.width + 12, pageWidth - 140);
  page.drawText(`✎ ${noteText}`, {
    x: marginX,
    y: box.y,
    size: noteFontSize,
    font,
    color: RED,
    maxWidth: 130,
  });
}
