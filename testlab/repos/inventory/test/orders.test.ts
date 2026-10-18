import { describe as describeOrder, placeOrder } from "../src/orders";
import { Warehouse } from "../src/stock";

test("places an order when stock allows", () => {
  const wh = new Warehouse();
  wh.receive("A", 3);
  const order = placeOrder(wh, "o1", [{ sku: "A", qty: 2 }]);
  expect(order.status).toBe("placed");
  expect(wh.available("A")).toBe(1);
});

test("rejects and releases on a short line", () => {
  const wh = new Warehouse();
  wh.receive("A", 3);
  const order = placeOrder(wh, "o2", [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }]);
  expect(order.status).toBe("rejected");
  expect(wh.available("A")).toBe(3);
});

test("describes an order", () => {
  expect(describeOrder({ id: "o3", lines: [{ sku: "A", qty: 1 }], status: "placed" })).toBe("o3: 1 unit × A (placed)");
});
