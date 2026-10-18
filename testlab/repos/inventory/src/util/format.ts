export function formatQty(qty: number): string {
  return qty === 1 ? "1 unit" : `${qty} units`;
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
