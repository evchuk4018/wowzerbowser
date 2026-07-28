export const USER_MEMORY_TOOL_INSTRUCTIONS = [
  "The user_memory tools access a private durable User Profile.",
  "Use them only when past profile context is useful or the user states a fact likely to remain useful later.",
  "Before writing, browse the relevant folder and update an existing memory instead of creating a duplicate.",
  "Write only facts explicitly stated or clearly confirmed by the user.",
  "Do not store guesses, assistant claims, temporary details, incidental requests, passwords, tokens, API keys, or other secrets.",
  "When a newer supported statement contradicts memory, edit or delete the old memory rather than preserving both as current.",
].join("\n");
