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
              "The EXACT verbatim substring from the document to annotate. For margin_note, use the nearest text on the page as an anchor. For insert, use the word that will appear IMMEDIATELY AFTER the insertion point.",
          },
          replacement_text: {
            type: "string",
            description:
              "For strikeout_and_replace: the new text to show above the strikethrough. For insert: the text to insert before target_text. For strikeout_only: leave empty. For margin_note: the full comment.",
          },
          action_type: {
            type: "string",
            enum: ["strikeout_only", "strikeout_and_replace", "insert", "margin_note"],
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

Your job is to translate EVERY piece of feedback into a structured list of edits. Never omit feedback.

ACTION TYPES — choose exactly one per edit:

"strikeout_only"
  Use when: feedback says to DELETE, REMOVE, or CUT text with no replacement.
  target_text: exact text to strike out
  replacement_text: "" (empty)
  Example: "Remove Batt Insulation" → strike out "Batt Insulation – $15 off"

"strikeout_and_replace"
  Use when: feedback changes specific text to different text.
  target_text: the OLD text (exact verbatim from document)
  replacement_text: the NEW text to display above the strikethrough
  Example: "$100" → "$80": target_text="$100", replacement_text="$80"

"insert"
  Use when: feedback adds new text WITHOUT removing anything.
  target_text: the word IMMEDIATELY AFTER the insertion point
  replacement_text: the text to be inserted before target_text

"margin_note"
  Use when: feedback is about images, photos, graphics, layout, colors, branding, or ANY non-text element.
  NEVER omit this kind of feedback. Always include it as a margin_note.
  target_text: the nearest text on the same page to anchor the note
  replacement_text: the full comment verbatim from the feedback

CRITICAL RULES:
- target_text MUST be an exact, verbatim, contiguous substring from the document. Never invent or paraphrase.
- Keep target_text as SHORT as possible while still being unique on the page.
- For price changes like "$2 off" → "$3 off": target only the price ("$2 off"), replacement = "$3 off".
- NEVER omit any feedback item. If it is not a text change, use margin_note.`;

function buildUserMessage(documentText: string, feedbackText: string): string {
  return [
    `<document_text>\n${documentText}\n</document_text>`,
    `<client_feedback>\n${feedbackText}\n</client_feedback>`,
  ].join("\n\n");
}

// OpenAI via raw fetch — no npm package needed, works in any Deno runtime
async function generateWithOpenAI(documentText: string, feedbackText: string): Promise<EditInstruction[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY")!;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(documentText, feedbackText) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "edit_instructions", strict: true, schema: EDIT_SCHEMA },
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as { choices: Array<{ message: { content: string | null } }> };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty content");

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
