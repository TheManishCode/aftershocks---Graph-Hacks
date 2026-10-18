export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatName(first: string, last: string): string {
  return `${first} ${last}`;
}
