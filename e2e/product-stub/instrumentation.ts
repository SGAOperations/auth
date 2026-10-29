// An empty hook. The stub's Turbopack root is the repository root, so without
// its own instrumentation file the build picks up SGAuth's src/instrumentation.ts,
// whose @/ imports the stub does not define.
export function register() {}
