import Anthropic from "@anthropic-ai/sdk";
import type { EditInstruction } from "./types.ts";

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
});

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target_text: {
            type: "string",
            description:
              "The EXACT original string from the document. Must be a verbatim, contiguous substring — do not paraphrase or normalize whitespace.",
          },
          replacement_text: {
            type: "string",
            description: "The new text to insert in place of target_text.",
          },
          action_type: {
            type: "string",
            enum: ["strikeout_and_replace", "margin_note"],
          },
        },
        required: ["target_text", "replacement_text", "action_type"],
        additionalProperties: false,
      },
    },
  },
  required: ["edits"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a precision document-editing assistant for a marketing proofing tool.

You will be given:
1. The full extracted text of a marketing PDF (pages separated by "---PAGE BREAK---").
2. A block of messy, informal client feedback describing desired changes.

Your job is to translate the feedback into a structured list of edits.

CRITICAL RULES:
- "target_text" MUST be an exact, verbatim, contiguous substring copied directly from the document text. Never invent, paraphrase, or fix typos — copy it exactly as it appears.
- Keep target_text as SHORT as possible while still being unique enough to locate unambiguously.
- If the feedback describes a direct wording change, use action_type "strikeout_and_replace".
- If the feedback is a general comment that doesn't map to a specific text swap, use action_type "margin_note".
- If a piece of feedback cannot be confidently mapped to text in the document, omit it rather than guessing.`;

export async function generateEditInstructions(
  documentText: string,
  feedbackText: string,
): Promise<EditInstruction[]> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: EDIT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          `<document_text>\n${documentText}\n</document_text>`,
          `<client_feedback>\n${feedbackText}\n</client_feedback>`,
        ].join("\n\n"),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("The AI declined to process this request."), { status: 422 });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No structured output returned from the model.");
  }

  const parsed = JSON.parse(textBlock.text) as { edits: EditInstruction[] };
  return parsed.edits;
}
