// Optional password: only enforced when PM_PASSWORD is set in Vercel.
export function checkAuth(req) {
  const want = process.env.PM_PASSWORD;
  if (!want) return true;
  const got = req.headers['x-pm-key'] || '';
  return got.length === want.length && got === want;
}
