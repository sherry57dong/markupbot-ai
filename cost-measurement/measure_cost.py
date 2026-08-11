#!/usr/bin/env python3
"""
Red Ink — True Cost Per Credit Measurement Harness
====================================================
Runs real OpenAI API calls (same model + prompt as production) against
a folder of sample PDFs and outputs per-doc cost breakdown + summary.

Usage:
  OPENAI_API_KEY=sk-... python3 measure_cost.py [--pdf-dir ./test_pdfs]

Output:
  redink_cost_YYYYMMDD_HHMMSS.csv   — one row per document
  printed summary table
"""

import os, sys, csv, json, time, math, argparse, statistics, urllib.request, urllib.error
from pathlib import Path
from datetime import datetime

# ── Pricing (verified 2026-08-11) ────────────────────────────────────────────
# gpt-4o-mini  https://openai.com/api/pricing/
GPT4O_MINI_IN  = 0.150 / 1_000_000   # $ per input  token
GPT4O_MINI_OUT = 0.600 / 1_000_000   # $ per output token

# Anthropic claude-sonnet-5 intro pricing (through 2026-08-31)
CLAUDE_S5_IN   = 2.00  / 1_000_000
CLAUDE_S5_OUT  = 10.00 / 1_000_000

# Supabase Edge Function (after free-tier 500K invocations)
SUPABASE_PER_INVOCATION = 0.0000025   # $ per invocation
SUPABASE_PER_GB_SECOND  = 0.000025    # $ per GB-second CPU
EDGE_MEMORY_GB = 0.128                # 128 MB function class

# Price points to evaluate margin against
PRICE_POINTS = {
    "Studio  $0.17/cr":  0.17,
    "Agency  $0.33/cr":  0.33,
    "Starter $0.58/cr":  0.58,
    "Add-on  $0.30/cr":  0.30,
    "Agent   $0.50/cr":  0.50,
}

# ── Exact production system prompt (keep in sync with aiLocator.ts) ───────────
SYSTEM_PROMPT = """You are a precision document-editing assistant for a marketing PDF proofing tool.

You will be given:
1. The full extracted text of a marketing PDF (pages separated by "---PAGE BREAK---").
2. A block of messy, informal client feedback describing desired changes.

Your job is to translate EVERY piece of feedback into a structured list of edits. Never omit feedback.

OUTPUT STYLE: This tool creates professional PDF redline annotations. Replacement text goes in the annotation POPUP — it is NOT drawn on the page. Target only the minimum text that needs to change.

ACTION TYPES — choose exactly one per edit:

"strikeout_only"
  Use when: feedback says to DELETE, REMOVE, or CUT text with no replacement.
  target_text: exact text to strike out
  replacement_text: "" (empty)
  page_hint: null
  Example: "Remove Batt Insulation" → target_text="Batt Insulation – $15 off"

"strikeout_and_replace"
  Use when: feedback changes specific text to different text.
  target_text: the MINIMUM exact verbatim substring that changes (just the price, just the word)
  replacement_text: the new value that replaces it
  page_hint: null
  Example: "$100" → "$80": target_text="$100", replacement_text="$80"
  Example: "$2 off" price change: target_text="$2 off", replacement_text="$3 off" (not the whole line)

"insert"
  Use when: feedback adds new text WITHOUT removing anything.
  target_text: the word IMMEDIATELY AFTER the insertion point
  replacement_text: the text to be inserted before target_text
  page_hint: null

"margin_note"
  Use when: feedback is about images, photos, graphics, layout, colors, branding, or ANY non-text element.
  NEVER omit this kind of feedback. Always use margin_note for image/photo comments.
  target_text: a short text snippet that exists on the SAME PAGE as the image (use the page headline or nearby paragraph text)
  replacement_text: the full comment verbatim from the feedback
  page_hint: the 1-indexed page number where the image is located (1 = first page, 2 = second page, etc.)

CRITICAL RULES:
- target_text MUST be an exact, verbatim, contiguous substring from the document. Never invent or paraphrase.
- MINIMUM target_text: target ONLY the specific element that changes, never the surrounding sentence.
- page_hint is REQUIRED for margin_note (set to the page number). Set to null for all other types.
- NEVER omit any feedback item. Every piece of feedback must produce at least one edit."""

