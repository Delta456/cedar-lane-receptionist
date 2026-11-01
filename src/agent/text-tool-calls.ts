// Small models sometimes write a tool call into their reply text instead of
// making it, either as a function call ('book_appointment(date="monday")') or
// in their raw chat-template syntax, which for Gemma-based models looks like
// 'book_appointment{date:<|"|>monday<|"|>}', or as just the tool's name
// ('end_call'). That text must never reach the caller. The template form and
// a bare name are regular enough to turn back into the call the model meant;
// anything else is only detected, so it can be retried.

export type TextToolCall = { name: string; args: unknown };

// Gemma's string delimiter inside its tool-call syntax.
const TEMPLATE_QUOTE = '<|"|>';

export function createTextToolCallDetector(toolNames: readonly string[]) {
  const names = toolNames.join('|');
  // Any tool name, or any raw template token. Tool names have underscores,
  // so they never turn up in an ordinary reply.
  const looksLikeCall = new RegExp(`\\b(${names})\\b|<\\|`);
  const templateCall = new RegExp(`^\\s*(${names})\\s*(\\{[\\s\\S]*\\})\\s*$`);
  // Only a tool's name, perhaps with empty brackets: seen as 'end_call'.
  const bareCall = new RegExp(`^\\s*(${names})\\s*(\\(\\s*\\))?\\s*[.!]?\\s*$`);

  return {
    // True if the text contains anything that looks like a tool call.
    detect(text: string): boolean {
      return looksLikeCall.test(text);
    },
    // The call, if the whole text is one call in template syntax, or only a
    // tool's name. A bare name has no arguments: right for end_call, and any
    // other tool sends back invalid_input, so the model fixes its call.
    parse(text: string): TextToolCall | null {
      const bare = bareCall.exec(text);
      if (bare?.[1]) {
        return { name: bare[1], args: {} };
      }
      const match = templateCall.exec(text);
      if (!match?.[1] || !match[2]) {
        return null;
      }
      const args = parseTemplateArgs(match[2]);
      return args === undefined ? null : { name: match[1], args };
    },
  };
}

// '{date:<|"|>monday<|"|>,minutesLate:10}' becomes {"date":"monday","minutesLate":10}.
function parseTemplateArgs(body: string): unknown {
  const json = body
    .split(TEMPLATE_QUOTE)
    // Odd pieces are string values: escape them as JSON strings. Even pieces
    // are structure, where keys get quoted.
    .map((piece, i) => (i % 2 === 1 ? JSON.stringify(piece) : piece.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')))
    .join('');
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
