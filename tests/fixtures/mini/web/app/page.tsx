import { formatPrice } from "../lib/format";

export function Price({ cents }: { cents: number }) {
  return <span>{formatPrice(cents)}</span>;
}

export default function Page() {
  return <Price cents={1999} />;
}
