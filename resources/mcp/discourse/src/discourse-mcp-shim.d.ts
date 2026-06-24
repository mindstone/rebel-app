// Ambient declaration for the side-effect import `import '@discourse/mcp'` in
// index.ts. The published `@discourse/mcp` package ships no type declarations, so
// tsc reported TS2882 ("cannot find module or type declarations for side-effect
// import"). This is a side-effect import that binds no names, so an empty module
// declaration resolves it with ZERO type-safety cost (no `any` leaks into our
// code — nothing is imported from it). Lets the ts-ratchet's mcp-discourse project
// sit at baseline 0 instead of grandfathering the error at baseline 1 (a count
// baseline can be silently satisfied by a different, real error replacing this
// one). See docs/plans/260624_ts-ratchet-extend/PLAN.md.
declare module '@discourse/mcp';
