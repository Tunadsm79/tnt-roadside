// api/_auth.js
//
// Shared authentication helpers -- token signing/verification and PIN
// hashing/verification. This is NOT a Vercel route: the leading
// underscore excludes it from function routing (the same convention
// already used by api/_notify.js in this repo), so other files can
// require() it without using one of the 12 Hobby-plan function slots.
//
// Step 1 of the TNT Roadside security plan
// (claude/TNT-Roadside-Security-Architecture-Plan.md). This file is
// pure addition: as of Step 1, nothing in the live system calls it
// yet, so adding it changes no existing behavior. Later steps will
// require() these functions from the endpoints that need them.
//
// Uses only Node's built-in `crypto` module -- no new npm dependency.

const crypto = require('crypto');

function getSigningSecret() {
  const secret = process.env.TNT_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'TNT_AUTH_SECRET is not set. Add it as a Vercel environment variable ' +
      '(and, if generating a PIN hash locally, set it temporarily in your ' +
      'terminal) before calling any function in api/_auth.js.'
    );
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(input) {
  const restored = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (restored.length % 4)) % 4;
  const padded = restored + '='.repeat(padLength);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function timingSafeStringsEqual(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Create a signed, stateless token carrying `claims` (a plain object --
 * e.g. { job_id: '...' }, or { role: 'tech', tech_name: 'Demian' }, or
 * { role: 'admin' }). Adds `iat`/`exp` automatically. Default lifetime
 * is 24 hours -- generous enough for a roadside job that runs long or
 * a technician's shift.
 *
 * Returns a compact string: base64url(payload) + '.' + hex HMAC signature.
 * No external JWT library involved -- this is a small, purpose-built
 * equivalent using only `crypto`.
 */
function signToken(claims, expiresInSeconds = 24 * 60 * 60) {
  const secret = getSigningSecret();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iat: nowSeconds,
    exp: nowSeconds + expiresInSeconds,
  };
  const payloadPart = base64url(JSON.stringify(payload));
  const signaturePart = hmacHex(secret, payloadPart);
  return `${payloadPart}.${signaturePart}`;
}

/**
 * Verify a token produced by signToken(). Returns the decoded claims
 * object (including iat/exp) if the signature is valid and the token
 * has not expired. Returns null for anything else -- missing token,
 * malformed token, wrong signature, or expired token. Never throws on
 * bad input; callers should treat null as "not authenticated."
 */
function verifyToken(token) {
  try {
    const secret = getSigningSecret();
    if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
    const dotIndex = token.indexOf('.');
    const payloadPart = token.slice(0, dotIndex);
    const signaturePart = token.slice(dotIndex + 1);
    if (!payloadPart || !signaturePart) return null;

    const expectedSignature = hmacHex(secret, payloadPart);
    if (!timingSafeStringsEqual(signaturePart, expectedSignature)) return null;

    const claims = JSON.parse(base64urlDecode(payloadPart));
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || nowSeconds > claims.exp) return null;

    return claims;
  } catch (err) {
    return null;
  }
}

/**
 * Hash a PIN for storage in a Vercel environment variable (e.g.
 * TECH_PIN_HASH_DEMIAN, ADMIN_PIN_HASH). Uses the signing secret as
 * the HMAC key, so the stored hash isn't a bare, rainbow-table-able
 * hash of a 4-digit number -- but this is still a lightweight
 * deterrent matched to a small fixed roster, not a password system.
 * Run this locally (see the project doc) to generate the value that
 * goes into each PIN-hash environment variable; never commit a PIN
 * or its hash into the repository itself.
 */
function hashPin(pin) {
  const secret = getSigningSecret();
  return hmacHex(secret, String(pin));
}

/**
 * Constant-time check of a submitted PIN against a stored hash
 * (an environment variable value). Returns false for a missing/empty
 * stored hash rather than throwing, so a not-yet-configured PIN slot
 * fails closed instead of comparing against an empty string.
 */
function verifyPin(submittedPin, storedHash) {
  if (!storedHash) return false;
  const computed = hashPin(submittedPin);
  return timingSafeStringsEqual(computed, storedHash);
}

/**
 * Step 4 of the security plan (claude/TNT-Roadside-Security-Architecture-Plan.md):
 * LOG-ONLY token check, shared by every endpoint that will eventually
 * require a token. Reads an `Authorization: Bearer <token>` header if
 * present, verifies it, and writes one line to the function's console
 * log describing what it found -- absent, invalid/expired, or valid
 * (with its role and, for a tech token, which technician). It never
 * changes the response in any way: no matter what this finds, the
 * caller's existing logic runs exactly as it did before this call was
 * added. The point is purely to see, in real Vercel logs against real
 * usage, whether each endpoint would already have a usable token by
 * the time enforcement (plan step 7) is turned on for real -- so a
 * mismatch like the admin-PIN one from Step 3 shows up here first,
 * not as a locked-out technician after enforcement flips on.
 *
 * Returns the decoded claims (or null) in case a future step wants
 * them, but no endpoint should act on that return value yet -- this
 * step is deliberately observe-only.
 */
function logTokenCheck(endpointLabel, req) {
  try {
    const header = req.headers && req.headers.authorization;
    const token = header && header.indexOf('Bearer ') === 0 ? header.slice(7) : null;

    if (!token) {
      console.log(`[auth-log-only] ${endpointLabel}: no token present`);
      return null;
    }

    const claims = verifyToken(token);
    if (!claims) {
      console.log(`[auth-log-only] ${endpointLabel}: token present but INVALID or expired`);
      return null;
    }

    const who = claims.role === 'tech'
      ? `tech (${claims.tech_name})`
      : claims.role === 'admin'
        ? 'admin'
        : claims.job_id
          ? `customer (job_id ${claims.job_id})`
          : 'unknown claim shape';
    console.log(`[auth-log-only] ${endpointLabel}: valid token -- ${who}`);
    return claims;
  } catch (err) {
    console.log(`[auth-log-only] ${endpointLabel}: error while checking token, treated as absent (non-blocking): ${err.message}`);
    return null;
  }
}

module.exports = {
  signToken,
  verifyToken,
  hashPin,
  verifyPin,
  logTokenCheck,
};
