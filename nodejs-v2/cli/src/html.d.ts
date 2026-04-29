// Allow `import x from "*.html"` — populated at build time by esbuild's text loader.
declare module "*.html" {
  const content: string;
  export default content;
}
