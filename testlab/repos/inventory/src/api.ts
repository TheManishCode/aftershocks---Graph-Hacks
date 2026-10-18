import { describe, Line, placeOrder } from "./orders";
import { Warehouse } from "./stock";

const warehouse = new Warehouse();

export function handleOrder(body: { id: string; lines: Line[] }): { status: number; text: string } {
  const order = placeOrder(warehouse, body.id, body.lines);
  return { status: order.status === "placed" ? 201 : 409, text: describe(order) };
}

export function handleRestock(sku: string, qty: number): number {
  warehouse.receive(sku, qty);
  return warehouse.available(sku);
}
