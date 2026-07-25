// palette.js — avatar colours offered in Settings. Kept in one place so the
// server's default picker and the client's chooser stay in agreement.

export const AVATAR_COLORS = [
  '#2458E6', '#7C4DDB', '#B0367A', '#0E7490',
  '#B45309', '#4D7C0F', '#334155', '#9D174D',
];

/** Rough strength signal for the sign-up meter. Advisory only — the server
    enforces the actual minimum. */
export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: 'Use at least 8 characters.' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  const label = pw.length < 8
    ? 'Use at least 8 characters.'
    : score <= 2 ? 'Weak — add length or variety.'
      : score <= 3 ? 'Okay — longer is stronger.' : 'Strong password.';
  return { score, label };
}
