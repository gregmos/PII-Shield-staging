/**
 * Ambient type declarations for `@ansonlai/docx-redline-js`.
 *
 * The upstream package (v0.1.x) ships plain JS with no bundled .d.ts files.
 * We only use a narrow surface — just enough to silence `TS7016` and give
 * callers basic IntelliSense. If the public API grows, update these types
 * from the upstream README/source rather than running the package through
 * `tsc --declaration` (the JS isn't typed internally either).
 */

declare module "@ansonlai/docx-redline-js" {
  /**
   * Inject a DOM parser/serializer pair so the redliner can operate in Node
   * (where `DOMParser` / `XMLSerializer` aren't globals). We pass the
   * `@xmldom/xmldom` implementation — the same one already used elsewhere
   * in this project for OOXML manipulation.
   */
  export function configureXmlProvider(provider: {
    DOMParser: new () => {
      parseFromString(source: string, mimeType: string): unknown;
    };
    XMLSerializer: new () => {
      serializeToString(node: unknown): string;
    };
  }): void;

  /** Set the author string used by any subsequent redline operation. */
  export function setDefaultAuthor(author: string): void;
  export function getDefaultAuthor(): string;

  export function configureLogger(logger: unknown): void;
  export function setPlatform(platform: string): void;
  export function getPlatform(): string;

  /**
   * Apply redline reconciliation between `originalText` and `modifiedText`
   * over the given OOXML scope. Returns the redlined OOXML plus metadata.
   * Signature matches the upstream implementation in index.js.
   */
  export function applyRedlineToOxml(
    oxml: string,
    originalText: string,
    modifiedText: string,
    options?: Record<string, unknown>,
  ): Promise<{
    oxml?: string;
    hasChanges?: boolean;
    warnings?: string[];
    useNativeApi?: boolean;
    [key: string]: unknown;
  }>;
}

declare module "@ansonlai/docx-redline-js/services/standalone-operation-runner.js" {
  /**
   * Low-level per-operation runner used by the top-level wrappers. Consumed
   * directly by `src/docx/docx-redliner.ts` to thread a sequence of
   * single-target redline ops through one document part.
   *
   * Arg order reflects the upstream JS source exactly:
   *   (documentXml, op, author, runtimeContext = null, options = {})
   *
   * Returns an object whose `documentXml` field holds the updated OOXML and
   * `hasChanges` flags whether this particular op actually modified it.
   */
  export function applyOperationToDocumentXml(
    documentXml: string,
    op: {
      type: "redline" | "highlight" | "comment" | string;
      target: string;
      modified?: string;
      [key: string]: unknown;
    },
    author: string,
    runtimeContext?: unknown,
    options?: Record<string, unknown>,
  ): Promise<{
    documentXml?: string;
    hasChanges?: boolean;
    warnings?: string[];
    [key: string]: unknown;
  }>;
}
