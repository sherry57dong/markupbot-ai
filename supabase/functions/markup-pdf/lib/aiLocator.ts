import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { EditInstruction } from "./types.ts";

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

function buildUserMessage(documentText: string, feedbackText: string): string {
  return [
    `<document_text>\n${documentText}\n</document_text>`,
    `<client_feedback>\n${feedbackText}\n</client_feedback>`,
  ].join("\n\n");
}

async function generateWithOpenAI(documentText: string, feedbackText: string): Promise<EditInstruction[]> {
  const client = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") });

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(documentText, feedbackText) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "edit_instructions",
        strict: true,
        schema: EDIT_SCHEMA,
      },
    },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty response");

  const parsed = JSON.parse(content) as { edits: EditInstruction[] };
  return parsed.edits;
}

async function generateWithAnthropic(documentText: string, feedbackText: string): Promise<EditInstruction[]> {
  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: EDIT_SCHEMA },
    },
    messages: [{ role: "user", content: buildUserMessage(documentText, feedbackText) }],
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

export async function generateEditInstructions(
  documentText: string,
  feedbackText: string,
): Promise<EditInstruction[]> {
  if (Deno.env.get("OPENAI_API_KEY")) {
    try {
      return await generateWithOpenAI(documentText, feedbackText);
    } catch (err) {
      console.warn("OpenAI failed, falling back to Anthropic:", err instanceof Error ? err.message : err);
    }
  }
  return await generateWithAnthropic(documentText, feedbackText);
}
