import { buildCorsHeaders } from "./lib/cors.ts";
import { authenticateAndCheckCredits, deductCredit } from "./lib/auth.ts";
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
    const { supabaseAdmin, user } = await authenticateAndCheckCredits(req);

    const form = await req.formData();
    const pdfFile = form.get("pdf");
    const feedbackText = form.get("feedback");

    if (!(pdfFile instanceof File) || typeof feedbackText !== "string") {
      return jsonError(corsHeaders, 400, "Missing 'pdf' file or 'feedback' text field");
    }

    const originalPdfBytes = new Uint8Array(await pdfFile.arrayBuffer());

    const pageLayouts = await extractPageTextLayout(originalPdfBytes);

    const documentText = pageLayouts.map((p) => p.fullText).join("\n\n---PAGE BREAK---\n\n");
    const editInstructions = await generateEditInstructions(documentText, feedbackText);

    const markedUpPdfBytes = await applyMarkupToPdf(
      originalPdfBytes,
      pageLayouts,
      editInstructions,
    );

    // Deduct credit after successful processing
    await deductCredit(supabaseAdmin, user.id);

    // Return PDF bytes directly — avoids any redirect to supabase.co
    return new Response(markedUpPdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": 'attachment; filename="markup.pdf"',
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
