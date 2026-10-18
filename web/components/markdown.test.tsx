import { render, screen } from "@testing-library/react";
import { githubToMarkdown, Markdown } from "./markdown";

describe("githubToMarkdown", () => {
  it("strips HTML comments", () => {
    expect(githubToMarkdown("a <!-- hidden --> b")).toBe("a  b");
  });
  it("converts <b> to markdown bold", () => {
    expect(githubToMarkdown("<b>bold</b>")).toBe("**bold**");
  });
  it("unwraps <summary> and <details>", () => {
    expect(githubToMarkdown("<details><summary>Click me</summary>body</details>")).toBe(
      "Click me\n\nbody"
    );
  });
  it("converts <sub> to markdown emphasis", () => {
    expect(githubToMarkdown("<sub>fine print</sub>")).toBe("_fine print_");
  });
  it("converts <code> to backticks", () => {
    expect(githubToMarkdown("<code>x = 1</code>")).toBe("`x = 1`");
  });
  it("converts <br> to a middle dot", () => {
    expect(githubToMarkdown("a<br/>b")).toBe("a · b");
  });
});

describe("Markdown", () => {
  it("renders GFM content, including bold text", () => {
    render(<Markdown text="**bold** and normal" />);
    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.getByText(/and normal/)).toBeInTheDocument();
  });

  it("renders links with target=_blank and rel=noreferrer noopener (no tabnabbing)", () => {
    render(<Markdown text="[docs](https://example.com/docs)" />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("does not render raw HTML tags as live markup (XSS-safety)", () => {
    render(<Markdown text='<img src=x onerror="window.__pwned=true" />' />);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
