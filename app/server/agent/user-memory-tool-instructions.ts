export const USER_MEMORY_TOOL_INSTRUCTIONS = [
  "The user_memory tools access a private durable User Profile.",
  "Use them only when past profile context is useful or the user states a fact likely to remain useful later.",
  "Before writing, browse the relevant folder and update an existing memory instead of creating a duplicate.",
  "Write only facts explicitly stated or clearly confirmed by the user.",
  "Do not store guesses, assistant claims, temporary details, or incidental requests.",
  "User memory may store security-sensitive values when the user explicitly provides them; mark those writes with sensitive=true so the server stores a keyed one-way hash. Hashed memories can be read and compared, but their original values cannot be recovered.",
  "When a newer supported statement contradicts memory, edit or delete the old memory rather than preserving both as current.",
].join("\n");
