# KOYDUM — mobile app (Expo SDK 57)

Read `/home/user/repo/SPEC.md` (section 3) before writing code. It is the contract.

## Expo SDK 57 notes

`docs.expo.dev` is blocked by this container's egress proxy. Read the versioned docs from
GitHub raw instead, e.g.
`https://raw.githubusercontent.com/expo/expo/main/docs/pages/versions/v57.0.0/sdk/<module>.mdx`,
or read the installed package's own `.d.ts` under `/home/user/repo/node_modules/<pkg>/build/`.

Things that changed and bite:
- `StyleSheet.absoluteFillObject` is gone; use `StyleSheet.absoluteFill`.
- Routes live in `src/app` (not `app/`), with the `@/*` alias mapped to `./src/*`.
- `expo-router` exports `ThemeProvider`, `DarkTheme`, `Stack`, `Tabs`, `Stack.Protected`.
- React 19.2 + React Compiler is enabled (`experiments.reactCompiler`): do not memoise by hand.
- `Pedometer.getStepCountAsync` is **iOS only**. On Android use `watchStepCount` (foreground only)
  or Health Connect via `react-native-health-connect` (needs a dev build).
- Push notifications do not work in Expo Go on Android; local notifications do.

## Rules

- Do NOT run `npm install`. Everything is already installed at the repo root.
- Every user-visible string is Turkish. Identifiers and comments are English.
- `npx tsc --noEmit` must pass, and `npx expo export --platform web` must succeed.
