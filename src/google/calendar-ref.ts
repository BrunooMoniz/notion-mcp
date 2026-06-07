// src/google/calendar-ref.ts
// Referência opaca de agenda para as tools: embute (email da conta Google,
// calendarId) num único token base64url, para criar/editar/excluir sem
// ambiguidade entre contas. NÃO é segredo (é só um id); o isolamento real é
// feito em google-token.ts validando o email contra as contas conectadas.

export function encodeCalendarRef(email: string, calendarId: string): string {
  return Buffer.from(JSON.stringify([email, calendarId]), "utf8").toString("base64url");
}

export function decodeCalendarRef(ref: string): { email: string; calendarId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
  } catch {
    throw new Error("calendar_ref inválido");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error("calendar_ref inválido");
  }
  return { email: parsed[0], calendarId: parsed[1] };
}
