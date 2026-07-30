import { getDocumentProxy } from "unpdf";
import type { PageLayout, TextItemWithPosition } from "./types.ts";

export async function extractPageTextLayout(
  pdfBytes: Uint8Array,
): Promise<PageLayout[]> {
  const pdfDocProxy = await getDocumentProxy(pdfBytes);
  const layouts: PageLayout[] = [];

  for (let pageNum = 1; pageNum <= pdfDocProxy.numPages; pageNum++) {
    const page = await pdfDocProxy.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    const items: TextItemWithPosition[] = [];
    let fullText = "";
    let cursor = 0;

    for (const raw of textContent.items) {
      if (!("str" in raw) || typeof raw.str !== "string" || raw.str.length === 0) {
        continue;
      }

      // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
      // translateX/Y are in PDF user-space (bottom-left origin) — same system pdf-lib draws in
      const [, , , , x, y] = raw.transform;
      const width = raw.width ?? 0;
      const height = raw.height ?? (raw.transform[3] ?? 10);

      items.push({
        text: raw.str,
        x,
        y,
        width,
        height,
        startOffset: cursor,
        endOffset: cursor + raw.str.length,
      });

      fullText += raw.str;
      cursor += raw.str.length;

      if (raw.hasEOL) {
        fullText += " ";
        cursor += 1;
      }
    }

    layouts.push({
      pageIndex: pageNum - 1,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      items,
      fullText,
    });
  }

  return layouts;
}
