// A record id is also the file name of its record (`<dir>/<id>.json`), so an id
// that can climb out of its directory must be refused before a path is built
// from it. Starts with a letter or digit, then letters, digits, `.`, `_` or `-`,
// at most 128 characters, and no `..`. Upper case and dots are allowed because
// stored ids already use them; `/`, `\`, `:` and leading dots are not.
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const RECORD_ID_MESSAGE = 'must be 1-128 letters, digits, dots, underscores or hyphens, '
  + 'starting with a letter or digit, and must not contain ".."';

export function isValidRecordId(id) {
  return typeof id === 'string' && RECORD_ID.test(id) && !id.includes('..');
}

export function assertRecordId(id) {
  if (!isValidRecordId(id)) {
    throw new Error(`invalid record id ${JSON.stringify(id)}: ${RECORD_ID_MESSAGE}`);
  }
}
