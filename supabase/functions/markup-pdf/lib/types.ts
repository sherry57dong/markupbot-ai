export interface TextItemWithPosition {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  startOffset: number;
  endOffset: number;
}

export interface PageLayout {
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  items: TextItemWithPosition[];
  fullText: string;
}

export interface EditInstruction {
  target_text: string;
  replacement_text: string;
  action_type: "strikeout_and_replace" | "margin_note";
}

export interface BoundingBox {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSizeEstimate: number;
}
