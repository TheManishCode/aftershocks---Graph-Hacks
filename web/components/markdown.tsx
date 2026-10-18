"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The PR-comment report uses a few GitHub-only HTML tags. Rewrite them as plain Markdown instead of enabling raw HTML,
 * so model output still can't inject markup.
 */
export function githubToMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?b>/g, "**")
    .replace(/<summary>([\s\S]*?)<\/summary>/g, "$1\n\n")
    .replace(/<\/?details>/g, "")
    .replace(/<sub>([\s\S]*?)<\/sub>/g, "_$1_")
    .replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<br\s*\/?>/g, " · ");
}

/** The model's answer as Markdown (GFM tables, lists, code). No raw HTML: react-markdown escapes it by default. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 gt-prose text-[14px] leading-[1.65] text-ink-dim break-words [&_strong]:font-medium [&_strong]:text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-mark underline-offset-2 hover:underline">
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          h1: ({ children }) => <p className="font-medium text-ink">{children}</p>,
          h2: ({ children }) => <p className="font-medium text-ink">{children}</p>,
          h3: ({ children }) => <p className="font-medium text-ink">{children}</p>,
          code: ({ children, className }) =>
            className ? (
              <code className={className}>{children}</code>
            ) : (
              <code className="bg-black/25 px-1 py-0.5 font-mono text-[0.85em] text-ink">{children}</code>
            ),
          pre: ({ children }) => <pre className="gt-scroll overflow-x-auto border border-line bg-deep p-3 font-mono text-[12px] text-ink">{children}</pre>,
          table: ({ children }) => (
            <div className="gt-scroll overflow-x-auto border-y border-line">
              <table className="w-full text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b border-line px-2 py-1.5 text-left font-mono text-[10px] font-medium tracking-[.12em] text-ink-faint uppercase">{children}</th>,
          td: ({ children }) => <td className="border-b border-line px-2 py-1.5">{children}</td>,
          blockquote: ({ children }) => <blockquote className="border-l border-mark/60 pl-3 text-ink-faint">{children}</blockquote>,
        }}
      >
        {githubToMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
