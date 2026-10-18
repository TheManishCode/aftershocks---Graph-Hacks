import { pct, num, relTime, splitId, symName, hue, ms } from "./format";

describe("pct", () => {
  it("formats a fraction as a percentage", () => {
    expect(pct(0.8142)).toBe("81%");
    expect(pct(0.8142, 1)).toBe("81.4%");
  });
  it("renders an em dash for null/undefined", () => {
    expect(pct(null)).toBe("—");
    expect(pct(undefined)).toBe("—");
  });
});

describe("num", () => {
  it("rounds and groups thousands", () => {
    expect(num(1234.6)).toBe("1,235");
  });
  it("renders an em dash for null/undefined", () => {
    expect(num(null)).toBe("—");
    expect(num(undefined)).toBe("—");
  });
});

describe("ms", () => {
  it("shows sub-10ms durations with one decimal", () => {
    expect(ms(5)).toBe("5.0 ms");
  });
  it("shows sub-second durations as a whole number", () => {
    expect(ms(142)).toBe("142 ms");
  });
  it("shows durations over a second in s", () => {
    expect(ms(1500)).toBe("1.50 s");
  });
});

describe("relTime", () => {
  const REAL_NOW = Date.now;
  beforeEach(() => {
    // Fixed "now" so relative-time boundaries are deterministic.
    Date.now = () => new Date("2026-10-18T12:00:00Z").getTime();
  });
  afterEach(() => {
    Date.now = REAL_NOW;
  });

  it("renders an em dash for falsy input", () => {
    expect(relTime(null)).toBe("—");
    expect(relTime(0)).toBe("—");
  });
  it("says 'just now' under a minute", () => {
    const epoch = Date.now() / 1000 - 30;
    expect(relTime(epoch)).toBe("just now");
  });
  it("renders minutes ago under an hour", () => {
    const epoch = Date.now() / 1000 - 5 * 60;
    expect(relTime(epoch)).toBe("5m ago");
  });
  it("renders hours ago under a day", () => {
    const epoch = Date.now() / 1000 - 3 * 3600;
    expect(relTime(epoch)).toBe("3h ago");
  });
});

describe("splitId", () => {
  it("splits a file::qname id on the first '::'", () => {
    expect(splitId("api/graph.py::EnvGraph.ro")).toEqual(["api/graph.py", "EnvGraph.ro"]);
  });
  it("returns the whole string as the file part when there is no '::'", () => {
    expect(splitId("api/graph.py")).toEqual(["api/graph.py", ""]);
  });
});

describe("symName", () => {
  it("strips the #N overload suffix", () => {
    expect(symName("Context.invoke#2")).toBe("Context.invoke");
    expect(symName("Context.invoke#2.inner")).toBe("Context.invoke.inner");
  });
  it("leaves names with no suffix untouched", () => {
    expect(symName("Context.invoke")).toBe("Context.invoke");
  });
});

describe("hue", () => {
  it("is deterministic for the same input", () => {
    expect(hue("shop/api.py")).toBe(hue("shop/api.py"));
  });
  it("stays within [0, 360)", () => {
    for (const s of ["a", "shop/service.py", "very-long-subsystem-name-here"]) {
      const h = hue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
