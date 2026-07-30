// Add your actual Lovable app domain(s) here before going to production.
const ALLOWED_ORIGINS = new Set([
  "https://your-project.lovable.app",
  "https://your-custom-domain.com",
  "http://localhost:5173",
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
