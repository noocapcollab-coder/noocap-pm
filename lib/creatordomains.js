// The creators' own email domains: mail from these is the creator's side, never the brand, never a Brand Email or To.
// CREATOR_DOMAINS (Vercel) can add or rename pairs, but the built-in pairs always apply on top of it, so a creator whose
// inbox the env forgot is still recognised. Brad's partnerships@ninjaaitools.com was missing: it became the Brand Email
// on PromoCut and Teamily AI, so follow-ups went To Brad himself and the Teamily reply left out Alyssa who asked
// (system check, Nov 10).
const BUILT_IN = 'buildroom.ai:Duncan,chriscordero.net:Chris,valchy.ai:Valeri,automateaiconsulting.com:Lindsay,ninjaaitools.com:Brad';
export const CREATOR_DOMAINS = [String(process.env.CREATOR_DOMAINS || ''), BUILT_IN].filter(Boolean).join(',');
