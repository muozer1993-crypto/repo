// expo-router's own entry goes first: it loads `@expo/metro-runtime` before
// anything else and registers the root component.
import 'expo-router/entry';

// The background task has to be defined here, at the top of the bundle, and not
// only from `NotificationBridge`. expo-router evaluates `_layout` (and so the
// bridge and everything it imports) only while it renders. When Android starts
// the app headless for the 15-minute check after the phone was swiped closed,
// nothing renders: without this import `koydum-sync` would be undefined, and
// expo-task-manager unregisters a task it cannot find, so closed-phone
// "KOYDUM MU?" and step uploads would stop until the app is opened again.
// Loading the module twice is harmless: Metro keeps one instance, and the
// definition is guarded, so the bridge's `setBackgroundHandler` still lands on
// the same task.
import './src/services/background';
