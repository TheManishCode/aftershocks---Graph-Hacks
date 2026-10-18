import { Sku, Warehouse } from "./stock";
import { formatQty } from "./util/format";

export interface Line {
  sku: Sku;
  qty: number;
}

export interface Order {
  id: string;
  lines: Line[];
  status: "placed" | "rejected";
}

export function placeOrder(wh: Warehouse, id: string, lines: Line[]): Order {
  const taken: Line[] = [];
  for (const line of lines) {
    if (!wh.reserve(line.sku, line.qty)) {
      for (const t of taken) wh.release(t.sku, t.qty);
      return { id, lines, status: "rejected" };
    }
    taken.push(line);
  }
  return { id, lines, status: "placed" };
}

export function describe(order: Order): string {
  return `${order.id}: ${order.lines.map((l) => `${formatQty(l.qty)} × ${l.sku}`).join(", ")} (${order.status})`;
}
