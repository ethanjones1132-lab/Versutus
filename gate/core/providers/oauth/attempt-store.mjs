export class AttemptStore {
  constructor() {
    this.attempts = new Map();
  }

  put(attempt) {
    this.attempts.set(attempt.id, attempt);
    return attempt;
  }

  get(id) {
    return this.attempts.get(id);
  }

  delete(id) {
    this.attempts.delete(id);
  }
}
