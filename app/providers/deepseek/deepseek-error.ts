export class DeepSeekError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}
