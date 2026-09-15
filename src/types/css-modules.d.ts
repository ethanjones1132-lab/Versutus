// `src/app/_layout.tsx` imports `@/global.css` for its side effect, and that
// import needs a module declaration. Expo writes one into `expo-env.d.ts`, but
// that file is generated and git-ignored, so a fresh clone (CI included) failed
// typecheck with TS2882. This tracked declaration makes every checkout agree.
declare module '*.css';
