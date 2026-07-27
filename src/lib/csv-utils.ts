// Minimal CSV building/downloading helpers (the app's first export feature).
//
// Files are tuned for double-click-into-Excel on a fi-FI locale machine:
// semicolon delimiter (Finnish Excel uses comma as the decimal separator, so
// comma-delimited files shred into columns), UTF-8 BOM so Excel detects the
// encoding (ä/ö/€ survive), CRLF line endings, RFC 4180 quoting.

export type CsvCell = string | number;

const BOM = '\uFEFF';

function quoteCell(cell: CsvCell, delimiter: string): string {
  const text = typeof cell === 'number' ? formatCsvNumber(cell) : cell;
  if (text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Two decimals, comma decimal separator, no thousands separator ("1234,56"). */
export function formatCsvNumber(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

export function toCsv(rows: CsvCell[][], opts?: { delimiter?: string }): string {
  const delimiter = opts?.delimiter ?? ';';
  const body = rows.map(row => row.map(cell => quoteCell(cell, delimiter)).join(delimiter)).join('\r\n');
  return `${BOM}${body}\r\n`;
}

export function slugifyFilename(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'budget';
}

/** Browser-only: trigger a download of the given text as a file. */
export function downloadTextFile(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** Browser-only: trigger a download of the given CSV text. */
export function downloadCsv(filename: string, csv: string): void {
  downloadTextFile(filename, csv, 'text/csv;charset=utf-8');
}
