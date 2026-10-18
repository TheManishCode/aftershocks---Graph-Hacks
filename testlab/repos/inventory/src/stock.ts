export type Sku = string;

export interface Level {
  sku: Sku;
  onHand: number;
  reserved: number;
}

export class Warehouse {
  private levels = new Map<Sku, Level>();

  receive(sku: Sku, qty: number): void {
    const l = this.levels.get(sku) ?? { sku, onHand: 0, reserved: 0 };
    l.onHand += qty;
    this.levels.set(sku, l);
  }

  available(sku: Sku): number {
    const l = this.levels.get(sku);
    return l ? l.onHand - l.reserved : 0;
  }

  reserve(sku: Sku, qty: number): boolean {
    const l = this.levels.get(sku);
    if (!l || this.available(sku) < qty) return false;
    l.reserved += qty;
    return true;
  }

  release(sku: Sku, qty: number): void {
    const l = this.levels.get(sku);
    if (l) l.reserved = Math.max(0, l.reserved - qty);
  }
}