EDIT_SCHEMA = {
    "type": "object",
    "properties": {
        "edits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "target_text":     {"type": "string"},
                    "replacement_text":{"type": "string"},
                    "action_type":     {"type": "string", "enum": ["strikeout_only","strikeout_and_replace","insert","margin_note"]},
                    "page_hint":       {"anyOf": [{"type": "number"}, {"type": "null"}]},
                },
                "required": ["target_text","replacement_text","action_type","page_hint"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["edits"],
    "additionalProperties": False,
}

# Representative feedback strings — vary by doc complexity
FEEDBACK_BY_SIZE = {
    "light":  "Change the price from $100 to $80. Remove the disclaimer at the bottom.",
    "medium": "Update the headline to 'New & Improved'. Change $150 to $120. Remove the old logo. Update the contact email to info@example.com. Add 'Limited time offer' before the CTA.",
    "heavy":  "Page 1: Change title to 'Summer Collection 2026'. Price on banner: $299 → $249. Replace winter photo with summer imagery. Page 2: Update all product prices — Basic $49, Premium $99. Remove 'Coming Soon' badge. Add footnote: '*Prices valid through Aug 31 2026'. Page 3: Update team photo. Change CEO name from John Smith to Sarah Chen. Update office address to 123 Main St, New York NY 10001. Remove the 2023 certification badge.",
}

# ── PDF text extraction ───────────────────────────────────────────────────────

def extract_text_and_pages(pdf_path: Path) -> tuple[str, int]:
    """
    Returns (full_document_text, page_count).
    Uses pdfplumber — approximates what unpdf produces in production.
    Pages are joined with the same PAGE BREAK separator the pipeline uses.
    """
    import pdfplumber
    pages_text = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            text = page.extract_text() or ""
            pages_text.append(text.strip())
    document_text = "\n\n---PAGE BREAK---\n\n".join(pages_text)
    return document_text, page_count

# ── OpenAI call ───────────────────────────────────────────────────────────────

def call_openai(document_text: str, feedback: str, api_key: str) -> dict:
    """
    Makes a real gpt-4o-mini call and returns the full API response dict,
    including usage.prompt_tokens and usage.completion_tokens.
    """
    user_message = (
        f"<document_text>\n{document_text}\n</document_text>\n\n"
        f"<client_feedback>\n{feedback}\n</client_feedback>"
    )
    payload = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_message},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "edit_instructions", "strict": True, "schema": EDIT_SCHEMA},
        },
    }).encode()

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())

# ── Per-document measurement ──────────────────────────────────────────────────

def measure_document(pdf_path: Path, api_key: str, verbose: bool = True) -> dict:
    filename = pdf_path.name
    result = {
        "filename": filename, "page_count": 0, "credits": 0,
        "model_calls": 0, "input_tokens": 0, "output_tokens": 0, "model_cost": 0.0,
        "extract_seconds": 0.0, "api_seconds": 0.0, "total_seconds": 0.0,
        "compute_cost": 0.0, "infrastructure_cost": 0.0,
        "total_cost": 0.0, "cost_per_credit": 0.0,
        "success": False, "error": "",
    }

    try:
        # ── Step 1: PDF text extraction (local — no API cost) ──────────────
        t0 = time.perf_counter()
        document_text, page_count = extract_text_and_pages(pdf_path)
        extract_seconds = time.perf_counter() - t0

        result["page_count"] = page_count
        result["credits"] = math.ceil(page_count / 10)
        result["extract_seconds"] = round(extract_seconds, 3)

        # Choose feedback complexity based on page count
        if page_count <= 3:
            feedback = FEEDBACK_BY_SIZE["light"]
        elif page_count <= 15:
            feedback = FEEDBACK_BY_SIZE["medium"]
        else:
            feedback = FEEDBACK_BY_SIZE["heavy"]

        # ── Step 2: AI call (real API, real tokens) ────────────────────────
        t1 = time.perf_counter()
        api_response = call_openai(document_text, feedback, api_key)
        api_seconds = time.perf_counter() - t1

        usage = api_response.get("usage", {})
        input_tokens  = usage.get("prompt_tokens", 0)
        output_tokens = usage.get("completion_tokens", 0)
        model_cost    = input_tokens * GPT4O_MINI_IN + output_tokens * GPT4O_MINI_OUT

        result["model_calls"]   = 1
        result["input_tokens"]  = input_tokens
        result["output_tokens"] = output_tokens
        result["model_cost"]    = model_cost
        result["api_seconds"]   = round(api_seconds, 3)

        # ── Step 3: Infrastructure / compute cost ─────────────────────────
        # Wall-clock time for the full edge function invocation
        total_seconds = extract_seconds + api_seconds  # pdfDraw is fast, ~0.1s
        compute_cost  = total_seconds * EDGE_MEMORY_GB * SUPABASE_PER_GB_SECOND
        infra_cost    = SUPABASE_PER_INVOCATION + compute_cost

        result["total_seconds"]       = round(total_seconds, 3)
        result["compute_cost"]        = compute_cost
        result["infrastructure_cost"] = infra_cost

        # ── Totals ────────────────────────────────────────────────────────
        total_cost     = model_cost + infra_cost   # processing is local → $0 API cost
        cost_per_credit = total_cost / result["credits"] if result["credits"] > 0 else 0

        result["total_cost"]      = total_cost
        result["cost_per_credit"] = cost_per_credit
        result["success"]         = True

        if verbose:
            print(f"  ✓ {filename:40s} {page_count:3d}p  {result['credits']}cr  "
                  f"in={input_tokens:5d} out={output_tokens:4d}  "
                  f"${total_cost:.5f}  (${cost_per_credit:.5f}/cr)")

    except Exception as e:
        result["error"] = str(e)
        if verbose:
            print(f"  ✗ {filename:40s} FAILED: {e}")

    return result

