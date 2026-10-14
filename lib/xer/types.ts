// Raw, lossless representation of a Primavera P6 XER file.
// Rows are RAGGED: P6 drops trailing empty values, so a row may be shorter than
// its field list. Read past the end as '' and never pad on write.

export interface XerTable {
  name: string;
  fields: string[];
  rows: string[][];
}

export interface XerFile {
  /** ERMHDR values, without the 'ERMHDR' token itself. */
  header: string[];
  /** Tables in file order. */
  tables: XerTable[];
  eol: '\n' | '\r\n';
  /** Whether the file ended with an eol after %E. */
  trailingNewline: boolean;
  /** Anything after the %E line, verbatim (normally ''). */
  tail: string;
  encoding: 'windows-1252' | 'utf-8';
}

export class XerParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.line = line;
    this.name = 'XerParseError';
  }
}
