/** Wasm files imported `with { type: "file" }`: a path that also works inside the compiled binary. */
declare module "*.wasm" {
  const path: string;
  export default path;
}