# ── Summary ───────────────────────────────────────────────────────────────────

def print_summary(results: list[dict]) -> None:
    successes = [r for r in results if r["success"]]
    failures  = [r for r in results if not r["success"]]

    print("\n" + "="*70)
    print("  RED INK — COST MEASUREMENT RESULTS")
    print("="*70)
    print(f"  Docs run: {len(results)}   Succeeded: {len(successes)}   Failed: {len(failures)}   "
          f"Failure rate: {len(failures)/len(results)*100:.1f}%\n")

    if not successes:
        print("  No successful runs — cannot compute averages.")
        return

    cpcs = [r["cost_per_credit"] for r in successes]
    avg_cpc = statistics.mean(cpcs)
    med_cpc = statistics.median(cpcs)
    min_cpc = min(cpcs)
    max_cpc = max(cpcs)
    p90_cpc = sorted(cpcs)[max(0, math.ceil(len(cpcs) * 0.9) - 1)]

    # Cost component breakdown
    total_model  = sum(r["model_cost"]         for r in successes)
    total_infra  = sum(r["infrastructure_cost"] for r in successes)
    total_all    = total_model + total_infra
    pct_model    = total_model / total_all * 100 if total_all else 0
    pct_infra    = total_infra / total_all * 100 if total_all else 0

    print(f"  {'METRIC':<30} {'VALUE':>12}")
    print(f"  {'-'*44}")
    print(f"  {'Average cost/credit':<30} {'${:.5f}'.format(avg_cpc):>12}")
    print(f"  {'Median cost/credit':<30} {'${:.5f}'.format(med_cpc):>12}")
    print(f"  {'Min cost/credit':<30} {'${:.5f}'.format(min_cpc):>12}")
    print(f"  {'Max cost/credit':<30} {'${:.5f}'.format(max_cpc):>12}")
    print(f"  {'p90 cost/credit':<30} {'${:.5f}'.format(p90_cpc):>12}  ← worst realistic case")
    print(f"  {'-'*44}")
    print(f"  {'AI model cost share':<30} {'{:.1f}%'.format(pct_model):>12}")
    print(f"  {'Infrastructure cost share':<30} {'{:.1f}%'.format(pct_infra):>12}")
    print(f"  {'Processing cost share':<30} {'0.0% (local)':>12}")

    print(f"\n  IMPLIED MARGINS (using avg cost ${avg_cpc:.5f}/cr)")
    print(f"  {'PRICE POINT':<25} {'PRICE':>8} {'MARGIN':>10} {'STATUS':>10}")
    print(f"  {'-'*57}")
    for label, price in PRICE_POINTS.items():
        margin_pct = (price - avg_cpc) / price * 100
        flag = "✓ OK" if margin_pct >= 50 else ("⚠ THIN" if margin_pct > 0 else "✗ NEGATIVE")
        print(f"  {label:<25} {'${:.2f}'.format(price):>8} {'{:.1f}%'.format(margin_pct):>10} {flag:>10}")

    print(f"\n  p90 margins (worst-case ${p90_cpc:.5f}/cr):")
    for label, price in PRICE_POINTS.items():
        margin_pct = (price - p90_cpc) / price * 100
        flag = "✓" if margin_pct >= 50 else ("⚠" if margin_pct > 0 else "✗ NEGATIVE")
        print(f"  {label:<25} {'{:.1f}%'.format(margin_pct):>8}  {flag}")

    if failures:
        print(f"\n  FAILURES ({len(failures)}):")
        for f in failures:
            print(f"  ✗ {f['filename']}: {f['error']}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Red Ink cost measurement harness")
    parser.add_argument("--pdf-dir", default=str(Path(__file__).parent / "test_pdfs"),
                        help="Folder of test PDFs (default: ./test_pdfs)")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        print("ERROR: set OPENAI_API_KEY environment variable", file=sys.stderr)
        sys.exit(1)

    pdf_dir = Path(args.pdf_dir)
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in {pdf_dir}")
        print("Add test PDFs to that folder, then re-run.")
        sys.exit(0)

    print(f"\nRed Ink Cost Measurement Harness")
    print(f"Model: gpt-4o-mini  |  {len(pdfs)} PDFs  |  {datetime.now():%Y-%m-%d %H:%M}")
    print(f"{'─'*70}")

    results = []
    for pdf_path in pdfs:
        results.append(measure_document(pdf_path, api_key))

    # Write CSV
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = Path(__file__).parent / f"redink_cost_{ts}.csv"
    fieldnames = [
        "filename","page_count","credits","success","error",
        "model_calls","input_tokens","output_tokens","model_cost",
        "extract_seconds","api_seconds","total_seconds",
        "compute_cost","infrastructure_cost","total_cost","cost_per_credit",
    ]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(results)
    print(f"\nCSV written → {csv_path}")

    print_summary(results)

if __name__ == "__main__":
    main()
