import { buildCorsHeaders } from "./lib/cors.ts";
import { authenticateUser, checkCreditsAndValidate, chargeCredits } from "./lib/auth.ts";
import { extractPageTextLayout } from "./lib/pdfText.ts";
import { generateEditInstructions } from "./lib/aiLocator.ts";
import { applyMarkupToPdf } from "./lib/pdfDraw.ts";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const corsHeaders = buildCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonError(corsHeaders, 405, "Method not allowed");
  }

  try {
    // Phase 1: authenticate (fast — before any heavy work)
    const { supabaseAdmin, user } = await authenticateUser(req);

    const form = await req.formData();
    const pdfFile = form.get("pdf");
    const feedbackText = form.get("feedback");

    if (!(pdfFile instanceof File) || typeof feedbackText !== "string") {
      return jsonError(corsHeaders, 400, "Missing 'pdf' file or 'feedback' text field");
    }

    const originalPdfBytes = new Uint8Array(await pdfFile.arrayBuffer());

    // Phase 2: extract layout (we need page count before checking credits)
    const pageLayouts = await extractPageTextLayout(originalPdfBytes);
    const pageCount = pageLayouts.length;

    // Phase 3: validate limits + confirm sufficient credits
    const jobId = crypto.randomUUID();
    const creditsNeeded = await checkCreditsAndValidate(
      supabaseAdmin,
      user.id,
      pageCount,
      originalPdfBytes.length,
    );

    // Phase 4: AI analysis + annotation (the expensive work)
    const documentText = pageLayouts.map((p) => p.fullText).join("\n\n---PAGE BREAK---\n\n");
    const editInstructions = await generateEditInstructions(documentText, feedbackText);
    const markedUpPdfBytes = await applyMarkupToPdf(originalPdfBytes, pageLayouts, editInstructions);

    // Phase 5: deduct on success (idempotent via jobId)
    await chargeCredits(supabaseAdmin, user.id, creditsNeeded, jobId);

    return new Response(markedUpPdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="markup.pdf"',
        "X-Credits-Charged": String(creditsNeeded),
      },
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
