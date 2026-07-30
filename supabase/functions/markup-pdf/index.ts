import { buildCorsHeaders } from "./lib/cors.ts";
import { authenticateAndCheckCredits, deductCredit } from "./lib/auth.ts";
import { extractPageTextLayout } from "./lib/pdfText.ts";
import { generateEditInstructions } from "./lib/aiLocator.ts";
import { applyMarkupToPdf } from "./lib/pdfDraw.ts";
import { createClient } from "@supabase/supabase-js";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const corsHeaders = buildCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonError(corsHeaders, 405, "Method not allowed");
  }

  try {
    // Phase 4: Verify JWT + check credits before spending any API budget
    const { supabaseAdmin, user } = await authenticateAndCheckCredits(req);

    // Parse multipart form: expects a "pdf" file and "feedback" text field
    const form = await req.formData();
    const pdfFile = form.get("pdf");
    const feedbackText = form.get("feedback");

    if (!(pdfFile instanceof File) || typeof feedbackText !== "string") {
      return jsonError(corsHeaders, 400, "Missing 'pdf' file or 'feedback' text field");
    }

    const originalPdfBytes = new Uint8Array(await pdfFile.arrayBuffer());

    // Phase 2a: Extract text + coordinates from each page
    const pageLayouts = await extractPageTextLayout(originalPdfBytes);

    // Phase 2b: Ask Claude to map client feedback → structured edit instructions
    const documentText = pageLayouts.map((p) => p.fullText).join("\n\n---PAGE BREAK---\n\n");
    const editInstructions = await generateEditInstructions(documentText, feedbackText);

    // Phase 3: Draw red strike-throughs + replacement text onto the PDF
    const markedUpPdfBytes = await applyMarkupToPdf(
      originalPdfBytes,
      pageLayouts,
      editInstructions,
    );

    // Phase 4: Deduct 1 credit, upload to Storage, return a 5-min signed URL
    const downloadUrl = await saveAndSign(supabaseAdmin, user.id, markedUpPdfBytes);

    return new Response(JSON.stringify({ downloadUrl }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("markup-pdf error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = (err as { status?: number })?.status ?? 500;
    return jsonError(corsHeaders, status, message);
  }
});

function jsonError(corsHeaders: HeadersInit, status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function saveAndSign(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  pdfBytes: Uint8Array,
): Promise<string> {
  const path = `${userId}/${crypto.randomUUID()}.pdf`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from("markups")
    .upload(path, pdfBytes, { contentType: "application/pdf", upsert: false });

  if (uploadError) {
    throw Object.assign(new Error(`Storage upload failed: ${uploadError.message}`), { status: 500 });
  }

  // Deduct AFTER a successful upload — don't charge on a failed render
  await deductCredit(supabaseAdmin, userId);

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from("markups")
    .createSignedUrl(path, 60 * 5); // 5-minute expiry

  if (signError || !signed) {
    throw Object.assign(new Error("Failed to create signed URL"), { status: 500 });
  }

  return signed.signedUrl;
}
