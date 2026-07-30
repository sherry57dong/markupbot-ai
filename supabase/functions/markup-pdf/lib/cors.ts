// Add your actual Lovable app domain(s) here before going to production.
const ALLOWED_ORIGINS = new Set([
  "https://id-preview--d0fef311-8696-4dbe-8273-73718f709c57.lovable.app",
  "https://d0fef311-8696-4dbe-8273-73718f709c57.lovable.app",
  "http://localhost:5173",
  "http://localhost:3000",
]);

export function buildCorsHeaders(origin: string | null): HeadersInit {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
