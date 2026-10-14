// Log files may contain several starts; the last token belongs to the latest one.
export function lastWebToken(text) {
  let token = null;
  for (const match of text.matchAll(/token=([A-Za-z0-9_-]{16,})/g)) token = match[1];
  return token;
}

export function sessionCookie(setCookie) {
  const pair = (setCookie || "").split(";", 1)[0].trim();
  return /^[^=\s;,]+=[^\r\n;]*$/.test(pair) ? pair : null;
}
